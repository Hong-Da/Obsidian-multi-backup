// 恢复：计划、执行、撤销，以及镜像、zip、本地 git 三种恢复来源
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { executeRestore, hashOf, planRestore, scopeMatcher, undoRestore, type LocalFileInfo, type RestoreRecord } from "../../src/core/restore";
import { runBackup } from "../../src/core/sync";
import { LocalGit } from "../../src/destinations/local-git";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { LocalZip } from "../../src/destinations/local-zip";
import type { FileStore, SnapshotStore } from "../../src/destinations/types";
import { exists, fs, makeTmp, MemoryState, nodeTargetFs, NodeVaultFs, NodeVaultWriter, path, readText, writeText } from "../support/node";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (d: Uint8Array) => new TextDecoder().decode(d);

async function localMap(files: Record<string, string>): Promise<Map<string, LocalFileInfo>> {
  const out = new Map<string, LocalFileInfo>();
  for (const [p, t] of Object.entries(files)) out.set(p, { size: enc(t).byteLength, hash: await hashOf(enc(t)) });
  return out;
}

describe("恢复计划", () => {
  const remote: Record<string, string> = { "a.md": "A 旧", "b.md": "B", "c.md": "C 新加", "d/e.md": "E", "d/f.md": "F 旧" };
  const remoteMap = new Map(Object.entries(remote).map(([p, t]) => [p, { size: enc(t).byteLength }]));
  const read = async (p: string) => enc(remote[p] ?? "");

  it("本机没有的写回，不同的覆盖，相同的跳过；默认不移走本机多出的文件", async () => {
    const local = await localMap({ "a.md": "A 新改的", "b.md": "B", "d/e.md": "E", "d/f.md": "F 新", "later.md": "后来新建的" });
    const plan = await planRestore({ remote: remoteMap, local, include: () => true, removeExtra: false, read });
    expect(plan).toEqual({ add: ["c.md"], overwrite: ["a.md", "d/f.md"], same: ["b.md", "d/e.md"], remove: [] });
    const withRemove = await planRestore({ remote: remoteMap, local, include: () => true, removeExtra: true, read });
    expect(withRemove.remove).toEqual(["later.md"]);
  });

  it("大小相同但内容不同也算覆盖；只恢复选中的文件夹和文件", async () => {
    const local = await localMap({ "d/f.md": "F 新" });
    expect((await planRestore({ remote: remoteMap, local, include: scopeMatcher(["d/f.md"]), removeExtra: false, read })).overwrite).toEqual(["d/f.md"]);
    const scope = scopeMatcher(["d", "b.md"]);
    expect(["d/e.md", "d/f.md", "b.md", "a.md", "dd/x.md"].filter(scope)).toEqual(["d/e.md", "d/f.md", "b.md"]);
    expect(scopeMatcher(null)("任何.md")).toBe(true);
  });
});

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let vault: string;
beforeEach(async () => {
  tmp = await makeTmp();
  vault = path.join(tmp.dir, "vault");
  await fs.mkdir(vault, { recursive: true });
});
afterEach(() => tmp.cleanup());

describe("执行与撤销", () => {
  it("覆盖、移走前先另存；撤销后本机回到恢复前，撤销时的本机文件也另存", async () => {
    await writeText(path.join(vault, "a.md"), "本机 A");
    await writeText(path.join(vault, "later.md"), "后来新建");
    const backup: Record<string, string> = { "a.md": "备份 A", "new/b.md": "备份 B" };
    const io = new NodeVaultWriter(vault);
    const dir = ".trash/multi-backup/restore-2026-10-31-1530";
    const r = await executeRestore({ add: ["new/b.md"], overwrite: ["a.md"], same: [], remove: ["later.md"] }, { read: async (p) => enc(backup[p] ?? ""), io, dir });
    expect(r).toMatchObject({ added: ["new/b.md"], overwritten: ["a.md"], removed: ["later.md"], failed: [] });
    expect(await readText(path.join(vault, "a.md"))).toBe("备份 A");
    expect(await readText(path.join(vault, "new", "b.md"))).toBe("备份 B");
    expect(await exists(path.join(vault, "later.md"))).toBe(false);
    expect(await readText(path.join(vault, ...`${dir}/a.md`.split("/")))).toBe("本机 A");
    expect(await readText(path.join(vault, ...`${dir}/later.md`.split("/")))).toBe("后来新建");

    // 恢复后又改了 a.md，撤销时这个版本也要留着
    await writeText(path.join(vault, "a.md"), "恢复后又改");
    const rec: RestoreRecord = { id: "r1", time: 0, destId: "d", destName: "d", point: "", dir, added: r.added, overwritten: r.overwritten, removed: r.removed, failed: 0 };
    const undoDir = ".trash/multi-backup/undo-2026-10-31-1535";
    expect((await undoRestore(rec, io, undoDir)).failed).toEqual([]);
    expect(await readText(path.join(vault, "a.md"))).toBe("本机 A");
    expect(await readText(path.join(vault, "later.md"))).toBe("后来新建");
    expect(await exists(path.join(vault, "new", "b.md"))).toBe(false);
    expect(await readText(path.join(vault, ...`${undoDir}/a.md`.split("/")))).toBe("恢复后又改");
    expect(await readText(path.join(vault, ...`${undoDir}/new/b.md`.split("/")))).toBe("备份 B");
  });

  it("一个文件失败不影响其他文件", async () => {
    const io = new NodeVaultWriter(vault);
    const r = await executeRestore(
      { add: ["bad.md", "ok.md"], overwrite: [], same: [], remove: [] },
      { read: async (p) => (p === "bad.md" ? Promise.reject(new Error("读不到")) : enc("好")), io, dir: ".trash/x" },
    );
    expect(r.added).toEqual(["ok.md"]);
    expect(r.failed.map((f) => f.path)).toEqual(["bad.md"]);
  });
});

describe("恢复来源", () => {
  const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
  let clock: Date;
  const backup = async (store: FileStore | SnapshotStore, state: MemoryState) => {
    const r = await runBackup({ vault: new NodeVaultFs(vault), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => clock }, [{ id: "d", store, extraExcludes: [] }]);
    expect(r.destinations[0]?.status).not.toBe("failed");
  };
  const twoBackups = async (make: () => FileStore | SnapshotStore) => {
    const state = new MemoryState();
    clock = new Date(2026, 9, 30, 9, 0);
    await writeText(path.join(vault, "n.md"), "第一版");
    await writeText(path.join(vault, "x/y.md"), "Y");
    await backup(make(), state);
    clock = new Date(2026, 9, 31, 9, 0);
    await writeText(path.join(vault, "n.md"), "第二版", Date.now() + 60_000);
    await backup(make(), state);
  };

  it("镜像：当前备份 + 单个文件的历史版本", async () => {
    const root = path.join(tmp.dir, "mirror");
    await fs.mkdir(root);
    const make = () => new LocalMirror(nodeTargetFs(), { root, deletePolicy: "trash30", keepVersions: 10, now: () => clock });
    await twoBackups(make);
    const src = make().restoreSource();
    expect(src.mode).toBe("current");
    const [p] = await src.points(10);
    expect([...(await src.files(p!.id)).keys()].sort()).toEqual(["n.md", "x/y.md"]);
    expect(dec(await src.read("current", "n.md"))).toBe("第二版");
    const vers = await src.fileVersions("n.md", 10);
    expect(vers.map((v) => v.pointId.slice(0, 2))).toEqual(["cu", "v:"]);
    expect(new Date(vers[1]!.time).getDate()).toBe(31);
    expect(dec(await src.read(vers[1]!.pointId, "n.md"))).toBe("第一版");
  });

  it("zip：每个快照是一个时间点", async () => {
    const root = path.join(tmp.dir, "zip");
    await fs.mkdir(root);
    const make = () => new LocalZip(nodeTargetFs(), { root, vaultName: "V", fileName: "{vault}_{date}_{time}.zip", keepCount: 30, keepDays: 0 });
    await twoBackups(make);
    const src = make().restoreSource();
    const pts = await src.points(10);
    expect(pts.length).toBe(2);
    expect(dec(await src.read(pts[1]!.id, "n.md"))).toBe("第一版");
    expect(dec(await src.read(pts[0]!.id, "n.md"))).toBe("第二版");
    expect([...(await src.files(pts[1]!.id)).keys()].sort()).toEqual(["n.md", "x/y.md"]);
    expect((await src.fileVersions("x/y.md", 10)).length).toBe(2);
  });

  it("本地 git：每个提交是一个时间点；文件的版本是内容变化的那些提交", async () => {
    const root = path.join(tmp.dir, "repo");
    await fs.mkdir(root);
    const make = () => new LocalGit(nodeTargetFs(), nodeFs, { root, vaultName: "V", message: "Backup {date} {time}", author: { name: "t", email: "t@t" }, now: () => clock });
    await twoBackups(make);
    const src = make().restoreSource();
    const pts = await src.points(10);
    expect(pts.map((p) => p.title)).toEqual(["Backup 2026-10-31 09:00", "Backup 2026-10-30 09:00"]);
    expect(pts[0]!.short).toHaveLength(7);
    expect(dec(await src.read(pts[1]!.id, "n.md"))).toBe("第一版");
    expect([...(await src.files(pts[0]!.id)).keys()].sort()).toEqual(["n.md", "x/y.md"]);
    expect((await src.fileVersions("n.md", 10)).map((v) => v.pointId)).toEqual(pts.map((p) => p.id));
    // x/y.md 只在第一次提交里变化过
    expect((await src.fileVersions("x/y.md", 10)).map((v) => v.pointId)).toEqual([pts[1]!.id]);
  });
});
