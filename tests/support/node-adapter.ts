/// <reference types="node" />
// 测试用的 DataAdapter：读写磁盘上的真实文件夹（相当于桌面端 Obsidian 的 FileSystemAdapter），只实现 adapterGitFs 用到的方法。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DataAdapter } from "obsidian";

export class NodeAdapter {
  constructor(private readonly root: string) {}

  private abs(p: string): string {
    return path.join(this.root, ...p.split("/").filter(Boolean));
  }

  async exists(p: string) {
    return fs.stat(this.abs(p)).then(
      () => true,
      () => false,
    );
  }
  async stat(p: string) {
    try {
      const s = await fs.stat(this.abs(p));
      return {
        type: s.isDirectory() ? ("folder" as const) : ("file" as const),
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: s.size,
      };
    } catch {
      return null;
    }
  }
  async read(p: string) {
    return fs.readFile(this.abs(p), "utf8");
  }
  async readBinary(p: string) {
    const b = await fs.readFile(this.abs(p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async write(p: string, data: string) {
    await fs.writeFile(this.abs(p), data);
  }
  async writeBinary(p: string, data: ArrayBuffer) {
    await fs.writeFile(this.abs(p), new Uint8Array(data));
  }
  async list(p: string) {
    const entries = await fs.readdir(this.abs(p), { withFileTypes: true });
    const pre = p ? p + "/" : "";
    return {
      files: entries.filter((e) => !e.isDirectory()).map((e) => pre + e.name),
      folders: entries.filter((e) => e.isDirectory()).map((e) => pre + e.name),
    };
  }
  async mkdir(p: string) {
    await fs.mkdir(this.abs(p), { recursive: true });
  }
  async rmdir(p: string, recursive: boolean) {
    await fs.rm(this.abs(p), { recursive, force: true });
  }
  async remove(p: string) {
    await fs.rm(this.abs(p), { force: true });
  }

  asAdapter(): DataAdapter {
    return this as unknown as DataAdapter;
  }
}
