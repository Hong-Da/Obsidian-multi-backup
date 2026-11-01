// 集成测试：WebDAV（rclone serve webdav）与 S3（rclone serve s3）。由 scripts/test-services.sh 启动并传入账号；没有设置时跳过。
// 两种都复用本地镜像的逻辑：备份（历史版本、回收站）与主同步端双向同步。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import process from "node:process";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { signV4 } from "../../src/core/sigv4";
import { runBackup } from "../../src/core/sync";
import { syncTwoWay } from "../../src/core/two-way";
import { scanVault } from "../../src/core/scanner";
import type { BaseEntry } from "../../src/core/sync-planner";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { S3Fs } from "../../src/destinations/s3-fs";
import type { TargetFs } from "../../src/destinations/types";
import { WebDavFs } from "../../src/destinations/webdav-fs";
import { nodeFetchHttp } from "../support/node-http";
import { fs, makeTmp, MemoryState, NodeVaultFs, NodeVaultWriter, path, readText, removePath, renamePath, writeText } from "../support/node";

const env = process.env;
const DAV = env.MB_WEBDAV_URL ?? "";
const S3 = env.MB_S3_ENDPOINT ?? "";
const BUCKET = "mbtest";

const backends: [string, boolean, () => TargetFs][] = [
  ["WebDAV", !!DAV, () => new WebDavFs({ url: DAV, username: env.MB_WEBDAV_USER ?? "", password: env.MB_WEBDAV_PASSWORD ?? "", http: nodeFetchHttp })],
  ["S3", !!S3, () => new S3Fs({ endpoint: S3, region: "us-east-1", bucket: BUCKET, accessKeyId: env.MB_S3_KEY ?? "", secretAccessKey: env.MB_S3_SECRET ?? "", pathStyle: true, http: nodeFetchHttp })],
];

beforeAll(async () => {
  if (!S3) return;
  // 建测试用的桶（已存在时忽略）
  const url = `${S3}/${BUCKET}`;
  const h = await signV4({ method: "PUT", url, headers: {} }, { accessKeyId: env.MB_S3_KEY ?? "", secretAccessKey: env.MB_S3_SECRET ?? "", region: "us-east-1", service: "s3" }, new Date());
  await globalThis.fetch(url, { method: "PUT", headers: h });
});

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let n = 0;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));

for (const [name, enabled, make] of backends) {
  describe.skipIf(!enabled)(`${name} 集成测试`, () => {
    it("备份：首次、增量（改、改名、删），历史版本与回收站在 .multi-backup/ 下", async () => {
      const fsx = make();
      const root = `/it-${Date.now().toString(36)}-${++n}`;
      const vault = path.join(tmp.dir, "vault");
      await writeText(path.join(vault, "a.md"), "A1");
      await writeText(path.join(vault, "中文/笔记 1.md"), "N1");
      const state = new MemoryState();
      const mirror = () => new LocalMirror(fsx, { root, deletePolicy: "trash30", keepVersions: 10, createRoot: true });
      const run = () => runBackup({ vault: new NodeVaultFs(vault), state, matcher: matcher(), maxFileSize: 1 << 30 }, [{ id: "d", store: mirror(), extraExcludes: [] }]);

      const r1 = await run();
      expect(r1.destinations[0]).toMatchObject({ status: "ok", uploaded: 2 });
      expect(new TextDecoder().decode(await fsx.readFile(`${root}/中文/笔记 1.md`))).toBe("N1");

      await writeText(path.join(vault, "a.md"), "A2");
      await renamePath(path.join(vault, "中文", "笔记 1.md"), path.join(vault, "中文", "笔记 2.md"));
      await writeText(path.join(vault, "gone.md"), "G");
      await run();
      await removePath(path.join(vault, "gone.md"));
      const r2 = await run();
      expect(r2.destinations[0]?.status).toBe("ok");
      const top = (await fsx.list(root)).map((e) => e.name).sort();
      expect(top).toEqual([".multi-backup", "a.md", "中文"]);
      expect((await fsx.list(`${root}/中文`)).map((e) => e.name)).toEqual(["笔记 2.md"]);
      expect(new TextDecoder().decode(await fsx.readFile(`${root}/a.md`))).toBe("A2");
      expect((await fsx.list(`${root}/.multi-backup/versions/a.md`)).length).toBe(1);
      expect((await fsx.list(`${root}/.multi-backup/trash`)).length).toBe(1);
      // 恢复来源：当前备份与 a.md 被覆盖前的版本
      const src = mirror().restoreSource();
      expect([...(await src.files("current")).keys()].sort()).toEqual(["a.md", "中文/笔记 2.md"]);
      const vers = await src.fileVersions("a.md", 10);
      expect(vers.map((v) => v.pointId.slice(0, 2))).toEqual(["cu", "v:"]);
      expect(new TextDecoder().decode(await src.read(vers[1]!.pointId, "a.md"))).toBe("A1");
      await fsx.removeDir(root);
    });

    it("主同步端：两台设备交替修改后一致，两边都改了保留两份", async () => {
      const fsx = make();
      const root = `/primary-${Date.now().toString(36)}-${++n}`;
      const device = (dev: string) => {
        const dir = path.join(tmp.dir, dev);
        let base = new Map<string, BaseEntry>();
        return {
          dir,
          async sync(t = new Date()) {
            await fs.mkdir(dir, { recursive: true });
            const store = new LocalMirror(fsx, { root, deletePolicy: "trash30", keepVersions: 10, createRoot: true }).asPrimary();
            await store.prepare();
            const vault = new NodeVaultFs(dir);
            const scan = await scanVault(vault, { matcher: matcher(), maxFileSize: 1 << 30, previous: { version: 1, updatedAt: 0, files: {} } });
            const res = await syncTwoWay({ vault, writer: new NodeVaultWriter(dir), store, local: scan.files, base, remote: await store.list(), matches: (d, id, p) => store.matches(d, id, p), remoteDevice: () => "other", now: () => t });
            await store.finish(t);
            base = res.base;
            return res;
          },
        };
      };
      const a = device("a");
      const b = device("b");
      await writeText(path.join(a.dir, "n.md"), "v1");
      await writeText(path.join(a.dir, "x.md"), "X");
      await a.sync();
      await b.sync();
      expect(await readText(path.join(b.dir, "x.md"))).toBe("X");
      await writeText(path.join(b.dir, "n.md"), "B 改的");
      await removePath(path.join(b.dir, "x.md"));
      await b.sync();
      await writeText(path.join(a.dir, "n.md"), "A 改的");
      const r = await a.sync(new Date(2026, 9, 31, 16, 0));
      expect(r.conflicts).toMatchObject([{ path: "n.md", kind: "both" }]);
      expect(await fs.stat(path.join(a.dir, "x.md")).then(() => true, () => false)).toBe(false);
      await b.sync();
      expect(await readText(path.join(b.dir, "n.md"))).toBe("A 改的");
      expect(await readText(path.join(b.dir, "n.conflict-other-2026-10-31-1600.md"))).toBe("B 改的");
      await fsx.removeDir(root);
    });

    it("密码不对：报“用户名或密码不对”", async () => {
      const bad =
        name === "WebDAV"
          ? new WebDavFs({ url: DAV, username: "mbtest", password: "wrong-password", http: nodeFetchHttp })
          : new S3Fs({ endpoint: S3, region: "us-east-1", bucket: BUCKET, accessKeyId: "mbtest", secretAccessKey: "wrong-secret", pathStyle: true, http: nodeFetchHttp });
      const err: unknown = await new LocalMirror(bad, { root: "/x", deletePolicy: "trash30", keepVersions: 1, createRoot: true }).test().catch((e: unknown) => e);
      expect(["auth-failed", "no-permission"]).toContain((err as { code?: string }).code);
    });
  });
}
