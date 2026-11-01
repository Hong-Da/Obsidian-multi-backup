// WebDAV、S3 的 HTTP 请求走 Obsidian 的 requestUrl：不受 CORS 限制，桌面和移动端都能用
import { requestUrl } from "obsidian";
import type { HttpFn } from "../destinations/http";

export const obsidianRequest: HttpFn = async (req) => {
  let res;
  try {
    res = await requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body ? (req.body.buffer.slice(req.body.byteOffset, req.body.byteOffset + req.body.byteLength) as ArrayBuffer) : undefined,
      throw: false,
    });
  } catch (e) {
    throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code: "ENETWORK" });
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, body: req.method === "HEAD" ? new Uint8Array(0) : new Uint8Array(res.arrayBuffer) };
};
