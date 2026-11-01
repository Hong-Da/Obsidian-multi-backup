import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { LocalZip, type ZipOptions } from "../../src/destinations/local-zip";
import type { SnapshotFile } from "../../src/destinations/types";
import { exists, fs, listTree, makeTmp, nodeTargetFs, path, writeText } from "../support/node";

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let root: string;
beforeEach(async () => {
  tmp = await makeTmp();
  root = path.join(tmp.dir, "snaps");
  await fs.mkdir(root, { recursive: true });
});
afterEach(() => tmp.cleanup());

const zip = (o: Partial<ZipOptions> = {}) =>
  new LocalZip(nodeTargetFs(), { root, vaultName: "My Notes", fileName: "{vault}_{date}_{time}.zip", keepCount: 30, keepDays: 90, ...o });
const file = (p: string, text: string): SnapshotFile => ({ path: p, mtime: new Date(2026, 0, 1).getTime(), read: async () => new TextEncoder().encode(text) });

describe("zip 快照", () => {
  it("生成快照，内容完整，可以解压", async () => {
    const big = "重复的中文内容 ".repeat(2000);
    const r = await zip().writeSnapshot([file("a.md", "A"), file("Notes/b.md", big), file("img/p.png", "PNGDATA")], new Date(2026, 9, 31, 10, 42));
    expect(r.name).toBe("My Notes_2026-10-31_1042.zip");
    const data = unzipSync(new Uint8Array(await fs.readFile(path.join(root, r.name))));
    expect(Object.keys(data).sort()).toEqual(["Notes/b.md", "a.md", "img/p.png"]);
    expect(new TextDecoder().decode(data["Notes/b.md"])).toBe(big);
    expect(r.size).toBeLessThan(big.length / 5); // 文本被压缩
    expect(await exists(path.join(root, r.name + ".partial"))).toBe(false);
  });

  it("同一分钟内再次生成，文件名加序号", async () => {
    const t = new Date(2026, 9, 31, 10, 42);
    await zip().writeSnapshot([file("a.md", "A")], t);
    const r2 = await zip().writeSnapshot([file("a.md", "A")], t);
    expect(r2.name).toBe("My Notes_2026-10-31_1042_2.zip");
  });

  it("读取文件失败时不留下半截文件", async () => {
    const bad: SnapshotFile = { path: "x.md", mtime: 1, read: async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } };
    await expect(zip().writeSnapshot([file("a.md", "A"), bad], new Date(2026, 9, 31))).rejects.toMatchObject({ code: "in-use" });
    expect(await listTree(root)).toEqual([]);
  });

  it("测试连接：显示现有快照数与最新时间", async () => {
    await zip().writeSnapshot([file("a.md", "A")], new Date(2026, 9, 30, 8));
    await zip().writeSnapshot([file("a.md", "A")], new Date(2026, 9, 31, 8));
    const info = await zip().test();
    expect(info.existing).toBe(2);
    expect(info.newest).toBe(new Date(2026, 9, 31, 8).getTime());
  });

  it("保留规则：最近 N 个且不超过 D 天，最新的一个总是保留", async () => {
    const z = zip({ keepCount: 3, keepDays: 10 });
    for (const d of [1, 5, 20, 25, 28, 30]) await z.writeSnapshot([file("a.md", "A")], new Date(2026, 9, d, 8));
    // 10 月 31 日清理：10 天内的是 25、28、30 日（共 3 个，正好满足数量）
    const removed = await z.prune(new Date(2026, 9, 31, 9));
    expect(removed.length).toBe(3);
    expect((await listTree(root)).filter((f) => f.endsWith(".zip"))).toEqual([
      "My Notes_2026-10-25_0800.zip",
      "My Notes_2026-10-28_0800.zip",
      "My Notes_2026-10-30_0800.zip",
    ]);
  });

  it("全部超过天数时仍保留最新的一个", async () => {
    const z = zip({ keepCount: 0, keepDays: 7 });
    await z.writeSnapshot([file("a.md", "A")], new Date(2026, 0, 1));
    await z.writeSnapshot([file("a.md", "A")], new Date(2026, 0, 2));
    await z.prune(new Date(2026, 9, 31));
    expect((await listTree(root)).filter((f) => f.endsWith(".zip"))).toEqual(["My Notes_2026-01-02_0000.zip"]);
  });

  it("不清理不是插件生成的 zip", async () => {
    await writeText(path.join(root, "my-own.zip"), "x");
    const z = zip({ keepCount: 1, keepDays: 0 });
    await z.writeSnapshot([file("a.md", "A")], new Date(2026, 9, 30));
    await z.writeSnapshot([file("a.md", "A")], new Date(2026, 9, 31));
    await z.prune(new Date(2026, 9, 31));
    expect((await listTree(root)).filter((f) => f.endsWith(".zip")).sort()).toEqual(["My Notes_2026-10-31_0000.zip", "my-own.zip"]);
  });
});
