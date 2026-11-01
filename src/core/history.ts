// 同步历史：每次同步一条记录，保存在插件目录 history.json，只保留最近 200 条。

import type { DestinationErrorCode } from "./errors";
import type { Change } from "./executor";
import type { BackupResult, DestinationStatus } from "./sync";

export type Trigger = "ribbon" | "sidebar" | "command" | "status-bar" | "settings" | "auto" | "quit";

export interface HistoryDestination {
  id: string;
  name: string;
  type: string;
  status: DestinationStatus;
  uploaded: number;
  moved: number;
  deleted: number;
  failedCount: number;
  errorCode?: DestinationErrorCode;
  errorPath?: string;
  snapshot?: string;
  /** git 提交号（前 7 位） */
  commit?: string;
  /** 主同步端：从远程下载的文件数、本次新出现的冲突数 */
  primary?: { downloaded: number; conflicts: number };
  /** 最多记录 20 条，changeCount 为总数 */
  changes: Change[];
  changeCount: number;
  failures: { path: string; op: string; code: DestinationErrorCode }[];
  durationMs: number;
}

export interface HistoryEntry {
  id: string;
  startedAt: number;
  finishedAt: number;
  trigger: Trigger;
  skippedLarge: { path: string; size: number }[];
  destinations: HistoryDestination[];
}

export const HISTORY_LIMIT = 200;
const DETAIL_LIMIT = 20;

export function toHistoryEntry(
  result: BackupResult,
  trigger: Trigger,
  names: Record<string, { name: string; type: string }>,
): HistoryEntry {
  return {
    id: `${result.startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    trigger,
    skippedLarge: result.skippedLarge.slice(0, DETAIL_LIMIT).map((s) => ({ path: s.path, size: s.size })),
    destinations: result.destinations.map((d) => ({
      id: d.id,
      name: names[d.id]?.name ?? d.id,
      type: names[d.id]?.type ?? "",
      status: d.status,
      uploaded: d.uploaded,
      moved: d.moved,
      deleted: d.deleted,
      failedCount: d.failed.length,
      errorCode: d.error?.code ?? d.failed[0]?.error.code,
      errorPath: d.error?.path ?? d.failed[0]?.path,
      snapshot: d.snapshot?.name,
      commit: d.commit,
      primary: d.primary ? { downloaded: d.primary.downloaded, conflicts: d.primary.conflicts.length } : undefined,
      changes: d.changes.slice(0, DETAIL_LIMIT),
      changeCount: d.changes.length,
      failures: d.failed.slice(0, DETAIL_LIMIT).map((f) => ({ path: f.path, op: f.op, code: f.error.code })),
      durationMs: d.durationMs,
    })),
  };
}

/** 新记录放最前面，超出上限的丢弃 */
export function appendHistory(list: HistoryEntry[], entry: HistoryEntry, limit = HISTORY_LIMIT): HistoryEntry[] {
  return [entry, ...list].slice(0, limit);
}

/** 读取保存的历史；格式不对的条目丢弃 */
export function parseHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is HistoryEntry =>
      typeof e === "object" && e !== null && typeof (e as HistoryEntry).startedAt === "number" && Array.isArray((e as HistoryEntry).destinations),
  );
}

/** 某个目的地最近一次的结果 */
export function lastResultOf(list: HistoryEntry[], destId: string): { entry: HistoryEntry; dest: HistoryDestination } | null {
  for (const entry of list) {
    const dest = entry.destinations.find((d) => d.id === destId);
    if (dest) return { entry, dest };
  }
  return null;
}
