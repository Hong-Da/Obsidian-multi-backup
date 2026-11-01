// 用 Node 的 fs 访问 Vault 之外的目标文件夹（仅桌面端）。
// fs 与 path 由调用方传入：插件中在 Platform.isDesktopApp 时按需加载，测试中直接传 Node 模块。

import type { TargetFs } from "../destinations/types";

/** 只声明用到的部分，避免在插件代码里静态引入 Node 模块 */
export interface NodeFsPromises {
  stat(p: string): Promise<{ isDirectory(): boolean; size: number; mtimeMs: number }>;
  mkdir(p: string, o: { recursive: true }): Promise<unknown>;
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  utimes(p: string, atime: Date, mtime: Date): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rm(p: string, o: { recursive: true; force: true }): Promise<void>;
  readdir(p: string, o: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean }[]>;
  statfs?(p: string): Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  open(p: string, flags: string): Promise<{ write(data: Uint8Array): Promise<unknown>; close(): Promise<void> }>;
}

export interface NodePath {
  join(...parts: string[]): string;
  dirname(p: string): string;
}

export class NodeTargetFs implements TargetFs {
  constructor(
    private readonly fs: NodeFsPromises,
    private readonly path: NodePath,
  ) {}

  join(...parts: string[]): string {
    return this.path.join(...parts);
  }

  dirname(p: string): string {
    return this.path.dirname(p);
  }

  async stat(p: string) {
    try {
      const s = await this.fs.stat(p);
      return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw e;
    }
  }

  async mkdirp(p: string): Promise<void> {
    await this.fs.mkdir(p, { recursive: true });
  }

  readFile(p: string): Promise<Uint8Array> {
    return this.fs.readFile(p);
  }

  async writeFile(p: string, data: Uint8Array, mtime?: number): Promise<void> {
    const tmp = `${p}.mb-tmp`;
    try {
      await this.fs.writeFile(tmp, data);
      if (mtime) await this.fs.utimes(tmp, new Date(mtime), new Date(mtime));
      await this.fs.rename(tmp, p);
    } catch (e) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  rename(from: string, to: string): Promise<void> {
    return this.fs.rename(from, to);
  }

  removeFile(p: string): Promise<void> {
    return this.fs.unlink(p);
  }

  removeDir(p: string): Promise<void> {
    return this.fs.rm(p, { recursive: true, force: true });
  }

  async list(p: string) {
    return (await this.fs.readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  }

  async freeSpace(p: string): Promise<number | null> {
    if (!this.fs.statfs) return null;
    try {
      const s = await this.fs.statfs(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  async openWrite(p: string) {
    const h = await this.fs.open(p, "w");
    return {
      write: async (chunk: Uint8Array) => {
        await h.write(chunk);
      },
      close: () => h.close(),
    };
  }
}
