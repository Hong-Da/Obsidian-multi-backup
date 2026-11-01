// AWS Signature Version 4（S3 用）：只用 WebCrypto，桌面和移动端都能用。
// 参考 AWS 文档“Authenticating Requests (AWS Signature Version 4)”，单元测试用文档中的样例核对。

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

export interface SignInput {
  method: string;
  url: string;
  /** 要一起签名的请求头（键大小写随意）；host 由地址得出，不用传 */
  headers: Record<string, string>;
  body?: Uint8Array;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBuffer(d: Uint8Array): ArrayBuffer {
  return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const d = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", toBuffer(d)));
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? toBuffer(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, toBuffer(enc.encode(msg)));
}

/** RFC 3986：除 A-Z a-z 0-9 - _ . ~ 外都编码（encodeURIComponent 不编码 !'()*，这里补上） */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 返回要加到请求上的头：Authorization、x-amz-date、x-amz-content-sha256 */
export async function signV4(req: SignInput, c: SigV4Credentials, now: Date): Promise<Record<string, string>> {
  const url = new URL(req.url);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const payload = await sha256Hex(req.body ?? new Uint8Array(0));

  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const path = url.pathname.split("/").map((s) => rfc3986(safeDecode(s))).join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonical = [req.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payload].join("\n");
  const scope = `${date}/${c.region}/${c.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");

  let key = await hmac(enc.encode("AWS4" + c.secretAccessKey), date);
  key = await hmac(key, c.region);
  key = await hmac(key, c.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payload,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
