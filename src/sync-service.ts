// 插件层的同步服务：按设置创建目的地、执行备份、记录历史、发通知。
// 界面（状态栏、设置页、历史视图）监听 "changed" 事件刷新。

import { EditTracker } from "./core/edit-tracker";
import { Events, normalizePath, Notice, Platform, type App } from "obsidian";
import { buildConfig, configPath, encodeConfig, newestPerDevice, parseConfig, type ConfigFile } from "./core/config-backup";
import { defaultDeviceName, resolveConflict, type ConflictChoice } from "./core/conflict";
import { DestinationError } from "./core/errors";
import { builtinRules, ExcludeMatcher } from "./core/exclude";
import { appendHistory, toHistoryEntry, type HistoryEntry, type Trigger } from "./core/history";
import { localDate, localStamp, conflictsWithVault } from "./core/paths";
import { executeRestore, planRestore, scopeMatcher, undoRestore, type RestorePlan, type RestoreRecord, type RestoreSource } from "./core/restore";
import type { Logger } from "./core/logger";
import { runBackup, type ConfigUpload, type DestinationResult, type DestinationRun, type PrimaryRun } from "./core/sync";
import { planTwoWay, type ConflictRecord } from "./core/two-way";
import { dueDestinations } from "./core/scheduler";
import { scanVault } from "./core/scanner";
import type { SyncPlan } from "./core/sync-planner";
import { LocalGit } from "./destinations/local-git";
import { RemoteGit } from "./destinations/remote-git";
import { LocalMirror } from "./destinations/local-mirror";
import { LocalZip } from "./destinations/local-zip";
import { S3Fs } from "./destinations/s3-fs";
import { WebDavFs } from "./destinations/webdav-fs";
import { cloudFs } from "./destinations/cloud-fs";
import { cloudConfigured } from "./destinations/cloud-providers";
import type { CloudAuth } from "./platform/cloud-auth";
import type { FileStore, PrimaryStore, SnapshotStore, TestInfo } from "./destinations/types";
import { t, tn } from "./i18n";
import { adapterGitFs } from "./platform/adapter-git-fs";
import { desktopGitFs, desktopTargetFs, vaultBasePath } from "./platform/desktop";
import { obsidianHttp } from "./platform/obsidian-http";
import { obsidianRequest } from "./platform/obsidian-request";
import { ObsidianSecrets } from "./platform/secrets";
import type { ObsidianState } from "./platform/obsidian-state";
import { ObsidianVaultFs } from "./platform/obsidian-vault-fs";
import { ObsidianVaultWriter, TRASH_DIR } from "./platform/obsidian-vault-writer";
import {
  canBePrimary,
  CLOUD_NAMES,
  cloudFolder,
  cloudSecretName,
  isRemote,
  mergeSettings,
  portableSettings,
  splitRules,
  type CloudConfig,
  type DestinationConfig,
  type GitRemoteConfig,
  type MultiBackupSettings,
  type S3Config,
  type WebDavConfig,
} from "./settings";
import { destDisplayName, durationText, errorText, joinSentences, sentenceGap } from "./ui/messages";

/** WebDAV、S3 同时上传的文件数 */
const PARALLEL_UPLOADS = 4;

export interface SyncContext {
  app: App;
  pluginDir: string;
  logger: Logger;
  state: ObsidianState;
  settings(): MultiBackupSettings;
  /** 导入配置时替换全部设置并保存 */
  replaceSettings(s: MultiBackupSettings): Promise<void>;
  pluginVersion: string;
  cloud: CloudAuth;
  openHistory(): void;
  openConflicts(): void;
  editDestination(id: string): void;
}

const DEVICE_KEY = "multi-backup-device-name";

export interface Progress {
  destId: string;
  done: number;
  total: number;
}

export class SyncService extends Events {
  history: HistoryEntry[] = [];
  /** 还没处理的冲突 */
  conflicts: ConflictRecord[] = [];
  /** 最近的恢复记录（新的在前），用于撤销 */
  restores: RestoreRecord[] = [];
  /** 正在恢复或撤销：这时不同步 */
  restoring = false;
  /** 用户最后一次编辑 Vault 的时间（同步过程中插件自己写入的不算） */
  /** 用户最后一次编辑的时间（插件自己写的不算） */
  private readonly edits = new EditTracker();
  private startupChecked = false;
  /** 正在同步时不为 null；progress 在拿到第一个进度后才有 */
  running: { progress: Progress | null } | null = null;

  constructor(private readonly ctx: SyncContext) {
    super();
  }

  async load(): Promise<void> {
    this.history = await this.ctx.state.loadHistory();
    this.conflicts = await this.ctx.state.loadConflicts();
    this.restores = await this.ctx.state.loadRestores();
  }

  /** Vault 有文件被修改、新建、删除或改名时调用 */
  markEdit(path?: string): void {
    this.edits.edited(path);
  }

  /** 自动同步：每隔几秒检查一次，到点的目的地一起同步（主同步端照样排在最前） */
  async autoTick(): Promise<void> {
    if (this.running || this.restoring) return;
    const startup = !this.startupChecked;
    this.startupChecked = true;
    const s = this.ctx.settings();
    const lastSync: Record<string, number> = {};
    for (const e of [...this.history].reverse()) for (const d of e.destinations) lastSync[d.id] = e.finishedAt;
    // 手机上用不了本地类目的地，不自动尝试
    const usable = s.destinations.filter((d) => Platform.isDesktopApp || isRemote(d));
    const due = dueDestinations(usable, { now: Date.now(), lastSync, lastEdit: this.edits.lastEdit, startup });
    if (!due.length) return;
    const ids = new Set(due.map((d) => d.id));
    await this.sync(s.destinations.filter((d) => ids.has(d.id)), "auto");
  }

  /** 关闭前是否还有没同步的编辑 */
  hasUnsyncedEdits(): boolean {
    const last = this.history[0]?.finishedAt ?? 0;
    return this.edits.lastEdit > last;
  }

  /** 本设备名称：只存在本设备（不进 data.json），第一次用时生成默认名 */
  deviceName(): string {
    const saved = this.ctx.app.loadLocalStorage(DEVICE_KEY) as unknown;
    if (typeof saved === "string" && saved.trim()) return saved;
    const name = defaultDeviceName(Platform.isMobile, { desktop: t("device.desktop"), phone: t("device.phone") });
    this.ctx.app.saveLocalStorage(DEVICE_KEY, name);
    return name;
  }

  setDeviceName(name: string): void {
    this.ctx.app.saveLocalStorage(DEVICE_KEY, name.trim() || null);
  }

  /** 网盘登录 */
  get cloudAuth(): CloudAuth {
    return this.ctx.cloud;
  }

  /** 当前的主同步端（已启用、类型支持） */
  primaryConfig(): DestinationConfig | null {
    const s = this.ctx.settings();
    const d = s.destinations.find((x) => x.id === s.primaryId);
    return d && canBePrimary(d) ? d : null;
  }

  /** 设为主同步端前的只读比较：首次同步会下载、上传、保留两份各多少 */
  async previewPrimary(cfg: DestinationConfig): Promise<{ plan: SyncPlan; localCount: number; remoteCount: number }> {
    const store = await this.buildPrimary(cfg);
    await store.prepare();
    const matcher = this.matcher();
    const extra = splitRules(cfg.extraExcludes);
    const extraMatcher = extra.length ? new ExcludeMatcher(extra) : null;
    const keep = (p: string) => !matcher.isExcludedFile(p) && !extraMatcher?.isExcludedFile(p);
    const remote = new Map([...(await store.list())].filter(([p]) => keep(p)));
    const vault = new ObsidianVaultFs(this.ctx.app.vault.adapter);
    const scan = await scanVault(vault, { matcher, maxFileSize: this.ctx.settings().maxFileSizeMB * 1024 * 1024, previous: await this.ctx.state.loadHashCache() });
    const local = new Map([...scan.files].filter(([p]) => keep(p)));
    const plan = await planTwoWay({ vault, local, base: await this.ctx.state.loadBase(cfg.id), remote, matches: (d, id, p) => store.matches(d, id, p) });
    return { plan, localCount: local.size, remoteCount: remote.size };
  }

  /** 作为主同步端创建；不可用时抛 DestinationError */
  async buildPrimary(cfg: DestinationConfig): Promise<PrimaryStore> {
    if (cfg.type === "git-remote") return this.remoteGit(cfg).asPrimary();
    if (!canBePrimary(cfg)) throw new DestinationError("not-configured", cfg.path);
    const store = await this.buildStore(cfg);
    return (store as LocalMirror).asPrimary();
  }

  private remoteGit(cfg: GitRemoteConfig): RemoteGit {
    if (!cfg.url.trim()) throw new DestinationError("not-configured", "");
    return new RemoteGit(adapterGitFs(this.ctx.app.vault.adapter), obsidianHttp, {
      gitdir: this.ctx.state.repoDir(cfg.id),
      url: cfg.url.trim(),
      branch: cfg.branch.trim() || "main",
      username: cfg.provider === "github" ? "" : cfg.username.trim(),
      token: new ObsidianSecrets(this.ctx.app, this.ctx.logger).get(cfg.tokenSecret) ?? "",
      vaultName: this.ctx.app.vault.getName(),
      message: cfg.commitMessage,
      author: { name: cfg.authorName, email: cfg.authorEmail },
    });
  }

  /** WebDAV、S3：远程文件系统上的镜像，文件夹不存在时自动创建 */
  private async remoteMirror(cfg: WebDavConfig | S3Config | CloudConfig): Promise<LocalMirror> {
    const secrets = new ObsidianSecrets(this.ctx.app, this.ctx.logger);
    const known = Object.keys((await this.ctx.state.loadManifest(cfg.id)).files).length;
    const opts = { deletePolicy: cfg.deletePolicy, keepVersions: cfg.keepVersions, knownFiles: known, createRoot: true };
    const root = (p: string) => "/" + p.split("/").filter(Boolean).join("/");
    if (cfg.type === "cloud") {
      const name = CLOUD_NAMES[cfg.kind];
      if (!cloudConfigured(cfg.kind)) throw new DestinationError("not-configured", name);
      const secret = cloudSecretName(cfg.id);
      if (!this.ctx.cloud.load(secret)) throw new DestinationError("not-signed-in", name);
      const fs = cloudFs(cfg.kind, { token: this.ctx.cloud.token(cfg.kind, secret), http: obsidianRequest });
      return new LocalMirror(fs, { ...opts, root: cloudFolder(cfg, this.ctx.app.vault.getName()) });
    }
    if (cfg.type === "webdav") {
      if (!cfg.url.trim()) throw new DestinationError("not-configured", "");
      const fs = new WebDavFs({ url: cfg.url.trim(), username: cfg.username.trim(), password: secrets.get(cfg.passwordSecret) ?? "", http: obsidianRequest });
      return new LocalMirror(fs, { ...opts, root: root(cfg.folder), parallel: PARALLEL_UPLOADS });
    }
    if (!cfg.endpoint.trim() || !cfg.bucket.trim()) throw new DestinationError("not-configured", "");
    const fs = new S3Fs({
      endpoint: cfg.endpoint.trim().replace(/\/+$/, ""),
      region: cfg.region.trim() || "us-east-1",
      bucket: cfg.bucket.trim(),
      accessKeyId: cfg.accessKeyId.trim(),
      secretAccessKey: secrets.get(cfg.secretKeySecret) ?? "",
      pathStyle: cfg.pathStyle,
      http: obsidianRequest,
    });
    return new LocalMirror(fs, { ...opts, root: root(cfg.prefix), parallel: PARALLEL_UPLOADS });
  }

  private changed(): void {
    this.trigger("changed");
  }

  /** 全局排除规则：内置 + 用户设置 */
  matcher(): ExcludeMatcher {
    const s = this.ctx.settings();
    const builtin = builtinRules({ configDir: this.ctx.app.vault.configDir, pluginDir: this.ctx.pluginDir, includeConfigDir: s.includeConfigDir });
    return new ExcludeMatcher([...builtin, ...splitRules(s.excludes)]);
  }

  /** 按配置创建目的地；不可用时抛 DestinationError */
  async buildStore(cfg: DestinationConfig): Promise<FileStore | SnapshotStore> {
    if (cfg.type === "git-remote") return this.remoteGit(cfg);
    if (cfg.type === "webdav" || cfg.type === "s3" || cfg.type === "cloud") return this.remoteMirror(cfg);
    const fs = desktopTargetFs();
    if (!fs) throw new DestinationError("desktop-only", cfg.path);
    if (!cfg.path.trim()) throw new DestinationError("not-configured", "");
    if (conflictsWithVault(cfg.path, vaultBasePath(this.ctx.app.vault.adapter))) throw new DestinationError("inside-vault", cfg.path);
    if (cfg.type === "git") {
      const gitFs = desktopGitFs();
      if (!gitFs) throw new DestinationError("desktop-only", cfg.path);
      return new LocalGit(fs, gitFs, {
        root: cfg.path.trim(),
        vaultName: this.ctx.app.vault.getName(),
        message: cfg.commitMessage,
        author: { name: cfg.authorName, email: cfg.authorEmail },
      });
    }
    if (cfg.type === "mirror") {
      const known = Object.keys((await this.ctx.state.loadManifest(cfg.id)).files).length;
      return new LocalMirror(fs, { root: cfg.path.trim(), deletePolicy: cfg.deletePolicy, keepVersions: cfg.keepVersions, knownFiles: known });
    }
    return new LocalZip(fs, {
      root: cfg.path.trim(),
      vaultName: this.ctx.app.vault.getName(),
      fileName: cfg.fileName,
      keepCount: cfg.keepCount,
      keepDays: cfg.keepDays,
    });
  }

  async testDestination(cfg: DestinationConfig): Promise<TestInfo> {
    return (await this.buildStore(cfg)).test();
  }

  syncAll(trigger: Trigger): Promise<void> {
    return this.sync(this.ctx.settings().destinations.filter((d) => d.enabled), trigger);
  }

  syncOne(id: string, trigger: Trigger): Promise<void> {
    return this.sync(this.ctx.settings().destinations.filter((d) => d.id === id), trigger);
  }

  private async sync(configs: DestinationConfig[], trigger: Trigger): Promise<void> {
    const auto = trigger === "auto" || trigger === "quit";
    if (this.restoring) {
      if (!auto) new Notice(t("notice.restoreRunning"));
      return;
    }
    if (this.running) {
      if (!auto) new Notice(t("notice.alreadyRunning"));
      return;
    }
    if (!configs.length) {
      if (!auto) new Notice(t("notice.noDestinations"));
      return;
    }
    this.running = { progress: null };
    this.edits.start();
    this.changed();
    const log = this.ctx.logger;
    try {
      const runs: DestinationRun[] = [];
      const early: DestinationResult[] = [];
      const fail = (cfg: DestinationConfig, e: unknown) => {
        const error = e instanceof DestinationError ? e : new DestinationError("io", cfg.path);
        early.push({ id: cfg.id, status: "failed", uploaded: 0, identical: 0, moved: 0, deleted: 0, failed: [], changes: [], error, durationMs: 0 });
      };
      // 主同步端先于各备份端（任务文档 F-S3）
      const primaryCfg = configs.find((c) => c.id === this.primaryConfig()?.id);
      const writer = new ObsidianVaultWriter(this.ctx.app, undefined, (p) => this.edits.touched(p));
      const upload = this.configUpload();
      let primary: PrimaryRun | undefined;
      if (primaryCfg) {
        try {
          primary = {
            id: primaryCfg.id,
            store: await this.buildPrimary(primaryCfg),
            extraExcludes: splitRules(primaryCfg.extraExcludes),
            writer,
            device: this.deviceName(),
            config: primaryCfg.uploadConfig ? upload : undefined,
          };
        } catch (e) {
          fail(primaryCfg, e);
        }
      }
      for (const cfg of configs) {
        if (cfg === primaryCfg) continue;
        try {
          runs.push({ id: cfg.id, store: await this.buildStore(cfg), extraExcludes: splitRules(cfg.extraExcludes), config: cfg.uploadConfig ? upload : undefined });
        } catch (e) {
          fail(cfg, e);
        }
      }
      const s = this.ctx.settings();
      log.info(`sync start (${trigger}): ${configs.length} destination(s)`);
      const result = await runBackup(
        {
          vault: new ObsidianVaultFs(this.ctx.app.vault.adapter),
          state: this.ctx.state,
          matcher: this.matcher(),
          maxFileSize: s.maxFileSizeMB * 1024 * 1024,
          logger: log,
          onProgress: (destId, done, total) => {
            if (this.running) this.running.progress = { destId, done, total };
            this.changed();
          },
        },
        runs,
        primary,
      );
      await writer.cleanup(s.trashKeepDays).catch((e: unknown) => log.warn("trash cleanup failed", e));
      const newConflicts = result.destinations.flatMap((d) => d.primary?.conflicts ?? []);
      if (primary) this.conflicts = await this.ctx.state.loadConflicts();
      // 保持设置中的顺序
      const all = [...result.destinations, ...early];
      result.destinations = configs.map((c) => all.find((r) => r.id === c.id)).filter((r): r is DestinationResult => !!r);

      const names = Object.fromEntries(configs.map((c) => [c.id, { name: destDisplayName(c), type: c.type }]));
      this.history = appendHistory(this.history, toHistoryEntry(result, trigger, names));
      await this.ctx.state.saveHistory(this.history);
      // 自动同步时：成功不弹通知；失败只在这个目的地上一次不是失败时提醒，避免每隔几分钟弹一次
      const prevFailed = (id: string) => {
        const prev = this.history.slice(1).find((e) => e.destinations.some((d) => d.id === id));
        const d = prev?.destinations.find((x) => x.id === id);
        return d?.status === "failed" || d?.status === "partial";
      };
      const shown = auto ? result.destinations.filter((d) => (d.status === "failed" || d.status === "partial") && !prevFailed(d.id)) : result.destinations;
      if (!auto || shown.length) this.notify(shown, configs, result.finishedAt - result.startedAt, result.skippedLarge.length);
      if (newConflicts.length) this.notifyConflicts(newConflicts);
    } catch (e) {
      log.error("sync stopped", e);
      new Notice(t("notice.unexpected"), 0);
    } finally {
      this.running = null;
      this.edits.end();
      this.changed();
    }
  }

  /** 随备份上传的插件配置：这台设备的名称 + 当前设置（只有密钥名，没有凭据） */
  private configUpload(): ConfigUpload {
    const s = this.ctx.settings();
    const device = this.deviceName();
    return { path: configPath(device), data: encodeConfig(buildConfig(portableSettings(s), device, this.ctx.pluginVersion, s.updatedAt)) };
  }

  /** 当前设置做成的配置（导出用） */
  currentConfig(): ConfigFile {
    const s = this.ctx.settings();
    return buildConfig(portableSettings(s), this.deviceName(), this.ctx.pluginVersion, s.updatedAt || Date.now());
  }

  /** 把配置导出为 Vault 根目录下的文件，返回文件路径 */
  async exportConfig(): Promise<string> {
    const adapter = this.ctx.app.vault.adapter;
    const day = localDate(new Date());
    let name = `multi-backup-config-${day}.json`;
    for (let i = 2; await adapter.exists(name); i++) name = `multi-backup-config-${day}-${i}.json`;
    const data = encodeConfig(this.currentConfig());
    await this.ctx.app.vault.createBinary(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    this.ctx.logger.info(`config exported to ${name}`);
    return name;
  }

  /** Vault 里导出过的配置文件（文件名含 multi-backup-config） */
  configFilesInVault(): string[] {
    return this.ctx.app.vault
      .getFiles()
      .filter((f) => f.extension === "json" && f.name.includes("multi-backup-config"))
      .map((f) => f.path)
      .sort()
      .reverse();
  }

  async readConfigFile(path: string): Promise<ConfigFile | null> {
    return parseConfig(await this.ctx.app.vault.adapter.read(normalizePath(path)));
  }

  /** 目的地里各设备上传的配置，每台设备取最新一份，新的在前 */
  async readConfigs(cfg: DestinationConfig): Promise<ConfigFile[]> {
    const store = cfg.type === "git-remote" ? this.remoteGit(cfg) : await this.buildStore(cfg);
    if (!(store instanceof LocalMirror || store instanceof LocalZip || store instanceof LocalGit || store instanceof RemoteGit)) return [];
    const list = (await store.listConfigs()).map((d) => parseConfig(d)).filter((c): c is ConfigFile => !!c);
    return newestPerDevice(list);
  }

  /** 导入前的说明：有哪些目的地、哪些在这台设备上还缺密钥、哪些只能在桌面端用、原来的主同步端 */
  describeImport(c: ConfigFile): { dests: string[]; needSecret: string[]; desktopOnly: string[]; primary: string } {
    const s = mergeSettings(c.settings);
    const secrets = new ObsidianSecrets(this.ctx.app, this.ctx.logger);
    const secretOf = (d: DestinationConfig) => (d.type === "git-remote" ? d.tokenSecret : d.type === "webdav" ? d.passwordSecret : d.type === "s3" ? d.secretKeySecret : "");
    const needs = (d: DestinationConfig) => {
      if (d.type === "cloud") return !this.ctx.cloud.load(cloudSecretName(d.id));
      const name = secretOf(d);
      if (d.type === "git-remote" || d.type === "s3") return !name || !secrets.get(name);
      return d.type === "webdav" && !!name && !secrets.get(name);
    };
    return {
      dests: s.destinations.map(destDisplayName),
      needSecret: s.destinations.filter(needs).map(destDisplayName),
      desktopOnly: s.destinations.filter((d) => !isRemote(d)).map(destDisplayName),
      primary: ((p) => (p ? destDisplayName(p) : ""))(s.destinations.find((d) => d.id === s.primaryId)),
    };
  }

  /**
   * 导入配置：替换全部设置。当前设置先另存到插件目录 state/；主同步端不直接恢复（要在设置里重新设，会先比较）。
   * 返回另存的文件路径。
   */
  async importConfig(c: ConfigFile): Promise<string> {
    const backup = await this.ctx.state.saveSettingsBackup(this.ctx.settings(), localStamp(new Date()).replace("_", "-"));
    const next = mergeSettings(c.settings);
    next.primaryId = "";
    next.onboarding = this.ctx.settings().onboarding;
    next.updatedAt = Date.now();
    await this.ctx.replaceSettings(next);
    this.ctx.logger.info(`config imported from ${c.device || "file"} (${next.destinations.length} destinations); previous settings saved to ${backup}`);
    this.changed();
    return backup;
  }

  /** 这台设备上能用作恢复来源的目的地（手机上只有远程目的地） */
  restoreTargets(): DestinationConfig[] {
    return this.ctx.settings().destinations.filter((d) => Platform.isDesktopApp || isRemote(d));
  }

  /** 目的地作为恢复来源；不可用时抛 DestinationError */
  async restoreSource(cfg: DestinationConfig): Promise<RestoreSource> {
    if (cfg.type === "git-remote") return this.remoteGit(cfg).restoreSource();
    const store = await this.buildStore(cfg);
    if (store instanceof LocalMirror || store instanceof LocalZip || store instanceof LocalGit) return store.restoreSource();
    throw new DestinationError("not-configured", cfg.path);
  }

  /** 同步时被排除的文件，恢复时也不碰（插件自己的文件夹、回收站、额外排除规则等） */
  restoreFilter(cfg: DestinationConfig): (path: string) => boolean {
    const matcher = this.matcher();
    const extra = splitRules(cfg.extraExcludes);
    const extraMatcher = extra.length ? new ExcludeMatcher(extra) : null;
    return (p) => !matcher.isExcludedFile(p) && !extraMatcher?.isExcludedFile(p);
  }

  /** 恢复前的预览：哪些写回、覆盖、跳过、移走。selected 为 null 表示整个 Vault */
  async previewRestore(
    cfg: DestinationConfig,
    src: RestoreSource,
    pointId: string,
    selected: string[] | null,
    removeExtra: boolean,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RestorePlan> {
    const keep = this.restoreFilter(cfg);
    const inScope = scopeMatcher(selected);
    const remote = await src.files(pointId);
    const vault = new ObsidianVaultFs(this.ctx.app.vault.adapter);
    const scan = await scanVault(vault, { matcher: this.matcher(), maxFileSize: this.ctx.settings().maxFileSizeMB * 1024 * 1024, previous: await this.ctx.state.loadHashCache() });
    return planRestore({
      remote,
      local: scan.files,
      include: (p) => keep(p) && inScope(p),
      removeExtra: removeExtra && !selected,
      read: (p) => src.read(pointId, p),
      onProgress,
    });
  }

  /** 按预览恢复。只改本机文件；被覆盖、移走的先另存，可以撤销 */
  async restore(cfg: DestinationConfig, src: RestoreSource, pointId: string, pointLabel: string, plan: RestorePlan): Promise<RestoreRecord | null> {
    if (this.running || this.restoring) {
      new Notice(t(this.running ? "notice.alreadyRunning" : "notice.restoreRunning"));
      return null;
    }
    this.restoring = true;
    this.changed();
    const log = this.ctx.logger;
    try {
      const now = new Date();
      const dir = `${TRASH_DIR}/restore-${localStamp(now).replace("_", "-")}`;
      const writer = new ObsidianVaultWriter(this.ctx.app);
      log.info(`restore from ${cfg.id} @ ${pointId}: add ${plan.add.length}, overwrite ${plan.overwrite.length}, remove ${plan.remove.length}`);
      const r = await executeRestore(plan, { read: (p) => src.read(pointId, p), io: writer, dir });
      for (const f of r.failed) log.warn(`restore failed: ${f.path}`, f.error);
      const rec: RestoreRecord = {
        id: `r-${now.getTime().toString(36)}`,
        time: now.getTime(),
        destId: cfg.id,
        destName: destDisplayName(cfg),
        point: pointLabel,
        dir,
        added: r.added,
        overwritten: r.overwritten,
        removed: r.removed,
        failed: r.failed.length,
      };
      this.restores = [rec, ...this.restores].slice(0, 20);
      await this.ctx.state.saveRestores(this.restores);
      this.notifyRestore(rec);
      return rec;
    } catch (e) {
      log.error("restore stopped", e);
      new Notice(t("notice.unexpected"), 0);
      return null;
    } finally {
      this.restoring = false;
      this.changed();
    }
  }

  /** 撤销一次恢复；另存的文件已被清理时不能撤销 */
  async undoRestore(rec: RestoreRecord): Promise<void> {
    if (this.running || this.restoring) {
      new Notice(t(this.running ? "notice.alreadyRunning" : "notice.restoreRunning"));
      return;
    }
    const saved = rec.overwritten.length + rec.removed.length;
    if (saved && !(await this.ctx.app.vault.adapter.exists(normalizePath(rec.dir)))) {
      new Notice(t("notice.undoExpired"));
      return;
    }
    this.restoring = true;
    this.changed();
    try {
      const writer = new ObsidianVaultWriter(this.ctx.app);
      const r = await undoRestore(rec, writer, `${TRASH_DIR}/undo-${localStamp(new Date()).replace("_", "-")}`);
      for (const f of r.failed) this.ctx.logger.warn(`undo failed: ${f.path}`, f.error);
      rec.undone = true;
      await this.ctx.state.saveRestores(this.restores);
      new Notice(r.failed.length ? tn("notice.undoPartial", r.failed.length) : t("notice.undone"));
    } finally {
      this.restoring = false;
      this.changed();
    }
  }

  private notifyRestore(rec: RestoreRecord): void {
    const n = rec.added.length + rec.overwritten.length;
    const saved = rec.overwritten.length + rec.removed.length;
    const frag = createFragment((f) => {
      f.createEl("b", { text: tn("notice.restored.title", n), cls: rec.failed ? "mb-notice-error" : "" });
      f.createEl("br");
      const parts: string[] = [];
      if (rec.removed.length) parts.push(tn("notice.restored.removed", rec.removed.length));
      if (saved) parts.push(tn("notice.restored.saved", saved));
      if (rec.failed) parts.push(tn("notice.restored.failed", rec.failed));
      if (!parts.length) parts.push(t("notice.restored.nothing"));
      f.appendText(parts.join(" "));
      const act = f.createDiv({ cls: "mb-notice-actions" });
      if (n || rec.removed.length) act.createEl("button", { text: t("restore.undo") }).addEventListener("click", () => void this.undoRestore(rec));
      act.createEl("button", { text: t("notice.viewDetails") }).addEventListener("click", () => this.ctx.openHistory());
    });
    new Notice(frag, rec.failed ? 0 : 10000);
  }

  /** 处理一个冲突（改动只在本机，下次同步传到其他设备），并从登记中移除 */
  async resolve(c: ConflictRecord, choice: ConflictChoice): Promise<void> {
    const adapter = this.ctx.app.vault.adapter;
    const writer = new ObsidianVaultWriter(this.ctx.app);
    await resolveConflict(c, choice, {
      read: async (p) => new Uint8Array(await adapter.readBinary(normalizePath(p))),
      exists: (p) => writer.exists(p),
      write: (p, d) => writer.write(p, d),
      trash: (p, move) => writer.trash(p, move),
    });
    this.conflicts = this.conflicts.filter((k) => !(k.path === c.path && k.kind === c.kind && k.copy === c.copy));
    await this.ctx.state.saveConflicts(this.conflicts);
    this.changed();
  }

  /** 冲突提醒：两边都改了的优先；否则是“别的设备删除了”的提醒 */
  private notifyConflicts(list: ConflictRecord[]): void {
    const both = list.filter((c) => c.kind === "both");
    const first = both[0] ?? list[0];
    if (!first) return;
    const frag = createFragment((f) => {
      f.createEl("b", { text: both.length ? tn("notice.conflict.title", both.length) : t("notice.conflict.deletedTitle") });
      f.createEl("br");
      f.appendText(
        t(first.kind === "both" ? "notice.conflict.both" : first.kind === "keepLocal" ? "notice.conflict.keepLocal" : "notice.conflict.restoreRemote", { path: first.path }),
      );
      const act = f.createDiv({ cls: "mb-notice-actions" });
      act.createEl("button", { text: t("notice.openConflicts") }).addEventListener("click", () => this.ctx.openConflicts());
    });
    new Notice(frag, 0);
  }

  private notify(results: DestinationResult[], configs: DestinationConfig[], ms: number, skipped: number): void {
    const bad = results.filter((r) => r.status === "failed" || r.status === "partial");
    const name = (id: string) => destDisplayName(configs.find((c) => c.id === id) as DestinationConfig);
    if (!bad.length) {
      const up = results.reduce((n, r) => n + r.uploaded, 0);
      const moved = results.reduce((n, r) => n + r.moved, 0);
      const del = results.reduce((n, r) => n + r.deleted, 0);
      const body = up + moved + del
        ? tn("notice.done.body", results.length, { dests: results.length, up, moved, del, dur: durationText(ms) })
        : tn("notice.done.nochange", results.length, { dests: results.length });
      const frag = createFragment((f) => {
        f.createEl("b", { text: t("notice.done.title") });
        f.createEl("br");
        f.appendText(body);
        if (skipped) {
          f.createEl("br");
          f.appendText(tn("notice.skippedLarge", skipped, { mb: this.ctx.settings().maxFileSizeMB }));
        }
      });
      this.showResult(new Notice(frag, 4000));
      return;
    }
    const first = bad[0] as DestinationResult;
    const title =
      bad.length > 1
        ? t("notice.failed.titleMany", { count: bad.length })
        : t(first.status === "partial" ? "notice.partial.title" : "notice.failed.title", { name: name(first.id) });
    const reason =
      first.status === "partial"
        ? joinSentences(tn("notice.partial.body", first.failed.length), errorText(first.failed[0]?.error.code, first.failed[0]?.path))
        : errorText(first.error?.code, first.error?.path);
    const others = results.length - bad.length;
    const frag = createFragment((f) => {
      f.createEl("b", { text: title, cls: "mb-notice-error" });
      f.createEl("br");
      f.appendText(reason);
      if (others > 0) f.appendText(sentenceGap() + tn("notice.failed.others", others));
      const act = f.createDiv({ cls: "mb-notice-actions" });
      act.createEl("button", { text: t("notice.viewDetails") }).addEventListener("click", () => this.ctx.openHistory());
      act.createEl("button", { text: t("notice.editDestination") }).addEventListener("click", () => this.ctx.editDestination(first.id));
    });
    this.showResult(new Notice(frag, 0));
  }

  /** 同步结果只保留最新一条提示：同样的失败不重复叠加，成功后旧的失败提示也会消失 */
  private resultNotice: Notice | null = null;
  private showResult(n: Notice): void {
    this.resultNotice?.hide();
    this.resultNotice = n;
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.ctx.state.saveHistory(this.history);
    this.changed();
  }

  async forgetDestination(id: string): Promise<void> {
    await this.ctx.state.removeDestination(id);
    this.changed();
  }

  /** 把最近的日志合并为 Vault 根目录下的一个文件 */
  async exportLogs(): Promise<void> {
    const adapter = this.ctx.app.vault.adapter;
    const dir = normalizePath(`${this.ctx.pluginDir}/logs`);
    if (!(await adapter.exists(dir))) {
      new Notice(t("notice.noLogs"));
      return;
    }
    const files = (await adapter.list(dir)).files.filter((f) => f.endsWith(".log")).sort();
    if (!files.length) {
      new Notice(t("notice.noLogs"));
      return;
    }
    const parts: string[] = [];
    for (const f of files) parts.push(`===== ${f.slice(f.lastIndexOf("/") + 1)} =====\n${await adapter.read(f)}`);
    let name = `multi-backup-logs-${localDate(new Date())}.txt`;
    for (let i = 2; await adapter.exists(name); i++) name = `multi-backup-logs-${localDate(new Date())}-${i}.txt`;
    await adapter.write(name, parts.join("\n"));
    new Notice(t("notice.logsExported", { path: name }));
  }
}
