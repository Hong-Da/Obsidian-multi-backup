// zip 快照：每次同步把 Vault 打包成一个带时间的 zip，按保留规则清理旧快照。
// 快照清单记在目标文件夹的 .multi-backup/snapshots.json，改了文件名模板或重装插件也能正确清理。

import { yieldToUi } from "../core/timers";
import { unzipSync, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { DestinationError, toDestinationError } from "../core/errors";
import { snapshotFileName } from "../core/paths";
import type { FileVersion, RestoreSource } from "../core/restore";
import { RESERVED_DIR, type SnapshotFile, type SnapshotStore, type TargetFs, type TestInfo } from "./types";

/** 分段压缩的段大小 */
const ZIP_CHUNK = 512 * 1024;

export interface ZipOptions {
  root: string;
  vaultName: string;
  /** 文件名模板，可用 {vault} {date} {time} */
  fileName: string;
  /** 保留最近几个，0 表示不限 */
  keepCount: number;
  /** 保留多少天内的，0 表示不限 */
  keepDays: number;
}

interface SnapshotRecord {
  name: string;
  createdAt: number;
  size: number;
}

// 已经压缩过的格式只打包不压缩，省时间
const STORED = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".heic",
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".mp3",
  ".m4a",
  ".ogg",
  ".flac",
  ".zip",
  ".7z",
  ".gz",
  ".rar",
]);

export class LocalZip implements SnapshotStore {
  readonly kind = "snapshot" as const;

  constructor(
    private readonly fs: TargetFs,
    private readonly o: ZipOptions,
  ) {}

  async test(): Promise<TestInfo> {
    await this.prepare();
    const probe = this.fs.join(this.o.root, RESERVED_DIR, ".probe");
    try {
      await this.fs.mkdirp(this.fs.dirname(probe));
      await this.fs.writeFile(probe, new Uint8Array([1]));
      await this.fs.removeFile(probe);
    } catch (e) {
      throw toDestinationError(e, this.o.root);
    }
    const list = await this.readIndex();
    return {
      freeBytes: await this.fs.freeSpace(this.o.root),
      existing: list.length,
      newest: list.length ? Math.max(...list.map((s) => s.createdAt)) : undefined,
    };
  }

  async prepare(): Promise<void> {
    if (!this.o.root.trim()) throw new DestinationError("not-configured", "");
    const st = await this.fs.stat(this.o.root).catch((e: unknown) => {
      throw toDestinationError(e, this.o.root);
    });
    if (!st || !st.isDir) throw new DestinationError("not-found", this.o.root);
  }

  async writeSnapshot(
    files: SnapshotFile[],
    now: Date,
    onFile?: (done: number) => void,
  ): Promise<{ name: string; size: number }> {
    const name = await this.uniqueName(snapshotFileName(this.o.fileName, this.o.vaultName, now));
    const finalPath = this.fs.join(this.o.root, name);
    const partial = finalPath + ".partial";
    let size = 0;
    let handle: Awaited<ReturnType<TargetFs["openWrite"]>> | null = null;
    try {
      const out = await this.fs.openWrite(partial);
      handle = out;
      // fflate 同步产出数据块，这里串成一个写入队列，按顺序写盘
      let queue: Promise<void> = Promise.resolve();
      let failed: unknown = null;
      let finished!: () => void;
      const done = new Promise<void>((r) => (finished = r));
      const zip = new Zip((err, chunk, final) => {
        if (err) {
          failed ??= err;
          finished();
          return;
        }
        size += chunk.byteLength;
        queue = queue.then(() => out.write(chunk)).catch((e: unknown) => void (failed ??= e));
        if (final) void queue.then(finished);
      });
      let n = 0;
      for (const f of files) {
        if (failed) break;
        const data = await f.read();
        const entry = STORED.has(extOfLower(f.path))
          ? new ZipPassThrough(f.path)
          : new ZipDeflate(f.path, { level: 6 });
        entry.mtime = new Date(f.mtime);
        zip.add(entry);
        // 分段压缩，段与段之间让出主线程：大文件压缩时编辑笔记不卡
        for (let at = 0; ; at += ZIP_CHUNK) {
          const last = at + ZIP_CHUNK >= data.byteLength;
          entry.push(data.subarray(at, at + ZIP_CHUNK), last);
          if (last) break;
          await yieldToUi();
        }
        await queue; // 等这个文件写完再读下一个，内存里只有一个文件的数据
        onFile?.(++n);
      }
      if (failed) finished();
      else zip.end();
      await done;
      await queue;
      handle = null;
      await out.close();
      if (failed) throw failed instanceof Error ? failed : new Error("zip failed");
      await this.fs.rename(partial, finalPath);
    } catch (e) {
      // 出错时先关闭文件再删除半截的临时文件
      await handle?.close().catch(() => undefined);
      await this.fs.removeFile(partial).catch(() => undefined);
      throw toDestinationError(e, finalPath);
    }
    const index = await this.readIndex();
    index.push({ name, createdAt: now.getTime(), size });
    await this.writeIndex(index);
    return { name, size };
  }

  async prune(now: Date): Promise<string[]> {
    const index = (await this.readIndex()).sort((a, b) => b.createdAt - a.createdAt);
    const minTime = this.o.keepDays > 0 ? now.getTime() - this.o.keepDays * 86_400_000 : -Infinity;
    const keep: SnapshotRecord[] = [];
    const removed: string[] = [];
    index.forEach((s, i) => {
      const byCount = this.o.keepCount <= 0 || i < this.o.keepCount;
      // 最新的一个总是保留，即使已经超过天数
      if (i === 0 || (byCount && s.createdAt >= minTime)) keep.push(s);
      else removed.push(s.name);
    });
    for (const name of removed) await this.fs.removeFile(this.fs.join(this.o.root, name)).catch(() => undefined);
    if (removed.length) await this.writeIndex(keep);
    return removed;
  }

  /** 最新快照里各设备上传的插件配置 */
  async listConfigs(): Promise<Uint8Array[]> {
    const latest = (await this.readIndex()).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latest) return [];
    const at = this.fs.join(this.o.root, latest.name);
    let data: Uint8Array;
    try {
      data = await this.fs.readFile(at);
    } catch (e) {
      throw toDestinationError(e, at);
    }
    const prefix = RESERVED_DIR + "/config/";
    return Object.values(unzipSync(data, { filter: (f) => f.name.startsWith(prefix) && f.name.endsWith(".json") }));
  }

  /** 作为恢复来源：每个快照是一个时间点。读出的 zip 只缓存最近一个 */
  restoreSource(): RestoreSource {
    let cached: { name: string; data: Uint8Array } | null = null;
    const load = async (name: string): Promise<Uint8Array> => {
      if (cached?.name === name) return cached.data;
      const at = this.fs.join(this.o.root, name);
      try {
        cached = { name, data: await this.fs.readFile(at) };
      } catch (e) {
        throw toDestinationError(e, at);
      }
      return cached.data;
    };
    const entries = async (name: string) => {
      const out = new Map<string, { size?: number }>();
      unzipSync(await load(name), {
        filter: (f) => {
          // 插件自己的 .multi-backup/（例如随快照保存的插件配置）不算 Vault 里的文件
          if (!f.name.endsWith("/") && !f.name.startsWith(RESERVED_DIR + "/"))
            out.set(f.name, { size: f.originalSize });
          return false;
        },
      });
      return out;
    };
    const points = async () => (await this.readIndex()).sort((a, b) => b.createdAt - a.createdAt);
    return {
      mode: "snapshots",
      points: async (limit) =>
        (await points()).slice(0, limit).map((s) => ({ id: s.name, time: s.createdAt, title: s.name })),
      files: entries,
      read: async (name, path) => {
        const data = unzipSync(await load(name), { filter: (f) => f.name === path })[path];
        if (!data) throw new DestinationError("io", path);
        return data;
      },
      // 每个快照都要整个读出来才能知道有没有这个文件，只看最近几个
      fileVersions: async (path, limit) => {
        const out: FileVersion[] = [];
        for (const s of (await points()).slice(0, Math.min(limit, 5))) {
          if ((await entries(s.name).catch(() => new Map())).has(path))
            out.push({ pointId: s.name, time: s.createdAt, title: s.name });
        }
        return out;
      },
    };
  }

  private async uniqueName(base: string): Promise<string> {
    let name = base;
    for (let i = 2; await this.fs.stat(this.fs.join(this.o.root, name)); i++)
      name = base.replace(/\.zip$/i, `_${i}.zip`);
    return name;
  }

  private indexPath(): string {
    return this.fs.join(this.o.root, RESERVED_DIR, "snapshots.json");
  }

  private async readIndex(): Promise<SnapshotRecord[]> {
    try {
      const raw = JSON.parse(new TextDecoder().decode(await this.fs.readFile(this.indexPath()))) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (s): s is SnapshotRecord =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as SnapshotRecord).name === "string" &&
          typeof (s as SnapshotRecord).createdAt === "number",
      );
    } catch {
      return [];
    }
  }

  private async writeIndex(list: SnapshotRecord[]): Promise<void> {
    await this.fs.mkdirp(this.fs.dirname(this.indexPath()));
    await this.fs.writeFile(this.indexPath(), new TextEncoder().encode(JSON.stringify(list, null, 2)));
  }
}

function extOfLower(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}
