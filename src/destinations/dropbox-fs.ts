// Dropbox 上的目标文件系统（API v2，应用文件夹权限）。本地镜像的全部逻辑（历史版本、回收站、主同步端）直接复用。
// 路径相对于应用文件夹：TargetFs 的 / 就是应用文件夹根目录（Dropbox 里写作空字符串）。Dropbox 路径不区分大小写。

import { DestinationError } from "../core/errors";
import type { AccessToken } from "../core/oauth";
import { networkError, posixDirname, posixJoin, text, type HttpFn, type HttpResponse } from "./http";
import type { TargetFs } from "./types";

export interface DropboxOptions {
  token: AccessToken;
  http: HttpFn;
  /** 限流时等待；测试中换成假的 */
  sleep?: (ms: number) => Promise<void>;
  /** 超过这个大小改用分段上传（Dropbox 单次上传上限 150 MB）；测试中调小 */
  sessionThreshold?: number;
  /** 分段上传每段大小 */
  chunkSize?: number;
}

const RPC = "https://api.dropboxapi.com/2/";
const CONTENT = "https://content.dropboxapi.com/2/";
const HOST = "Dropbox";
/** 限流（429）与服务暂不可用（503）最多重试几次 */
const MAX_RETRY = 3;

interface DbxMeta {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  size?: number;
  server_modified?: string;
  rev?: string;
}

interface DbxCall {
  /** 内容接口（上传、下载）的参数放在 Dropbox-API-Arg 头里；RPC 接口放在 JSON 正文里 */
  content?: boolean;
  arg?: unknown;
  body?: Uint8Array;
}

/** Dropbox 返回的错误（409 时带 error_summary，例如 path/not_found/..） */
class DbxError extends Error {
  constructor(
    readonly status: number,
    readonly summary: string,
  ) {
    super(`${status} ${summary}`);
  }
}

export class DropboxFs implements TargetFs {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly threshold: number;
  private readonly chunk: number;

  constructor(private readonly o: DropboxOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
    this.threshold = o.sessionThreshold ?? 150 * 1024 * 1024;
    this.chunk = o.chunkSize ?? 8 * 1024 * 1024;
  }

  join(...parts: string[]): string {
    return posixJoin(...parts);
  }

  dirname(p: string): string {
    return posixDirname(p);
  }

  /** TargetFs 路径 → Dropbox 路径（根目录为空字符串） */
  private dbx(p: string): string {
    const segs = p.split("/").filter(Boolean);
    return segs.length ? "/" + segs.join("/") : "";
  }

  /** 发请求：401 续期令牌后重试一次；429、503 按 Retry-After 等待后重试 */
  private async call(endpoint: string, c: DbxCall = {}): Promise<HttpResponse> {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      let r: HttpResponse;
      try {
        const token = await this.o.token.get();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        let body: Uint8Array | undefined;
        if (c.content) {
          if (c.arg !== undefined) headers["Dropbox-API-Arg"] = asciiJson(c.arg);
          headers["Content-Type"] = "application/octet-stream";
          body = c.body ?? new Uint8Array(0);
        } else {
          headers["Content-Type"] = "application/json";
          body = new TextEncoder().encode(JSON.stringify(c.arg ?? null));
        }
        r = await this.o.http({ url: (c.content ? CONTENT : RPC) + endpoint, method: "POST", headers, body });
      } catch (e) {
        throw networkError(e, HOST);
      }
      if (r.status === 401 && !renewed) {
        renewed = true;
        this.o.token.invalidate();
        continue;
      }
      if ((r.status === 429 || r.status === 503) && attempt < MAX_RETRY) {
        const sec = Number(r.headers["retry-after"]);
        await this.sleep((Number.isFinite(sec) && sec > 0 ? sec : 1) * 1000);
        continue;
      }
      if (r.status >= 200 && r.status < 300) return r;
      throw new DbxError(r.status, summaryOf(r));
    }
  }

  private async rpc<T>(endpoint: string, arg: unknown): Promise<T> {
    const r = await this.call(endpoint, { arg });
    return JSON.parse(text(r)) as T;
  }

  /** 调用并把 Dropbox 错误转成目的地错误 */
  private async run<T>(path: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      throw toError(e, path);
    }
  }

  async stat(p: string) {
    const path = this.dbx(p);
    // 根目录（应用文件夹）总是存在；get_metadata 不支持根目录
    if (!path) return { isDir: true, size: 0, mtime: 0 };
    try {
      return toInfo(await this.rpc<DbxMeta>("files/get_metadata", { path }));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw toError(e, p);
    }
  }

  async mkdirp(p: string): Promise<void> {
    if (await this.stat(p)) return;
    const segs = p.split("/").filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const dir = "/" + segs.slice(0, i).join("/");
      try {
        await this.rpc("files/create_folder_v2", { path: dir, autorename: false });
      } catch (e) {
        // 已有同名文件夹：继续下一层
        if (e instanceof DbxError && e.summary.startsWith("path/conflict/folder")) continue;
        throw toError(e, dir);
      }
    }
  }

  readFile(p: string): Promise<Uint8Array> {
    return this.run(
      p,
      async () => (await this.call("files/download", { content: true, arg: { path: this.dbx(p) } })).body,
    );
  }

  /** 覆盖写入；Dropbox 上传本身是原子的，传到一半失败不会留下半个文件 */
  writeFile(p: string, data: Uint8Array): Promise<void> {
    const path = this.dbx(p);
    const commit = { path, mode: "overwrite", mute: true };
    return this.run(p, async () => {
      if (data.byteLength <= this.threshold) {
        await this.call("files/upload", { content: true, arg: commit, body: data });
        return;
      }
      // 大文件：分段上传，最后一段随 finish 一起提交
      const first = data.subarray(0, this.chunk);
      const start = JSON.parse(
        text(await this.call("files/upload_session/start", { content: true, arg: { close: false }, body: first })),
      ) as { session_id: string };
      let offset = first.byteLength;
      while (data.byteLength - offset > this.chunk) {
        const part = data.subarray(offset, offset + this.chunk);
        await this.call("files/upload_session/append_v2", {
          content: true,
          arg: { cursor: { session_id: start.session_id, offset }, close: false },
          body: part,
        });
        offset += part.byteLength;
      }
      await this.call("files/upload_session/finish", {
        content: true,
        arg: { cursor: { session_id: start.session_id, offset }, commit },
        body: data.subarray(offset),
      });
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const arg = { from_path: this.dbx(from), to_path: this.dbx(to), autorename: false };
    try {
      await this.rpc("files/move_v2", arg);
    } catch (e) {
      // 目标已存在：先删掉再移动（只差大小写时目标就是源文件本身，不能删）
      if (
        !(e instanceof DbxError && e.summary.startsWith("to/conflict")) ||
        arg.from_path.toLowerCase() === arg.to_path.toLowerCase()
      )
        throw toError(e, from);
      await this.removeFile(to);
      await this.run(from, () => this.rpc("files/move_v2", arg));
    }
  }

  async removeFile(p: string): Promise<void> {
    try {
      await this.rpc("files/delete_v2", { path: this.dbx(p) });
    } catch (e) {
      if (!isNotFound(e)) throw toError(e, p);
    }
  }

  /** delete_v2 删除文件夹时连同里面的内容一起删 */
  removeDir(p: string): Promise<void> {
    return this.removeFile(p);
  }

  list(p: string) {
    return this.run(p, async () => {
      const out: { name: string; isDir: boolean; size?: number; mtime?: number; etag?: string }[] = [];
      let page = await this.rpc<{ entries: DbxMeta[]; cursor: string; has_more: boolean }>("files/list_folder", {
        path: this.dbx(p),
        recursive: false,
        limit: 2000,
      });
      for (;;) {
        for (const m of page.entries) {
          const info = toInfo(m);
          if (info) out.push({ name: m.name, ...info });
        }
        if (!page.has_more) return out;
        page = await this.rpc("files/list_folder/continue", { cursor: page.cursor });
      }
    });
  }

  /** 个人账号：分配空间减已用；团队空间或拿不到时返回 null */
  async freeSpace(): Promise<number | null> {
    try {
      const u = await this.rpc<{ used?: number; allocation?: { ".tag"?: string; allocated?: number } }>(
        "users/get_space_usage",
        null,
      );
      const a = u.allocation;
      if (a?.[".tag"] !== "individual" || typeof a.allocated !== "number" || typeof u.used !== "number") return null;
      return Math.max(0, a.allocated - u.used);
    } catch {
      return null;
    }
  }

  /** 先在内存里收集，关闭时一次上传（大文件由 writeFile 分段） */
  async openWrite(p: string) {
    const parts: Uint8Array[] = [];
    return {
      write: async (chunk: Uint8Array) => {
        parts.push(chunk.slice());
      },
      close: async () => {
        const all = new Uint8Array(parts.reduce((n, c) => n + c.byteLength, 0));
        let at = 0;
        for (const c of parts) {
          all.set(c, at);
          at += c.byteLength;
        }
        await this.writeFile(p, all);
      },
    };
  }
}

/** Dropbox-API-Arg 头只能是 ASCII：非 ASCII 字符（以及 0x7F）写成 \uXXXX */
export function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function summaryOf(r: HttpResponse): string {
  const body = text(r);
  try {
    const j = JSON.parse(body) as { error_summary?: unknown };
    if (typeof j.error_summary === "string") return j.error_summary;
  } catch {
    // 不是 JSON（例如 400 的纯文本说明）
  }
  return body.slice(0, 200);
}

function toInfo(m: DbxMeta): { isDir: boolean; size: number; mtime: number; etag?: string } | null {
  if (m[".tag"] === "folder") return { isDir: true, size: 0, mtime: 0 };
  if (m[".tag"] === "file")
    return { isDir: false, size: m.size ?? 0, mtime: Date.parse(m.server_modified ?? "") || 0, etag: m.rev };
  return null;
}

function isNotFound(e: unknown): boolean {
  return e instanceof DbxError && e.status === 409 && /(^|\/)not_found(\/|$)/.test(e.summary);
}

function toError(e: unknown, path: string): DestinationError {
  if (!(e instanceof DbxError)) return networkError(e, HOST);
  const detail = e.message.slice(0, 200);
  if (e.status === 401) return new DestinationError("auth-expired", HOST, detail);
  if (e.status === 403) return new DestinationError("no-permission", HOST, detail);
  if (/insufficient_space/.test(e.summary) || e.status === 507) return new DestinationError("quota", HOST, detail);
  if (isNotFound(e)) return new DestinationError("not-found", path, detail);
  return new DestinationError("io", path, detail);
}
