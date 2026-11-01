// M2 验收（远程 Git 部分）：1000 篇笔记 + 50 个附件推送到本机的 HTTP Git 服务（git http-backend）。
// 本机仓库经 DataAdapter（内存实现）存放，和移动端的方式相同。结果见 tmp/accept-m2-remote/report.txt。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import nodeHttp from "isomorphic-git/http/node";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup, type DestinationResult } from "../../src/core/sync";
import { RemoteGit } from "../../src/destinations/remote-git";
import { adapterGitFs } from "../../src/platform/adapter-git-fs";
import { startGitServer, type GitServer } from "../support/git-server";
import { MemoryAdapter } from "../support/memory-adapter";
import { fs, MemoryState, NodeVaultFs, path, removePath, ROOT, writeText } from "../support/node";
import { SampleVault } from "../support/sample-vault";

const BASE = path.join(ROOT, "tmp", "accept-m2-remote");
const VAULT = path.join(BASE, "vault");
const TOKEN = "accept-token";
const REPORT: string[] = [];
const sample = new SampleVault();
const state = new MemoryState();
const mem = new MemoryAdapter();
let server: GitServer;
let clock = new Date(2026, 10, 1, 9, 0);

const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));

async function backup(label: string): Promise<{ r: DestinationResult; ms: number }> {
  const store = new RemoteGit(adapterGitFs(mem.asAdapter()), nodeHttp, {
    gitdir: ".obsidian/plugins/multi-backup/repos/remote",
    url: server.url("notes.git"),
    branch: "main",
    username: "",
    token: TOKEN,
    vaultName: "accept",
    message: "Backup {date} {time}",
    author: { name: "Multi Backup", email: "multi-backup@localhost" },
    now: () => clock,
  });
  const t0 = performance.now();
  const res = await runBackup({ vault: new NodeVaultFs(VAULT), state, matcher: matcher(), maxFileSize: 50 * 1024 * 1024, now: () => clock }, [
    { id: "remote", store, extraExcludes: [] },
  ]);
  const ms = performance.now() - t0;
  const r = res.destinations[0] as DestinationResult;
  REPORT.push(`${label}：用时 ${(ms / 1000).toFixed(2)} 秒；${r.status}，上传 ${r.uploaded}、移动 ${r.moved}、删除 ${r.deleted}；提交 ${r.commit ?? "无"}`);
  return { r, ms };
}

beforeAll(async () => {
  await removePath(BASE);
  await fs.mkdir(path.join(BASE, "server"), { recursive: true });
  server = await startGitServer(path.join(BASE, "server"), { token: TOKEN });
  await server.createRepo("notes.git");
  const bytes = await sample.generate(VAULT, 1000, 50);
  REPORT.push(`测试数据：1000 篇笔记 + 50 个附件，共 ${(bytes / 1024 / 1024).toFixed(1)} MB（推送到本机 HTTP Git 服务，不含真实网络耗时）`);
});

afterAll(async () => {
  await server.close();
  await fs.writeFile(path.join(BASE, "report.txt"), REPORT.join("\n") + "\n");
});

describe("M2 验收：远程 Git，1000 篇笔记", () => {
  it("首次推送：远程分支与 Vault 文件一致", async () => {
    const { r } = await backup("首次推送");
    expect(r.status).toBe("ok");
    const files = (await new NodeVaultFs(VAULT).listFiles(() => true)).map((f) => f.path).sort();
    expect(server.lsTree("notes.git", "main")).toEqual(files);
  });

  it("增量推送：改 10 篇、增 5 篇", async () => {
    clock = new Date(2026, 10, 1, 10, 0);
    const notes = (await new NodeVaultFs(VAULT).listFiles(() => true)).map((f) => f.path).filter((p) => p.endsWith(".md")).sort();
    for (const f of notes.slice(0, 10)) await fs.appendFile(path.join(VAULT, ...f.split("/")), "\n增量修改\n");
    for (let i = 1; i <= 5; i++) await writeText(path.join(VAULT, "Inbox", `新笔记 ${i}.md`), sample.note(3000 + i));
    const { r } = await backup("增量推送");
    expect(r).toMatchObject({ status: "ok", uploaded: 15 });
    expect(server.log("notes.git", "main")).toHaveLength(2);
  });

  it("没有变化：不推送", async () => {
    const { r } = await backup("无变化");
    expect(r.commit).toBeUndefined();
  });
});
