// M1 验收：1000 篇笔记的测试 Vault，桌面端首次与增量备份（本地镜像 + zip 快照）。
// 生成的笔记写入 dev-vault/验收测试/ 并保留，便于之后在 Obsidian 中用真实界面复验。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup, type BackupResult, type DestinationRun } from "../../src/core/sync";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { LocalZip } from "../../src/destinations/local-zip";
import { fs, listTree, MemoryState, nodeTargetFs, NodeVaultFs, path, removePath, ROOT, writeText } from "../support/node";
import { SampleVault } from "../support/sample-vault";

const VAULT = path.join(ROOT, "dev-vault");
const SET = "验收测试";
const MIRROR = path.join(ROOT, "tmp", "accept-m1", "mirror");
const ZIPS = path.join(ROOT, "tmp", "accept-m1", "zips");
const REPORT: string[] = [];

const sample = new SampleVault();

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const userFiles = async (dir: string) => (await listTree(dir)).filter((f) => !f.startsWith(".multi-backup/"));

async function vaultFiles(): Promise<string[]> {
  const m = matcher();
  const v = new NodeVaultFs(VAULT);
  return (await v.listFiles((d) => !m.isExcludedDir(d))).map((f) => f.path).filter((p) => !m.isExcludedFile(p)).sort();
}

function matcher() {
  return new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
}

const state = new MemoryState();
let clock = new Date(2026, 9, 31, 18, 0);
const dests = (): DestinationRun[] => [
  { id: "mirror", store: new LocalMirror(nodeTargetFs(), { root: MIRROR, deletePolicy: "trash30", keepVersions: 10, now: () => clock }), extraExcludes: [] },
  { id: "zip", store: new LocalZip(nodeTargetFs(), { root: ZIPS, vaultName: "dev-vault", fileName: "{vault}_{date}_{time}.zip", keepCount: 30, keepDays: 90 }), extraExcludes: [] },
];

async function backup(label: string): Promise<BackupResult> {
  const t0 = performance.now();
  const r = await runBackup({ vault: new NodeVaultFs(VAULT), state, matcher: matcher(), maxFileSize: 50 * 1024 * 1024, now: () => clock }, dests());
  const ms = performance.now() - t0;
  const m = r.destinations[0];
  const z = r.destinations[1];
  REPORT.push(
    `${label}：用时 ${(ms / 1000).toFixed(2)} 秒；镜像 ${m?.status}，上传 ${m?.uploaded}、移动 ${m?.moved}、删除 ${m?.deleted}、失败 ${m?.failed.length}；快照 ${z?.status} ${z?.snapshot?.name ?? ""}（${((z?.snapshot?.size ?? 0) / 1024 / 1024).toFixed(1)} MB）`,
  );
  return r;
}

/** 镜像与 Vault 逐个文件比对哈希 */
async function assertMirrorEqualsVault(): Promise<number> {
  const files = await vaultFiles();
  expect(await userFiles(MIRROR)).toEqual(files);
  for (const f of files) {
    const a = await fs.readFile(path.join(VAULT, ...f.split("/")));
    const b = await fs.readFile(path.join(MIRROR, ...f.split("/")));
    expect(sha(b), f).toBe(sha(a));
  }
  return files.length;
}

beforeAll(async () => {
  await removePath(path.join(VAULT, SET));
  await removePath(path.join(ROOT, "tmp", "accept-m1"));
  await fs.mkdir(MIRROR, { recursive: true });
  await fs.mkdir(ZIPS, { recursive: true });
  const t0 = performance.now();
  const bytes = await sample.generate(path.join(VAULT, SET), 1000, 50);
  REPORT.push(`生成测试数据：1000 篇笔记 + 50 个附件，共 ${(bytes / 1024 / 1024).toFixed(1)} MB，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
});

afterAll(async () => {
  const out = path.join(ROOT, "tmp", "accept-m1", "report.txt");
  await fs.writeFile(out, REPORT.join("\n") + "\n");
  // 结果见 tmp/accept-m1/report.txt
});

describe("M1 验收：1000 篇笔记", () => {
  it("首次备份：镜像与 Vault 完全一致，快照包含全部文件", async () => {
    const r = await backup("首次备份");
    expect(r.destinations.map((d) => d.status)).toEqual(["ok", "ok"]);
    const n = await assertMirrorEqualsVault();
    REPORT.push(`首次备份核对：镜像中 ${n} 个文件与 Vault 逐个哈希一致`);
    const zipName = r.destinations[1]?.snapshot?.name as string;
    const entries = Object.keys(unzipSync(new Uint8Array(await fs.readFile(path.join(ZIPS, zipName))))).sort();
    expect(entries).toEqual(await vaultFiles());
    REPORT.push(`首次快照核对：zip 中 ${entries.length} 个文件，与 Vault 一致`);
  });

  it("增量备份：改 10、改名 5、删 5、增 5，只处理变化的文件", async () => {
    clock = new Date(2026, 9, 31, 19, 0);
    const notes = (await vaultFiles()).filter((f) => f.startsWith(`${SET}/`) && f.endsWith(".md"));
    const [edit, rename, del] = [notes.slice(0, 10), notes.slice(10, 15), notes.slice(15, 20)];
    for (const f of edit) await fs.appendFile(path.join(VAULT, ...f.split("/")), "\n\n增量修改：2026-10-31 19:00\n");
    for (const f of rename) await fs.rename(path.join(VAULT, ...f.split("/")), path.join(VAULT, ...f.replace(/\.md$/, " 已改名.md").split("/")));
    for (const f of del) await fs.rm(path.join(VAULT, ...f.split("/")));
    for (let i = 1; i <= 5; i++) await writeText(path.join(VAULT, SET, "Inbox", `新笔记 ${i}.md`), sample.note(2000 + i));

    const t0 = performance.now();
    const r = await backup("增量备份");
    const ms = performance.now() - t0;
    expect(r.destinations[0]).toMatchObject({ status: "ok", uploaded: 15, moved: 5, deleted: 5 });
    expect(r.destinations[1]?.status).toBe("ok");
    await assertMirrorEqualsVault();
    expect(await listTree(path.join(MIRROR, ".multi-backup", "trash", "2026-10-31"))).toHaveLength(5);
    const versions = (await listTree(path.join(MIRROR, ".multi-backup", "versions"))).length;
    expect(versions).toBe(10);
    REPORT.push(`增量备份核对：镜像与 Vault 一致；回收站 5 个文件；历史版本 10 个；用时 ${(ms / 1000).toFixed(2)} 秒`);
  });

  it("没有变化：镜像无操作，快照不重复生成", async () => {
    clock = new Date(2026, 9, 31, 19, 30);
    const r = await backup("无变化");
    expect(r.destinations[0]).toMatchObject({ status: "ok", uploaded: 0, moved: 0, deleted: 0 });
    expect(r.destinations[1]?.status).toBe("unchanged");
    expect((await listTree(ZIPS)).filter((f) => f.endsWith(".zip"))).toHaveLength(2);
  });
});
