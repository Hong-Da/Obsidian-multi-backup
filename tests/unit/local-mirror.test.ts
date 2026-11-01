import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalMirror, type MirrorOptions } from "../../src/destinations/local-mirror";
import { exists, listTree, makeTmp, nodeTargetFs, path, readText, writeText } from "../support/node";

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let root: string;
beforeEach(async () => {
  tmp = await makeTmp();
  root = path.join(tmp.dir, "mirror");
  await writeText(path.join(root, ".keep"), "");
});
afterEach(() => tmp.cleanup());

const enc = (s: string) => new TextEncoder().encode(s);
let clock = new Date(2026, 9, 31, 10, 0, 0);
const mirror = (o: Partial<MirrorOptions> = {}) =>
  new LocalMirror(nodeTargetFs(), { root, deletePolicy: "trash30", keepVersions: 3, now: () => clock, ...o });

describe("本地镜像", () => {
  it("目标文件夹不存在时报 not-found，不自动创建", async () => {
    const m = new LocalMirror(nodeTargetFs(), { root: path.join(tmp.dir, "no-such"), deletePolicy: "trash30", keepVersions: 0 });
    await expect(m.prepare()).rejects.toMatchObject({ code: "not-found" });
    expect(await exists(path.join(tmp.dir, "no-such"))).toBe(false);
  });

  it("没填路径时报 not-configured", async () => {
    await expect(mirror({ root: " " }).prepare()).rejects.toMatchObject({ code: "not-configured" });
  });

  it("测试连接：可以写入，探测文件已删除", async () => {
    const info = await mirror({ knownFiles: 7 }).test();
    expect(info.existing).toBe(7);
    expect(await exists(path.join(root, ".multi-backup", ".probe"))).toBe(false);
  });

  it("写入时自动创建子文件夹，并保留修改时间", async () => {
    const m = mirror();
    const mtime = new Date(2026, 0, 1).getTime();
    expect(await m.write("Notes/deep/a.md", enc("A"), mtime)).toBe("written");
    expect(await readText(path.join(root, "Notes", "deep", "a.md"))).toBe("A");
    const { fs } = await import("../support/node");
    expect(Math.abs((await fs.stat(path.join(root, "Notes", "deep", "a.md"))).mtimeMs - mtime)).toBeLessThan(2000);
  });

  it("内容相同时不写入，也不产生历史版本", async () => {
    const m = mirror();
    await m.write("a.md", enc("A"), 1);
    expect(await m.write("a.md", enc("A"), 2)).toBe("identical");
    expect(await exists(path.join(root, ".multi-backup", "versions"))).toBe(false);
  });

  it("覆盖前保留旧版本（文件名是被替换的时间），只留最近 N 个", async () => {
    const m = mirror({ keepVersions: 2 });
    for (let i = 1; i <= 4; i++) {
      clock = new Date(2026, 9, 31, 10, i, 0);
      await m.write("Notes/a.md", enc("v" + i), 1);
    }
    const versions = await listTree(path.join(root, ".multi-backup", "versions", "Notes", "a.md"));
    // 10:02 替换 v1、10:03 替换 v2、10:04 替换 v3，只留最近 2 个
    expect(versions).toEqual(["2026-10-31_100300.md", "2026-10-31_100400.md"]);
    expect(await readText(path.join(root, ".multi-backup", "versions", "Notes", "a.md", "2026-10-31_100400.md"))).toBe("v3");
    expect(await readText(path.join(root, "Notes", "a.md"))).toBe("v4");
  });

  it("同一秒内多次覆盖，版本文件名不冲突", async () => {
    const m = mirror({ keepVersions: 5 });
    clock = new Date(2026, 9, 31, 11, 0, 0);
    for (const v of ["a", "b", "c"]) await m.write("x.md", enc(v), 1);
    expect(await listTree(path.join(root, ".multi-backup", "versions", "x.md"))).toEqual(["2026-10-31_110000-1.md", "2026-10-31_110000.md"]);
  });

  it("历史版本数为 0 时直接覆盖", async () => {
    const m = mirror({ keepVersions: 0 });
    await m.write("a.md", enc("1"), 1);
    await m.write("a.md", enc("2"), 1);
    expect(await exists(path.join(root, ".multi-backup"))).toBe(false);
  });

  it("移动文件并删除变空的旧文件夹", async () => {
    const m = mirror();
    await m.write("Old/Sub/a.md", enc("A"), 1);
    expect(await m.move("Old/Sub/a.md", "New/a.md")).toBe(true);
    expect(await readText(path.join(root, "New", "a.md"))).toBe("A");
    expect(await exists(path.join(root, "Old"))).toBe(false);
  });

  it("只改大小写的重命名", async () => {
    const m = mirror();
    await m.write("readme.md", enc("R"), 1);
    expect(await m.move("readme.md", "Readme.md")).toBe(true);
    expect((await listTree(root)).filter((f) => !f.startsWith("."))).toEqual(["Readme.md"]);
  });

  it("源文件不存在时 move 返回 false", async () => {
    expect(await mirror().move("missing.md", "b.md")).toBe(false);
  });

  it("删除：移到回收站的当天文件夹", async () => {
    const m = mirror();
    clock = new Date(2026, 9, 31, 12, 0, 0);
    await m.write("Notes/a.md", enc("A"), 1);
    await m.remove("Notes/a.md");
    expect(await exists(path.join(root, "Notes"))).toBe(false);
    expect(await readText(path.join(root, ".multi-backup", "trash", "2026-10-31", "Notes", "a.md"))).toBe("A");
  });

  it("删除策略：直接删除 / 永不删除", async () => {
    const del = mirror({ deletePolicy: "delete" });
    await del.write("a.md", enc("A"), 1);
    await del.remove("a.md");
    expect(await exists(path.join(root, "a.md"))).toBe(false);
    expect(await exists(path.join(root, ".multi-backup", "trash"))).toBe(false);

    const keep = mirror({ deletePolicy: "keep" });
    await keep.write("b.md", enc("B"), 1);
    await keep.remove("b.md");
    expect(await exists(path.join(root, "b.md"))).toBe(true);
  });

  it("回收站超过 30 天的日期文件夹在同步结束时清理", async () => {
    for (const d of ["2026-09-30", "2026-10-01", "2026-10-31"]) await writeText(path.join(root, ".multi-backup", "trash", d, "x.md"), "x");
    await mirror().finish(new Date(2026, 9, 31, 9));
    expect(await listTree(path.join(root, ".multi-backup", "trash"))).toEqual(["2026-10-01/x.md", "2026-10-31/x.md"]);
  });
});
