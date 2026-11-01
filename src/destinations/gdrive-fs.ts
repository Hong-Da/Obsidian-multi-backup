// Google Drive 上的目标文件系统（API v3，drive.file 权限：只看得到本插件自己建的文件）。本地镜像的全部逻辑（历史版本、回收站、主同步端）直接复用。
// Drive 没有路径：从“我的云端硬盘”根目录（别名 root）逐段按名字查出文件 id，查到的 id 缓存在内存里。
// Drive 允许同一文件夹里有多个同名条目：一律取创建时间最早的那个（时间相同再比 id），各设备结果一致。

import { DestinationError } from "../core/errors";
import type { AccessToken } from "../core/oauth";
import { networkError, posixDirname, posixJoin, text, type HttpFn, type HttpResponse } from "./http";
import type { TargetFs } from "./types";

export interface GoogleDriveOptions {
  token: AccessToken;
  http: HttpFn;
  /** 限流、服务暂不可用时等待；测试中换成假的 */
  sleep?: (ms: number) => Promise<void>;
  /** 超过这个大小改用可续传上传（Google 建议 5 MB 以上用它）；测试中调小 */
  resumableThreshold?: number;
  /** 可续传上传每段大小，取 256 KiB 的整数倍 */
  chunkSize?: number;
}

const API = "https://www.googleapis.com/drive/v3/";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/";
const HOST = "Google Drive";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,modifiedTime,md5Checksum,version,createdTime";
const UNIT = 256 * 1024;
/** 限流（403 rateLimitExceeded、429）与服务器错误（5xx）最多重试几次，等待 1、2、4 秒 */
const MAX_RETRY = 3;
const RATE_REASONS = ["rateLimitExceeded", "userRateLimitExceeded"];

interface GFile {
  id: string;
  name: string;
  mimeType: string;
  /** API 里是字符串 */
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  version?: string;
  createdTime?: string;
}

interface Node {
  id: string;
  isDir: boolean;
}

const ROOT: Node = { id: "root", isDir: true };

/** Drive 返回的错误（status 与 errors[0].reason） */
class GError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    detail: string,
  ) {
    super(`${status} ${reason} ${detail}`.trim());
  }
}

interface Call {
  headers?: Record<string, string>;
  body?: Uint8Array;
  json?: unknown;
}

export class GoogleDriveFs implements TargetFs {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly threshold: number;
  private readonly chunk: number;
  /** 路径（/a/b）→ 文件 id；删除、改名时清掉对应的条目 */
  private readonly ids = new Map<string, Node>();

  constructor(private readonly o: GoogleDriveOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => window.setTimeout(r, ms)));
    this.threshold = o.resumableThreshold ?? 5 * 1024 * 1024;
    this.chunk = Math.max(UNIT, Math.floor((o.chunkSize ?? 8 * 1024 * 1024) / UNIT) * UNIT);
  }

  join(...parts: string[]): string {
    return posixJoin(...parts);
  }

  dirname(p: string): string {
    return posixDirname(p);
  }

  /** 发请求：401 续期令牌后重试一次；限流与 5xx 按 Retry-After（没有时 1、2、4 秒）等待后重试；2xx 与 308 以外抛 GError */
  private async call(method: string, url: string, c: Call = {}): Promise<HttpResponse> {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      let r: HttpResponse;
      try {
        const token = await this.o.token.get();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...c.headers };
        let body = c.body;
        if (c.json !== undefined) {
          headers["Content-Type"] = "application/json; charset=UTF-8";
          body = new TextEncoder().encode(JSON.stringify(c.json));
        }
        r = await this.o.http({ url, method, headers, body });
      } catch (e) {
        throw networkError(e, HOST);
      }
      if ((r.status >= 200 && r.status < 300) || r.status === 308) return r;
      const reason = reasonOf(r);
      if (r.status === 401 && !renewed) {
        renewed = true;
        this.o.token.invalidate();
        continue;
      }
      const retryable = r.status === 429 || r.status >= 500 || (r.status === 403 && RATE_REASONS.includes(reason));
      if (retryable && attempt < MAX_RETRY) {
        const sec = Number(r.headers["retry-after"]);
        await this.sleep(Number.isFinite(sec) && sec > 0 ? sec * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new GError(r.status, reason, text(r).slice(0, 200));
    }
  }

  private async callJson<T>(method: string, url: string, c: Call = {}): Promise<T> {
    return JSON.parse(text(await this.call(method, url, c))) as T;
  }

  /** 缓存里的 id 可能已失效（别的设备删了又重建）：服务器回 404 时清空缓存，从根目录重新查一次 */
  private async run<T>(p: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof GError && e.status === 404)) throw toError(e, p);
    }
    this.ids.clear();
    try {
      return await f();
    } catch (e) {
      throw toError(e, p);
    }
  }

  /** 查询的全部结果（自动翻页） */
  private async query(q: string): Promise<GFile[]> {
    const out: GFile[] = [];
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, spaces: "drive", pageSize: "1000" });
      if (token) params.set("pageToken", token);
      const page = await this.callJson<{ files?: GFile[]; nextPageToken?: string }>("GET", `${API}files?${params.toString()}`);
      out.push(...(page.files ?? []));
      token = page.nextPageToken;
    } while (token);
    return out;
  }

  private async child(parentId: string, name: string): Promise<GFile | null> {
    return oldest(await this.query(`'${esc(parentId)}' in parents and name = '${esc(name)}' and trashed = false`));
  }

  /** 路径 → 条目，不存在时返回 null；从最长的已缓存前缀往下查 */
  private async resolve(p: string): Promise<Node | null> {
    const segs = segments(p);
    let i = segs.length;
    while (i > 0 && !this.ids.has(keyOf(segs, i))) i--;
    let cur = i > 0 ? (this.ids.get(keyOf(segs, i)) as Node) : ROOT;
    for (; i < segs.length; i++) {
      if (!cur.isDir) return null;
      const f = await this.child(cur.id, segs[i] as string);
      if (!f) return null;
      cur = nodeOf(f);
      this.ids.set(keyOf(segs, i + 1), cur);
    }
    return cur;
  }

  /** 删掉路径本身及其下所有路径的缓存 */
  private forget(p: string): void {
    const k = posixJoin(p);
    for (const key of [...this.ids.keys()]) if (key === k || key.startsWith(k + "/")) this.ids.delete(key);
  }

  stat(p: string) {
    const segs = segments(p);
    // 根目录（我的云端硬盘）总是存在
    if (!segs.length) return Promise.resolve({ isDir: true, size: 0, mtime: 0 });
    return this.run(p, async () => {
      const parent = await this.resolve(posixDirname(p));
      const f = parent?.isDir ? await this.child(parent.id, segs[segs.length - 1] as string) : null;
      if (!f) {
        this.forget(p);
        return null;
      }
      this.ids.set(posixJoin(p), nodeOf(f));
      return infoOf(f);
    });
  }

  mkdirp(p: string): Promise<void> {
    return this.run(p, async () => {
      await this.ensureDir(p);
    });
  }

  /** 逐层找到或新建文件夹；缓存里有的不再查（失效时后续请求 404，由 run 清缓存重来） */
  private async ensureDir(p: string): Promise<Node> {
    const segs = segments(p);
    let cur = ROOT;
    for (let i = 1; i <= segs.length; i++) {
      const key = keyOf(segs, i);
      let next = this.ids.get(key);
      if (!next) {
        const name = segs[i - 1] as string;
        const f = (await this.child(cur.id, name)) ?? (await this.callJson<GFile>("POST", `${API}files?fields=${FIELDS}`, { json: { name, mimeType: FOLDER, parents: [cur.id] } }));
        next = nodeOf(f);
        this.ids.set(key, next);
      }
      if (!next.isDir) throw new DestinationError("io", key, "not a folder");
      cur = next;
    }
    return cur;
  }

  readFile(p: string): Promise<Uint8Array> {
    return this.run(p, async () => {
      const f = await this.resolve(p);
      if (!f) throw new GError(404, "notFound", p);
      if (f.isDir) throw new DestinationError("io", p, "is a folder");
      return (await this.call("GET", `${API}files/${encodeURIComponent(f.id)}?alt=media`)).body;
    });
  }

  /** 覆盖写入；Drive 的上传本身是原子的（传完才生成新内容），不需要临时文件 */
  writeFile(p: string, data: Uint8Array): Promise<void> {
    const name = segments(p).pop();
    if (!name) return Promise.reject(new DestinationError("io", p, "is a folder"));
    return this.run(p, async () => {
      // 上级文件夹不在时新建：mkdirp 可能用了已失效的缓存，什么也没做
      const parent = await this.ensureDir(posixDirname(p));
      // 每次重新查目标是否已有文件：别的设备可能刚建了它
      const existing = await this.child(parent.id, name);
      if (existing?.mimeType === FOLDER) throw new DestinationError("io", p, "is a folder");
      const f = await this.upload(data, existing?.id ?? null, { name, parents: [parent.id] });
      this.ids.set(posixJoin(p), nodeOf(f));
    });
  }

  /** 新文件用 multipart 一次上传，已有文件用 media 只换内容；大文件用可续传上传 */
  private async upload(data: Uint8Array, id: string | null, meta: { name: string; parents: string[] }): Promise<GFile> {
    if (data.byteLength > this.threshold) return this.resumable(data, id, meta);
    if (id) {
      return this.callJson<GFile>("PATCH", `${UPLOAD}files/${encodeURIComponent(id)}?uploadType=media&fields=${FIELDS}`, { headers: { "Content-Type": "application/octet-stream" }, body: data });
    }
    const boundary = "mb-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    return this.callJson<GFile>("POST", `${UPLOAD}files?uploadType=multipart&fields=${FIELDS}`, { headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: concat([head, data, tail]) });
  }

  /** 可续传上传：先开会话拿到 Location，再按 256 KiB 整数倍分段 PUT；308 表示继续，Range 头给出服务器已收到的部分 */
  private async resumable(data: Uint8Array, id: string | null, meta: { name: string; parents: string[] }): Promise<GFile> {
    const total = data.byteLength;
    const headers = { "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(total) };
    const start = id
      ? await this.call("PATCH", `${UPLOAD}files/${encodeURIComponent(id)}?uploadType=resumable&fields=${FIELDS}`, { headers, json: {} })
      : await this.call("POST", `${UPLOAD}files?uploadType=resumable&fields=${FIELDS}`, { headers, json: meta });
    const session = start.headers["location"];
    if (!session) throw new GError(start.status, "noUploadSession", "");
    let offset = 0;
    for (;;) {
      const end = Math.min(offset + this.chunk, total);
      const r = await this.call("PUT", session, { headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` }, body: data.subarray(offset, end) });
      if (r.status !== 308) return JSON.parse(text(r)) as GFile;
      const m = /bytes=0-(\d+)/.exec(r.headers["range"] ?? "");
      const next = m ? Number(m[1]) + 1 : 0;
      // 服务器一点都没收下：不再死循环
      if (next <= offset) throw new GError(308, "uploadStalled", `${offset}/${total}`);
      offset = next;
    }
  }

  /** 改名或移动；目标已有文件时先删掉它 */
  rename(from: string, to: string): Promise<void> {
    const name = segments(to).pop();
    if (posixJoin(from) === posixJoin(to)) return Promise.resolve();
    if (!name) return Promise.reject(new DestinationError("io", to, "bad target"));
    return this.run(from, async () => {
      const src = await this.resolve(from);
      if (!src) throw new GError(404, "notFound", from);
      const oldParent = await this.resolve(posixDirname(from));
      if (!oldParent) throw new GError(404, "notFound", posixDirname(from));
      const newParent = await this.ensureDir(posixDirname(to));
      const existing = await this.child(newParent.id, name);
      if (existing && existing.id !== src.id) await this.deleteId(existing.id);
      const q = new URLSearchParams({ fields: FIELDS });
      if (oldParent.id !== newParent.id) {
        q.set("addParents", newParent.id);
        q.set("removeParents", oldParent.id);
      }
      await this.call("PATCH", `${API}files/${encodeURIComponent(src.id)}?${q.toString()}`, { json: { name } });
      this.forget(from);
      this.forget(to);
      this.ids.set(posixJoin(to), src);
    });
  }

  /** 永久删除（不进 Drive 回收站：本地镜像有自己的回收站）；已不存在时不算错 */
  private async deleteId(id: string): Promise<void> {
    try {
      await this.call("DELETE", `${API}files/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof GError && e.status === 404)) throw e;
    }
  }

  async removeFile(p: string): Promise<void> {
    if (!segments(p).length) throw new DestinationError("io", p, "cannot remove root");
    // 删除也要按最新的 id：缓存失效时 run 会重新查一次
    await this.run(p, async () => {
      const f = await this.resolve(p);
      if (f) await this.call("DELETE", `${API}files/${encodeURIComponent(f.id)}`);
    }).catch((e: unknown) => {
      if (!(e instanceof DestinationError && e.code === "not-found")) throw e;
    });
    this.forget(p);
  }

  /** 删除文件夹时连同里面的内容一起删 */
  removeDir(p: string): Promise<void> {
    return this.removeFile(p);
  }

  list(p: string) {
    return this.run(p, async () => {
      const dir = await this.resolve(p);
      if (!dir) throw new GError(404, "notFound", p);
      if (!dir.isDir) throw new DestinationError("not-found", p, "not a folder");
      const files = await this.query(`'${esc(dir.id)}' in parents and trashed = false`);
      // 列表为空时确认文件夹还在：缓存的 id 若已失效，查询可能只返回空列表，会被当成“远程什么都没有”
      if (!files.length && dir.id !== ROOT.id) {
        const self = await this.callJson<{ trashed?: boolean }>("GET", `${API}files/${encodeURIComponent(dir.id)}?fields=id,trashed`);
        if (self.trashed) throw new GError(404, "notFound", p);
      }
      const byName = new Map<string, GFile[]>();
      for (const f of files) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
      const out: { name: string; isDir: boolean; size?: number; mtime?: number; etag?: string }[] = [];
      for (const [name, same] of byName) {
        const f = oldest(same) as GFile;
        this.ids.set(posixJoin(p, name), nodeOf(f));
        out.push({ name, ...infoOf(f) });
      }
      return out;
    });
  }

  /** 空间上限减已用；没有上限（无限空间）或拿不到时返回 null */
  async freeSpace(): Promise<number | null> {
    try {
      const a = await this.callJson<{ storageQuota?: { limit?: string; usage?: string } }>("GET", `${API}about?fields=storageQuota`);
      const limit = Number(a.storageQuota?.limit);
      const usage = Number(a.storageQuota?.usage ?? 0);
      if (a.storageQuota?.limit === undefined || !Number.isFinite(limit) || !Number.isFinite(usage)) return null;
      return Math.max(0, limit - usage);
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
        await this.writeFile(p, concat(parts));
      },
    };
  }
}

function segments(p: string): string[] {
  return p.split("/").filter((s) => s && s !== ".");
}

function keyOf(segs: string[], n: number): string {
  return "/" + segs.slice(0, n).join("/");
}

/** 查询语句里的字符串：反斜杠与单引号前加反斜杠 */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** 同名条目里取创建时间最早的（相同再比 id），保证每次、每台设备选中同一个 */
function oldest(files: GFile[]): GFile | null {
  let best: GFile | null = null;
  for (const f of files) {
    if (!best) {
      best = f;
      continue;
    }
    const a = Date.parse(f.createdTime ?? "") || 0;
    const b = Date.parse(best.createdTime ?? "") || 0;
    if (a < b || (a === b && f.id < best.id)) best = f;
  }
  return best;
}

function nodeOf(f: GFile): Node {
  return { id: f.id, isDir: f.mimeType === FOLDER };
}

/** etag 用 md5Checksum（内容变了才变），没有时用 version */
function infoOf(f: GFile): { isDir: boolean; size: number; mtime: number; etag?: string } {
  if (f.mimeType === FOLDER) return { isDir: true, size: 0, mtime: Date.parse(f.modifiedTime ?? "") || 0 };
  return { isDir: false, size: Number(f.size ?? 0) || 0, mtime: Date.parse(f.modifiedTime ?? "") || 0, etag: f.md5Checksum ?? f.version };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of parts) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

/** 错误正文里的 errors[0].reason */
function reasonOf(r: HttpResponse): string {
  try {
    const j = JSON.parse(text(r)) as { error?: { errors?: { reason?: unknown }[] } };
    const reason = j.error?.errors?.[0]?.reason;
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  }
}

function toError(e: unknown, path: string): DestinationError {
  if (!(e instanceof GError)) return networkError(e, HOST);
  const detail = e.message.slice(0, 200);
  if (e.status === 401) return new DestinationError("auth-expired", HOST, detail);
  if (e.reason === "storageQuotaExceeded") return new DestinationError("quota", HOST, detail);
  if (e.status === 403 && !RATE_REASONS.includes(e.reason)) return new DestinationError("no-permission", HOST, detail);
  if (e.status === 404) return new DestinationError("not-found", path, detail);
  return new DestinationError("io", path, detail);
}
