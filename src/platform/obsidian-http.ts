// isomorphic-git 的 HTTP 客户端：统一走 Obsidian 的 requestUrl（不受 CORS 限制，桌面和移动端都能用）。
// requestUrl 不支持流式传输，请求体先拼成一整块，响应体作为一整块返回。

import { requestUrl } from "obsidian";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

async function collect(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    parts.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

async function* once(data: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield data;
}

export const obsidianHttp: HttpClient = {
  async request(req: GitHttpRequest): Promise<GitHttpResponse> {
    const method = req.method ?? "GET";
    const body = await collect(req.body);
    let res;
    try {
      res = await requestUrl({ url: req.url, method, headers: req.headers, body, throw: false });
    } catch (e) {
      // 断网、域名解析失败、证书错误等：requestUrl 直接抛错
      throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code: "ENETWORK" });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
    return {
      url: req.url,
      method,
      statusCode: res.status,
      statusMessage: String(res.status),
      headers,
      body: once(new Uint8Array(res.arrayBuffer)),
    };
  },
};
