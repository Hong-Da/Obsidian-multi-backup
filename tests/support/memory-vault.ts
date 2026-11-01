import type { FileStat, VaultFs } from "../../src/core/platform";

/** 内存中的 Vault：记录读取次数与进入过的文件夹，便于断言 */
export class MemoryVault implements VaultFs {
  reads: string[] = [];
  visitedDirs: string[] = [];
  private readonly files = new Map<string, { data: Uint8Array; mtime: number }>();

  set(path: string, content: string, mtime = 1000): this {
    this.files.set(path, { data: new TextEncoder().encode(content), mtime });
    return this;
  }

  delete(path: string): this {
    this.files.delete(path);
    return this;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.data) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  setBytes(path: string, data: Uint8Array, mtime = 1000): this {
    this.files.set(path, { data: data.slice(), mtime });
    return this;
  }

  async listFiles(descend: (folderPath: string) => boolean): Promise<FileStat[]> {
    const out: FileStat[] = [];
    const blocked = new Set<string>();
    const dirs = new Set<string>();
    for (const path of this.files.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const dir of [...dirs].sort()) {
      if ([...blocked].some((b) => dir.startsWith(b + "/"))) continue;
      if (descend(dir)) this.visitedDirs.push(dir);
      else blocked.add(dir);
    }
    for (const [path, f] of this.files) {
      if ([...blocked].some((b) => path.startsWith(b + "/"))) continue;
      out.push({ path, size: f.data.byteLength, mtime: f.mtime });
    }
    return out;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`not found: ${path}`);
    this.reads.push(path);
    return f.data.slice().buffer;
  }
}
