// 从备份恢复（按 M4 预览页 restore.html 与评审结论）：
// 只把目的地里的文件写回本机，不改动任何目的地；被覆盖或移走的本机文件先另存到 restore-<时间>/，可以撤销。
// 整个 Vault 恢复时默认不删除本机多出的文件。

import { sha256Hex } from "./hash";

/** 一个可恢复的时间点：git 的提交、zip 的快照，或镜像的“当前备份” */
export interface RestorePoint {
  id: string;
  /** 毫秒；镜像的当前备份为 0（由界面用上次同步时间） */
  time: number;
  /** 提交说明第一行或快照文件名 */
  title: string;
  /** git 提交号前 7 位 */
  short?: string;
}

/** 单个文件在某个目的地的一个版本 */
export interface FileVersion {
  pointId: string;
  time: number;
  title: string;
  short?: string;
}

/** 目的地作为恢复来源 */
export interface RestoreSource {
  /** commits：git 提交；snapshots：zip 快照；current：镜像只有当前备份（另有单个文件的历史版本） */
  readonly mode: "commits" | "snapshots" | "current";
  /** 从新到旧，最多 limit 个 */
  points(limit: number): Promise<RestorePoint[]>;
  /** 这个时间点的全部文件（Vault 内的路径），不含插件自己的 .multi-backup/ */
  files(pointId: string): Promise<Map<string, { size?: number }>>;
  read(pointId: string, path: string): Promise<Uint8Array>;
  /** 这个文件的各个版本，从新到旧 */
  fileVersions(path: string, limit: number): Promise<FileVersion[]>;
  /** Git：仓库里的分支，第一个是现在读取的分支（目的地设置里的分支） */
  branches?(): Promise<string[]>;
  /** Git：读取另一个分支（只读，不改设置） */
  onBranch?(name: string): RestoreSource;
}

export interface LocalFileInfo {
  size: number;
  hash: string;
}

export interface RestorePlan {
  /** 本机没有，写回 */
  add: string[];
  /** 本机内容不同，覆盖（先另存） */
  overwrite: string[];
  /** 和本机相同，跳过 */
  same: string[];
  /** 本机有、这个版本没有，移走（只在整个 Vault 恢复并勾选时） */
  remove: string[];
}

export async function hashOf(data: Uint8Array): Promise<string> {
  return sha256Hex(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
}

/**
 * 比较备份与本机，得出恢复计划。大小不同直接算覆盖；大小相同或未知时读出来比对内容。
 * include 决定恢复范围；removeExtra 只应在整个 Vault 恢复时打开。
 */
export async function planRestore(o: {
  remote: Map<string, { size?: number }>;
  local: Map<string, LocalFileInfo>;
  include: (path: string) => boolean;
  removeExtra: boolean;
  read: (path: string) => Promise<Uint8Array>;
  onProgress?: (done: number, total: number) => void;
}): Promise<RestorePlan> {
  const plan: RestorePlan = { add: [], overwrite: [], same: [], remove: [] };
  const paths = [...o.remote.keys()].filter(o.include).sort();
  let done = 0;
  for (const p of paths) {
    const local = o.local.get(p);
    const size = o.remote.get(p)?.size;
    if (!local) plan.add.push(p);
    else if (size !== undefined && size !== local.size) plan.overwrite.push(p);
    else {
      const data = await o.read(p);
      if (data.byteLength === local.size && (await hashOf(data)) === local.hash) plan.same.push(p);
      else plan.overwrite.push(p);
    }
    o.onProgress?.(++done, paths.length);
  }
  if (o.removeExtra) plan.remove = [...o.local.keys()].filter((p) => o.include(p) && !o.remote.has(p)).sort();
  return plan;
}

/** 恢复与撤销对本机文件的操作 */
export interface RestoreIo {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** 把本机文件复制到 dir/<原路径>；move 为 true 时随后移走原文件 */
  stash(path: string, dir: string, move: boolean): Promise<void>;
}

/** 一次恢复的记录，用于撤销 */
export interface RestoreRecord {
  id: string;
  time: number;
  destId: string;
  destName: string;
  /** 恢复的是哪个版本（界面文字） */
  point: string;
  /** 被覆盖、被移走的本机文件另存在这里 */
  dir: string;
  added: string[];
  overwritten: string[];
  removed: string[];
  failed: number;
  undone?: boolean;
}

export interface RestoreResult {
  added: string[];
  overwritten: string[];
  removed: string[];
  failed: { path: string; error: unknown }[];
}

/** 按计划恢复。每个文件单独处理，一个失败不影响其他 */
export async function executeRestore(
  plan: RestorePlan,
  o: { read: (path: string) => Promise<Uint8Array>; io: RestoreIo; dir: string; onProgress?: (done: number, total: number) => void },
): Promise<RestoreResult> {
  const r: RestoreResult = { added: [], overwritten: [], removed: [], failed: [] };
  const total = plan.add.length + plan.overwrite.length + plan.remove.length;
  let done = 0;
  const step = async (path: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      r.failed.push({ path, error });
    }
    o.onProgress?.(++done, total);
  };
  for (const p of [...plan.add, ...plan.overwrite]) {
    await step(p, async () => {
      const data = await o.read(p);
      // 计划之后本机又出现了这个文件，也按覆盖处理：先另存
      const existed = await o.io.exists(p);
      if (existed) await o.io.stash(p, o.dir, false);
      await o.io.write(p, data);
      (existed ? r.overwritten : r.added).push(p);
    });
  }
  for (const p of plan.remove) {
    await step(p, async () => {
      if (!(await o.io.exists(p))) return;
      await o.io.stash(p, o.dir, true);
      r.removed.push(p);
    });
  }
  return r;
}

/**
 * 撤销一次恢复：恢复时写回的文件移走，被覆盖、被移走的放回原样。
 * 现在的本机文件都先另存到 undoDir，撤销本身也不会丢数据。
 */
export async function undoRestore(rec: RestoreRecord, io: RestoreIo, undoDir: string): Promise<{ failed: { path: string; error: unknown }[] }> {
  const failed: { path: string; error: unknown }[] = [];
  const step = async (path: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      failed.push({ path, error });
    }
  };
  for (const p of rec.added) {
    await step(p, async () => {
      if (await io.exists(p)) await io.stash(p, undoDir, true);
    });
  }
  for (const p of [...rec.overwritten, ...rec.removed]) {
    await step(p, async () => {
      const saved = await io.read(`${rec.dir}/${p}`);
      if (await io.exists(p)) await io.stash(p, undoDir, false);
      await io.write(p, saved);
    });
  }
  return { failed };
}

/** 整个 Vault 或选中的文件夹与文件：路径等于或在某个选中的文件夹下 */
export function scopeMatcher(selected: string[] | null): (path: string) => boolean {
  if (!selected) return () => true;
  const set = new Set(selected);
  return (p) => {
    if (set.has(p)) return true;
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) if (set.has(p.slice(0, i))) return true;
    return false;
  };
}
