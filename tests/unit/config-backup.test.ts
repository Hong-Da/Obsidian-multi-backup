// 插件配置备份：格式、随备份写到各类目的地、内容不变时不重写、恢复时不当作笔记
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import { log } from "isomorphic-git";
import { buildConfig, configPath, encodeConfig, newestPerDevice, parseConfig } from "../../src/core/config-backup";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { runBackup, type ConfigUpload } from "../../src/core/sync";
import { LocalGit } from "../../src/destinations/local-git";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { LocalZip } from "../../src/destinations/local-zip";
import type { FileStore, SnapshotStore } from "../../src/destinations/types";
import { mergeSettings, newDestination } from "../../src/settings";
import { exists, fs, makeTmp, MemoryState, nodeTargetFs, NodeVaultFs, path, writeText } from "../support/node";

describe("配置格式", () => {
  it("读回一致；不是本插件的文件读不出来；每台设备只留最新一份", () => {
    const s = mergeSettings({ destinations: [{ ...newDestination("git-remote"), tokenSecret: "github-token" }], excludes: "Private/" });
    const c = buildConfig(s, "书房电脑", "0.5.0", 1000);
    const back = parseConfig(encodeConfig(c));
    expect(back).toEqual(c);
    expect(mergeSettings(back?.settings)).toEqual(s);
    expect(parseConfig("{}")).toBeNull();
    expect(parseConfig("不是 JSON")).toBeNull();
    expect(parseConfig(JSON.stringify({ ...c, settings: [] }))).toBeNull();
    const list = newestPerDevice([buildConfig(s, "A", "", 1), buildConfig(s, "B", "", 5), buildConfig(s, "A", "", 9)]);
    expect(list.map((x) => [x.device, x.time])).toEqual([["A", 9], ["B", 5]]);
    expect(configPath("我的 手机/1")).toBe(".multi-backup/config/我的-手机-1.json");
  });

  it("配置里只有密钥名，没有凭据", () => {
    const s = mergeSettings({ destinations: [{ ...newDestination("s3"), accessKeyId: "AKIA-not-secret", secretKeySecret: "oss-secret" }] });
    const text = new TextDecoder().decode(encodeConfig(buildConfig(s, "d", "", 1)));
    expect(text).toContain("oss-secret");
    expect(text).not.toMatch(/secretAccessKey|password"|token"/);
  });
});

let tmp: Awaited<ReturnType<typeof makeTmp>>;
let vault: string;
beforeEach(async () => {
  tmp = await makeTmp();
  vault = path.join(tmp.dir, "vault");
  await writeText(path.join(vault, "a.md"), "A");
});
afterEach(() => tmp.cleanup());

describe("随备份上传", () => {
  const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
  const upload = (time: number): ConfigUpload => ({ path: configPath("书房电脑"), data: encodeConfig(buildConfig(mergeSettings({ excludes: "X/" }), "书房电脑", "0.5.0", time)) });
  const run = (store: FileStore | SnapshotStore, state: MemoryState, cfg: ConfigUpload) =>
    runBackup({ vault: new NodeVaultFs(vault), state, matcher: matcher(), maxFileSize: 1 << 30 }, [{ id: "d", store, extraExcludes: [], config: cfg }]);

  it("镜像：写到 .multi-backup/config/，不算备份里的笔记；内容不变时不重写", async () => {
    const root = path.join(tmp.dir, "mirror");
    await fs.mkdir(root);
    const make = () => new LocalMirror(nodeTargetFs(), { root, deletePolicy: "trash30", keepVersions: 10 });
    const state = new MemoryState();
    const r1 = await run(make(), state, upload(1));
    expect(r1.destinations[0]).toMatchObject({ status: "ok", uploaded: 1 });
    const file = path.join(root, ".multi-backup", "config", "书房电脑.json");
    expect(parseConfig(await fs.readFile(file))?.time).toBe(1);
    const st1 = await fs.stat(file);
    await run(make(), state, upload(1));
    expect((await fs.stat(file)).mtimeMs).toBe(st1.mtimeMs);
    expect(await exists(path.join(root, ".multi-backup", "versions", ".multi-backup"))).toBe(false);
    await run(make(), state, upload(2));
    const got = (await make().listConfigs()).map((d) => parseConfig(d)?.time);
    expect(got).toEqual([2]);
    expect([...(await make().restoreSource().files("current")).keys()]).toEqual(["a.md"]);
  });

  it("zip：放进快照里，恢复时不当作笔记", async () => {
    const root = path.join(tmp.dir, "zip");
    await fs.mkdir(root);
    const make = () => new LocalZip(nodeTargetFs(), { root, vaultName: "V", fileName: "{vault}_{date}_{time}.zip", keepCount: 30, keepDays: 0 });
    await run(make(), new MemoryState(), upload(7));
    expect((await make().listConfigs()).map((d) => parseConfig(d)?.device)).toEqual(["书房电脑"]);
    const src = make().restoreSource();
    const [p] = await src.points(1);
    expect([...(await src.files(p!.id)).keys()]).toEqual(["a.md"]);
  });

  it("本地 git：配置随提交保存；没有变化时不产生新提交", async () => {
    const root = path.join(tmp.dir, "repo");
    await fs.mkdir(root);
    const make = () => new LocalGit(nodeTargetFs(), nodeFs, { root, vaultName: "V", message: "Backup", author: { name: "t", email: "t@t" } });
    const state = new MemoryState();
    await run(make(), state, upload(1));
    const n1 = (await log({ fs: nodeFs, dir: root })).length;
    const r2 = await run(make(), state, upload(1));
    expect(r2.destinations[0]?.commit).toBeUndefined();
    expect((await log({ fs: nodeFs, dir: root })).length).toBe(n1);
    expect((await make().listConfigs()).length).toBe(1);
    const src = make().restoreSource();
    const [p] = await src.points(1);
    expect([...(await src.files(p!.id)).keys()]).toEqual(["a.md"]);
  });
});
