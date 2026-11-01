// 备份端的同步计划：比较本次扫描结果与上次同步的清单，得出要做的操作。纯函数。
// 主同步端的三方比较在 M3 实现。

import type { FileEntry, Manifest } from "./manifest";

export type BackupOp =
  | { type: "upload"; path: string; reason: "new" | "changed" }
  | { type: "move"; from: string; to: string }
  | { type: "delete"; path: string };

export interface BackupPlan {
  /** 顺序：移动 → 上传 → 删除。删除放最后，中途失败时目的地不会先丢文件 */
  ops: BackupOp[];
  unchanged: number;
}

export function planBackup(current: Map<string, FileEntry>, last: Manifest): BackupPlan {
  const uploads: BackupOp[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const [path, cur] of current) {
    const prev = last.files[path];
    if (!prev) added.push(path);
    else if (prev.hash !== cur.hash) uploads.push({ type: "upload", path, reason: "changed" });
    else unchanged++;
  }
  for (const path of Object.keys(last.files)) if (!current.has(path)) removed.push(path);

  // 重命名：删除的路径与新增的路径内容相同 → 移动，不必重新上传。
  // 同一内容有多个候选时按路径排序一一配对；空文件不配对（内容相同没有意义）。
  const moves: BackupOp[] = [];
  const byHash = new Map<string, string[]>();
  for (const path of [...added].sort()) {
    const e = current.get(path) as FileEntry;
    if (e.size === 0) continue;
    const list = byHash.get(e.hash) ?? [];
    list.push(path);
    byHash.set(e.hash, list);
  }
  const movedTo = new Set<string>();
  const deletes: BackupOp[] = [];
  for (const path of [...removed].sort()) {
    const prev = last.files[path] as FileEntry;
    const target = prev.size > 0 ? byHash.get(prev.hash)?.shift() : undefined;
    if (target) {
      moves.push({ type: "move", from: path, to: target });
      movedTo.add(target);
    } else deletes.push({ type: "delete", path });
  }
  for (const path of added) if (!movedTo.has(path)) uploads.push({ type: "upload", path, reason: "new" });

  uploads.sort((a, b) => cmp((a as { path: string }).path, (b as { path: string }).path));
  return { ops: [...moves, ...uploads, ...deletes], unchanged };
}

/** 按计划成功执行后的新清单：以本次扫描结果为准 */
export function manifestAfter(current: Map<string, FileEntry>, now: number): Manifest {
  return { version: 1, updatedAt: now, files: Object.fromEntries(current) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
