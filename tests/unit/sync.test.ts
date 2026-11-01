import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup, type DestinationRun } from "../../src/core/sync";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { LocalZip } from "../../src/destinations/local-zip";
import { exists, fs, listTree, makeTmp, MemoryState, nodeTargetFs, NodeVaultFs, path, readText, removePath, renamePath, writeText } from "../support/node";

// 端到端：真实文件夹上的 Vault → 本地镜像 + zip 快照，首次与增量备份
let tmp: Awaited<ReturnType<typeof makeTmp>>;
let vaultDir: string, mirrorDir: string, zipDir: string;
let state: MemoryState;
let clock: Date;

beforeEach(async () => {
  tmp = await makeTmp();
  vaultDir = path.join(tmp.dir, "vault");
  mirrorDir = path.join(tmp.dir, "mirror");
  zipDir = path.join(tmp.dir, "zips");
  await fs.mkdir(mirrorDir, { recursive: true });
  await fs.mkdir(zipDir, { recursive: true });
  state = new MemoryState();
  clock = new Date(2026, 9, 31, 10, 0);
  const files: Record<string, string> = {
    "Welcome.md": "# 你好",
    "Daily/2026-10-31.md": "今天写插件",
    "Projects/Multi Backup/设计.md": "设计方案",
    "Attachments/pic.png": "PNG",
    ".obsidian/app.json": "{}",
    ".obsidian/workspace.json": "{\"layout\":1}",
    ".obsidian/plugins/multi-backup/data.json": "{}",
    ".trash/old.md": "old",
    "Archive/2019/x.md": "x",
  };
  for (const [p, t] of Object.entries(files)) await writeText(path.join(vaultDir, ...p.split("/")), t, new Date(2026, 9, 1).getTime());
});
afterEach(() => tmp.cleanup());

const matcher = () =>
  new ExcludeMatcher([...builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }), "Archive/"]);

function dests(): DestinationRun[] {
  return [
    { id: "m1", store: new LocalMirror(nodeTargetFs(), { root: mirrorDir, deletePolicy: "trash30", keepVersions: 10, now: () => clock }), extraExcludes: [] },
    { id: "z1", store: new LocalZip(nodeTargetFs(), { root: zipDir, vaultName: "Test Vault", fileName: "{vault}_{date}_{time}.zip", keepCount: 30, keepDays: 90 }), extraExcludes: ["Attachments/"] },
  ];
}
const backup = () => runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 50 * 1024 * 1024, now: () => clock }, dests());
const userFiles = async (dir: string) => (await listTree(dir)).filter((f) => !f.startsWith(".multi-backup/"));

describe("端到端备份", () => {
  it("首次备份：镜像与快照都包含应备份的文件，排除项不在其中", async () => {
    const r = await backup();
    expect(r.destinations.map((d) => d.status)).toEqual(["ok", "ok"]);
    const expected = [".obsidian/app.json", "Attachments/pic.png", "Daily/2026-10-31.md", "Projects/Multi Backup/设计.md", "Welcome.md"];
    expect(await userFiles(mirrorDir)).toEqual(expected);
    expect(await readText(path.join(mirrorDir, "Projects", "Multi Backup", "设计.md"))).toBe("设计方案");

    const zipName = r.destinations[1]?.snapshot?.name as string;
    const entries = Object.keys(unzipSync(new Uint8Array(await fs.readFile(path.join(zipDir, zipName))))).sort();
    expect(entries).toEqual(expected.filter((f) => !f.startsWith("Attachments/"))); // 快照有自己的额外排除
  });

  it("增量备份：只处理变化；重命名为移动；删除进回收站；覆盖留历史版本", async () => {
    await backup();
    clock = new Date(2026, 9, 31, 11, 0);
    await writeText(path.join(vaultDir, "Daily", "2026-10-31.md"), "今天写插件，下午写测试");
    await renamePath(path.join(vaultDir, "Welcome.md"), path.join(vaultDir, "Start here.md"));
    await removePath(path.join(vaultDir, "Attachments", "pic.png"));
    await writeText(path.join(vaultDir, "Inbox.md"), "新想法");

    const r = await backup();
    const m = r.destinations[0];
    expect(m).toMatchObject({ status: "ok", uploaded: 2, moved: 1, deleted: 1 });
    expect(await userFiles(mirrorDir)).toEqual([".obsidian/app.json", "Daily/2026-10-31.md", "Inbox.md", "Projects/Multi Backup/设计.md", "Start here.md"]);
    expect(await exists(path.join(mirrorDir, ".multi-backup", "trash", "2026-10-31", "Attachments", "pic.png"))).toBe(true);
    expect(await listTree(path.join(mirrorDir, ".multi-backup", "versions", "Daily", "2026-10-31.md"))).toEqual(["2026-10-31_110000.md"]);
    expect(r.destinations[1]?.status).toBe("ok"); // 快照：有变化，生成新快照
  });

  it("没有变化：镜像无操作，快照不生成新文件", async () => {
    await backup();
    clock = new Date(2026, 9, 31, 12, 0);
    const r = await backup();
    expect(r.destinations[0]).toMatchObject({ status: "ok", uploaded: 0, moved: 0, deleted: 0 });
    expect(r.destinations[1]?.status).toBe("unchanged");
    expect((await listTree(zipDir)).filter((f) => f.endsWith(".zip")).length).toBe(1);
  });

  it("一个目的地不可用：报 not-found，另一个照常完成；恢复后自动补上", async () => {
    await removePath(mirrorDir);
    const r = await backup();
    expect(r.destinations[0]?.status).toBe("failed");
    expect(r.destinations[0]?.error?.code).toBe("not-found");
    expect(r.destinations[1]?.status).toBe("ok");

    await fs.mkdir(mirrorDir, { recursive: true });
    const again = await backup();
    expect(again.destinations[0]).toMatchObject({ status: "ok", uploaded: 5 });
  });

  it("超过大小上限的文件跳过并列出", async () => {
    await writeText(path.join(vaultDir, "big.bin"), "0123456789");
    const r = await runBackup({ vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 8, now: () => clock }, dests());
    expect(r.skippedLarge.map((s) => s.path)).toContain("big.bin");
    expect(await exists(path.join(mirrorDir, "big.bin"))).toBe(false);
  });

  it("第二次扫描复用哈希缓存", async () => {
    await backup();
    expect(Object.keys(state.cache.files).length).toBe(5);
    const r = await backup();
    expect(r.destinations[0]?.uploaded).toBe(0);
  });
});
