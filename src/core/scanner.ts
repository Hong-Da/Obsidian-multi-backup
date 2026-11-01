// 扫描 Vault：列出文件、应用排除规则与大小上限、计算哈希。
// 大小和修改时间都没变的文件直接沿用上次的哈希，不重新读取。

import type { ExcludeMatcher } from "./exclude";
import { sha256Hex } from "./hash";
import type { FileEntry, Manifest } from "./manifest";
import type { VaultFs } from "./platform";

export interface ScanOptions {
  matcher: ExcludeMatcher;
  /** 单个文件大小上限（字节）；超过的跳过 */
  maxFileSize: number;
  /** 上次的清单，用于复用哈希 */
  previous?: Manifest;
  hash?: (data: ArrayBuffer) => Promise<string>;
}

export interface SkippedFile {
  path: string;
  reason: "too-large";
  size: number;
}

export interface ScanResult {
  files: Map<string, FileEntry>;
  skipped: SkippedFile[];
  /** 本次实际读取并计算哈希的文件数 */
  hashed: number;
}

export async function scanVault(fs: VaultFs, o: ScanOptions): Promise<ScanResult> {
  const hash = o.hash ?? sha256Hex;
  const listed = await fs.listFiles((dir) => !o.matcher.isExcludedDir(dir));
  const files = new Map<string, FileEntry>();
  const skipped: SkippedFile[] = [];
  let hashed = 0;

  for (const f of listed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (o.matcher.isExcludedFile(f.path)) continue;
    if (f.size > o.maxFileSize) {
      skipped.push({ path: f.path, reason: "too-large", size: f.size });
      continue;
    }
    const prev = o.previous?.files[f.path];
    if (prev && prev.size === f.size && prev.mtime === f.mtime) {
      files.set(f.path, { size: f.size, mtime: f.mtime, hash: prev.hash });
      continue;
    }
    files.set(f.path, { size: f.size, mtime: f.mtime, hash: await hash(await fs.readBinary(f.path)) });
    hashed++;
  }
  return { files, skipped, hashed };
}
