// WebDAV 上的目标文件系统：坚果云、Nextcloud、群晖、Alist 等。本地镜像的全部逻辑（历史版本、回收站、主同步端）直接复用。
// 只用最基本的 WebDAV 方法：PROPFIND、MKCOL、GET、PUT、MOVE、DELETE。

import { sleep as defaultSleep } from "../core/timers";
import { DestinationError } from "../core/errors";
import { httpError, networkError, posixDirname, posixJoin, text, urlFor, type HttpFn, type HttpResponse } from "./http";
import type { FsEntryInfo, TargetFs } from "./types";

export interface WebDavOptions {
  /** 服务器地址，例如 https://dav.jianguoyun.com/dav/ */
  url: string;
  username: string;
  password: string;
  http: HttpFn;
  /** 等待（测试时替换） */
  sleep?: (ms: number) => Promise<void>;
}

/** 423 Locked（同时写同一文件夹时有的服务器会返回）、429、503：最多重试几次，等 0.5、1、2 秒 */
const MAX_RETRY = 3;
const RETRY_STATUS = new Set([423, 429, 503]);

const PROPS = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>`;
const QUOTA = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-available-bytes/></d:prop></d:propfind>`;

export interface DavEntry extends FsEntryInfo {
  href: string;
  isDir: boolean;
  quota?: number;
}

export class WebDavFs implements TargetFs {
  private readonly auth: string;
  private readonly host: string;
  /** 已确认存在的文件夹：建文件夹前不再逐个查询（每次同步新建一个实例，删除、移动时清掉） */
  private readonly dirs = new Set<string>();

  constructor(private readonly o: WebDavOptions) {
    this.auth = "Basic " + base64(`${o.username}:${o.password}`);
    try {
      this.host = new URL(o.url).host;
    } catch {
      this.host = o.url;
    }
  }

  join(...parts: string[]): string {
    return posixJoin(...parts);
  }

  dirname(p: string): string {
    return posixDirname(p);
  }

  private async req(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: Uint8Array,
  ): Promise<HttpResponse> {
    const sleep = this.o.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      let r: HttpResponse;
      try {
        r = await this.o.http({
          url: urlFor(this.o.url, path),
          method,
          headers: { Authorization: this.auth, ...headers },
          body,
        });
      } catch (e) {
        throw networkError(e, this.host);
      }
      if (!RETRY_STATUS.has(r.status) || attempt >= MAX_RETRY) return r;
      const sec = Number(r.headers["retry-after"]);
      await sleep(Number.isFinite(sec) && sec > 0 ? Math.min(sec, 30) * 1000 : 500 * 2 ** attempt);
    }
  }

  private propfind(path: string, depth: "0" | "1", xml = PROPS): Promise<HttpResponse> {
    return this.req(
      "PROPFIND",
      path,
      { Depth: depth, "Content-Type": "application/xml; charset=utf-8" },
      new TextEncoder().encode(xml),
    );
  }

  async stat(p: string) {
    const r = await this.propfind(p, "0");
    if (r.status === 404) return null;
    if (r.status !== 207) throw this.fail(r, p, "PROPFIND");
    const e = parseMultistatus(text(r))[0];
    return e ? { isDir: e.isDir, size: e.size, mtime: e.mtime, etag: e.etag } : null;
  }

  async mkdirp(p: string): Promise<void> {
    const segs = p.split("/").filter(Boolean);
    const key = "/" + segs.join("/");
    if (this.dirs.has(key)) return;
    if (!(await this.stat(p))) {
      for (let i = 1; i <= segs.length; i++) {
        const dir = "/" + segs.slice(0, i).join("/");
        if (this.dirs.has(dir)) continue;
        const r = await this.req("MKCOL", dir);
        // 201 新建；405 已存在
        if (r.status !== 201 && r.status !== 405 && r.status !== 200) throw this.fail(r, dir, "MKCOL");
        this.dirs.add(dir);
      }
    }
    for (let i = 1; i <= segs.length; i++) this.dirs.add("/" + segs.slice(0, i).join("/"));
  }

  /** 这个路径（可能是文件夹）被删除或移走了：忘掉它和它下面的文件夹 */
  private forget(p: string): void {
    const key = "/" + p.split("/").filter(Boolean).join("/");
    for (const d of this.dirs) if (d === key || d.startsWith(key + "/")) this.dirs.delete(d);
  }

  async readFile(p: string): Promise<Uint8Array> {
    const r = await this.req("GET", p);
    if (r.status !== 200) throw this.fail(r, p, "GET");
    return r.body;
  }

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    const r = await this.req("PUT", p, { "Content-Type": "application/octet-stream" }, data);
    if (r.status < 200 || r.status >= 300) throw this.fail(r, p, "PUT");
  }

  async rename(from: string, to: string): Promise<void> {
    this.forget(from);
    const r = await this.req("MOVE", from, { Destination: urlFor(this.o.url, to), Overwrite: "T" });
    if (r.status < 200 || r.status >= 300) throw this.fail(r, from, "MOVE");
  }

  async removeFile(p: string): Promise<void> {
    this.forget(p);
    const r = await this.req("DELETE", p);
    if ((r.status < 200 || r.status >= 300) && r.status !== 404) throw this.fail(r, p, "DELETE");
  }

  removeDir(p: string): Promise<void> {
    return this.removeFile(p.replace(/\/*$/, "/"));
  }

  async list(p: string) {
    const r = await this.propfind(p, "1");
    if (r.status === 404) throw new DestinationError("not-found", p);
    if (r.status !== 207) throw this.fail(r, p, "PROPFIND");
    const self = normalizeHref(new URL(urlFor(this.o.url, p)).pathname);
    return parseMultistatus(text(r))
      .filter((e) => normalizeHref(e.href) !== self)
      .map((e) => ({ name: lastSegment(e.href), isDir: e.isDir, size: e.size, mtime: e.mtime, etag: e.etag }))
      .filter((e) => e.name);
  }

  async freeSpace(p: string): Promise<number | null> {
    try {
      const r = await this.propfind(p, "0", QUOTA);
      const q = r.status === 207 ? parseMultistatus(text(r))[0]?.quota : undefined;
      // 0 或负数：服务器不知道（rclone 返回 0，Nextcloud 无限额返回 -3），不显示剩余空间
      return q !== undefined && q > 0 ? q : null;
    } catch {
      return null;
    }
  }

  /** WebDAV 没有追加写：先在内存里收集，关闭时一次上传（zip 快照用） */
  async openWrite(p: string) {
    const parts: Uint8Array[] = [];
    return {
      write: async (chunk: Uint8Array) => {
        parts.push(chunk.slice());
      },
      close: async () => {
        const size = parts.reduce((n, c) => n + c.byteLength, 0);
        const all = new Uint8Array(size);
        let at = 0;
        for (const c of parts) {
          all.set(c, at);
          at += c.byteLength;
        }
        await this.writeFile(p, all);
      },
    };
  }

  private fail(r: HttpResponse, path: string, method: string): DestinationError {
    // 地址不是 WebDAV（普通网站对 PROPFIND 返回 405 或 200 HTML）
    if (method === "PROPFIND" && (r.status === 405 || r.status === 200))
      return new DestinationError("not-webdav", this.host, `${r.status}`);
    return httpError(r, path, this.host);
  }
}

/** 解析 PROPFIND 的 207 Multi-Status（不依赖 DOMParser，Node 测试和移动端都能用；兼容不同的命名空间前缀） */
export function parseMultistatus(xml: string): DavEntry[] {
  const tag = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i");
  const out: DavEntry[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const block = m[1] as string;
    const href = decodeEntities(tag("href").exec(block)?.[1]?.trim() ?? "");
    const len = tag("getcontentlength").exec(block)?.[1];
    const mod = tag("getlastmodified").exec(block)?.[1];
    const etag = tag("getetag").exec(block)?.[1];
    const quota = tag("quota-available-bytes").exec(block)?.[1];
    out.push({
      href,
      isDir: /<(?:[\w-]+:)?collection\b/i.test(block),
      size: len ? Number(len) : 0,
      mtime: mod ? Date.parse(mod.trim()) || 0 : 0,
      etag: etag ? decodeEntities(etag.trim()).replace(/^W\//, "").replace(/"/g, "") : undefined,
      quota: quota !== undefined ? Number(quota) : undefined,
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeHref(href: string): string {
  let p = href;
  try {
    p = new URL(href, "http://x").pathname;
  } catch {
    // 保持原样
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // 保持原样
  }
  return p.replace(/\/+$/, "");
}

function lastSegment(href: string): string {
  const p = normalizeHref(href);
  return p.slice(p.lastIndexOf("/") + 1);
}

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
