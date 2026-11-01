// 同步清单：记录某个目的地上次同步成功时，各文件的大小、修改时间与哈希。

export interface FileEntry {
  size: number;
  mtime: number;
  hash: string;
}

export interface Manifest {
  version: 1;
  /** 上次更新时间（毫秒） */
  updatedAt: number;
  files: Record<string, FileEntry>;
}

export function emptyManifest(): Manifest {
  return { version: 1, updatedAt: 0, files: {} };
}

/** 解析保存的清单；格式不对时返回空清单（相当于首次同步，全部重新上传，不会丢数据） */
export function parseManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null) return emptyManifest();
  const m = raw as Partial<Manifest>;
  if (m.version !== 1 || typeof m.files !== "object" || m.files === null) return emptyManifest();
  const files: Record<string, FileEntry> = {};
  for (const [path, e] of Object.entries(m.files as Record<string, unknown>)) {
    const f = e as Partial<FileEntry> | null;
    if (f && typeof f.size === "number" && typeof f.mtime === "number" && typeof f.hash === "string" && f.hash) {
      files[path] = { size: f.size, mtime: f.mtime, hash: f.hash };
    }
  }
  return { version: 1, updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : 0, files };
}
