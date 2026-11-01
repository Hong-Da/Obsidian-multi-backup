// 主同步端的双向同步：比较 → 执行 → 得出新的 base。
//
// 安全规则：
// - 覆盖或删除本机文件前，先确认它和扫描时一样（同步过程中又被编辑过就跳过，下次再同步），再把原文件放进回收站。
// - 冲突时本机版本留在原处并上传，远程版本另存为冲突副本（副本也上传），各设备最终一致。
// - 新的 base 由调用方在 store.finish() 成功后才保存：推送失败时这次的上传都不算数，下次重做。

import { conflictName, withSuffix } from "./conflict";
import { DestinationError, toDestinationError } from "./errors";
import { sha256Hex } from "./hash";
import type { FileEntry } from "./manifest";
import type { VaultFs, VaultWriter } from "./platform";
import { compareCandidates, planSync, type BaseEntry, type SyncOp, type SyncPlan } from "./sync-planner";
import type { PrimaryStore, RemoteEntry } from "../destinations/types";

export type ConflictKind = "both" | "keepLocal" | "restoreRemote";

export interface ConflictRecord {
  path: string;
  kind: ConflictKind;
  /** 两边都改了时，远程版本另存的冲突副本 */
  copy?: string;
  /** 远程版本的版本号（同一冲突重试时不再另存一份） */
  remoteId?: string;
  /** 远程最后修改它的设备 */
  device?: string;
  time: number;
}

export type TwoWayOpName = "upload" | "download" | "deleteLocal" | "deleteRemote" | "conflict" | "caseClash";

export interface TwoWayFailure {
  path: string;
  op: TwoWayOpName;
  error: DestinationError;
}

export interface TwoWayChange {
  op: "upload" | "download" | "deleteLocal" | "deleteRemote" | "conflict";
  path: string;
}

export interface TwoWayResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: ConflictRecord[];
  failed: TwoWayFailure[];
  changes: TwoWayChange[];
  /** store.finish() 成功后才保存 */
  base: Map<string, BaseEntry>;
  unchanged: number;
}

export interface TwoWayArgs {
  vault: VaultFs;
  writer: VaultWriter;
  store: PrimaryStore;
  /** 本次扫描结果（已按排除规则过滤） */
  local: Map<string, FileEntry>;
  base: Map<string, BaseEntry>;
  /** 远程现状（已按排除规则过滤） */
  remote: Map<string, RemoteEntry>;
  /** 本机内容与远程某个版本是否相同 */
  matches(localData: Uint8Array, remoteId: string, path: string): Promise<boolean>;
  /** 远程版本另存冲突副本时用的设备名（远程最后修改它的设备；不知道时用“remote”） */
  remoteDevice(path: string): string;
  /** 已登记、还没处理的冲突（同一远程版本不再另存副本） */
  known?: ConflictRecord[];
  now: () => Date;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** 只比较、不执行：设为主同步端前先告诉用户首次同步会做什么 */
export async function planTwoWay(a: Pick<TwoWayArgs, "vault" | "local" | "base" | "remote" | "matches">): Promise<SyncPlan> {
  // 内容需要比对的路径：两边都有，且没有 base 或两边都变了
  const same = new Set<string>();
  for (const path of compareCandidates(a.local, a.base, a.remote)) {
    const r = a.remote.get(path) as RemoteEntry;
    if (await a.matches(new Uint8Array(await a.vault.readBinary(path)), r.id, path)) same.add(path);
  }
  return planSync(a.local, a.base, a.remote, same);
}

export async function syncTwoWay(a: TwoWayArgs): Promise<TwoWayResult> {
  const readLocal = async (path: string) => new Uint8Array(await a.vault.readBinary(path));
  const hashOf = async (d: Uint8Array) => sha256Hex(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
  const plan = await planTwoWay(a);

  const base = new Map(a.base);
  const res: TwoWayResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], failed: [], changes: [], base, unchanged: plan.unchanged };
  const total = plan.ops.length;
  let done = 0;

  /** 覆盖或删除本机文件前确认它没在同步中被改过 */
  const assertUnchanged = async (path: string) => {
    const e = a.local.get(path);
    if (!e || !(await a.writer.exists(path))) return;
    if ((await hashOf(await readLocal(path))) !== e.hash) throw new DestinationError("local-changed", path);
  };

  const upload = async (path: string) => {
    const data = await readLocal(path);
    const e = a.local.get(path) as FileEntry;
    const id = await a.store.put(path, data, e.mtime);
    base.set(path, { hash: await hashOf(data), remoteId: id });
    res.uploaded++;
  };

  const download = async (path: string) => {
    const r = a.remote.get(path) as RemoteEntry;
    const data = await a.store.read(path);
    await assertUnchanged(path);
    if (await a.writer.exists(path)) await a.writer.trash(path, false);
    await a.writer.write(path, data);
    base.set(path, { hash: await hashOf(data), remoteId: r.id });
    res.downloaded++;
  };

  for (const op of plan.ops) {
    if (a.signal?.aborted) break;
    try {
      await run(op);
    } catch (e) {
      res.failed.push({ path: op.path, op: opName(op), error: toDestinationError(e, op.path) });
    }
    a.onProgress?.(++done, total);
  }
  return res;

  async function run(op: SyncOp): Promise<void> {
    const path = op.path;
    switch (op.type) {
      case "upload":
        await upload(path);
        res.changes.push({ op: "upload", path });
        return;
      case "download":
        await download(path);
        res.changes.push({ op: "download", path });
        return;
      case "keepLocal":
        await upload(path);
        res.conflicts.push({ path, kind: "keepLocal", device: a.remoteDevice(path), time: a.now().getTime() });
        res.changes.push({ op: "upload", path });
        return;
      case "restoreRemote":
        await download(path);
        res.conflicts.push({ path, kind: "restoreRemote", device: a.remoteDevice(path), time: a.now().getTime() });
        res.changes.push({ op: "download", path });
        return;
      case "deleteLocal":
        await assertUnchanged(path);
        await a.writer.trash(path, true);
        base.delete(path);
        res.deletedLocal++;
        res.changes.push({ op: "deleteLocal", path });
        return;
      case "deleteRemote":
        await a.store.remove(path);
        base.delete(path);
        res.deletedRemote++;
        res.changes.push({ op: "deleteRemote", path });
        return;
      case "link": {
        const l = a.local.get(path) as FileEntry;
        base.set(path, { hash: l.hash, remoteId: (a.remote.get(path) as RemoteEntry).id });
        return;
      }
      case "forget":
        base.delete(path);
        return;
      case "caseClash":
        throw new DestinationError("case-clash", `${op.path} ↔ ${op.local}`);
      case "conflict":
        await conflict(path);
        return;
    }
  }

  /** 远程版本另存为冲突副本（也上传），本机版本上传到原路径 */
  async function conflict(path: string): Promise<void> {
    const r = a.remote.get(path) as RemoteEntry;
    const known = a.known?.find((k) => k.path === path && k.kind === "both" && k.remoteId === r.id && k.copy);
    let copy = known?.copy;
    if (!copy || !(await a.writer.exists(copy))) {
      const data = await a.store.read(path);
      copy = conflictName(path, a.remoteDevice(path), a.now());
      for (let n = 2; await a.writer.exists(copy); n++) copy = withSuffix(conflictName(path, a.remoteDevice(path), a.now()), n);
      await a.writer.write(copy, data);
      const copyId = await a.store.put(copy, data, a.now().getTime());
      base.set(copy, { hash: await hashOf(data), remoteId: copyId });
    }
    await upload(path);
    res.uploaded--; // 计入冲突，不算普通上传
    res.conflicts.push({ path, kind: "both", copy, remoteId: r.id, device: a.remoteDevice(path), time: a.now().getTime() });
    res.changes.push({ op: "conflict", path });
  }
}

function opName(op: SyncOp): TwoWayOpName {
  switch (op.type) {
    case "keepLocal":
      return "upload";
    case "restoreRemote":
      return "download";
    case "link":
    case "forget":
      return "upload";
    default:
      return op.type;
  }
}
