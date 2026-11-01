// 按备份计划写入文件存储类目的地。每成功一步就更新一步清单：
// 中途失败或被中断时，清单只记录已经完成的部分，失败的文件下次自动重试。

import type { FileStore } from "../destinations/types";
import { toDestinationError, type DestinationError } from "./errors";
import type { FileEntry, Manifest } from "./manifest";
import type { BackupOp, BackupPlan } from "./planner";
import type { VaultFs } from "./platform";

export interface FailedOp {
  path: string;
  op: Change["op"];
  error: DestinationError;
}

export interface Change {
  /** download、deleteLocal、conflict 只出现在主同步端 */
  op: "upload" | "move" | "delete" | "download" | "deleteLocal" | "conflict";
  path: string;
}

export interface ExecuteResult {
  uploaded: number;
  /** 目标中已有相同内容、没有重新写入的文件数 */
  identical: number;
  moved: number;
  deleted: number;
  failed: FailedOp[];
  /** 成功完成的操作（写入同步历史） */
  changes: Change[];
  aborted: boolean;
  manifest: Manifest;
}

export interface ExecuteArgs {
  vault: VaultFs;
  store: FileStore;
  plan: BackupPlan;
  current: Map<string, FileEntry>;
  previous: Manifest;
  now: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export async function executeFilePlan(a: ExecuteArgs): Promise<ExecuteResult> {
  const files: Record<string, FileEntry> = { ...a.previous.files };
  // 内容没变的文件：清单更新为本次的大小与修改时间
  for (const [path, e] of a.current) if (files[path]?.hash === e.hash) files[path] = e;

  const r: ExecuteResult = {
    uploaded: 0,
    identical: 0,
    moved: 0,
    deleted: 0,
    failed: [],
    changes: [],
    aborted: false,
    manifest: { version: 1, updatedAt: a.now, files },
  };
  const total = a.plan.ops.length;
  let done = 0;

  const upload = async (path: string) => {
    const e = a.current.get(path) as FileEntry;
    const data = new Uint8Array(await a.vault.readBinary(path));
    const res = await a.store.write(path, data, e.mtime);
    if (res === "identical") r.identical++;
    else {
      r.uploaded++;
      r.changes.push({ op: "upload", path });
    }
    files[path] = e;
  };

  const run = async (op: BackupOp) => {
    const path = op.type === "move" ? op.to : op.path;
    try {
      if (op.type === "upload") await upload(op.path);
      else if (op.type === "move") {
        if (await a.store.move(op.from, op.to)) {
          r.moved++;
          r.changes.push({ op: "move", path: op.to });
          files[op.to] = a.current.get(op.to) as FileEntry;
        } else await upload(op.to); // 目标里旧文件已经不在了，改为上传
        delete files[op.from];
      } else {
        await a.store.remove(op.path);
        r.deleted++;
        r.changes.push({ op: "delete", path: op.path });
        delete files[op.path];
      }
    } catch (e) {
      r.failed.push({ path, op: op.type, error: toDestinationError(e, path) });
    }
    a.onProgress?.(++done, total);
  };

  // 移动、删除按顺序做；连续的上传按目的地允许的数量同时进行
  const width = Math.max(1, a.store.parallel ?? 1);
  const ops = a.plan.ops;
  for (let i = 0; i < ops.length && !r.aborted;) {
    if (a.signal?.aborted) {
      r.aborted = true;
      break;
    }
    const op = ops[i] as BackupOp;
    if (op.type !== "upload" || width === 1) {
      await run(op);
      i++;
      continue;
    }
    let end = i;
    while (end < ops.length && ops[end]?.type === "upload") end++;
    let next = i;
    const worker = async () => {
      while (next < end) {
        if (a.signal?.aborted) {
          r.aborted = true;
          return;
        }
        await run(ops[next++] as BackupOp);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, end - i) }, worker));
    i = end;
  }
  return r;
}
