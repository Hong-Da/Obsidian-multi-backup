// 本地镜像作为主同步端：两台电脑共用一个文件夹（例如 NAS 共享文件夹）双向同步
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { scanVault } from "../../src/core/scanner";
import type { BaseEntry } from "../../src/core/sync-planner";
import { syncTwoWay } from "../../src/core/two-way";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { fs, listTree, makeTmp, nodeTargetFs, NodeVaultFs, NodeVaultWriter, path, readText, removePath, writeText } from "../support/node";

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let shared: string;
beforeEach(async () => {
  tmp = await makeTmp();
  shared = path.join(tmp.dir, "nas");
  await fs.mkdir(shared, { recursive: true });
});
afterEach(() => tmp.cleanup());

function device(name: string) {
  const dir = path.join(tmp.dir, name);
  let base = new Map<string, BaseEntry>();
  const writer = new NodeVaultWriter(dir);
  return {
    dir,
    writer,
    async sync(t = new Date(2026, 9, 31, 10, 0)) {
      await fs.mkdir(dir, { recursive: true });
      const store = new LocalMirror(nodeTargetFs(), { root: shared, deletePolicy: "trash30", keepVersions: 10, now: () => t }).asPrimary();
      await store.prepare();
      const vault = new NodeVaultFs(dir);
      const matcher = new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
      const scan = await scanVault(vault, { matcher, maxFileSize: 1 << 30, previous: { version: 1, updatedAt: 0, files: {} } });
      const res = await syncTwoWay({
        vault, writer, store, local: scan.files, base, remote: await store.list(),
        matches: (d, id, p) => store.matches(d, id, p), remoteDevice: () => "other", now: () => t,
      });
      await store.finish(t);
      base = res.base;
      return res;
    },
    files: async () => (await listTree(dir)).filter((f) => !f.startsWith(".trash/")),
  };
}

describe("本地镜像作为主同步端", () => {
  it("两台电脑经共享文件夹交替修改、删除，内容一致；远程删除的文件进目标的回收站", async () => {
    const a = device("pc-a");
    const b = device("pc-b");
    await writeText(path.join(a.dir, "x.md"), "X1");
    await writeText(path.join(a.dir, "y.md"), "Y1");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual(["x.md", "y.md"]);

    await writeText(path.join(b.dir, "x.md"), "X2");
    await removePath(path.join(b.dir, "y.md"));
    await b.sync();
    await a.sync();
    expect(await a.files()).toEqual(["x.md"]);
    expect(await readText(path.join(a.dir, "x.md"))).toBe("X2");
    // 共享文件夹里的 y.md 移进了目标的回收站，没有直接删掉
    expect((await listTree(shared)).some((f) => f.startsWith(".multi-backup/trash/") && f.endsWith("y.md"))).toBe(true);
  });

  it("两边都改了：保留两份", async () => {
    const a = device("pc-a");
    const b = device("pc-b");
    await writeText(path.join(a.dir, "n.md"), "v1");
    await a.sync();
    await b.sync();
    await writeText(path.join(b.dir, "n.md"), "B 改的");
    await b.sync();
    await writeText(path.join(a.dir, "n.md"), "A 改的");
    const r = await a.sync(new Date(2026, 9, 31, 11, 0));
    expect(r.conflicts).toMatchObject([{ kind: "both", copy: "n.conflict-other-2026-10-31-1100.md" }]);
    expect(await readText(path.join(a.dir, "n.conflict-other-2026-10-31-1100.md"))).toBe("B 改的");
  });
});
