// 集成测试：对 Docker 里真实的 Gitea 推送。由 scripts/test-services.sh 启动服务并传入账号；没有设置时整组跳过。
// 令牌在测试开始时通过 Gitea 接口生成，只在内存里使用。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import nodeHttp from "isomorphic-git/http/node";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup } from "../../src/core/sync";
import { buildConfig, configPath, encodeConfig, parseConfig } from "../../src/core/config-backup";
import { mergeSettings } from "../../src/settings";
import { RemoteGit, type RemoteGitOptions } from "../../src/destinations/remote-git";
import { adapterGitFs } from "../../src/platform/adapter-git-fs";
import { MemoryAdapter } from "../support/memory-adapter";
import { makeTmp, MemoryState, NodeVaultFs, path, renamePath, writeText } from "../support/node";

const URL_ = process.env.MB_GITEA_URL ?? "";
const USER = process.env.MB_GITEA_USER ?? "";
const PASSWORD = process.env.MB_GITEA_PASSWORD ?? "";
const basic = "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64");

let writeToken = "";
let readToken = "";
let tmp: Awaited<ReturnType<typeof makeTmp>>;
let vaultDir: string;
let state: MemoryState;
let repo = "";
let n = 0;

async function api(method: string, p: string, body?: unknown, auth = basic): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await globalThis.fetch(`${URL_}/api/v1${p}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function token(scopes: string[]): Promise<string> {
  const r = await api("POST", `/users/${USER}/tokens`, { name: `mb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, scopes });
  expect(r.status).toBe(201);
  return r.json.sha1 as string;
}

/** 从 Gitea 读出分支上的文件内容；不存在时返回 null */
async function content(file: string): Promise<string | null> {
  const p = file.split("/").map(encodeURIComponent).join("/");
  const r = await globalThis.fetch(`${URL_}/api/v1/repos/${USER}/${repo}/raw/${p}?ref=main`, { headers: { Authorization: basic } });
  return r.status === 200 ? await r.text() : null;
}

/** Gitea 在推送后异步更新数据库，立刻查询可能还是旧的：最多等 10 秒，直到读到期望的值 */
async function eventually<T>(read: () => Promise<T>, want: T): Promise<T> {
  let v = await read();
  for (let i = 0; i < 40 && v !== want; i++) {
    await new Promise((r) => setTimeout(r, 250));
    v = await read();
  }
  return v;
}

async function commits(): Promise<number> {
  const r = await globalThis.fetch(`${URL_}/api/v1/repos/${USER}/${repo}/commits?sha=main&limit=50`, { headers: { Authorization: basic } });
  return r.status === 200 ? ((await r.json()) as unknown[]).length : 0;
}

describe.skipIf(!URL_)("Gitea 集成测试", () => {
  beforeAll(async () => {
    writeToken = await token(["write:repository", "write:user"]);
    readToken = await token(["read:repository", "read:user"]);
  });

  beforeEach(async () => {
    tmp = await makeTmp();
    vaultDir = path.join(tmp.dir, "vault");
    state = new MemoryState();
    repo = `mb-it-${Date.now().toString(36)}-${++n}`;
    expect((await api("POST", "/user/repos", { name: repo, private: true, auto_init: false })).status).toBe(201);
    for (const [p, t] of Object.entries({ "Welcome.md": "# 你好", "Daily/2026-10-31.md": "今天写插件" })) await writeText(path.join(vaultDir, ...p.split("/")), t);
  });
  afterEach(() => tmp.cleanup());

  const opts = (o: Partial<RemoteGitOptions> = {}): RemoteGitOptions => ({
    gitdir: ".obsidian/plugins/multi-backup/repos/it",
    url: `${URL_}/${USER}/${repo}.git`,
    branch: "main",
    username: USER,
    token: writeToken,
    vaultName: "Gitea IT",
    message: "Backup {date} {time}",
    author: { name: "Multi Backup", email: "multi-backup@localhost" },
    ...o,
  });
  const mem = () => adapterGitFs(new MemoryAdapter().asAdapter());
  const backup = async (gitFs = mem(), o?: Partial<RemoteGitOptions>) =>
    (await runBackup(
      {
        vault: new NodeVaultFs(vaultDir),
        state,
        matcher: new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true })),
        maxFileSize: 1 << 30,
      },
      [{ id: "it", store: new RemoteGit(gitFs, nodeHttp, opts(o)), extraExcludes: [] }],
    )).destinations[0];

  it("测试连接：空仓库", async () => {
    expect(await new RemoteGit(mem(), nodeHttp, opts()).test()).toMatchObject({ remote: "empty" });
  });

  it("首次与增量推送，Gitea 上内容一致", async () => {
    const gitFs = mem();
    expect((await backup(gitFs))?.status).toBe("ok");
    expect(await eventually(() => content("Welcome.md"), "# 你好")).toBe("# 你好");
    expect(await eventually(() => content("Daily/2026-10-31.md"), "今天写插件")).toBe("今天写插件");

    await writeText(path.join(vaultDir, "Welcome.md"), "# 第二版");
    await renamePath(path.join(vaultDir, "Daily", "2026-10-31.md"), path.join(vaultDir, "Daily", "周五.md"));
    const r = await backup(gitFs);
    expect(r).toMatchObject({ status: "ok", uploaded: 1, moved: 1 });
    expect(await eventually(() => content("Welcome.md"), "# 第二版")).toBe("# 第二版");
    expect(await eventually(() => content("Daily/周五.md"), "今天写插件")).toBe("今天写插件");
    expect(await eventually(() => content("Daily/2026-10-31.md"), null)).toBeNull();
    expect(await eventually(commits, 2)).toBe(2);
  });

  it("恢复：新设备只有浅克隆，查看更早的提交时按需加深，能读出旧版本", async () => {
    const gitFs = mem();
    for (const v of ["# 第一版", "# 第二版", "# 第三版"]) {
      await writeText(path.join(vaultDir, "Welcome.md"), v, Date.now() + v.length * 1000);
      expect((await backup(gitFs))?.status).toBe("ok");
    }
    // 另一台设备：本机仓库是空的
    const src = new RemoteGit(mem(), nodeHttp, opts()).restoreSource();
    const pts = await src.points(10);
    expect(pts.length).toBe(3);
    const dec = (d: Uint8Array) => new TextDecoder().decode(d);
    expect(dec(await src.read(pts[2]!.id, "Welcome.md"))).toBe("# 第一版");
    expect(dec(await src.read(pts[0]!.id, "Welcome.md"))).toBe("# 第三版");
    expect([...(await src.files(pts[0]!.id)).keys()].sort()).toEqual(["Daily/2026-10-31.md", "Welcome.md"]);
    expect((await src.fileVersions("Welcome.md", 10)).length).toBe(3);
    expect((await src.fileVersions("Daily/2026-10-31.md", 10)).map((v) => v.pointId)).toEqual([pts[2]!.id]);
  });

  it("插件配置随备份上传：另一台设备能读出来，内容不变时不再提交", async () => {
    const cfg = { path: configPath("书房电脑"), data: encodeConfig(buildConfig(mergeSettings({ excludes: "X/" }), "书房电脑", "0.5.0", 1)) };
    const gitFs = mem();
    const run = async () =>
      (await runBackup(
        { vault: new NodeVaultFs(vaultDir), state, matcher: new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true })), maxFileSize: 1 << 30 },
        [{ id: "it", store: new RemoteGit(gitFs, nodeHttp, opts()), extraExcludes: [], config: cfg }],
      )).destinations[0];
    expect((await run())?.status).toBe("ok");
    expect((await run())?.commit).toBeUndefined();
    const list = await new RemoteGit(mem(), nodeHttp, opts()).listConfigs();
    expect(list.map((d) => parseConfig(d)?.device)).toEqual(["书房电脑"]);
  });

  it("本机仓库放在磁盘上（桌面端的 Node fs）也能推送", async () => {
    const r = await backup(nodeFs, { gitdir: path.join(tmp.dir, "repos", "it") });
    expect(r?.status).toBe("ok");
    expect(await eventually(() => content("Welcome.md"), "# 你好")).toBe("# 你好");
  });

  it("只读令牌：测试连接提示没有推送权限", async () => {
    await expect(new RemoteGit(mem(), nodeHttp, opts({ token: readToken })).test()).rejects.toMatchObject({ code: "no-permission" });
  });

  it("错误的令牌：提示令牌无效", async () => {
    await expect(new RemoteGit(mem(), nodeHttp, opts({ token: "0000000000000000000000000000000000000000" })).test()).rejects.toMatchObject({
      code: "auth-failed",
    });
  });

  it("仓库不存在：Gitea 对推送地址返回 403，提示没有权限并请检查地址", async () => {
    const err = await new RemoteGit(mem(), nodeHttp, opts({ url: `${URL_}/${USER}/no-such-repo.git` })).test().catch((e: unknown) => e);
    expect(["no-permission", "repo-not-found"]).toContain((err as { code?: string }).code);
  });
});
