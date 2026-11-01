// 测试用的内存 DataAdapter（只实现 adapterGitFs 用到的方法）。写文件时父文件夹必须已存在，和磁盘上的行为一致。
import type { DataAdapter } from "obsidian";

export class MemoryAdapter {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>([""]);
  writes = 0;
  /** 模拟 Android 上偶尔写出空文件：返回 true 的这次写入只留下 0 字节 */
  dropWrite: ((path: string, n: number) => boolean) | null = null;

  private parent(p: string): string {
    return p.split("/").slice(0, -1).join("/");
  }

  private need(p: string): void {
    if (!this.dirs.has(this.parent(p))) throw Object.assign(new Error("ENOENT " + p), { code: "ENOENT" });
  }

  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async stat(p: string) {
    if (this.dirs.has(p)) return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
    const f = this.files.get(p);
    return f ? { type: "file" as const, ctime: 0, mtime: 0, size: f.byteLength } : null;
  }
  async read(p: string) {
    return new TextDecoder().decode(this.files.get(p));
  }
  async readBinary(p: string) {
    const f = this.files.get(p) as Uint8Array;
    return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer;
  }
  async write(p: string, data: string) {
    this.need(p);
    this.writes++;
    this.files.set(p, new TextEncoder().encode(data));
  }
  async writeBinary(p: string, data: ArrayBuffer) {
    this.need(p);
    this.writes++;
    this.files.set(p, this.dropWrite?.(p, this.writes) ? new Uint8Array(0) : new Uint8Array(data.slice(0)));
  }
  async list(p: string) {
    const pre = p ? p + "/" : "";
    const direct = (k: string) => k.startsWith(pre) && k !== p && !k.slice(pre.length).includes("/");
    return { files: [...this.files.keys()].filter(direct), folders: [...this.dirs].filter((d) => d && direct(d)) };
  }
  async mkdir(p: string) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }
  async rmdir(p: string, recursive: boolean) {
    const inside = (k: string) => k.startsWith(p + "/");
    if (!recursive && ([...this.files.keys()].some(inside) || [...this.dirs].some(inside))) throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
    for (const k of [...this.files.keys()]) if (inside(k)) this.files.delete(k);
    for (const d of [...this.dirs]) if (inside(d)) this.dirs.delete(d);
    this.dirs.delete(p);
  }
  async remove(p: string) {
    this.files.delete(p);
  }

  asAdapter(): DataAdapter {
    return this as unknown as DataAdapter;
  }
}
