// 一次备份：扫描一遍 Vault，依次同步到各个目的地。
// 每个目的地互不影响：一个失败（例如移动硬盘没插），其他照常完成。

import type { FileStore, PrimaryStore, SnapshotFile, SnapshotStore } from "../destinations/types";
import { DestinationError, toDestinationError } from "./errors";
import { ExcludeMatcher } from "./exclude";
import { executeFilePlan, type Change, type FailedOp } from "./executor";
import type { Logger } from "./logger";
import type { FileEntry, Manifest } from "./manifest";
import { manifestAfter, planBackup } from "./planner";
import type { VaultFs, VaultWriter } from "./platform";
import { scanVault, type SkippedFile } from "./scanner";
import type { BaseEntry } from "./sync-planner";
import { syncTwoWay, type ConflictRecord } from "./two-way";

/** 同步状态的保存位置（Obsidian 中是插件目录下的 state/） */
export interface StateStore {
  loadManifest(destId: string): Promise<Manifest>;
  saveManifest(destId: string, m: Manifest): Promise<void>;
  /** 全局哈希缓存：大小与修改时间没变的文件不重新计算哈希 */
  loadHashCache(): Promise<Manifest>;
  saveHashCache(m: Manifest): Promise<void>;
  /** 主同步端：上次同步时两边的状态 */
  loadBase(destId: string): Promise<Map<string, BaseEntry>>;
  saveBase(destId: string, base: Map<string, BaseEntry>): Promise<void>;
  /** 还没处理的冲突 */
  loadConflicts(): Promise<ConflictRecord[]>;
  saveConflicts(list: ConflictRecord[]): Promise<void>;
}

export interface DestinationRun {
  id: string;
  store: FileStore | SnapshotStore;
  /** 只对这个目的地生效的额外排除规则 */
  extraExcludes: string[];
  /** 随备份上传的插件配置（.multi-backup/config/<设备>.json）；内容不变时目的地不会改动 */
  config?: ConfigUpload;
}

export interface ConfigUpload {
  path: string;
  data: Uint8Array;
}

/** 主同步端：先于各备份端，与远程双向同步 */
export interface PrimaryRun {
  id: string;
  store: PrimaryStore;
  extraExcludes: string[];
  writer: VaultWriter;
  /** 本设备名称：写进远程的 .multi-backup/devices.json，别的设备另存冲突副本时用 */
  device: string;
  config?: ConfigUpload;
}

/** 远程上记录“每个文件最后由哪台设备写入”的文件 */
export const DEVICES_FILE = ".multi-backup/devices.json";

export type DestinationStatus = "ok" | "partial" | "failed" | "unchanged";

export interface DestinationResult {
  id: string;
  status: DestinationStatus;
  uploaded: number;
  identical: number;
  moved: number;
  deleted: number;
  failed: FailedOp[];
  changes: Change[];
  /** 整个目的地失败的原因（例如目标文件夹不存在） */
  error?: DestinationError;
  snapshot?: { name: string; size: number };
  /** git 类目的地本次的提交号（前 7 位）；没有变化时不提交 */
  commit?: string;
  prunedSnapshots?: string[];
  durationMs: number;
  /** 主同步端才有 */
  primary?: { downloaded: number; deletedLocal: number; conflicts: ConflictRecord[] };
}

export interface BackupResult {
  startedAt: number;
  finishedAt: number;
  skippedLarge: SkippedFile[];
  destinations: DestinationResult[];
}

export interface BackupDeps {
  vault: VaultFs;
  state: StateStore;
  /** 全局排除规则（内置 + 用户设置） */
  matcher: ExcludeMatcher;
  maxFileSize: number;
  logger?: Logger;
  now?: () => Date;
  signal?: AbortSignal;
  onProgress?: (destId: string, done: number, total: number) => void;
}

export async function runBackup(deps: BackupDeps, dests: DestinationRun[], primary?: PrimaryRun): Promise<BackupResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().getTime();
  const log = deps.logger;

  const cache = await deps.state.loadHashCache();
  let scan = await scanVault(deps.vault, { matcher: deps.matcher, maxFileSize: deps.maxFileSize, previous: cache });
  await deps.state.saveHashCache(manifestAfter(scan.files, startedAt));
  log?.info(`scan: ${scan.files.size} files, ${scan.hashed} hashed, ${scan.skipped.length} too large`);

  const results: DestinationResult[] = [];
  if (primary && !deps.signal?.aborted) {
    const r = await syncPrimary(deps, primary, filterFiles(scan.files, primary.extraExcludes), now);
    results.push(r);
    // 本机文件变了：重新扫描（大小与时间没变的文件用缓存，不重新计算），备份端拿到的是合并后的结果
    if (r.primary && (r.primary.downloaded || r.primary.deletedLocal || r.primary.conflicts.length)) {
      scan = await scanVault(deps.vault, { matcher: deps.matcher, maxFileSize: deps.maxFileSize, previous: manifestAfter(scan.files, startedAt) });
      await deps.state.saveHashCache(manifestAfter(scan.files, now().getTime()));
    }
  }
  for (const d of dests) {
    if (deps.signal?.aborted) break;
    results.push(await backupOne(deps, d, filterFiles(scan.files, d.extraExcludes), now));
  }
  return { startedAt, finishedAt: now().getTime(), skippedLarge: scan.skipped, destinations: results };
}

async function backupOne(deps: BackupDeps, d: DestinationRun, files: Map<string, FileEntry>, now: () => Date): Promise<DestinationResult> {
  const t0 = now().getTime();
  const r: DestinationResult = { id: d.id, status: "ok", uploaded: 0, identical: 0, moved: 0, deleted: 0, failed: [], changes: [], durationMs: 0 };
  const log = deps.logger;
  try {
    const previous = await deps.state.loadManifest(d.id);
    const plan = planBackup(files, previous);

    if (d.store.kind === "snapshot") {
      if (plan.ops.length === 0 && previous.updatedAt > 0) {
        r.status = "unchanged";
      } else {
        await d.store.prepare();
        const list: SnapshotFile[] = [...files.entries()].map(([path, e]) => ({
          path,
          mtime: e.mtime,
          read: async () => new Uint8Array(await deps.vault.readBinary(path)),
        }));
        const cfg = d.config;
        if (cfg) list.push({ path: cfg.path, mtime: now().getTime(), read: async () => cfg.data });
        r.snapshot = await d.store.writeSnapshot(list, now(), (n) => deps.onProgress?.(d.id, n, list.length));
        r.uploaded = list.length;
        await deps.state.saveManifest(d.id, manifestAfter(files, now().getTime()));
      }
      r.prunedSnapshots = await d.store.prune(now());
    } else {
      await d.store.prepare();
      const ex = await executeFilePlan({
        vault: deps.vault,
        store: d.store,
        plan,
        current: files,
        previous,
        now: now().getTime(),
        signal: deps.signal,
        onProgress: (done, total) => deps.onProgress?.(d.id, done, total),
      });
      Object.assign(r, { uploaded: ex.uploaded, identical: ex.identical, moved: ex.moved, deleted: ex.deleted, failed: ex.failed, changes: ex.changes });
      if (ex.failed.length || ex.aborted) r.status = "partial";
      if (d.config) await d.store.write(d.config.path, d.config.data, now().getTime()).catch((e: unknown) => log?.warn(`config upload to ${d.id} failed`, e));
      // 先收尾再保存清单：远程 Git 在 finish 里提交并推送，推送失败时不能把这次的改动记为已同步
      const fin = await d.store.finish(now());
      if (fin?.commit) r.commit = fin.commit;
      await deps.state.saveManifest(d.id, ex.manifest);
    }
  } catch (e) {
    r.status = "failed";
    r.error = e instanceof DestinationError ? e : toDestinationError(e, d.id);
    log?.error(`destination ${d.id} failed`, r.error);
  }
  r.durationMs = now().getTime() - t0;
  log?.info(`destination ${d.id}: ${r.status}, up ${r.uploaded}, moved ${r.moved}, deleted ${r.deleted}, failed ${r.failed.length}`);
  return r;
}

/** 主同步端：读远程现状 → 三方比较执行 → 推送 → 成功后保存 base。冲突登记无论成败都保存。 */
async function syncPrimary(deps: BackupDeps, p: PrimaryRun, files: Map<string, FileEntry>, now: () => Date): Promise<DestinationResult> {
  const t0 = now().getTime();
  const r: DestinationResult = { id: p.id, status: "ok", uploaded: 0, identical: 0, moved: 0, deleted: 0, failed: [], changes: [], durationMs: 0 };
  const log = deps.logger;
  const extra = p.extraExcludes.length ? new ExcludeMatcher(p.extraExcludes) : null;
  try {
    await p.store.prepare();
    const remote = new Map([...(await p.store.list())].filter(([path]) => !deps.matcher.isExcludedFile(path) && !extra?.isExcludedFile(path)));
    let devices: Record<string, string> = {};
    try {
      devices = JSON.parse(new TextDecoder().decode(await p.store.read(DEVICES_FILE))) as Record<string, string>;
    } catch {
      devices = {};
    }
    const known = await deps.state.loadConflicts();
    const res = await syncTwoWay({
      vault: deps.vault,
      writer: p.writer,
      store: p.store,
      local: files,
      base: await deps.state.loadBase(p.id),
      remote,
      matches: (data, id, path) => p.store.matches(data, id, path),
      remoteDevice: (path) => devices[path] ?? "remote",
      known,
      now,
      signal: deps.signal,
      onProgress: (done, total) => deps.onProgress?.(p.id, done, total),
    });

    // 冲突登记：本机已经写了冲突副本，推送成败都要记下（同一副本不重复登记）
    const merged = [...known];
    for (const c of res.conflicts) if (!merged.some((k) => k.path === c.path && k.kind === c.kind && k.copy === c.copy)) merged.push(c);
    if (res.conflicts.length) await deps.state.saveConflicts(merged);

    // 记下本机写到远程的文件，别的设备另存冲突副本时用这个设备名（冲突副本记原来那台设备，要在改写原路径之前）
    let touched = false;
    for (const c of res.conflicts) if (c.copy) devices[c.copy] = devices[c.path] ?? "remote";
    for (const ch of res.changes) {
      if (ch.op === "upload" || ch.op === "conflict") {
        devices[ch.path] = p.device;
        touched = true;
      } else if (ch.op === "deleteRemote") {
        delete devices[ch.path];
        touched = true;
      }
    }
    if (touched) await p.store.put(DEVICES_FILE, new TextEncoder().encode(JSON.stringify(devices)), now().getTime());
    if (p.config) await p.store.put(p.config.path, p.config.data, now().getTime()).catch((e: unknown) => log?.warn(`config upload to ${p.id} failed`, e));

    const fin = await p.store.finish(now());
    if (fin?.commit) r.commit = fin.commit;
    await deps.state.saveBase(p.id, res.base);

    r.uploaded = res.uploaded;
    r.deleted = res.deletedRemote;
    r.primary = { downloaded: res.downloaded, deletedLocal: res.deletedLocal, conflicts: res.conflicts };
    r.changes = res.changes.map((c) => ({ op: c.op === "deleteRemote" ? "delete" : c.op, path: c.path }));
    r.failed = res.failed.map((f) => ({ path: f.path, op: f.op === "deleteRemote" ? "delete" : f.op === "caseClash" ? "download" : f.op, error: f.error }));
    if (res.failed.length) r.status = "partial";
  } catch (e) {
    r.status = "failed";
    r.error = e instanceof DestinationError ? e : toDestinationError(e, p.id);
    log?.error(`primary ${p.id} failed`, r.error);
  }
  r.durationMs = now().getTime() - t0;
  log?.info(`primary ${p.id}: ${r.status}, up ${r.uploaded}, down ${r.primary?.downloaded ?? 0}, conflicts ${r.primary?.conflicts.length ?? 0}`);
  return r;
}

function filterFiles(files: Map<string, FileEntry>, extra: string[]): Map<string, FileEntry> {
  const rules = extra.map((s) => s.trim()).filter(Boolean);
  if (!rules.length) return files;
  const m = new ExcludeMatcher(rules);
  return new Map([...files].filter(([path]) => !m.isExcludedFile(path)));
}
