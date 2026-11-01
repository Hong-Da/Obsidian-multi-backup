// S3 兼容存储上的目标文件系统：AWS S3、阿里云 OSS、腾讯云 COS、Cloudflare R2、MinIO。本地镜像的逻辑直接复用。
// 对象存储没有真正的文件夹：路径 /a/b.md 对应对象键 a/b.md；“文件夹”就是公共前缀，创建文件夹不需要做任何事。

import { DestinationError } from "../core/errors";
import { signV4 } from "../core/sigv4";
import { httpError, networkError, posixDirname, posixJoin, text, type HttpFn, type HttpResponse } from "./http";
import type { TargetFs } from "./types";

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 路径风格（MinIO、R2）：endpoint/bucket/key；否则虚拟主机风格：bucket.endpoint/key */
  pathStyle: boolean;
  http: HttpFn;
  now?: () => Date;
}

export interface S3Object {
  key: string;
  size: number;
  mtime: number;
  etag: string;
}

export class S3Fs implements TargetFs {
  private readonly host: string;
  private readonly now: () => Date;

  constructor(private readonly o: S3Options) {
    this.now = o.now ?? (() => new Date());
    try {
      this.host = new URL(o.endpoint).host;
    } catch {
      this.host = o.endpoint;
    }
  }

  join(...parts: string[]): string {
    return posixJoin(...parts);
  }

  dirname(p: string): string {
    return posixDirname(p);
  }

  private key(p: string): string {
    return p.split("/").filter(Boolean).join("/");
  }

  /** 对象（或桶本身，key 为空时）的地址 */
  private url(key: string, query = ""): string {
    const ep = new URL(this.o.endpoint);
    const k = key.split("/").map(encodeURIComponent).join("/");
    const base = this.o.pathStyle ? `${ep.protocol}//${ep.host}/${encodeURIComponent(this.o.bucket)}` : `${ep.protocol}//${this.o.bucket}.${ep.host}`;
    return `${base}/${k}${query ? "?" + query : ""}`;
  }

  private async req(method: string, key: string, opts: { query?: string; headers?: Record<string, string>; body?: Uint8Array } = {}): Promise<HttpResponse> {
    const url = this.url(key, opts.query);
    const extra = opts.headers ?? {};
    try {
      const signed = await signV4(
        { method, url, headers: extra, body: opts.body },
        { accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, region: this.o.region, service: "s3" },
        this.now(),
      );
      return await this.o.http({ url, method, headers: { ...extra, ...signed }, body: opts.body });
    } catch (e) {
      throw networkError(e, this.host);
    }
  }

  async stat(p: string) {
    const key = this.key(p);
    if (key) {
      // 不用 HEAD：有的服务对 HEAD 的 404 带着 Content-Length 却没有正文，Android 上读响应会报“Stream closed”（M6-2 实测）。
      // 以键名为前缀列 1 个对象：存在时它一定排在第一个
      const first = (await this.listPage(key, "", 1)).objects[0];
      if (first?.key === key) return { isDir: false, size: first.size, mtime: first.mtime, etag: first.etag || undefined };
    }
    // 不是对象：前缀下有对象时当作文件夹（桶本身存在时根目录总是存在）
    const page = await this.listPage(key ? key + "/" : "", "/", 1);
    if (!key || page.objects.length || page.prefixes.length) return { isDir: true, size: 0, mtime: 0 };
    return null;
  }

  /** 对象存储没有文件夹，不需要创建 */
  async mkdirp(): Promise<void> {}

  async readFile(p: string): Promise<Uint8Array> {
    const r = await this.req("GET", this.key(p));
    if (r.status !== 200) throw this.fail(r, p);
    return r.body;
  }

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    const r = await this.req("PUT", this.key(p), { body: data, headers: { "content-type": "application/octet-stream" } });
    if (r.status !== 200) throw this.fail(r, p);
  }

  /** 对象存储没有改名：复制后删除原对象 */
  async rename(from: string, to: string): Promise<void> {
    const src = `/${this.o.bucket}/${this.key(from)}`.split("/").map(encodeURIComponent).join("/");
    const r = await this.req("PUT", this.key(to), { headers: { "x-amz-copy-source": src } });
    if (r.status !== 200 || /<Error>/.test(text(r))) throw this.fail(r, from);
    await this.removeFile(from);
  }

  async removeFile(p: string): Promise<void> {
    const r = await this.req("DELETE", this.key(p));
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw this.fail(r, p);
  }

  async removeDir(p: string): Promise<void> {
    const prefix = this.key(p) + "/";
    let token: string | undefined;
    do {
      const page = await this.listPage(prefix, "", 1000, token);
      for (const o of page.objects) await this.removeFile("/" + o.key);
      token = page.next;
    } while (token);
  }

  async list(p: string) {
    const key = this.key(p);
    const prefix = key ? key + "/" : "";
    const out: { name: string; isDir: boolean; size?: number; mtime?: number; etag?: string }[] = [];
    let token: string | undefined;
    do {
      const page = await this.listPage(prefix, "/", 1000, token);
      for (const d of page.prefixes) out.push({ name: d.slice(prefix.length).replace(/\/$/, ""), isDir: true });
      for (const o of page.objects) {
        const name = o.key.slice(prefix.length);
        if (name && !name.endsWith("/")) out.push({ name, isDir: false, size: o.size, mtime: o.mtime, etag: o.etag });
      }
      token = page.next;
    } while (token);
    return out;
  }

  async freeSpace(): Promise<number | null> {
    return null;
  }

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

  /** ListObjectsV2 的一页 */
  private async listPage(prefix: string, delimiter: string, max: number, token?: string): Promise<{ objects: S3Object[]; prefixes: string[]; next?: string }> {
    // 显式要求键名做 URL 编码（再自己解码）：各家服务行为一致，特殊字符也不会弄乱 XML
    const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": String(max), "encoding-type": "url" });
    if (delimiter) q.set("delimiter", delimiter);
    if (token) q.set("continuation-token", token);
    const r = await this.req("GET", "", { query: q.toString().replace(/\+/g, "%20") });
    if (r.status !== 200) throw this.fail(r, "/" + prefix);
    return parseListObjects(text(r));
  }

  private fail(r: HttpResponse, path: string): DestinationError {
    const body = text(r);
    if (/<Code>NoSuchBucket<\/Code>/.test(body)) return new DestinationError("no-bucket", this.o.bucket, body.slice(0, 200));
    if (/<Code>SignatureDoesNotMatch<\/Code>|<Code>InvalidAccessKeyId<\/Code>/.test(body)) return new DestinationError("auth-failed", this.host, body.slice(0, 200));
    return httpError(r, path, this.host);
  }
}

export function parseListObjects(xml: string): { objects: S3Object[]; prefixes: string[]; next?: string } {
  const val = (block: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1];
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const b = m[1] as string;
    objects.push({
      key: decodeKey(decodeXml(val(b, "Key") ?? "")),
      size: Number(val(b, "Size") ?? 0),
      mtime: Date.parse(val(b, "LastModified") ?? "") || 0,
      etag: cleanEtag(decodeXml(val(b, "ETag") ?? "")) ?? "",
    });
  }
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>/g)].map((m) => decodeKey(decodeXml(m[1] as string)));
  const truncated = val(xml, "IsTruncated") === "true";
  const next = truncated ? decodeXml(val(xml, "NextContinuationToken") ?? "") : undefined;
  return { objects, prefixes, next: next || undefined };
}

/** encoding-type=url 时键名是 URL 编码的（空格可能写成 +）；没编码的键原样返回 */
function decodeKey(k: string): string {
  try {
    return decodeURIComponent(k.replace(/\+/g, "%20"));
  } catch {
    return k;
  }
}

function cleanEtag(e: string | undefined): string | undefined {
  return e ? e.replace(/^W\//, "").replace(/"/g, "") : undefined;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
