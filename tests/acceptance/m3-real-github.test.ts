// M3 验收：真实 GitHub 仓库上的双设备双向同步（另一台设备是 Android 模拟器里的 Obsidian）。
// 令牌只从环境变量 MB_GITHUB_TOKEN 读取，不写入文件；没有设置时整组跳过。
// MB_STEP=1：作为新设备从主同步端初始化（下载全部），再改一个文件、新增一个文件并推送
// MB_STEP=2：再同步一次，取回另一台设备的修改和冲突副本
// 本机的 Vault 与同步状态保存在 tmp/m3-real/，两步之间保留。
import { describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import process from "node:process";
import nodeHttp from "isomorphic-git/http/node";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { DEVICES_FILE, runBackup } from "../../src/core/sync";
import { RemoteGit } from "../../src/destinations/remote-git";
import { parseBase, parseConflicts } from "../../src/platform/obsidian-state";
import { fs, listTree, MemoryState, NodeVaultFs, NodeVaultWriter, path, readText, ROOT, writeText } from "../support/node";

const TOKEN = process.env.MB_GITHUB_TOKEN ?? "";
const STEP = process.env.MB_STEP ?? "1";
const BASE = path.join(ROOT, "tmp", "m3-real");
const VAULT = path.join(BASE, "vault");
const STATE = path.join(BASE, "state.json");

async function syncOnce(label: string) {
  const state = new MemoryState();
  if (nodeFs.existsSync(STATE)) {
    const saved = JSON.parse(await fs.readFile(STATE, "utf8")) as { base: unknown; conflicts: unknown };
    state.bases.set("gh", parseBase(saved.base));
    state.conflicts = parseConflicts(saved.conflicts);
  }
  const git = new RemoteGit(nodeFs, nodeHttp, {
    gitdir: path.join(BASE, "repo"),
    url: "https://github.com/Hong-Da/multi-backup-test.git",
    branch: "main",
    username: "",
    token: TOKEN,
    vaultName: "pc",
    message: "Sync {date} {time}",
    author: { name: "Multi Backup", email: "multi-backup@localhost" },
  });
  const t0 = performance.now();
  const r = await runBackup(
    { vault: new NodeVaultFs(VAULT), state, matcher: new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true })), maxFileSize: 50 * 1024 * 1024 },
    [],
    { id: "gh", store: git.asPrimary(), extraExcludes: [], writer: new NodeVaultWriter(VAULT), device: "电脑-验收" },
  );
  const base = state.bases.get("gh") ?? new Map<string, unknown>();
  await fs.writeFile(STATE, JSON.stringify({ base: { version: 1, files: Object.fromEntries(base) }, conflicts: state.conflicts }));
  const d = r.destinations[0];
  out(`${label}: ${d?.status} up ${d?.uploaded} down ${d?.primary?.downloaded} delLocal ${d?.primary?.deletedLocal} conflicts ${d?.primary?.conflicts.length} commit ${d?.commit ?? "-"} ${((performance.now() - t0) / 1000).toFixed(1)}s ${d?.error?.message ?? ""}`);
  return d;
}

/** 验收过程输出到终端（不用 console，避免插件代码规范的检查） */
function out(line: string): void {
  process.stdout.write(line + "\n");
}

describe.skipIf(!TOKEN)("M3 验收：真实 GitHub 双设备", () => {
  it.runIf(STEP === "1")("第 1 步：新设备从主同步端初始化，然后修改并推送", async () => {
    await fs.rm(BASE, { recursive: true, force: true });
    await fs.mkdir(VAULT, { recursive: true });
    const init = await syncOnce("初始化");
    expect(init?.status).toBe("ok");
    expect((await listTree(VAULT)).length).toBeGreaterThan(1000);
    // 改一个文件（模拟器上也会改它 → 冲突），新增一个文件
    await writeText(path.join(VAULT, "Inbox", "phone-1.md"), "# phone note 1\n电脑上改的这一行\n");
    await writeText(path.join(VAULT, "Inbox", "电脑新建.md"), "电脑上新建的笔记\n");
    const push = await syncOnce("推送");
    expect(push?.status).toBe("ok");
    expect(push?.uploaded).toBe(2);
  });

  it.runIf(STEP === "2")("第 2 步：取回另一台设备的修改与冲突副本", async () => {
    const r = await syncOnce("取回");
    expect(r?.status).toBe("ok");
    const files = (await listTree(VAULT)).filter((f) => !f.startsWith(".trash/"));
    out("冲突副本：" + JSON.stringify(files.filter((f) => f.includes(".conflict-"))));
    out("手机新建：" + JSON.stringify(files.filter((f) => f.includes("手机新建"))));
    out("phone-1.md：" + JSON.stringify(await readText(path.join(VAULT, "Inbox", "phone-1.md"))));
    expect(files.some((f) => f.includes(".conflict-"))).toBe(true);
    void DEVICES_FILE;
  });
});
