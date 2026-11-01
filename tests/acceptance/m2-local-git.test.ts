// M2 验收（本地 git 部分）：1000 篇笔记 + 50 个附件，首次、增量、无变化三次备份到本地 git 仓库。
// 测试数据与仓库都在 tmp/accept-m2/，结果见 tmp/accept-m2/report.txt。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { listFiles, log, readBlob } from "isomorphic-git";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup, type DestinationResult } from "../../src/core/sync";
import { LocalGit } from "../../src/destinations/local-git";
import { fs, MemoryState, nodeTargetFs, NodeVaultFs, path, removePath, ROOT, writeText } from "../support/node";
import { SampleVault } from "../support/sample-vault";

const BASE = path.join(ROOT, "tmp", "accept-m2");
const VAULT = path.join(BASE, "vault");
const REPO = path.join(BASE, "repo");
const REPORT: string[] = [];
const sample = new SampleVault();
const state = new MemoryState();
let clock = new Date(2026, 10, 1, 9, 0);

const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function vaultFiles(): Promise<string[]> {
  const m = matcher();
  return (await new NodeVaultFs(VAULT).listFiles((d) => !m.isExcludedDir(d))).map((f) => f.path).filter((p) => !m.isExcludedFile(p)).sort();
}

async function backup(label: string): Promise<{ r: DestinationResult; ms: number }> {
  const store = new LocalGit(nodeTargetFs(), nodeFs, {
    root: REPO,
    vaultName: "accept-m2",
    message: "Backup {date} {time}",
    author: { name: "Multi Backup", email: "multi-backup@localhost" },
    now: () => clock,
  });
  const t0 = performance.now();
  const res = await runBackup({ vault: new NodeVaultFs(VAULT), state, matcher: matcher(), maxFileSize: 50 * 1024 * 1024, now: () => clock }, [
    { id: "git", store, extraExcludes: [] },
  ]);
  const ms = performance.now() - t0;
  const r = res.destinations[0] as DestinationResult;
  REPORT.push(`${label}：用时 ${(ms / 1000).toFixed(2)} 秒；${r.status}，上传 ${r.uploaded}、移动 ${r.moved}、删除 ${r.deleted}、失败 ${r.failed.length}；提交 ${r.commit ?? "无"}`);
  return { r, ms };
}

/** 最新提交里的文件与 Vault 逐个比对哈希 */
async function assertHeadEqualsVault(): Promise<number> {
  const files = await vaultFiles();
  expect((await listFiles({ fs: nodeFs, dir: REPO, ref: "HEAD" })).sort()).toEqual(files);
  const [head] = await log({ fs: nodeFs, dir: REPO, depth: 1 });
  for (const f of files) {
    const { blob } = await readBlob({ fs: nodeFs, dir: REPO, oid: head?.oid as string, filepath: f });
    expect(sha(blob), f).toBe(sha(await fs.readFile(path.join(VAULT, ...f.split("/")))));
  }
  return files.length;
}

beforeAll(async () => {
  await removePath(BASE);
  await fs.mkdir(REPO, { recursive: true });
  const t0 = performance.now();
  const bytes = await sample.generate(VAULT, 1000, 50);
  REPORT.push(`生成测试数据：1000 篇笔记 + 50 个附件，共 ${(bytes / 1024 / 1024).toFixed(1)} MB，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
});

afterAll(async () => {
  await fs.writeFile(path.join(BASE, "report.txt"), REPORT.join("\n") + "\n");
});

describe("M2 验收：本地 git 仓库，1000 篇笔记", () => {
  it("首次备份：一次提交，提交内容与 Vault 完全一致", async () => {
    const { r } = await backup("首次备份");
    expect(r.status).toBe("ok");
    expect(r.commit).toMatch(/^[0-9a-f]{7}$/);
    const n = await assertHeadEqualsVault();
    REPORT.push(`首次备份核对：提交中 ${n} 个文件与 Vault 逐个哈希一致`);
  });

  it("增量备份：改 10、改名 5、删 5、增 5，合成第二次提交", async () => {
    clock = new Date(2026, 10, 1, 10, 0);
    const notes = (await vaultFiles()).filter((f) => f.endsWith(".md"));
    const [edit, rename, del] = [notes.slice(0, 10), notes.slice(10, 15), notes.slice(15, 20)];
    for (const f of edit) await fs.appendFile(path.join(VAULT, ...f.split("/")), "\n\n增量修改：2026-11-01 10:00\n");
    for (const f of rename) await fs.rename(path.join(VAULT, ...f.split("/")), path.join(VAULT, ...f.replace(/\.md$/, " 已改名.md").split("/")));
    for (const f of del) await fs.rm(path.join(VAULT, ...f.split("/")));
    for (let i = 1; i <= 5; i++) await writeText(path.join(VAULT, "Inbox", `新笔记 ${i}.md`), sample.note(2000 + i));

    const { r, ms } = await backup("增量备份");
    expect(r).toMatchObject({ status: "ok", uploaded: 15, moved: 5, deleted: 5 });
    await assertHeadEqualsVault();
    const commits = await log({ fs: nodeFs, dir: REPO });
    expect(commits).toHaveLength(2);
    REPORT.push(`增量备份核对：共 ${commits.length} 次提交，最新提交与 Vault 一致；用时 ${(ms / 1000).toFixed(2)} 秒`);
  });

  it("没有变化：不产生新提交", async () => {
    clock = new Date(2026, 10, 1, 10, 30);
    const { r } = await backup("无变化");
    expect(r.commit).toBeUndefined();
    expect(await log({ fs: nodeFs, dir: REPO })).toHaveLength(2);
  });
});
