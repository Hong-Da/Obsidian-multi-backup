// 目的地接口：本地镜像、本地 git、WebDAV、S3（文件存储类）与 zip 快照（快照类）。

/** 文件条目的版本信息；etag 由服务器给出（WebDAV、S3），有它时优先用它判断内容是否变了 */
export interface FsEntryInfo {
  size: number;
  mtime: number;
  etag?: string;
}

/** 目标文件系统：本机文件夹（路径为本机绝对路径），或 WebDAV、S3（路径为以 / 分隔的远程路径） */
export interface TargetFs {
  join(...parts: string[]): string;
  dirname(p: string): string;
  stat(p: string): Promise<({ isDir: boolean } & FsEntryInfo) | null>;
  mkdirp(p: string): Promise<void>;
  readFile(p: string): Promise<Uint8Array>;
  /** 先写临时文件再改名，写到一半失败不会留下损坏的文件 */
  writeFile(p: string, data: Uint8Array, mtime?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  removeFile(p: string): Promise<void>;
  removeDir(p: string): Promise<void>;
  /** 列出一层；能顺便给出大小、时间、etag 的实现（WebDAV、S3）一并返回，省得逐个 stat */
  list(p: string): Promise<({ name: string; isDir: boolean } & Partial<FsEntryInfo>)[]>;
  /** 剩余空间（字节）；拿不到时返回 null */
  freeSpace(p: string): Promise<number | null>;
  openWrite(p: string): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

/** 测试连接的结果；失败时抛 DestinationError */
export interface TestInfo {
  freeBytes: number | null;
  /** 镜像：目标中已有的文件数；快照：现有快照数；git：提交数 */
  existing: number;
  /** 快照：最新快照的时间；git：最近一次提交的时间 */
  newest?: number;
  /** git：目标文件夹已经是 git 仓库 */
  isRepo?: boolean;
  /** 远程 Git：仓库是空的、已有这个分支、或有别的分支但没有这个分支 */
  remote?: "empty" | "branch" | "no-branch";
}

/** 文件存储类：逐个文件写入、移动、删除 */
export interface FileStore {
  readonly kind: "files";
  /** 同时上传几个文件（网络目的地可以大于 1；默认 1） */
  readonly parallel?: number;
  test(): Promise<TestInfo>;
  /** 同步开始前检查目标可用（不可用时抛 DestinationError，整个目的地本次跳过） */
  prepare(): Promise<void>;
  /** 写入文件；目标已有相同内容时不写，返回 "identical" */
  write(path: string, data: Uint8Array, mtime: number): Promise<"written" | "identical">;
  /** 移动文件；源文件已不存在时返回 false（由调用方改为上传） */
  move(from: string, to: string): Promise<boolean>;
  /** 删除文件（按目的地设置：移到回收站、直接删除或保留） */
  remove(path: string): Promise<void>;
  /** 同步结束后的收尾：清理回收站过期文件、git 提交等；产生提交时返回提交号 */
  finish(now: Date): Promise<FinishInfo | void>;
}

export interface FinishInfo {
  /** git 提交号（前 7 位） */
  commit?: string;
}

export interface SnapshotFile {
  path: string;
  mtime: number;
  read(): Promise<Uint8Array>;
}

/** 快照类：每次同步生成一个完整快照 */
export interface SnapshotStore {
  readonly kind: "snapshot";
  test(): Promise<TestInfo>;
  prepare(): Promise<void>;
  /** 写入一个新快照，返回文件名与大小 */
  writeSnapshot(files: SnapshotFile[], now: Date, onFile?: (done: number) => void): Promise<{ name: string; size: number }>;
  /** 按保留规则删除旧快照，返回删除的文件名 */
  prune(now: Date): Promise<string[]>;
}

/** 远程上的一个文件：id 是目的地的版本号（内容变了它就变） */
export interface RemoteEntry {
  id: string;
}

/** 可做主同步端的目的地：能列出远程现状、读取远程文件 */
export interface PrimaryStore {
  readonly kind: "primary";
  test(): Promise<TestInfo>;
  /** 同步开始前检查可用，并读出远程现状 */
  prepare(): Promise<void>;
  /** 远程现有文件（不含插件自己的 .multi-backup/） */
  list(): Promise<Map<string, RemoteEntry>>;
  read(path: string): Promise<Uint8Array>;
  /** 本机内容与远程这个版本是否相同（git 算对象号，不用下载；镜像读出来比对） */
  matches(localData: Uint8Array, remoteId: string, path: string): Promise<boolean>;
  /** 写入，返回写入后的版本号 */
  put(path: string, data: Uint8Array, mtime: number): Promise<string>;
  remove(path: string): Promise<void>;
  /** 收尾：git 在这里提交并推送；失败时抛错，这次的上传都不算数 */
  finish(now: Date): Promise<FinishInfo | void>;
}

export type DeletePolicy = "trash30" | "delete" | "keep";

/** 目标文件夹里插件自己的文件夹，放回收站、历史版本、快照索引 */
export const RESERVED_DIR = ".multi-backup";
