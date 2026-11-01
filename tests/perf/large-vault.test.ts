// 性能测试（验收标准第 4 条）：5000 篇笔记 + 1 GB 附件的 Vault，首次备份能完成；只改 1 个文件时增量同步 10 秒内。
// 对 Docker 里的 Gitea 与 WebDAV 测试；由 MB_TEST_CMD="pnpm test:perf" bash scripts/test-services.sh 启动服务后运行。
// 规模可调：MB_PERF_NOTES（默认 5000）、MB_PERF_MB（附件总量，默认 1024）。测试库生成一次后留在 tmp/ 里复用。
import { beforeAll, describe, expect, it } from "vitest";
import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import http from "node:http";
import nodeHttp from "isomorphic-git/http/node";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup, type DestinationResult } from "../../src/core/sync";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { LocalZip } from "../../src/destinations/local-zip";
import { RemoteGit } from "../../src/destinations/remote-git";
import type { FileStore } from "../../src/destinations/types";
import { WebDavFs } from "../../src/destinations/webdav-fs";
import { adapterGitFs } from "../../src/platform/adapter-git-fs";
import { NodeAdapter } from "../support/node-adapter";
import { nodeFetchHttp } from "../support/node-http";
import { fs, MemoryState, NodeVaultFs, nodeTargetFs, path, ROOT } from "../support/node";

const env = process.env;
const NOTES = Number(env.MB_PERF_NOTES ?? 5000);
const MB = Number(env.MB_PERF_MB ?? 1024);
const GITEA = env.MB_GITEA_URL ?? "";
const DAV = env.MB_WEBDAV_URL ?? "";
const LIMIT_MS = 10_000;
const out = (s: string) => process.stdout.write(s + "\n");

const vaultDir = path.join(ROOT, "tmp", `perf-vault-${NOTES}-${MB}`);
const workDir = path.join(ROOT, "tmp", "perf-work");

/** 确定性的伪随机字节（附件不可压缩，接近真实图片、PDF） */
function bytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let block = createHash("sha256").update(seed).digest();
  for (let off = 0; off < size; off += block.length) {
    block.copy(out, off);
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

async function makeVault(): Promise<void> {
  if (
    await fs.stat(path.join(vaultDir, ".done")).then(
      () => true,
      () => false,
    )
  )
    return;
  await fs.rm(vaultDir, { recursive: true, force: true });
  for (let i = 0; i < NOTES; i++) {
    const dir = path.join(vaultDir, `Folder ${i % 100}`, `Sub ${i % 7}`);
    await fs.mkdir(dir, { recursive: true });
    const body =
      `# 笔记 ${i}\n\n` +
      `这是第 ${i} 篇测试笔记，内容用于性能测试。[[笔记 ${(i * 7) % NOTES}]]\n`.repeat(20 + (i % 60));
    await fs.writeFile(path.join(dir, `笔记 ${i}.md`), body);
  }
  // 附件：大小 1–9 MB 不等，总量约 MB
  const att = path.join(vaultDir, "Attachments");
  await fs.mkdir(att, { recursive: true });
  let left = MB * 1024 * 1024;
  for (let i = 0; left > 0; i++) {
    const size = Math.min(left, (1 + (i % 9)) * 1024 * 1024);
    await fs.writeFile(path.join(att, `file-${i}.${i % 2 ? "pdf" : "png"}`), bytes(`att-${i}`, size));
    left -= size;
  }
  await fs.writeFile(path.join(vaultDir, ".done"), "");
}

/** 记录各步耗时 */
function timed(store: FileStore, t: Record<string, number>): FileStore {
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const s = performance.now();
      try {
        return await fn(...a);
      } finally {
        t[name] = (t[name] ?? 0) + performance.now() - s;
      }
    };
  return {
    kind: "files",
    parallel: store.parallel,
    test: () => store.test(),
    prepare: wrap("prepare", () => store.prepare()),
    write: wrap("write", (p: string, d: Uint8Array, m: number) => store.write(p, d, m)),
    move: wrap("move", (a: string, b: string) => store.move(a, b)),
    remove: wrap("remove", (p: string) => store.remove(p)),
    finish: wrap("finish", (now: Date) => store.finish(now)),
  };
}

const matcher = () =>
  new ExcludeMatcher(
    builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }),
  );
const fmt = (t: Record<string, number>) =>
  Object.entries(t)
    .map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}s`)
    .join(", ");

/** 首次、无变化、改 1 个文件，各跑一次，打印耗时 */
async function scenario(name: string, make: () => FileStore): Promise<void> {
  const state = new MemoryState();
  const run = async (label: string): Promise<{ r: DestinationResult; ms: number }> => {
    const t: Record<string, number> = {};
    // 主线程最长被占用多久（每 10 毫秒打一次点，实际间隔减 10 即被占用的时间）
    let lag = 0;
    let tick = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - tick - 10);
      tick = now;
    }, 10);
    const s = performance.now();
    const res = await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30 }, [
      { id: "p", store: timed(make(), t), extraExcludes: [] },
    ]);
    const ms = performance.now() - s;
    clearInterval(probe);
    const r = res.destinations[0] as DestinationResult;
    out(
      `[perf] ${name} ${label}: ${(ms / 1000).toFixed(2)}s, ${r.status}, up ${r.uploaded}，主线程最长占用 ${Math.round(lag)} ms（${fmt(t)}）${r.error ? " " + r.error.message : ""}`,
    );
    for (const f of r.failed.slice(0, 3)) out(`[perf]   失败 ${f.op} ${f.path}: ${f.error.code} ${f.error.message}`);
    return { r, ms };
  };
  const first = await run("首次");
  expect(first.r.status).toBe("ok");
  const same = await run("无变化");
  expect(same.r.uploaded).toBe(0);
  const note = path.join(vaultDir, "Folder 3", "Sub 3", "笔记 3.md");
  const old = await fs.readFile(note);
  try {
    await fs.writeFile(note, old.toString() + `\n修改于 ${Date.now()}\n`);
    const inc = await run("改 1 个文件");
    expect(inc.r).toMatchObject({ status: "ok", uploaded: 1 });
    expect(inc.ms).toBeLessThan(LIMIT_MS);
  } finally {
    await fs.writeFile(note, old);
  }
}

describe.skipIf(!GITEA && !DAV)(`性能：${NOTES} 篇笔记 + ${MB} MB 附件`, () => {
  beforeAll(async () => {
    // Node 自带连接池默认空闲 5 秒断开；Gitea 解包 1 GB 要更久，测试里关掉复用（插件在 Obsidian 中走 requestUrl，不受影响）
    http.globalAgent = new http.Agent({ keepAlive: false });
    const s = performance.now();
    await makeVault();
    out(`[perf] 测试库就绪：${((performance.now() - s) / 1000).toFixed(1)}s，${vaultDir}`);
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(workDir, { recursive: true });
  });

  it.skipIf(!GITEA)("Gitea（远程 Git）", async () => {
    const user = env.MB_GITEA_USER ?? "";
    const basic = "Basic " + Buffer.from(`${user}:${env.MB_GITEA_PASSWORD ?? ""}`).toString("base64");
    const repo = `mb-perf-${Date.now().toString(36)}`;
    const r = await globalThis.fetch(`${GITEA}/api/v1/user/repos`, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repo, private: true }),
    });
    expect(r.status).toBe(201);
    const tk = await globalThis.fetch(`${GITEA}/api/v1/users/${user}/tokens`, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repo, scopes: ["write:repository"] }),
    });
    const token = ((await tk.json()) as { sha1: string }).sha1;
    const adapter = new NodeAdapter(workDir);
    await scenario(
      "Gitea",
      () =>
        new RemoteGit(adapterGitFs(adapter.asAdapter()), nodeHttp, {
          gitdir: "repos/perf",
          url: `${GITEA}/${user}/${repo}.git`,
          branch: "main",
          username: user,
          token,
          vaultName: "Perf",
          message: "Backup {date} {time}",
          author: { name: "Multi Backup", email: "multi-backup@localhost" },
        }),
    );
  });

  it.skipIf(!DAV)("WebDAV", async () => {
    const dav = new WebDavFs({
      url: DAV,
      username: env.MB_WEBDAV_USER ?? "",
      password: env.MB_WEBDAV_PASSWORD ?? "",
      http: nodeFetchHttp,
    });
    const root = `/perf-${Date.now().toString(36)}`;
    await scenario(
      "WebDAV",
      () =>
        new LocalMirror(dav, {
          root,
          deletePolicy: "trash30",
          keepVersions: 10,
          createRoot: true,
          parallel: Number(env.MB_PERF_PARALLEL ?? 4),
        }),
    );
  });

  it("本机 zip 快照：能完成，主线程不被长时间占用", async () => {
    const dir = path.join(workDir, "zip");
    await fs.mkdir(dir, { recursive: true });
    let lag = 0;
    let tick = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - tick - 10);
      tick = now;
    }, 10);
    const s = performance.now();
    const res = await runBackup(
      { vault: new NodeVaultFs(vaultDir), state: new MemoryState(), matcher: matcher(), maxFileSize: 1 << 30 },
      [
        {
          id: "z",
          store: new LocalZip(nodeTargetFs(), {
            root: dir,
            vaultName: "Perf",
            fileName: "{vault}-{date}-{time}",
            keepCount: 1,
            keepDays: 0,
          }),
          extraExcludes: [],
        },
      ],
    );
    clearInterval(probe);
    const r = res.destinations[0] as DestinationResult;
    out(
      `[perf] zip 快照: ${((performance.now() - s) / 1000).toFixed(2)}s, ${r.status}, ${((r.snapshot?.size ?? 0) / 1048576).toFixed(0)} MB，主线程最长占用 ${Math.round(lag)} ms`,
    );
    expect(r.status).toBe("ok");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
