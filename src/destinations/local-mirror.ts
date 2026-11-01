// 本地文件夹镜像：目标文件夹中保存一份与 Vault 相同的副本。
// 被覆盖的旧版本存入 .multi-backup/versions/<路径>/，Vault 中删除的文件按设置移入 .multi-backup/trash/<日期>/。

import { DestinationError, toDestinationError } from "../core/errors";
import { sha256Hex } from "../core/hash";
import { extOf, localDate, localStamp } from "../core/paths";
import type { FileVersion, RestoreSource } from "../core/restore";
import { RESERVED_DIR, type DeletePolicy, type FileStore, type FsEntryInfo, type PrimaryStore, type RemoteEntry, type TargetFs, type TestInfo } from "./types";

export interface MirrorOptions {
  /** 目标文件夹（本机绝对路径） */
  root: string;
  deletePolicy: DeletePolicy;
  /** 每个文件保留的历史版本数，0 表示不保留 */
  keepVersions: number;
  /** 回收站保留天数 */
  trashDays?: number;
  /** 上次同步后目标中的文件数（用于测试连接时显示） */
  knownFiles?: number;
  /** 目标文件夹不存在时创建（WebDAV、S3）；本机文件夹不创建：多半是移动硬盘没插 */
  createRoot?: boolean;
  /** 同时上传几个文件（WebDAV、S3 用 4；网盘同时建文件夹会出重复，用 1） */
  parallel?: number;
  now?: () => Date;
}

export class LocalMirror implements FileStore {
  readonly kind = "files" as const;
  private readonly now: () => Date;

  constructor(
    private readonly fs: TargetFs,
    private readonly o: MirrorOptions,
  ) {
    this.now = o.now ?? (() => new Date());
  }

  get parallel(): number {
    return this.o.parallel ?? 1;
  }

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
    return { freeBytes: await this.fs.freeSpace(this.o.root), existing: this.o.knownFiles ?? 0 };
  }

  async prepare(): Promise<void> {
    if (!this.o.root.trim()) throw new DestinationError("not-configured", "");
    if (this.o.createRoot) {
      await this.fs.mkdirp(this.o.root).catch((e: unknown) => {
        throw toDestinationError(e, this.o.root);
      });
      return;
    }
    const st = await this.fs.stat(this.o.root).catch((e: unknown) => {
      throw toDestinationError(e, this.o.root);
    });
    // 目标文件夹本身不存在时不自动创建：多半是移动硬盘没插，自动创建会把备份写到错误的地方
    if (!st || !st.isDir) throw new DestinationError("not-found", this.o.root);
  }

  async write(path: string, data: Uint8Array, mtime: number): Promise<"written" | "identical"> {
    const target = this.native(path);
    try {
      const st = await this.fs.stat(target);
      if (st && !st.isDir) {
        if (st.size === data.byteLength) {
          const old = await this.fs.readFile(target);
          if ((await sha256Hex(toBuffer(old))) === (await sha256Hex(toBuffer(data)))) return "identical";
        }
        if (this.o.keepVersions > 0) await this.keepVersion(path, target);
      }
      await this.fs.mkdirp(this.fs.dirname(target));
      await this.fs.writeFile(target, data, mtime);
      return "written";
    } catch (e) {
      throw toDestinationError(e, target);
    }
  }

  async move(from: string, to: string): Promise<boolean> {
    const src = this.native(from);
    const dst = this.native(to);
    try {
      if (!(await this.fs.stat(src))) return false;
      await this.fs.mkdirp(this.fs.dirname(dst));
      await this.fs.rename(src, dst);
      await this.removeEmptyParents(from);
      return true;
    } catch (e) {
      throw toDestinationError(e, src);
    }
  }

  async remove(path: string): Promise<void> {
    if (this.o.deletePolicy === "keep") return;
    const target = this.native(path);
    try {
      if (!(await this.fs.stat(target))) return;
      if (this.o.deletePolicy === "trash30") {
        const dst = this.fs.join(this.o.root, RESERVED_DIR, "trash", localDate(this.now()), ...path.split("/"));
        await this.fs.mkdirp(this.fs.dirname(dst));
        await this.fs.rename(target, dst);
      } else {
        await this.fs.removeFile(target);
      }
      await this.removeEmptyParents(path);
    } catch (e) {
      throw toDestinationError(e, target);
    }
  }

  /** 删除回收站中超过保留天数的日期文件夹 */
  async finish(now: Date): Promise<void> {
    const trash = this.fs.join(this.o.root, RESERVED_DIR, "trash");
    if (!(await this.fs.stat(trash))) return;
    const days = this.o.trashDays ?? 30;
    const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
    for (const e of await this.fs.list(trash)) {
      if (e.isDir && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name < cutoff) await this.fs.removeDir(this.fs.join(trash, e.name));
    }
  }

  /** 作为主同步端：目标文件夹里现有的文件（不含 .multi-backup/），版本号用大小与修改时间 */
  asPrimary(): PrimaryStore {
    return {
      kind: "primary",
      test: () => this.test(),
      prepare: () => this.prepare(),
      list: () => this.listAll(),
      read: async (path) => {
        try {
          return await this.fs.readFile(this.native(path));
        } catch (e) {
          throw toDestinationError(e, this.native(path));
        }
      },
      matches: (data, _id, path) => this.matches(data, path),
      put: async (path, data, mtime) => {
        await this.write(path, data, mtime);
        return this.idOf(path);
      },
      remove: (path) => this.remove(path),
      finish: (now) => this.finish(now),
    };
  }

  /** 目标文件和本机内容是否相同 */
  async matches(data: Uint8Array, path: string): Promise<boolean> {
    const remote = await this.fs.readFile(this.native(path));
    if (remote.byteLength !== data.byteLength) return false;
    return (await sha256Hex(toBuffer(remote))) === (await sha256Hex(toBuffer(data)));
  }

  private async idOf(path: string): Promise<string> {
    const st = await this.fs.stat(this.native(path));
    return st ? versionId(st) : "";
  }

  private async listAll(): Promise<Map<string, RemoteEntry>> {
    return new Map([...(await this.walkAll())].map(([p, st]) => [p, { id: versionId(st) }]));
  }

  /** 目的地里各设备上传的插件配置（.multi-backup/config/*.json 的内容） */
  async listConfigs(): Promise<Uint8Array[]> {
    const dir = this.fs.join(this.o.root, RESERVED_DIR, "config");
    try {
      if (!(await this.fs.stat(dir))) return [];
      const out: Uint8Array[] = [];
      for (const e of await this.fs.list(dir)) if (!e.isDir && e.name.endsWith(".json")) out.push(await this.fs.readFile(this.fs.join(dir, e.name)));
      return out;
    } catch (e) {
      throw toDestinationError(e, this.o.root);
    }
  }

  /** 作为恢复来源：只有“当前备份”一个时间点；单个文件另有 versions/ 里的历史版本 */
  restoreSource(): RestoreSource {
    const versionsDir = (path: string) => this.fs.join(this.o.root, RESERVED_DIR, "versions", ...path.split("/"));
    const wrap = async <T>(fn: () => Promise<T>, at: string): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        throw toDestinationError(e, at);
      }
    };
    return {
      mode: "current",
      points: async () => [{ id: "current", time: 0, title: "" }],
      files: async () => new Map([...(await this.walkAll())].map(([p, st]) => [p, { size: st.size }])),
      read: (pointId, path) => {
        const at = pointId === "current" ? this.native(path) : this.fs.join(versionsDir(path), pointId.slice(2));
        return wrap(() => this.fs.readFile(at), at);
      },
      fileVersions: (path, limit) =>
        wrap(async () => {
          const out: FileVersion[] = [];
          const st = await this.fs.stat(this.native(path));
          if (st && !st.isDir) out.push({ pointId: "current", time: st.mtime, title: "" });
          const dir = versionsDir(path);
          const names = (await this.fs.stat(dir)) ? (await this.fs.list(dir)).filter((e) => !e.isDir).map((e) => e.name) : [];
          for (const name of names.sort().reverse()) out.push({ pointId: "v:" + name, time: stampTime(name), title: "" });
          return out.slice(0, limit);
        }, this.o.root),
    };
  }

  /** 目标里的全部文件（不含 .multi-backup/ 与写入中的临时文件）及大小、修改时间 */
  private async walkAll(): Promise<Map<string, FsEntryInfo>> {
    const out = new Map<string, FsEntryInfo>();
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const e of await this.fs.list(dir)) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (!rel && e.name === RESERVED_DIR) continue;
        const full = this.fs.join(dir, e.name);
        if (e.isDir) await walk(full, r);
        else if (!e.name.endsWith(".mb-tmp")) {
          const st = e.size !== undefined && e.mtime !== undefined ? (e as FsEntryInfo) : await this.fs.stat(full);
          if (st) out.set(r, st);
        }
      }
    };
    try {
      await walk(this.o.root, "");
    } catch (e) {
      throw toDestinationError(e, this.o.root);
    }
    return out;
  }

  private native(path: string): string {
    return this.fs.join(this.o.root, ...path.split("/"));
  }

  /** 把即将被覆盖的文件移入 versions/<路径>/<时间><扩展名>，并只保留最近 keepVersions 个 */
  private async keepVersion(path: string, target: string): Promise<void> {
    const dir = this.fs.join(this.o.root, RESERVED_DIR, "versions", ...path.split("/"));
    await this.fs.mkdirp(dir);
    const ext = extOf(path);
    let name = localStamp(this.now()) + ext;
    for (let i = 1; await this.fs.stat(this.fs.join(dir, name)); i++) name = `${localStamp(this.now())}-${i}${ext}`;
    await this.fs.rename(target, this.fs.join(dir, name));
    const versions = (await this.fs.list(dir)).filter((e) => !e.isDir).map((e) => e.name).sort();
    for (const old of versions.slice(0, Math.max(0, versions.length - this.o.keepVersions))) {
      await this.fs.removeFile(this.fs.join(dir, old));
    }
  }

  /** 移动或删除后，向上删除变空的文件夹（不删除目标根目录） */
  private async removeEmptyParents(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = this.fs.join(this.o.root, ...parts.slice(0, i));
      const entries = await this.fs.list(dir).catch(() => null);
      if (!entries || entries.length > 0) return;
      await this.fs.removeDir(dir);
    }
  }
}

function toBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** 历史版本文件名开头的时间 YYYY-MM-DD_HHmmss（本地时间） */
function stampTime(name: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime() : 0;
}

/** 远程版本号：有 etag 用 etag（WebDAV、S3），否则用大小与修改时间 */
function versionId(st: FsEntryInfo): string {
  return st.etag ? `e:${st.etag}` : `${st.size}-${Math.floor(st.mtime)}`;
}
