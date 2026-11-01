// 双向同步测试用：内存中的主同步端与本机写入器，以及“一台设备同步一次”的辅助函数
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import type { VaultWriter } from "../../src/core/platform";
import { scanVault } from "../../src/core/scanner";
import type { BaseEntry } from "../../src/core/sync-planner";
import { syncTwoWay, type ConflictRecord, type TwoWayResult } from "../../src/core/two-way";
import type { PrimaryStore, RemoteEntry, TestInfo } from "../../src/destinations/types";
import { MemoryVault } from "./memory-vault";

/** 远程：路径 → 内容与版本号；版本号每次写入递增 */
export class MemoryPrimary implements PrimaryStore {
  readonly kind = "primary" as const;
  files = new Map<string, { data: Uint8Array; id: string; by: string }>();
  private seq = 0;
  /** finish() 时抛错，模拟推送失败（推送失败时远程保持原样） */
  failFinish = false;
  private staged: Map<string, { data: Uint8Array; id: string; by: string }> | null = null;
  device = "remote";

  async test(): Promise<TestInfo> {
    return { freeBytes: null, existing: this.files.size };
  }
  async prepare(): Promise<void> {
    this.staged = new Map(this.files);
  }
  async list(): Promise<Map<string, RemoteEntry>> {
    return new Map([...this.files].filter(([p]) => !p.startsWith(".multi-backup/")).map(([p, f]) => [p, { id: f.id }]));
  }
  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return f.data.slice();
  }
  async matches(data: Uint8Array, id: string): Promise<boolean> {
    const r = [...this.files.values()].find((f) => f.id === id);
    return !!r && new TextDecoder().decode(r.data) === new TextDecoder().decode(data);
  }
  async put(path: string, data: Uint8Array): Promise<string> {
    const id = `v${++this.seq}`;
    (this.staged as Map<string, { data: Uint8Array; id: string; by: string }>).set(path, { data: data.slice(), id, by: this.device });
    return id;
  }
  async remove(path: string): Promise<void> {
    this.staged?.delete(path);
  }
  async finish(): Promise<void> {
    if (this.failFinish) throw new Error("push failed");
    if (this.staged) this.files = this.staged;
    this.staged = null;
  }
  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.data) : undefined;
  }
}

/** 本机写入器：回收站记录在 trashed 里 */
export class MemoryWriter implements VaultWriter {
  trashed: { path: string; content: string; moved: boolean }[] = [];
  constructor(private readonly v: MemoryVault) {}
  async exists(path: string) {
    return this.v.has(path);
  }
  async write(path: string, data: Uint8Array) {
    this.v.setBytes(path, data, Date.now());
  }
  async trash(path: string, move: boolean) {
    this.trashed.push({ path, content: this.v.text(path) ?? "", moved: move });
    if (move) this.v.delete(path);
  }
}

/** 一台设备：自己的 Vault、base、冲突登记 */
export class Device {
  vault = new MemoryVault();
  writer = new MemoryWriter(this.vault);
  base = new Map<string, BaseEntry>();
  conflicts: ConflictRecord[] = [];
  constructor(readonly name: string, readonly remote: MemoryPrimary) {}

  /** 同步一次：扫描 → 比较执行 → finish 成功后才保存 base */
  async sync(t = new Date(2026, 9, 31, 10, 42)): Promise<TwoWayResult> {
    const matcher = new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));
    const scan = await scanVault(this.vault, { matcher, maxFileSize: 1 << 30, previous: { version: 1, updatedAt: 0, files: {} } });
    this.remote.device = this.name;
    await this.remote.prepare();
    const remote = await this.remote.list();
    const res = await syncTwoWay({
      vault: this.vault,
      writer: this.writer,
      store: this.remote,
      local: scan.files,
      base: this.base,
      remote,
      matches: async (data, id) => {
        const r = [...this.remote.files.values()].find((f) => f.id === id);
        return !!r && new TextDecoder().decode(r.data) === new TextDecoder().decode(data);
      },
      remoteDevice: (path) => this.remote.files.get(path)?.by ?? "remote",
      known: this.conflicts,
      now: () => t,
    });
    // 冲突登记无论推送成败都保存（本机已经写了冲突副本）；base 只在推送成功后保存
    this.conflicts.push(...res.conflicts.filter((c) => !this.conflicts.some((k) => k.path === c.path && k.copy === c.copy)));
    await this.remote.finish();
    this.base = res.base;
    return res;
  }
}
