// 给 isomorphic-git 用的文件系统：经 Obsidian 的 DataAdapter 读写插件目录，桌面和移动端是同一套代码。
// isomorphic-git 靠错误码判断文件是否存在，所以找不到时抛带 ENOENT 的错误。
//
// 在 Android 上实测（M2-1）：写入一千多个对象文件时，偶尔会留下 0 字节的文件而不报错。
// 所以写完核对大小，不对就重写；git 对象不可能是 0 字节，已经留下的空对象文件当作不存在，让 isomorphic-git 重新写入。

import { normalizePath, type DataAdapter } from "obsidian";
import type { PromiseFsClient } from "isomorphic-git";

const fsError = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });

interface Stats {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const WRITE_TRIES = 3;

/** git 的对象文件（objects/xx/...）；0 字节时一定是坏的 */
const isObjectFile = (path: string) => /(^|\/)objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(path);

function wantsText(opts: unknown): boolean {
  const enc = typeof opts === "string" ? opts : (opts as { encoding?: string } | undefined)?.encoding;
  return enc === "utf8" || enc === "utf-8";
}

export function adapterGitFs(adapter: DataAdapter): PromiseFsClient {
  const p = (path: string) => normalizePath(path);
  const name = (full: string) => full.slice(full.lastIndexOf("/") + 1);

  const stat = async (path: string): Promise<Stats> => {
    const s = await adapter.stat(p(path));
    if (!s || (s.type === "file" && s.size === 0 && isObjectFile(p(path)))) throw fsError("ENOENT", path);
    const dir = s.type === "folder";
    return {
      type: dir ? "dir" : "file",
      mode: dir ? 0o40000 : 0o100644,
      size: s.size,
      ino: 0,
      mtimeMs: s.mtime,
      ctimeMs: s.ctime,
      uid: 0,
      gid: 0,
      dev: 0,
      isFile: () => !dir,
      isDirectory: () => dir,
      isSymbolicLink: () => false,
    };
  };

  // rm 不在 isomorphic-git 的类型声明里，但它会优先用来递归删除
  const promises = {
      async readFile(path: string, opts?: unknown) {
        await stat(path);
        if (wantsText(opts)) return adapter.read(p(path));
        return new Uint8Array(await adapter.readBinary(p(path)));
      },
      async writeFile(path: string, data: Uint8Array | string) {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        for (let i = 1; ; i++) {
          if (typeof data === "string") await adapter.write(p(path), data);
          else await adapter.writeBinary(p(path), data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
          const s = await adapter.stat(p(path));
          if (s && s.size === bytes.byteLength) return;
          if (i >= WRITE_TRIES) throw fsError("EIO", path);
        }
      },
      async unlink(path: string) {
        if (!(await adapter.exists(p(path)))) throw fsError("ENOENT", path);
        await adapter.remove(p(path));
      },
      async readdir(path: string) {
        const s = await adapter.stat(p(path));
        if (!s) throw fsError("ENOENT", path);
        if (s.type !== "folder") throw fsError("ENOTDIR", path);
        const l = await adapter.list(p(path));
        return [...l.folders, ...l.files].map(name);
      },
      async mkdir(path: string) {
        if (await adapter.exists(p(path))) throw fsError("EEXIST", path);
        const parent = p(path).split("/").slice(0, -1).join("/");
        if (parent && !(await adapter.exists(parent))) throw fsError("ENOENT", parent);
        await adapter.mkdir(p(path));
      },
      async rmdir(path: string) {
        if (!(await adapter.exists(p(path)))) throw fsError("ENOENT", path);
        await adapter.rmdir(p(path), false);
      },
      async rm(path: string) {
        if (!(await adapter.exists(p(path)))) throw fsError("ENOENT", path);
        await adapter.rmdir(p(path), true);
      },
      stat,
      lstat: stat,
      readlink(path: string) {
        return Promise.reject(fsError("ENOENT", path));
      },
      symlink(_target: string, path: string) {
        return Promise.reject(fsError("ENOTSUP", path));
      },
      chmod() {
        return Promise.resolve();
      },
  };
  return { promises };
}
