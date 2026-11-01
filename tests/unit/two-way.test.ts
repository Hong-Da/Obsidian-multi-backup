import { beforeEach, describe, expect, it } from "vitest";
import { conflictName, isConflictCopy, safeDeviceName, defaultDeviceName } from "../../src/core/conflict";
import { Device, MemoryPrimary } from "../support/two-way-fixtures";

let remote: MemoryPrimary;
let pc: Device;
let phone: Device;

beforeEach(() => {
  remote = new MemoryPrimary();
  pc = new Device("桌面-7F3A", remote);
  phone = new Device("手机-2B9C", remote);
});

const userFiles = (d: Device) => d.vault.paths().filter((p) => !p.startsWith(".trash/"));

describe("两台设备交替修改后内容一致", () => {
  it("新增、修改、删除、改名都能同步到另一台", async () => {
    pc.vault.set("a.md", "A1").set("b.md", "B1").set("dir/c.md", "C1");
    await pc.sync();
    await phone.sync();
    expect(userFiles(phone)).toEqual(["a.md", "b.md", "dir/c.md"]);

    // 手机：改 a、删 b、c 改名、新增 d
    phone.vault.set("a.md", "A2").delete("b.md").delete("dir/c.md").set("dir/c2.md", "C1").set("d.md", "D1");
    await phone.sync();
    await pc.sync();
    expect(userFiles(pc)).toEqual(["a.md", "d.md", "dir/c2.md"]);
    expect(pc.vault.text("a.md")).toBe("A2");

    // 电脑再改，手机拉取
    pc.vault.set("d.md", "D2");
    await pc.sync();
    await phone.sync();
    expect(phone.vault.text("d.md")).toBe("D2");
    expect(userFiles(pc)).toEqual(userFiles(phone));
  });

  it("没有变化时什么也不做", async () => {
    pc.vault.set("a.md", "A1");
    await pc.sync();
    const r = await pc.sync();
    expect([r.uploaded, r.downloaded, r.unchanged]).toEqual([0, 0, 1]);
  });
});

describe("被覆盖或删除的本机文件先进回收站", () => {
  it("下载新版本前，本机旧版复制进回收站；远程删除时，本机文件移进回收站", async () => {
    pc.vault.set("a.md", "A1").set("b.md", "B1");
    await pc.sync();
    await phone.sync();
    pc.vault.set("a.md", "A2").delete("b.md");
    await pc.sync();
    await phone.sync();
    expect(phone.writer.trashed).toEqual([
      { path: "b.md", content: "B1", moved: true },
      { path: "a.md", content: "A1", moved: false },
    ]);
  });
});

describe("冲突", () => {
  it("两边都改了：本机版本留在原处，远程版本另存为冲突副本，两边最终一致", async () => {
    pc.vault.set("note.md", "原文");
    await pc.sync();
    await phone.sync();
    phone.vault.set("note.md", "手机改的");
    await phone.sync();
    pc.vault.set("note.md", "电脑改的");
    const r = await pc.sync(new Date(2026, 9, 31, 14, 30));

    const copy = "note.conflict-手机-2B9C-2026-10-31-1430.md";
    expect(r.conflicts).toMatchObject([{ path: "note.md", kind: "both", copy }]);
    expect(pc.vault.text("note.md")).toBe("电脑改的");
    expect(pc.vault.text(copy)).toBe("手机改的");
    // 手机同步后两份都有，内容一致
    await phone.sync();
    expect(phone.vault.text("note.md")).toBe("电脑改的");
    expect(phone.vault.text(copy)).toBe("手机改的");
  });

  it("两边改成了一样的内容：不算冲突", async () => {
    pc.vault.set("n.md", "v1");
    await pc.sync();
    await phone.sync();
    phone.vault.set("n.md", "v2");
    await phone.sync();
    pc.vault.set("n.md", "v2");
    const r = await pc.sync();
    expect(r.conflicts).toEqual([]);
    expect(userFiles(pc)).toEqual(["n.md"]);
  });

  it("本机改了、远程删了：保留本机并重新上传，登记提醒", async () => {
    pc.vault.set("n.md", "v1");
    await pc.sync();
    await phone.sync();
    phone.vault.delete("n.md");
    await phone.sync();
    pc.vault.set("n.md", "v2");
    const r = await pc.sync();
    expect(r.conflicts).toMatchObject([{ path: "n.md", kind: "keepLocal" }]);
    expect(remote.text("n.md")).toBe("v2");
    await phone.sync();
    expect(phone.vault.text("n.md")).toBe("v2");
  });

  it("远程改了、本机删了：从远程恢复，登记提醒", async () => {
    pc.vault.set("n.md", "v1");
    await pc.sync();
    await phone.sync();
    phone.vault.set("n.md", "v2");
    await phone.sync();
    pc.vault.delete("n.md");
    const r = await pc.sync();
    expect(r.conflicts).toMatchObject([{ path: "n.md", kind: "restoreRemote" }]);
    expect(pc.vault.text("n.md")).toBe("v2");
  });

  it("推送失败后重试：同一个远程版本不再另存第二份冲突副本", async () => {
    pc.vault.set("n.md", "v1");
    await pc.sync();
    await phone.sync();
    phone.vault.set("n.md", "phone");
    await phone.sync();
    pc.vault.set("n.md", "pc");
    remote.failFinish = true;
    await expect(pc.sync()).rejects.toThrow("push failed");
    remote.failFinish = false;
    // 失败那次的冲突登记仍保留（由调用方在失败时保存），重试时复用
    await pc.sync(new Date(2026, 9, 31, 11, 0));
    expect(userFiles(pc).filter(isConflictCopy)).toHaveLength(1);
  });
});

describe("首次设为主同步端：不删除任何文件", () => {
  it("两边独有的互相补齐，内容相同的直接对上，不同的保留两份", async () => {
    remote.files.set("only-remote.md", { data: new TextEncoder().encode("R"), id: "x1", by: "笔记本" });
    remote.files.set("same.md", { data: new TextEncoder().encode("S"), id: "x2", by: "笔记本" });
    remote.files.set("diff.md", { data: new TextEncoder().encode("远程"), id: "x3", by: "笔记本" });
    pc.vault.set("only-local.md", "L").set("same.md", "S").set("diff.md", "本机");
    const r = await pc.sync(new Date(2026, 9, 31, 9, 5));
    expect(r.deletedLocal + r.deletedRemote).toBe(0);
    expect(userFiles(pc)).toEqual(["diff.conflict-笔记本-2026-10-31-0905.md", "diff.md", "only-local.md", "only-remote.md", "same.md"]);
    expect([...remote.files.keys()].sort()).toEqual(userFiles(pc));
  });
});

describe("同步过程中本机文件又被编辑", () => {
  it("要覆盖的文件和扫描时不一样了：跳过，不覆盖", async () => {
    pc.vault.set("n.md", "v1");
    await pc.sync();
    await phone.sync();
    pc.vault.set("n.md", "v2");
    await pc.sync();
    // 手机：扫描后、下载前用户又改了（用一个在 exists 时改内容的写入器模拟）
    const exists = phone.writer.exists.bind(phone.writer);
    phone.writer.exists = async (p: string) => {
      if (p === "n.md") phone.vault.set("n.md", "手机刚打的字");
      return exists(p);
    };
    const r = await phone.sync();
    expect(r.failed).toMatchObject([{ path: "n.md", op: "download", error: { code: "local-changed" } }]);
    expect(phone.vault.text("n.md")).toBe("手机刚打的字");
  });
});

describe("冲突副本命名", () => {
  it("扩展名留在最后，设备名里的特殊字符换掉", () => {
    expect(conflictName("Daily/2026-10-31.md", "手机-2B9C", new Date(2026, 9, 31, 10, 42))).toBe("Daily/2026-10-31.conflict-手机-2B9C-2026-10-31-1042.md");
    expect(conflictName("img/a.png", "My Phone/1", new Date(2026, 0, 2, 3, 4))).toBe("img/a.conflict-My-Phone-1-2026-01-02-0304.png");
    expect(conflictName("README", "pc", new Date(2026, 0, 2, 3, 4))).toBe("README.conflict-pc-2026-01-02-0304");
    expect(safeDeviceName("  ")).toBe("device");
    expect(isConflictCopy("Daily/2026-10-31.conflict-手机-2B9C-2026-10-31-1042.md")).toBe(true);
    expect(isConflictCopy("Daily/2026-10-31.md")).toBe(false);
  });

  it("默认设备名：桌面 / 手机 + 4 位编号", () => {
    expect(defaultDeviceName(true, { desktop: "桌面", phone: "手机" }, () => 0.5)).toBe("手机-8888");
    expect(defaultDeviceName(false, { desktop: "Desktop", phone: "Phone" })).toMatch(/^Desktop-[0-9A-F]{4}$/);
  });
});

describe("处理冲突", () => {
  async function setup() {
    const { MemoryVault } = await import("../support/memory-vault");
    const { MemoryWriter } = await import("../support/two-way-fixtures");
    const { resolveConflict } = await import("../../src/core/conflict");
    const v = new MemoryVault().set("n.md", "本机").set("n.conflict-手机-2026-10-31-1042.md", "远程");
    const w = new MemoryWriter(v);
    const io = { read: async (p: string) => new Uint8Array(await v.readBinary(p)), exists: (p: string) => w.exists(p), write: (p: string, d: Uint8Array) => w.write(p, d), trash: (p: string, m: boolean) => w.trash(p, m) };
    const c = { path: "n.md", copy: "n.conflict-手机-2026-10-31-1042.md" };
    return { v, w, io, c, resolveConflict };
  }

  it("保留本机：副本进回收站", async () => {
    const { v, io, c, resolveConflict } = await setup();
    await resolveConflict(c, "mine", io);
    expect(v.paths()).toEqual(["n.md"]);
    expect(v.text("n.md")).toBe("本机");
  });

  it("保留远程：本机原文件先进回收站，再用副本内容覆盖，副本进回收站", async () => {
    const { v, w, io, c, resolveConflict } = await setup();
    await resolveConflict(c, "remote", io);
    expect(v.paths()).toEqual(["n.md"]);
    expect(v.text("n.md")).toBe("远程");
    expect(w.trashed.map((t) => [t.path, t.content, t.moved])).toEqual([
      ["n.md", "本机", false],
      ["n.conflict-手机-2026-10-31-1042.md", "远程", true],
    ]);
  });

  it("两份都保留：什么都不删", async () => {
    const { v, io, c, resolveConflict } = await setup();
    await resolveConflict(c, "both", io);
    expect(v.paths()).toHaveLength(2);
  });

  it("副本已被手动删掉时，选“保留远程”不会动本机文件", async () => {
    const { v, io, c, resolveConflict } = await setup();
    v.delete(c.copy);
    await resolveConflict(c, "remote", io);
    expect(v.text("n.md")).toBe("本机");
  });
});
