import { normalizePath, type DataAdapter } from "obsidian";
import { parseHistory, type HistoryEntry } from "../core/history";
import { parseManifest, type Manifest } from "../core/manifest";
import type { StateStore } from "../core/sync";
import type { RestoreRecord } from "../core/restore";
import type { BaseEntry } from "../core/sync-planner";
import type { ConflictRecord } from "../core/two-way";

/** 同步状态与历史保存在插件目录：state/<目的地>.json、state/hash-cache.json、history.json */
export class ObsidianState implements StateStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly pluginDir: string,
  ) {}

  loadManifest(destId: string): Promise<Manifest> {
    return this.readJson(`state/${safe(destId)}.json`).then(parseManifest);
  }

  saveManifest(destId: string, m: Manifest): Promise<void> {
    return this.writeJson(`state/${safe(destId)}.json`, m);
  }

  loadHashCache(): Promise<Manifest> {
    return this.readJson("state/hash-cache.json").then(parseManifest);
  }

  saveHashCache(m: Manifest): Promise<void> {
    return this.writeJson("state/hash-cache.json", m);
  }

  async loadBase(destId: string): Promise<Map<string, BaseEntry>> {
    return parseBase(await this.readJson(`state/${safe(destId)}.base.json`));
  }

  saveBase(destId: string, base: Map<string, BaseEntry>): Promise<void> {
    return this.writeJson(`state/${safe(destId)}.base.json`, { version: 1, files: Object.fromEntries(base) });
  }

  async loadConflicts(): Promise<ConflictRecord[]> {
    return parseConflicts(await this.readJson("state/conflicts.json"));
  }

  saveConflicts(list: ConflictRecord[]): Promise<void> {
    return this.writeJson("state/conflicts.json", list);
  }

  async loadRestores(): Promise<RestoreRecord[]> {
    return parseRestores(await this.readJson("state/restores.json"));
  }

  saveRestores(list: RestoreRecord[]): Promise<void> {
    return this.writeJson("state/restores.json", list);
  }

  /** 导入配置前另存当前设置，返回文件路径 */
  async saveSettingsBackup(settings: unknown, stamp: string): Promise<string> {
    const rel = `state/settings-before-import-${stamp}.json`;
    await this.writeJson(rel, settings);
    return this.path(rel);
  }

  async removeDestination(destId: string): Promise<void> {
    const p = this.path(`state/${safe(destId)}.json`);
    if (await this.adapter.exists(p)) await this.adapter.remove(p);
    const b = this.path(`state/${safe(destId)}.base.json`);
    if (await this.adapter.exists(b)) await this.adapter.remove(b);
    // 远程 Git 在本机的仓库（只有 git 对象）
    const repo = this.repoDir(destId);
    if (await this.adapter.exists(repo)) await this.adapter.rmdir(repo, true);
  }

  /** 远程 Git 在本机的裸仓库位置：插件目录 repos/<目的地> */
  repoDir(destId: string): string {
    return this.path(`repos/${safe(destId)}`);
  }

  loadHistory(): Promise<HistoryEntry[]> {
    return this.readJson("history.json").then(parseHistory);
  }

  saveHistory(list: HistoryEntry[]): Promise<void> {
    return this.writeJson("history.json", list);
  }

  private path(rel: string): string {
    return normalizePath(`${this.pluginDir}/${rel}`);
  }

  private async readJson(rel: string): Promise<unknown> {
    const p = this.path(rel);
    try {
      if (!(await this.adapter.exists(p))) return null;
      return JSON.parse(await this.adapter.read(p)) as unknown;
    } catch {
      return null; // 文件损坏时当作没有（清单为空 → 全部重新上传，不会丢数据）
    }
  }

  private async writeJson(rel: string, data: unknown): Promise<void> {
    const p = this.path(rel);
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    await this.adapter.write(p, JSON.stringify(data));
  }
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 解析保存的 base；格式不对时当作没有（相当于首次同步：不删除任何文件，内容不同的保留两份） */
export function parseBase(raw: unknown): Map<string, BaseEntry> {
  const out = new Map<string, BaseEntry>();
  const files = (raw as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null) return out;
  for (const [path, e] of Object.entries(files as Record<string, unknown>)) {
    const b = e as Partial<BaseEntry> | null;
    if (b && typeof b.hash === "string" && typeof b.remoteId === "string") out.set(path, { hash: b.hash, remoteId: b.remoteId });
  }
  return out;
}

export function parseRestores(raw: unknown): RestoreRecord[] {
  if (!Array.isArray(raw)) return [];
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  return raw.filter((r): r is RestoreRecord => {
    const x = r as Partial<RestoreRecord> | null;
    return !!x && typeof x.id === "string" && typeof x.dir === "string" && typeof x.time === "number" && strs(x.added) && strs(x.overwritten) && strs(x.removed);
  });
}

export function parseConflicts(raw: unknown): ConflictRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is ConflictRecord =>
      typeof c === "object" && c !== null && typeof (c as ConflictRecord).path === "string" && ["both", "keepLocal", "restoreRemote"].includes((c as ConflictRecord).kind),
  );
}
