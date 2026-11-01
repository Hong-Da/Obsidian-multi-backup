import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import { init, listFiles, log, readBlob, commit as gitCommit, add as gitAdd } from "isomorphic-git";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { DestinationError } from "../../src/core/errors";
import { runBackup } from "../../src/core/sync";
import { LocalGit, type LocalGitOptions } from "../../src/destinations/local-git";
import { fs, makeTmp, MemoryState, nodeTargetFs, NodeVaultFs, path, readText, removePath, renamePath, writeText } from "../support/node";

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let vaultDir: string, repoDir: string;
let state: MemoryState;
let clock: Date;

beforeEach(async () => {
  tmp = await makeTmp();
  vaultDir = path.join(tmp.dir, "vault");
  repoDir = path.join(tmp.dir, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  state = new MemoryState();
  clock = new Date(2026, 9, 31, 10, 0);
  const files: Record<string, string> = {
    "Welcome.md": "# 你好",
    "Daily/2026-10-31.md": "今天写插件",
    "Attachments/pic.png": "PNG",
    ".obsidian/workspace.json": "{}",
  };
  for (const [p, t] of Object.entries(files)) await writeText(path.join(vaultDir, ...p.split("/")), t, new Date(2026, 9, 1).getTime());
});
afterEach(() => tmp.cleanup());

const opts = (o: Partial<LocalGitOptions> = {}): LocalGitOptions => ({
  root: repoDir,
  vaultName: "Test Vault",
  message: "{vault} {date} {time}",
  author: { name: "Multi Backup", email: "multi-backup@localhost" },
  now: () => clock,
  ...o,
});
const store = (o?: Partial<LocalGitOptions>) => new LocalGit(nodeTargetFs(), nodeFs, opts(o));
const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
const backup = async () =>
  (await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => clock }, [{ id: "g1", store: store(), extraExcludes: [] }]))
    .destinations[0];
const commits = () => log({ fs: nodeFs, dir: repoDir });
const tracked = async () => (await listFiles({ fs: nodeFs, dir: repoDir })).sort();
const blob = async (oid: string, filepath: string) => new TextDecoder().decode((await readBlob({ fs: nodeFs, dir: repoDir, oid, filepath })).blob);

describe("本地 git 仓库", () => {
  it("首次备份：初始化仓库并提交一次", async () => {
    const r = await backup();
    expect(r?.status).toBe("ok");
    expect(r?.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(await tracked()).toEqual(["Attachments/pic.png", "Daily/2026-10-31.md", "Welcome.md"]);
    const [c] = await commits();
    expect(c?.commit.message.trim()).toBe("Test Vault 2026-10-31 10:00");
    expect(c?.commit.author.name).toBe("Multi Backup");
    expect(c?.oid.startsWith(r?.commit as string)).toBe(true);
  });

  it("增量备份：修改、改名、删除合成一次提交，旧内容还能从上一次提交取回", async () => {
    await backup();
    await writeText(path.join(vaultDir, "Welcome.md"), "# 你好，第二版");
    await renamePath(path.join(vaultDir, "Daily", "2026-10-31.md"), path.join(vaultDir, "Daily", "周五.md"));
    await removePath(path.join(vaultDir, "Attachments"));
    clock = new Date(2026, 9, 31, 11, 30);

    const r = await backup();
    expect([r?.uploaded, r?.moved, r?.deleted]).toEqual([1, 1, 1]);
    expect(await tracked()).toEqual(["Daily/周五.md", "Welcome.md"]);
    const [latest, first] = await commits();
    expect(latest?.commit.message.trim()).toBe("Test Vault 2026-10-31 11:30");
    expect(await blob(latest?.oid as string, "Welcome.md")).toBe("# 你好，第二版");
    expect(await blob(first?.oid as string, "Welcome.md")).toBe("# 你好");
    expect(await blob(first?.oid as string, "Attachments/pic.png")).toBe("PNG");
  });

  it("没有变化时不提交", async () => {
    await backup();
    const r = await backup();
    expect(r?.commit).toBeUndefined();
    expect(await commits()).toHaveLength(1);
  });

  it("已有仓库：在原有历史后面继续提交", async () => {
    await init({ fs: nodeFs, dir: repoDir, defaultBranch: "main" });
    await writeText(path.join(repoDir, "README.md"), "old repo");
    await gitAdd({ fs: nodeFs, dir: repoDir, filepath: "README.md" });
    await gitCommit({ fs: nodeFs, dir: repoDir, message: "init", author: { name: "me", email: "me@example.com" } });

    await backup();
    const list = await commits();
    expect(list.map((c) => c.commit.message.trim())).toEqual(["Test Vault 2026-10-31 10:00", "init"]);
  });

  it("Vault 里的 .gitignore 不影响提交：按插件的排除规则备份", async () => {
    await writeText(path.join(vaultDir, ".gitignore"), "*.png\n");
    await backup();
    expect(await tracked()).toContain("Attachments/pic.png");
  });

  it("上次同步中途退出（写了文件没提交）：下次同步补提交", async () => {
    const s1 = store();
    await s1.prepare();
    await s1.write("Lost.md", new TextEncoder().encode("中途退出前写入"), clock.getTime());
    // 不调用 finish，模拟 Obsidian 被关掉

    const s2 = store();
    await s2.prepare();
    const fin = await s2.finish();
    expect(fin?.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(await tracked()).toEqual(["Lost.md"]);
    expect(await fs.stat(path.join(repoDir, ".git", "multi-backup-pending")).then(() => true, () => false)).toBe(false);
  });

  it("测试连接：显示提交数和最近一次提交时间", async () => {
    expect((await store().test()).existing).toBe(0);
    await backup();
    await writeText(path.join(vaultDir, "New.md"), "new");
    clock = new Date(2026, 9, 31, 12, 0);
    await backup();
    const info = await store().test();
    expect(info.existing).toBe(2);
    expect(info.newest).toBe(new Date(2026, 9, 31, 12, 0).getTime());
  });

  it("还不是 git 仓库时，测试连接说明第一次同步会创建", async () => {
    const info = await store().test();
    expect(info.isRepo).toBe(false);
    await backup();
    expect((await store().test()).isRepo).toBe(true);
  });

  it(".git 是文件（worktree 或子模块）时报“不支持的仓库”", async () => {
    await writeText(path.join(repoDir, ".git"), "gitdir: ../elsewhere/.git/worktrees/notes");
    await expect(store().prepare()).rejects.toMatchObject({ code: "unsupported-repo" });
    await expect(store().test()).rejects.toMatchObject({ code: "unsupported-repo" });
  });

  it("目标文件夹不存在时不创建，报“找不到”", async () => {
    const missing = path.join(tmp.dir, "unplugged-drive");
    await expect(store({ root: missing }).prepare()).rejects.toMatchObject({ code: "not-found" });
    await expect(store({ root: missing }).prepare()).rejects.toBeInstanceOf(DestinationError);
    expect(await fs.stat(missing).then(() => true, () => false)).toBe(false);
  });

  it("找变化时不遍历 .git（对象文件越积越多，遍历会越来越慢）", async () => {
    await backup();
    const seen: string[] = [];
    const spy = {
      promises: {
        ...nodeFs.promises,
        readdir: (p: string, ...rest: unknown[]) => {
          seen.push(p.split("\\").join("/"));
          return (nodeFs.promises.readdir as (p: string, ...r: unknown[]) => Promise<string[]>)(p, ...rest);
        },
      },
    };
    await writeText(path.join(vaultDir, "New.md"), "new");
    const r = (await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => clock }, [
      { id: "g1", store: new LocalGit(nodeTargetFs(), spy, opts()), extraExcludes: [] },
    ])).destinations[0];
    expect(r?.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((p) => p.includes("/.git/objects"))).toEqual([]);
  });

  it("工作区内容与 Vault 一致", async () => {
    await backup();
    expect(await readText(path.join(repoDir, "Daily", "2026-10-31.md"))).toBe("今天写插件");
  });
});
