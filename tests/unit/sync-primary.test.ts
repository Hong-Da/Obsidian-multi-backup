// 一次同步：先与主同步端双向同步，再推到备份端
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { DEVICES_FILE, runBackup } from "../../src/core/sync";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { MemoryPrimary } from "../support/two-way-fixtures";
import { fs, listTree, makeTmp, MemoryState, nodeTargetFs, NodeVaultFs, NodeVaultWriter, path, writeText } from "../support/node";

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let vaultDir: string, mirrorDir: string;
let state: MemoryState;
let remote: MemoryPrimary;

beforeEach(async () => {
  tmp = await makeTmp();
  vaultDir = path.join(tmp.dir, "vault");
  mirrorDir = path.join(tmp.dir, "mirror");
  await fs.mkdir(mirrorDir, { recursive: true });
  await writeText(path.join(vaultDir, "local.md"), "本机的");
  state = new MemoryState();
  remote = new MemoryPrimary();
  remote.files.set("from-phone.md", { data: new TextEncoder().encode("手机上的"), id: "x1", by: "手机" });
  remote.files.set(DEVICES_FILE, { data: new TextEncoder().encode(JSON.stringify({ "from-phone.md": "手机" })), id: "d1", by: "手机" });
});
afterEach(() => tmp.cleanup());

const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
const run = () =>
  runBackup(
    { vault: new NodeVaultFs(vaultDir), state, matcher: matcher(), maxFileSize: 1 << 30, now: () => new Date(2026, 9, 31, 10, 0) },
    [{ id: "mirror", store: new LocalMirror(nodeTargetFs(), { root: mirrorDir, deletePolicy: "trash30", keepVersions: 10 }), extraExcludes: [] }],
    { id: "primary", store: remote, extraExcludes: [], writer: new NodeVaultWriter(vaultDir), device: "桌面-7F3A" },
  );

describe("主同步端 + 备份端", () => {
  it("先合并再备份：从主同步端下载的文件，同一次同步里也进了备份端", async () => {
    const r = await run();
    expect(r.destinations.map((d) => [d.id, d.status])).toEqual([["primary", "ok"], ["mirror", "ok"]]);
    expect(r.destinations[0]?.primary).toMatchObject({ downloaded: 1 });
    expect((await listTree(mirrorDir)).filter((f) => !f.startsWith(".multi-backup/"))).toEqual(["from-phone.md", "local.md"]);
    expect(state.bases.get("primary")?.size).toBe(2);
  });

  it("远程记下每个文件由哪台设备写入", async () => {
    await run();
    const devices = JSON.parse(remote.text(DEVICES_FILE) as string) as Record<string, string>;
    expect(devices["local.md"]).toBe("桌面-7F3A");
  });

  it("推送失败：主同步端记为失败，base 不保存，冲突登记照样保存；备份端照常进行", async () => {
    await writeText(path.join(vaultDir, "from-phone.md"), "本机也有一份不同的");
    remote.failFinish = true;
    const r = await run();
    expect(r.destinations[0]).toMatchObject({ status: "failed" });
    expect(state.bases.has("primary")).toBe(false);
    expect(state.conflicts).toMatchObject([{ path: "from-phone.md", kind: "both", copy: "from-phone.conflict-手机-2026-10-31-1000.md" }]);
    expect(r.destinations[1]?.status).toBe("ok");
  });
});
