import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import { execFileSync } from "node:child_process";
import nodeHttp from "isomorphic-git/http/node";
import type { HttpClient, PromiseFsClient } from "isomorphic-git";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup } from "../../src/core/sync";
import { RemoteGit, type RemoteGitOptions } from "../../src/destinations/remote-git";
import { adapterGitFs } from "../../src/platform/adapter-git-fs";
import { startGitServer, type GitServer } from "../support/git-server";
import { MemoryAdapter } from "../support/memory-adapter";
import { fs, makeTmp, MemoryState, NodeVaultFs, path, removePath, renamePath, writeText } from "../support/node";

const TOKEN = "test-token-1234";
let server: GitServer;
let serverTmp: Awaited<ReturnType<typeof makeTmp>>;
let tmp: Awaited<ReturnType<typeof makeTmp>>;
let vaultDir: string;
let state: MemoryState;
let clock: Date;
let repo = "";
let n = 0;

beforeAll(async () => {
  serverTmp = await makeTmp();
  server = await startGitServer(serverTmp.dir, { token: TOKEN, readonlyToken: "readonly-token" });
});
afterAll(async () => {
  await server.close();
  await serverTmp.cleanup();
});

beforeEach(async () => {
  tmp = await makeTmp();
  vaultDir = path.join(tmp.dir, "vault");
  state = new MemoryState();
  clock = new Date(2026, 9, 31, 10, 0);
  repo = `r${++n}.git`;
  await server.createRepo(repo);
  const files: Record<string, string> = { "Welcome.md": "# 你好", "Daily/2026-10-31.md": "今天写插件", "Attachments/pic.png": "PNG" };
  for (const [p, t] of Object.entries(files)) await writeText(path.join(vaultDir, ...p.split("/")), t, new Date(2026, 9, 1).getTime());
});
afterEach(() => tmp.cleanup());

const opts = (o: Partial<RemoteGitOptions> = {}): RemoteGitOptions => ({
  gitdir: path.join(tmp.dir, "plugin", "repos", "g1"),
  url: server.url(repo),
  branch: "main",
  username: "",
  token: TOKEN,
  vaultName: "Test Vault",
  message: "{vault} {date} {time}",
  author: { name: "Multi Backup", email: "multi-backup@localhost" },
  now: () => clock,
  ...o,
});
const store = (o?: Partial<RemoteGitOptions>, gitFs: PromiseFsClient = nodeFs) => new RemoteGit(gitFs, nodeHttp, opts(o));
const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
const backup = async (o?: Partial<RemoteGitOptions>) =>
  (await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => clock }, [{ id: "g1", store: store(o), extraExcludes: [] }]))
    .destinations[0];

/** 模拟别的设备直接往远程推了一个提交 */
async function pushFromElsewhere(file: string, text: string): Promise<void> {
  const work = path.join(tmp.dir, "elsewhere");
  const g = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=other", "-c", "user.email=o@x", ...args], { encoding: "utf8" });
  if (!nodeFs.existsSync(work)) execFileSync("git", ["clone", "-q", path.join(serverTmp.dir, repo), work]);
  else g("pull", "-q", "origin", "main");
  await writeText(path.join(work, ...file.split("/")), text);
  g("add", "-A");
  g("commit", "-q", "-m", "from elsewhere");
  g("push", "-q", "origin", "HEAD:main");
}

describe("远程 Git", () => {
  it("测试连接：空仓库", async () => {
    expect(await store().test()).toMatchObject({ remote: "empty", isRepo: false });
  });

  it("首次备份：一次提交推送到远程，内容与 Vault 一致", async () => {
    const r = await backup();
    expect(r?.status).toBe("ok");
    expect(r?.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(server.lsTree(repo, "main")).toEqual(["Attachments/pic.png", "Daily/2026-10-31.md", "Welcome.md"]);
    expect(server.show(repo, "main", "Welcome.md")).toBe("# 你好");
    expect(server.log(repo, "main")).toEqual(["Test Vault 2026-10-31 10:00"]);
    expect(await store().test()).toMatchObject({ remote: "branch" });
  });

  it("增量备份：修改、改名、删除合成第二次提交", async () => {
    await backup();
    await writeText(path.join(vaultDir, "Welcome.md"), "# 你好，第二版");
    await renamePath(path.join(vaultDir, "Daily", "2026-10-31.md"), path.join(vaultDir, "Daily", "周五.md"));
    await removePath(path.join(vaultDir, "Attachments"));
    clock = new Date(2026, 9, 31, 11, 30);
    const r = await backup();
    expect([r?.uploaded, r?.moved, r?.deleted]).toEqual([1, 1, 1]);
    expect(server.lsTree(repo, "main")).toEqual(["Daily/周五.md", "Welcome.md"]);
    expect(server.show(repo, "main", "Welcome.md")).toBe("# 你好，第二版");
    expect(server.log(repo, "main")).toHaveLength(2);
  });

  it("没有变化时不提交、不推送", async () => {
    await backup();
    const r = await backup();
    expect(r?.commit).toBeUndefined();
    expect(server.log(repo, "main")).toHaveLength(1);
  });

  it("仓库里原有的文件保留，备份写在旁边", async () => {
    await pushFromElsewhere("README.md", "原有内容");
    const r = await backup();
    expect(r?.status).toBe("ok");
    expect(server.lsTree(repo, "main")).toEqual(["Attachments/pic.png", "Daily/2026-10-31.md", "README.md", "Welcome.md"]);
    expect(server.log(repo, "main")).toEqual(["Test Vault 2026-10-31 10:00", "from elsewhere"]);
  });

  it("两次同步之间远程被别处推进：把本次改动放到最新提交上再推送", async () => {
    await backup();
    await pushFromElsewhere("Other.md", "别的设备写的");
    await writeText(path.join(vaultDir, "New.md"), "新笔记");
    const r = await backup();
    expect(r?.status).toBe("ok");
    expect(server.lsTree(repo, "main")).toContain("Other.md");
    expect(server.lsTree(repo, "main")).toContain("New.md");
    expect(server.log(repo, "main")).toHaveLength(3);
  });

  it("推送失败时不记为已同步，修好后下次同步补推", async () => {
    const bad = await backup({ token: "wrong-token" });
    expect(bad).toMatchObject({ status: "failed", error: { code: "auth-failed" } });
    const r = await backup();
    expect(r?.status).toBe("ok");
    expect(server.lsTree(repo, "main")).toHaveLength(3);
  });

  it("推送那一步才失败（只读令牌能拉取、不能推送）：不记为已同步，换好令牌后全部补推", async () => {
    const bad = await backup({ token: "readonly-token" });
    expect(bad).toMatchObject({ status: "failed", error: { code: "no-permission" } });
    const r = await backup();
    expect(r).toMatchObject({ status: "ok", uploaded: 3 });
    expect(server.lsTree(repo, "main")).toHaveLength(3);
  });

  it("服务器拒绝更新分支（例如分支保护）：报“推送被拒绝”，不记为已同步", async () => {
    const hook = path.join(serverTmp.dir, repo, "hooks", "pre-receive");
    await fs.writeFile(hook, ["#!/bin/sh", "echo protected branch >&2", "exit 1", ""].join("\n"));
    await fs.chmod(hook, 0o755);
    const bad = await backup();
    expect(bad).toMatchObject({ status: "failed", error: { code: "push-rejected" } });
    await fs.rm(hook);
    const r = await backup();
    expect(r).toMatchObject({ status: "ok", uploaded: 3 });
  });

  it.each([
    ["令牌无效", { token: "wrong-token" }, "auth-failed"],
    ["没有推送权限", { token: "readonly-token" }, "no-permission"],
    ["找不到仓库", { url: "" }, "repo-not-found"],
    ["网络不通", { url: "http://127.0.0.1:1/x.git" }, "network"],
  ])("测试连接失败：%s", async (_name, o, code) => {
    const over = { ...o } as Partial<RemoteGitOptions>;
    if (over.url === "") over.url = server.url("missing.git");
    await expect(store(over).test()).rejects.toMatchObject({ code });
  });

  it("没有选择令牌时直接提示，不连网络", async () => {
    await expect(store({ token: "" }).prepare()).rejects.toMatchObject({ code: "no-token" });
  });

  it("经 DataAdapter 存放本机仓库（移动端用的方式）：首次与增量都能推送", async () => {
    const mem = new MemoryAdapter();
    const gitFs = adapterGitFs(mem.asAdapter());
    const run = async () =>
      (await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => clock }, [
        { id: "g1", store: store({ gitdir: ".obsidian/plugins/multi-backup/repos/g1" }, gitFs), extraExcludes: [] },
      ])).destinations[0];
    expect((await run())?.status).toBe("ok");
    await pushFromElsewhere("Other.md", "别的设备写的");
    await writeText(path.join(vaultDir, "Welcome.md"), "改过");
    const r = await run();
    expect(r).toMatchObject({ status: "ok", uploaded: 1 });
    expect(server.lsTree(repo, "main")).toEqual(["Attachments/pic.png", "Daily/2026-10-31.md", "Other.md", "Welcome.md"]);
    expect(server.show(repo, "main", "Welcome.md")).toBe("改过");
    expect([...mem.files.keys()].every((k) => k.startsWith(".obsidian/plugins/multi-backup/repos/g1/"))).toBe(true);
  });

  it("手机上偶尔写出空文件（M2-1 实测）：自动重写，推送成功；之前留下的空对象也会修好", async () => {
    const mem = new MemoryAdapter();
    const gitdir = ".obsidian/plugins/multi-backup/repos/g1";
    const run = async () =>
      (await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => clock }, [
        { id: "g1", store: store({ gitdir }, adapterGitFs(mem.asAdapter())), extraExcludes: [] },
      ])).destinations[0];
    // 每 5 次写入丢一次
    mem.dropWrite = (_p, n) => n % 5 === 0;
    expect((await run())?.status).toBe("ok");
    expect(server.lsTree(repo, "main")).toHaveLength(3);
    expect([...mem.files.values()].some((f) => f.byteLength === 0)).toBe(false);

    // 模拟旧版本留下的空对象：把一个对象清空，改动文件后再同步
    mem.dropWrite = null;
    const obj = [...mem.files.keys()].find((k) => /objects\/[0-9a-f]{2}\//.test(k)) as string;
    mem.files.set(obj, new Uint8Array(0));
    await writeText(path.join(vaultDir, "Welcome.md"), "第三版");
    const r = await run();
    expect(r?.status).toBe("ok");
    expect(server.show(repo, "main", "Welcome.md")).toBe("第三版");
  });

  it("远程没变时用本机缓存的文件树：不拉取；改 1 个文件只发新对象", async () => {
    await backup();
    const posts: string[] = [];
    const sizes: number[] = [];
    const counting: HttpClient = {
      async request(req) {
        if (req.method === "POST") posts.push(req.url.slice(req.url.lastIndexOf("/") + 1));
        if (req.method === "POST" && Array.isArray(req.body)) sizes.push((req.body as Uint8Array[]).reduce((n, b) => n + b.byteLength, 0));
        return nodeHttp.request(req);
      },
    };
    const run = async () =>
      (await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => clock }, [{ id: "g1", store: new RemoteGit(nodeFs, counting, opts()), extraExcludes: [] }]))
        .destinations[0];
    expect((await run())?.commit).toBeUndefined();
    expect(posts).toEqual([]);
    await writeText(path.join(vaultDir, "Daily", "2026-10-31.md"), "改了一行");
    const r = await run();
    expect(r).toMatchObject({ status: "ok", uploaded: 1 });
    expect(posts).toEqual(["git-receive-pack"]);
    // 新对象：1 个文件 + Daily 与根两层目录 + 提交；Attachments 目录与其余文件不发
    expect(server.show(repo, "main", "Daily/2026-10-31.md")).toBe("改了一行");
    expect(server.lsTree(repo, "main")).toEqual(["Attachments/pic.png", "Daily/2026-10-31.md", "Welcome.md"]);
    expect(sizes[0]).toBeLessThan(1000);
  });

  it("新设备（本机没有缓存和对象）：拉取后读树，结果与远程一致", async () => {
    await backup();
    await writeText(path.join(vaultDir, "New.md"), "新");
    state = new MemoryState();
    const r = await backup({ gitdir: path.join(tmp.dir, "plugin", "repos", "fresh") });
    expect(r).toMatchObject({ status: "ok", uploaded: 1, identical: 3 });
    expect(server.lsTree(repo, "main")).toEqual(["Attachments/pic.png", "Daily/2026-10-31.md", "New.md", "Welcome.md"]);
  });

  it("缓存的文件树坏了：忽略缓存，重新读树", async () => {
    await backup();
    await fs.writeFile(path.join(tmp.dir, "plugin", "repos", "g1", "multi-backup-tree.json"), "{坏的");
    await writeText(path.join(vaultDir, "Welcome.md"), "第二版");
    expect(await backup()).toMatchObject({ status: "ok", uploaded: 1 });
    expect(server.lsTree(repo, "main")).toEqual(["Attachments/pic.png", "Daily/2026-10-31.md", "Welcome.md"]);
    expect(server.show(repo, "main", "Welcome.md")).toBe("第二版");
  });

  it("新写入的内容超过阈值时分批推送，最后的文件树完整", async () => {
    for (let i = 0; i < 6; i++) await writeText(path.join(vaultDir, "Big", `f${i}.bin`), String(i).repeat(1000));
    const r = await backup({ checkpointBytes: 2500 });
    expect(r?.status).toBe("ok");
    expect(server.log(repo, "main").length).toBeGreaterThan(1);
    expect(server.lsTree(repo, "main")).toHaveLength(9);
    expect(server.show(repo, "main", "Big/f5.bin")).toBe("5".repeat(1000));
    // 再同步一次：没有变化
    expect((await backup({ checkpointBytes: 2500 }))?.commit).toBeUndefined();
  });

  it("分批推送中途远程被别处推进：重放后推送，不丢改动", async () => {
    await backup();
    for (let i = 0; i < 4; i++) await writeText(path.join(vaultDir, "Big", `f${i}.bin`), String(i).repeat(1000));
    await pushFromElsewhere("Other.md", "别的设备");
    const r = await backup({ checkpointBytes: 1500 });
    expect(r?.status).toBe("ok");
    expect(server.lsTree(repo, "main")).toEqual(expect.arrayContaining(["Other.md", "Big/f0.bin", "Big/f3.bin", "Welcome.md"]));
  });

  it("本机只保存 git 对象，没有 Vault 文件的副本", async () => {
    await backup();
    const repoDir = path.join(tmp.dir, "plugin", "repos", "g1");
    const top = (await fs.readdir(repoDir)).sort();
    expect(top).not.toContain("Welcome.md");
    expect(top).toContain("objects");
  });
});

describe("远程 Git：恢复时选分支", () => {
  /** 另一台设备备份到分支 phone：在 main 的基础上改一个文件 */
  async function pushPhoneBranch(): Promise<void> {
    const work = path.join(tmp.dir, "phone");
    const g = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=phone", "-c", "user.email=p@x", ...args], { encoding: "utf8" });
    execFileSync("git", ["clone", "-q", path.join(serverTmp.dir, repo), work]);
    g("checkout", "-q", "-b", "phone");
    await writeText(path.join(work, "Welcome.md"), "# 手机上改的");
    g("commit", "-q", "-am", "from phone");
    g("push", "-q", "origin", "phone");
  }

  it("分支列表里设置的分支排第一；读取另一个分支的提交和文件，不影响之后的同步", async () => {
    await backup();
    await pushPhoneBranch();
    const src = store().restoreSource();
    expect(await src.points(20)).toHaveLength(1);
    expect(await src.branches?.()).toEqual(["main", "phone"]);
    expect(src.onBranch?.("main")).toBe(src);

    const phone = src.onBranch!("phone");
    const pts = await phone.points(20);
    expect(pts.map((p) => p.title)).toEqual(["from phone", "Test Vault 2026-10-31 10:00"]);
    expect(new TextDecoder().decode(await phone.read(pts[0]!.id, "Welcome.md"))).toBe("# 手机上改的");

    // 设置里的分支照常同步，phone 分支不受影响
    await writeText(path.join(vaultDir, "Welcome.md"), "# 电脑上改的");
    clock = new Date(2026, 9, 31, 11, 0);
    expect((await backup())?.status).toBe("ok");
    expect(server.show(repo, "main", "Welcome.md")).toBe("# 电脑上改的");
    expect(server.show(repo, "phone", "Welcome.md")).toBe("# 手机上改的");
  });

  it("只有一个分支时列表只有它", async () => {
    await backup();
    expect(await store().restoreSource().branches?.()).toEqual(["main"]);
  });
});
