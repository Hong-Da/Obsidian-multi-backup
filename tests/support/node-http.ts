// 测试用的 HttpFn：Node 自带的 fetch
import type { HttpFn } from "../../src/destinations/http";

export const nodeFetchHttp: HttpFn = async (req) => {
  const r = await globalThis.fetch(req.url, { method: req.method, headers: req.headers, body: req.body ? new Uint8Array(req.body) : undefined });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
};
