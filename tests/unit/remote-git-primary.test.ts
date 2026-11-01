// 远程 Git 作为主同步端：两台设备（各自的 Vault 与本机仓库）经本机 HTTP Git 服务双向同步
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import nodeHttp from "isomorphic-git/http/node";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { scanVault } from "../../src/core/scanner";
import type { BaseEntry } from "../../src/core/sync-planner";
import { syncTwoWay, type ConflictRecord } from "../../src/core/two-way";
import { RemoteGit } from "../../src/destinations/remote-git";
import { startGitServer, type GitServer } from "../support/git-server";
import { listTree, makeTmp, NodeVaultFs, NodeVaultWriter, path, readText, removePath, writeText } from "../support/node";

const TOKEN = "primary-token";
let server: GitServer;
let serverTmp: Awaited<ReturnType<typeof makeTmp>>;
let tmp: Awaited<ReturnType<typeof makeTmp>>;
let repo = "";
let n = 0;

beforeAll(async () => {
  serverTmp = await makeTmp();
  server = await startGitServer(serverTmp.dir, { token: TOKEN });
});
afterAll(async () => {
  await server.close();
  await serverTmp.cleanup();
});
beforeEach(async () => {
  tmp = await makeTmp();
  repo = `p${++n}.git`;
  await server.createRepo(repo);
});
afterEach(() => tmp.cleanup());

class GitDevice {
  base = new Map<string, BaseEntry>();
  conflicts: ConflictRecord[] = [];
  readonly vaultDir: string;
  readonly writer: NodeVaultWriter;
  constructor(readonly name: string) {
    this.vaultDir = path.join(tmp.dir, name, "vault");
    this.writer = new NodeVaultWriter(this.vaultDir);
  }
  async sync(t = new Date(2026, 9, 31, 10, 42)) {
    await nodeFs.promises.mkdir(this.vaultDir, { recursive: true });
    const git = new RemoteGit(nodeFs, nodeHttp, {
      gitdir: path.join(tmp.dir, this.name, "repo"),
      url: server.url(repo),
      branch: "main",
      username: "",
      token: TOKEN,
      vaultName: this.name,
      message: "Sync {date} {time}",
      author: { name: this.name, email: "x@localhost" },
      now: () => t,
    });
    const store = git.asPrimary();
    await store.prepare();
    const matcher = new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
    const vault = new NodeVaultFs(this.vaultDir);
    const scan = await scanVault(vault, { matcher, maxFileSize: 1 << 30, previous: { version: 1, updatedAt: 0, files: {} } });
    const res = await syncTwoWay({
      vault,
      writer: this.writer,
      store,
      local: scan.files,
      base: this.base,
      remote: await store.list(),
      matches: (data, id) => git.matches(data, id),
      remoteDevice: () => (this.name === "pc" ? "phone" : "pc"),
      known: this.conflicts,
      now: () => t,
    });
    this.conflicts.push(...res.conflicts);
    await store.finish(t);
    this.base = res.base;
    return res;
  }
  files = async () => (await listTree(this.vaultDir)).filter((f) => !f.startsWith(".trash/"));
  text = (p: string) => readText(path.join(this.vaultDir, ...p.split("/")));
  write = (p: string, t: string) => writeText(path.join(this.vaultDir, ...p.split("/")), t);
  rm = (p: string) => removePath(path.join(this.vaultDir, ...p.split("/")));
}

describe("远程 Git 作为主同步端", () => {
  it("两台设备交替修改：新增、修改、删除都能同步，内容一致", async () => {
    const pc = new GitDevice("pc");
    const phone = new GitDevice("phone");
    await pc.write("a.md", "A1");
    await pc.write("dir/b.md", "B1");
    await pc.sync();
    await phone.sync();
    expect(await phone.files()).toEqual(["a.md", "dir/b.md"]);

    await phone.write("a.md", "A2");
    await phone.rm("dir/b.md");
    await phone.write("c.md", "C1");
    await phone.sync();
    await pc.sync();
    expect(await pc.files()).toEqual(["a.md", "c.md"]);
    expect(await pc.text("a.md")).toBe("A2");
    expect(server.lsTree(repo, "main")).toEqual(["a.md", "c.md"]);
  });

  it("两边都改了：保留两份，推到远程后另一台也有两份", async () => {
    const pc = new GitDevice("pc");
    const phone = new GitDevice("phone");
    await pc.write("note.md", "原文");
    await pc.sync();
    await phone.sync();
    await phone.write("note.md", "手机改的");
    await phone.sync();
    await pc.write("note.md", "电脑改的");
    const r = await pc.sync(new Date(2026, 9, 31, 14, 30));
    expect(r.conflicts).toMatchObject([{ kind: "both", copy: "note.conflict-phone-2026-10-31-1430.md" }]);
    await phone.sync();
    expect(await phone.text("note.md")).toBe("电脑改的");
    expect(await phone.text("note.conflict-phone-2026-10-31-1430.md")).toBe("手机改的");
  });

  it("推送时远程刚被另一台更新：这次失败，不覆盖对方；下次同步识别为冲突", async () => {
    const pc = new GitDevice("pc");
    const phone = new GitDevice("phone");
    await pc.write("n.md", "v1");
    await pc.sync();
    await phone.sync();
    // 电脑在同步过程中（prepare 之后、推送之前）手机推了新版本：用两步模拟
    await pc.write("n.md", "电脑版");
    await phone.write("n.md", "手机版");
    const pcGit = new RemoteGit(nodeFs, nodeHttp, {
      gitdir: path.join(tmp.dir, "pc", "repo"), url: server.url(repo), branch: "main", username: "", token: TOKEN,
      vaultName: "pc", message: "x", author: { name: "pc", email: "x@localhost" },
    });
    const store = pcGit.asPrimary();
    await store.prepare();
    await phone.sync(); // 手机先推上去
    await store.put("n.md", new TextEncoder().encode("电脑版"), 0);
    await expect(store.finish(new Date())).rejects.toMatchObject({ code: "remote-moved" });
    // 远程仍是手机版；电脑正常同步时得到冲突，两份都在
    expect(server.show(repo, "main", "n.md")).toBe("手机版");
    const r = await pc.sync();
    expect(r.conflicts).toMatchObject([{ path: "n.md", kind: "both" }]);
  });
});
