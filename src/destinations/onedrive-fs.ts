// OneDrive 上的目标文件系统（Microsoft Graph）。本地镜像的全部逻辑（历史版本、回收站、主同步端）直接复用。
// 权限只申请 Files.ReadWrite.AppFolder：路径 / 对应应用文件夹（OneDrive 中的“应用/多点备份”），看不到网盘里别的文件。

import { DestinationError } from "../core/errors";
import type { AccessToken } from "../core/oauth";
import { httpError, networkError, posixDirname, posixJoin, text, type HttpFn, type HttpRequest, type HttpResponse } from "./http";
import type { TargetFs } from "./types";

export interface OneDriveOptions {
  token: AccessToken;
  http: HttpFn;
  /** 限流时等待（测试中替换掉） */
  sleep?: (ms: number) => Promise<void>;
}

const GRAPH = "https://graph.microsoft.com/v1.0";
const BASE = `${GRAPH}/me/drive/special/approot`;
const HOST = "OneDrive";
/** 不超过 4 MiB 直接 PUT；更大的用上传会话分块 */
export const SMALL_UPLOAD = 4 * 1024 * 1024;
/** 分块大小必须是 320 KiB 的整数倍 */
export const CHUNK = 10 * 320 * 1024;
/** 429、503 最多重试几次 */
const MAX_THROTTLE_RETRY = 3;

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  cTag?: string;
  folder?: unknown;
  file?: unknown;
  "@microsoft.graph.downloadUrl"?: string;
}

export class OneDriveFs implements TargetFs {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: OneDriveOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
  }

  join(...parts: string[]): string {
    return posixJoin(...parts);
  }

  dirname(p: string): string {
    return posixDirname(p);
  }

  /** 按路径寻址的条目地址；根目录就是应用文件夹本身 */
  private item(p: string): string {
    const enc = p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return enc ? `${BASE}:/${enc}:` : BASE;
  }

  /**
   * 发请求：auth 为 false 时不带令牌（上传会话地址、下载地址是预先签好的）。
   * 401 时作废令牌再试一次；429、503 按 Retry-After 等待后重试。
   */
  private async send(req: HttpRequest, auth = true): Promise<HttpResponse> {
    let authRetried = false;
    let throttled = 0;
    for (;;) {
      const headers: Record<string, string> = { ...req.headers };
      if (auth) headers.Authorization = `Bearer ${await this.o.token.get()}`;
      let r: HttpResponse;
      try {
        r = await this.o.http({ ...req, headers });
      } catch (e) {
        throw networkError(e, HOST);
      }
      if (r.status === 401 && auth && !authRetried) {
        authRetried = true;
        this.o.token.invalidate();
        continue;
      }
      if ((r.status === 429 || r.status === 503) && throttled < MAX_THROTTLE_RETRY) {
        throttled++;
        const sec = Number(r.headers["retry-after"]);
        await this.sleep((Number.isFinite(sec) && sec > 0 ? sec : 1) * 1000);
        continue;
      }
      return r;
    }
  }

  private sendJson(method: string, url: string, body: unknown): Promise<HttpResponse> {
    return this.send({ url, method, headers: { "Content-Type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) });
  }

  /** 取条目；不存在返回 null */
  private async getItem(p: string, query = ""): Promise<DriveItem | null> {
    const r = await this.send({ url: this.item(p) + query, method: "GET" });
    if (r.status === 404) return null;
    if (r.status !== 200) throw this.fail(r, p);
    return parseJson<DriveItem>(r);
  }

  async stat(p: string) {
    const it = await this.getItem(p);
    return it ? info(it) : null;
  }

  async mkdirp(p: string): Promise<void> {
    if ((await this.stat(p))?.isDir) return;
    const segs = p.split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const parent = "/" + segs.slice(0, i).join("/");
      const r = await this.sendJson("POST", this.item(parent) + "/children", { name: segs[i], folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
      // 201 新建；409 已存在
      if (r.status !== 201 && r.status !== 200 && r.status !== 409) throw this.fail(r, posixJoin(parent, segs[i] ?? ""));
    }
  }

  /** 先取预签名的下载地址再下载（不依赖 302 跳转，requestUrl 对跳转的处理各平台不一致） */
  async readFile(p: string): Promise<Uint8Array> {
    const it = await this.getItem(p, "?select=id,@microsoft.graph.downloadUrl");
    if (!it) throw new DestinationError("not-found", p);
    const dl = it["@microsoft.graph.downloadUrl"];
    const r = dl ? await this.send({ url: dl, method: "GET" }, false) : await this.send({ url: this.item(p) + "/content", method: "GET" });
    if (r.status !== 200) throw this.fail(r, p);
    return r.body;
  }

  /** 小文件一次上传；大文件用上传会话，中途失败时服务器上的旧文件不变 */
  async writeFile(p: string, data: Uint8Array): Promise<void> {
    if (data.byteLength <= SMALL_UPLOAD) {
      const r = await this.send({ url: this.item(p) + "/content", method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: data });
      if (r.status !== 200 && r.status !== 201) throw this.fail(r, p);
      return;
    }
    const s = await this.sendJson("POST", this.item(p) + "/createUploadSession", { item: { "@microsoft.graph.conflictBehavior": "replace" } });
    if (s.status !== 200) throw this.fail(s, p);
    const uploadUrl = parseJson<{ uploadUrl?: string }>(s).uploadUrl;
    if (!uploadUrl) throw new DestinationError("io", p, "no uploadUrl");
    const total = data.byteLength;
    for (let start = 0; start < total; start += CHUNK) {
      const end = Math.min(start + CHUNK, total);
      // 上传会话地址自带授权，不能再带 Authorization
      const r = await this.send({ url: uploadUrl, method: "PUT", headers: { "Content-Range": `bytes ${start}-${end - 1}/${total}` }, body: data.subarray(start, end) }, false);
      const last = end === total;
      if (last ? r.status === 200 || r.status === 201 : r.status === 202) continue;
      // 取消会话，免得服务器留着半截上传
      await this.send({ url: uploadUrl, method: "DELETE" }, false).catch(() => undefined);
      throw this.fail(r, p);
    }
  }

  /** 移动并改名；目标已存在时覆盖（有的账号不接受 replace，就先删掉目标再移动） */
  async rename(from: string, to: string): Promise<void> {
    if (posixJoin(from) === posixJoin(to)) return;
    const src = await this.getItem(from);
    if (!src) throw new DestinationError("not-found", from);
    const parentPath = posixDirname(to);
    await this.mkdirp(parentPath);
    const parent = await this.getItem(parentPath);
    if (!parent) throw new DestinationError("not-found", parentPath);
    const url = `${GRAPH}/me/drive/items/${encodeURIComponent(src.id)}?@microsoft.graph.conflictBehavior=replace`;
    const body = { parentReference: { id: parent.id }, name: to.split("/").filter(Boolean).pop() ?? "" };
    let r = await this.sendJson("PATCH", url, body);
    if (r.status === 409) {
      await this.removeFile(to);
      r = await this.sendJson("PATCH", url, body);
    }
    if (r.status !== 200) throw this.fail(r, from);
  }

  /** 删除的文件进 OneDrive 的回收站 */
  async removeFile(p: string): Promise<void> {
    if (!p.split("/").some(Boolean)) throw new DestinationError("io", p, "refuse to delete app folder");
    const r = await this.send({ url: this.item(p), method: "DELETE" });
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw this.fail(r, p);
  }

  /** 删除文件夹（连同里面的文件） */
  removeDir(p: string): Promise<void> {
    return this.removeFile(p);
  }

  async list(p: string) {
    const out: { name: string; isDir: boolean; size?: number; mtime?: number; etag?: string }[] = [];
    let url: string | undefined = this.item(p) + "/children?$top=200";
    while (url) {
      const r = await this.send({ url, method: "GET" });
      if (r.status === 404) throw new DestinationError("not-found", p);
      if (r.status !== 200) throw this.fail(r, p);
      const page = parseJson<{ value?: DriveItem[]; "@odata.nextLink"?: string }>(r);
      for (const it of page.value ?? []) out.push({ name: it.name, ...info(it) });
      url = page["@odata.nextLink"];
    }
    return out;
  }

  async freeSpace(): Promise<number | null> {
    try {
      const r = await this.send({ url: `${GRAPH}/me/drive?$select=quota`, method: "GET" });
      if (r.status !== 200) return null;
      const q = parseJson<{ quota?: { remaining?: number } }>(r).quota?.remaining;
      return typeof q === "number" && q >= 0 ? q : null;
    } catch {
      return null;
    }
  }

  /** 没有追加写：先在内存里收集，关闭时一次上传（zip 快照用） */
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

  private fail(r: HttpResponse, path: string): DestinationError {
    const body = text(r);
    let code = "";
    try {
      code = String((JSON.parse(body) as { error?: { code?: string } }).error?.code ?? "");
    } catch {
      code = "";
    }
    const detail = `${r.status} ${code} ${body.slice(0, 200)}`;
    if (r.status === 401) return new DestinationError("auth-expired", HOST, detail);
    if (r.status === 403 && code !== "quotaLimitReached") return new DestinationError("no-permission", HOST, detail);
    if (r.status === 507 || code === "quotaLimitReached") return new DestinationError("quota", HOST, detail);
    return httpError(r, path, HOST);
  }
}

function parseJson<T>(r: HttpResponse): T {
  try {
    return JSON.parse(text(r)) as T;
  } catch {
    throw new DestinationError("io", HOST, `bad JSON: ${text(r).slice(0, 200)}`);
  }
}

/** cTag 只在内容变化时改变（eTag 连改名、改属性也会变），有它时用它当版本号 */
function info(it: DriveItem) {
  const tag = it.cTag ?? it.eTag;
  return {
    isDir: it.folder !== undefined,
    size: it.size ?? 0,
    mtime: Date.parse(it.lastModifiedDateTime ?? "") || 0,
    etag: tag ? tag.replace(/"/g, "") : undefined,
  };
}
