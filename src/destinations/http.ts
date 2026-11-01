// WebDAV、S3 共用的 HTTP 请求接口：Obsidian 中走 requestUrl（不受 CORS 限制），测试中走 Node 的 fetch。

import { DestinationError } from "../core/errors";

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  /** 键为小写 */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** 发请求；网络不通时抛带 code 的错误（ENETWORK 等），非 2xx 不抛错，由调用方判断 */
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export const text = (r: HttpResponse) => new TextDecoder().decode(r.body);

/** 把 HTTP 状态码转成目的地错误；host 用于提示 */
export function httpError(r: HttpResponse, path: string, host: string): DestinationError {
  const detail = `${r.status} ${text(r).slice(0, 200)}`;
  if (r.status === 401) return new DestinationError("auth-failed", host, detail);
  if (r.status === 403) return new DestinationError("no-permission", host, detail);
  if (r.status === 404) return new DestinationError("not-found", path, detail);
  if (r.status === 507 || r.status === 413) return new DestinationError("no-space", host, detail);
  if (r.status === 423) return new DestinationError("in-use", path, detail);
  return new DestinationError("io", path, detail);
}

/** 网络错误 → 目的地错误 */
export function networkError(e: unknown, host: string): DestinationError {
  if (e instanceof DestinationError) return e;
  const code = (e as { code?: string } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  if (code && ["ENETWORK", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code)) return new DestinationError("network", host, msg);
  if (/fetch failed|network|ERR_/i.test(msg)) return new DestinationError("network", host, msg);
  return new DestinationError("io", host, msg);
}

/** 远程路径（以 / 分隔）逐段编码后拼到基础地址上 */
export function urlFor(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return p ? `${b}/${p}` : `${b}/`;
}

export function posixJoin(...parts: string[]): string {
  const segs: string[] = [];
  for (const part of parts) {
    for (const s of part.split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") segs.pop();
      else segs.push(s);
    }
  }
  return "/" + segs.join("/");
}

export function posixDirname(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
