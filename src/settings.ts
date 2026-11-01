// 插件设置（保存在 data.json，不含任何凭据）。新增设置项必须在 DEFAULT_SETTINGS 中给出默认值。

import type { CloudKind } from "./core/oauth";
import type { DeletePolicy } from "./destinations/types";

/** 自动同步：满足任一条件时同步这个目的地 */
export interface AutoSync {
  enabled: boolean;
  interval: { on: boolean; minutes: number };
  afterEdit: { on: boolean; seconds: number };
  onStartup: boolean;
  daily: { on: boolean; time: string };
}

/** 默认值（M3 评审确定）：主同步端“修改后 30 秒 + 启动时 + 每 10 分钟”，备份端“每 30 分钟”，zip“每天 23:00” */
export function defaultAuto(role: "primary" | "backup" | "zip"): AutoSync {
  if (role === "primary") return { enabled: true, interval: { on: true, minutes: 10 }, afterEdit: { on: true, seconds: 30 }, onStartup: true, daily: { on: false, time: "23:00" } };
  if (role === "zip") return { enabled: true, interval: { on: false, minutes: 60 }, afterEdit: { on: false, seconds: 60 }, onStartup: false, daily: { on: true, time: "23:00" } };
  return { enabled: true, interval: { on: true, minutes: 30 }, afterEdit: { on: false, seconds: 60 }, onStartup: false, daily: { on: false, time: "23:00" } };
}

interface DestinationBase {
  id: string;
  name: string;
  enabled: boolean;
  auto: AutoSync;
  /** 目标文件夹（本机绝对路径） */
  path: string;
  /** 只对这个目的地生效的额外排除规则，每行一条 */
  extraExcludes: string;
  /** 同步时把插件配置写到目的地的 .multi-backup/config/（不含凭据） */
  uploadConfig: boolean;
}

export interface MirrorConfig extends DestinationBase {
  type: "mirror";
  deletePolicy: DeletePolicy;
  keepVersions: number;
}

export interface ZipConfig extends DestinationBase {
  type: "zip";
  fileName: string;
  keepCount: number;
  keepDays: number;
}

export interface GitConfig extends DestinationBase {
  type: "git";
  /** 提交说明模板：{vault} {date} {time} */
  commitMessage: string;
  authorName: string;
  authorEmail: string;
}

export type GitProvider = "github" | "gitee" | "other";

/** 远程 Git（GitHub / Gitee / 其他）。path 不用；令牌只存密钥名 tokenSecret，令牌本身在本机密钥存储 */
export interface GitRemoteConfig extends DestinationBase {
  type: "git-remote";
  provider: GitProvider;
  url: string;
  branch: string;
  /** Gitee 与其他 Git 需要；GitHub 留空 */
  username: string;
  tokenSecret: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
}

export type WebDavPreset = "jianguo" | "nextcloud" | "alist" | "other";

/** WebDAV（坚果云、Nextcloud、Alist、群晖等）。path 不用；密码只存密钥名 passwordSecret */
export interface WebDavConfig extends DestinationBase {
  type: "webdav";
  preset: WebDavPreset;
  url: string;
  username: string;
  passwordSecret: string;
  /** 服务器上的文件夹，不存在时自动创建 */
  folder: string;
  deletePolicy: DeletePolicy;
  keepVersions: number;
}

export type S3Preset = "aws" | "oss" | "cos" | "r2" | "minio";

/** S3 兼容存储。path 不用；Access Key ID 不算机密，存在设置里；Secret Key 只存密钥名 secretKeySecret */
export interface S3Config extends DestinationBase {
  type: "s3";
  preset: S3Preset;
  endpoint: string;
  region: string;
  bucket: string;
  /** 桶里的前缀（文件夹），同一个桶放多个 Vault 时区分 */
  prefix: string;
  accessKeyId: string;
  secretKeySecret: string;
  pathStyle: boolean;
  deletePolicy: DeletePolicy;
  keepVersions: number;
}

/** 网盘（OneDrive、Dropbox、Google Drive）。登录凭据存本机密钥存储，密钥名由目的地 id 得出（cloudSecretName），不写进设置 */
export interface CloudConfig extends DestinationBase {
  type: "cloud";
  kind: CloudKind;
  /** 网盘里的文件夹；空表示默认（OneDrive、Dropbox 为应用文件夹下的 /<Vault 名>，Google Drive 为 /Multi Backup/<Vault 名>） */
  folder: string;
  deletePolicy: DeletePolicy;
  keepVersions: number;
}

export const CLOUD_NAMES: Record<CloudKind, string> = { onedrive: "OneDrive", dropbox: "Dropbox", gdrive: "Google Drive" };

/** 网盘登录凭据在本机密钥存储里的名字 */
export function cloudSecretName(destId: string): string {
  return ("mb-oauth-" + destId).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** 网盘文件夹的默认值 */
export function cloudFolder(d: CloudConfig, vaultName: string): string {
  const f = d.folder.split("/").filter(Boolean).join("/");
  if (f) return "/" + f;
  return d.kind === "gdrive" ? `/Multi Backup/${vaultName}` : `/${vaultName}`;
}

export type DestinationConfig = MirrorConfig | ZipConfig | GitConfig | GitRemoteConfig | WebDavConfig | S3Config | CloudConfig;
export type DestinationType = DestinationConfig["type"];

export interface MultiBackupSettings {
  destinations: DestinationConfig[];
  includeConfigDir: boolean;
  /** 用户的排除规则，每行一条 */
  excludes: string;
  maxFileSizeMB: number;
  debugLog: boolean;
  logKeepDays: number;
  /** 主同步端的目的地 id；空表示没有 */
  primaryId: string;
  /** 被同步覆盖或删除的本机文件在 .trash/multi-backup/ 保留的天数 */
  trashKeepDays: number;
  /** 关闭 Obsidian 前同步一次（桌面端） */
  syncBeforeClose: boolean;
  /** 设置最后一次修改的时间（毫秒），随配置上传，导入时用来区分新旧 */
  updatedAt: number;
  /** 首次运行指导的状态：只属于这台设备，不随配置上传或导入 */
  onboarding: OnboardingState;
}

export interface OnboardingState {
  /** 欢迎窗口已经出现过 */
  welcomeDone: boolean;
  /** 设置页的上手清单已关闭 */
  guideClosed: boolean;
}

export const DEFAULT_SETTINGS: MultiBackupSettings = {
  destinations: [],
  includeConfigDir: true,
  excludes: "",
  maxFileSizeMB: 50,
  debugLog: false,
  logKeepDays: 14,
  primaryId: "",
  trashKeepDays: 30,
  syncBeforeClose: true,
  updatedAt: 0,
  onboarding: { welcomeDone: false, guideClosed: false },
};

/** 随配置上传、导出的设置：去掉只属于这台设备的首次运行指导状态 */
export function portableSettings(s: MultiBackupSettings): Omit<MultiBackupSettings, "onboarding"> {
  const copy: Partial<MultiBackupSettings> = { ...s };
  delete copy.onboarding;
  return copy as Omit<MultiBackupSettings, "onboarding">;
}

export function newDestinationId(): string {
  return "d-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function newDestination(type: DestinationType, kind: CloudKind = "onedrive"): DestinationConfig {
  const base = { id: newDestinationId(), name: "", enabled: true, path: "", extraExcludes: "", uploadConfig: true, auto: defaultAuto(type === "zip" ? "zip" : "backup") };
  switch (type) {
    case "mirror":
      return { ...base, type, deletePolicy: "trash30", keepVersions: 10 };
    case "zip":
      return { ...base, type, fileName: "{vault}_{date}_{time}.zip", keepCount: 30, keepDays: 90 };
    case "git":
      return { ...base, type, commitMessage: "Backup {date} {time}", authorName: "Multi Backup", authorEmail: "multi-backup@localhost" };
    case "git-remote":
      return {
        ...base,
        type,
        provider: "github",
        url: "",
        branch: "main",
        username: "",
        tokenSecret: "",
        commitMessage: "Backup {date} {time}",
        authorName: "Multi Backup",
        authorEmail: "multi-backup@localhost",
      };
    case "webdav":
      return { ...base, type, preset: "jianguo", url: WEBDAV_PRESETS.jianguo.url, username: "", passwordSecret: "", folder: "/Obsidian", deletePolicy: "trash30", keepVersions: 10 };
    case "cloud":
      return { ...base, type, kind, folder: "", deletePolicy: "trash30", keepVersions: 10 };
    case "s3": {
      const p = S3_PRESETS.aws;
      return { ...base, type, preset: "aws", endpoint: p.endpoint, region: p.region, bucket: "", prefix: "obsidian", accessKeyId: "", secretKeySecret: "", pathStyle: p.pathStyle, deletePolicy: "trash30", keepVersions: 10 };
    }
  }
}

/** WebDAV 各服务的默认地址（M4 预览页 storage-modal.html） */
export const WEBDAV_PRESETS: Record<WebDavPreset, { url: string }> = {
  jianguo: { url: "https://dav.jianguoyun.com/dav/" },
  nextcloud: { url: "" },
  alist: { url: "" },
  other: { url: "" },
};

/** S3 各服务商的默认地址、地域与地址风格 */
export const S3_PRESETS: Record<S3Preset, { endpoint: string; region: string; pathStyle: boolean }> = {
  aws: { endpoint: "https://s3.amazonaws.com", region: "us-east-1", pathStyle: false },
  oss: { endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "oss-cn-hangzhou", pathStyle: false },
  cos: { endpoint: "https://cos.ap-shanghai.myqcloud.com", region: "ap-shanghai", pathStyle: false },
  r2: { endpoint: "", region: "auto", pathStyle: true },
  minio: { endpoint: "", region: "us-east-1", pathStyle: true },
};

/** 远程目的地：手机上也能用 */
export function isRemote(d: DestinationConfig): boolean {
  return d.type === "git-remote" || d.type === "webdav" || d.type === "s3" || d.type === "cloud";
}

type Loose = Record<string, unknown>;
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const int = (v: unknown, d: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : d;

function mergeDestination(raw: unknown): DestinationConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Loose;
  if (r.type !== "mirror" && r.type !== "zip" && r.type !== "git" && r.type !== "git-remote" && r.type !== "webdav" && r.type !== "s3" && r.type !== "cloud") return null;
  const kind: CloudKind = r.kind === "dropbox" || r.kind === "gdrive" ? r.kind : "onedrive";
  const d = newDestination(r.type, kind);
  const base = {
    id: str(r.id, d.id) || d.id,
    name: str(r.name, ""),
    enabled: bool(r.enabled, true),
    path: str(r.path, ""),
    extraExcludes: str(r.extraExcludes, ""),
    uploadConfig: bool(r.uploadConfig, true),
    auto: mergeAuto(r.auto, d.auto),
  };
  const policy = r.deletePolicy === "delete" || r.deletePolicy === "keep" || r.deletePolicy === "trash30" ? r.deletePolicy : "trash30";
  if (d.type === "mirror") return { ...d, ...base, deletePolicy: policy, keepVersions: int(r.keepVersions, d.keepVersions, 0, 1000) };
  if (d.type === "cloud") return { ...d, ...base, folder: str(r.folder, "").trim(), deletePolicy: policy, keepVersions: int(r.keepVersions, d.keepVersions, 0, 1000) };
  if (d.type === "webdav") {
    const preset = typeof r.preset === "string" && r.preset in WEBDAV_PRESETS ? (r.preset as WebDavPreset) : d.preset;
    return {
      ...d,
      ...base,
      preset,
      url: str(r.url, d.url).trim(),
      username: str(r.username, "").trim(),
      passwordSecret: str(r.passwordSecret, ""),
      folder: str(r.folder, d.folder).trim() || d.folder,
      deletePolicy: policy,
      keepVersions: int(r.keepVersions, d.keepVersions, 0, 1000),
    };
  }
  if (d.type === "s3") {
    const preset = typeof r.preset === "string" && r.preset in S3_PRESETS ? (r.preset as S3Preset) : d.preset;
    return {
      ...d,
      ...base,
      preset,
      endpoint: str(r.endpoint, d.endpoint).trim(),
      region: str(r.region, d.region).trim() || d.region,
      bucket: str(r.bucket, "").trim(),
      prefix: str(r.prefix, d.prefix).trim(),
      accessKeyId: str(r.accessKeyId, "").trim(),
      secretKeySecret: str(r.secretKeySecret, ""),
      pathStyle: bool(r.pathStyle, d.pathStyle),
      deletePolicy: policy,
      keepVersions: int(r.keepVersions, d.keepVersions, 0, 1000),
    };
  }
  if (d.type === "git-remote") {
    const provider = r.provider === "gitee" || r.provider === "other" ? r.provider : "github";
    return {
      ...d,
      ...base,
      provider,
      url: str(r.url, "").trim(),
      branch: str(r.branch, d.branch).trim() || d.branch,
      username: str(r.username, "").trim(),
      tokenSecret: str(r.tokenSecret, ""),
      commitMessage: str(r.commitMessage, d.commitMessage) || d.commitMessage,
      authorName: str(r.authorName, d.authorName).trim() || d.authorName,
      authorEmail: str(r.authorEmail, d.authorEmail).trim() || d.authorEmail,
    };
  }
  if (d.type === "git") {
    return {
      ...d,
      ...base,
      commitMessage: str(r.commitMessage, d.commitMessage) || d.commitMessage,
      authorName: str(r.authorName, d.authorName).trim() || d.authorName,
      authorEmail: str(r.authorEmail, d.authorEmail).trim() || d.authorEmail,
    };
  }
  return {
    ...d,
    ...base,
    fileName: str(r.fileName, d.fileName) || d.fileName,
    keepCount: int(r.keepCount, d.keepCount, 0, 100000),
    keepDays: int(r.keepDays, d.keepDays, 0, 100000),
  };
}

/** 合并已保存的设置与默认值；缺少或类型不对的字段用默认值，认不出的目的地丢弃 */
export function mergeSettings(saved: unknown): MultiBackupSettings {
  const s = (typeof saved === "object" && saved !== null ? saved : {}) as Loose;
  const dests = Array.isArray(s.destinations) ? s.destinations.map(mergeDestination).filter((d): d is DestinationConfig => d !== null) : [];
  return {
    destinations: dests,
    includeConfigDir: bool(s.includeConfigDir, DEFAULT_SETTINGS.includeConfigDir),
    excludes: str(s.excludes, DEFAULT_SETTINGS.excludes),
    maxFileSizeMB: int(s.maxFileSizeMB, DEFAULT_SETTINGS.maxFileSizeMB, 1, 10240),
    debugLog: bool(s.debugLog, DEFAULT_SETTINGS.debugLog),
    logKeepDays: int(s.logKeepDays, DEFAULT_SETTINGS.logKeepDays, 1, 365),
    primaryId: dests.some((d) => d.id === s.primaryId && canBePrimary(d)) ? (s.primaryId as string) : "",
    trashKeepDays: int(s.trashKeepDays, DEFAULT_SETTINGS.trashKeepDays, 1, 3650),
    syncBeforeClose: bool(s.syncBeforeClose, DEFAULT_SETTINGS.syncBeforeClose),
    updatedAt: int(s.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    onboarding: mergeOnboarding(s.onboarding, dests.length > 0),
  };
}

/** 升级前已经有目的地的老用户：欢迎窗口和上手清单都不再出现 */
function mergeOnboarding(raw: unknown, existingUser: boolean): OnboardingState {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Loose;
  return { welcomeDone: bool(r.welcomeDone, existingUser), guideClosed: bool(r.guideClosed, existingUser) };
}

function mergeAuto(raw: unknown, d: AutoSync): AutoSync {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Loose;
  const sub = (v: unknown) => (typeof v === "object" && v !== null ? v : {}) as Loose;
  const time = str(sub(r.daily).time, d.daily.time);
  return {
    enabled: bool(r.enabled, d.enabled),
    interval: { on: bool(sub(r.interval).on, d.interval.on), minutes: int(sub(r.interval).minutes, d.interval.minutes, 1, 1440) },
    afterEdit: { on: bool(sub(r.afterEdit).on, d.afterEdit.on), seconds: int(sub(r.afterEdit).seconds, d.afterEdit.seconds, 5, 3600) },
    onStartup: bool(r.onStartup, d.onStartup),
    daily: { on: bool(sub(r.daily).on, d.daily.on), time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : d.daily.time },
  };
}

/** 能不能做主同步端：zip 只能做备份端；本地 git 仓库暂不支持（M3 决定，见决策记录） */
export function canBePrimary(d: DestinationConfig): boolean {
  return d.type !== "zip" && d.type !== "git";
}

/** 按行拆分规则文本，去掉空行与注释 */
export function splitRules(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
