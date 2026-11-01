/// <reference types="node" />
// Google Drive 文件系统：用内存里的假 Drive API（文件按 id 存，带 parents 与名字）测试路径解析、上传、改名、删除、错误处理，
// 并在它上面跑一遍本地镜像的备份与主同步端双向同步。
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DestinationError } from "../../src/core/errors";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import type { AccessToken } from "../../src/core/oauth";
import { scanVault } from "../../src/core/scanner";
import { runBackup } from "../../src/core/sync";
import type { BaseEntry } from "../../src/core/sync-planner";
import { syncTwoWay } from "../../src/core/two-way";
import { GoogleDriveFs, type GoogleDriveOptions } from "../../src/destinations/gdrive-fs";
import type { HttpFn, HttpRequest, HttpResponse } from "../../src/destinations/http";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { fs, makeTmp, MemoryState, NodeVaultFs, NodeVaultWriter, path, readText, removePath, renamePath, writeText } from "../support/node";

const FOLDER = "application/vnd.google-apps.folder";
const enc = new TextEncoder();
const dec = new TextDecoder();

interface FFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  data: Uint8Array;
  createdTime: string;
  modifiedTime: string;
  version: number;
}

interface Session {
  id?: string;
  meta?: { name: string; parents: string[] };
  total: number;
  got: Uint8Array[];
  received: number;
}

const json = (status: number, v: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body: enc.encode(JSON.stringify(v)) });
const gerr = (status: number, reason: string, headers: Record<string, string> = {}) => json(status, { error: { code: status, message: reason, errors: [{ reason, message: reason }] } }, headers);

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
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

/** multipart/related 正文 → 各部分的内容（不含头） */
function parseMultipart(body: Uint8Array, boundary: string): Uint8Array[] {
  const mark = enc.encode(`--${boundary}`);
  const out: Uint8Array[] = [];
  let at = indexOf(body, mark, 0);
  while (at >= 0) {
    const headEnd = indexOf(body, enc.encode("\r\n\r\n"), at);
    const next = indexOf(body, enc.encode(`\r\n--${boundary}`), at + mark.length);
    if (headEnd < 0 || next < 0) break;
    out.push(body.slice(headEnd + 4, next));
    at = next + 2;
    if (dec.decode(body.slice(at + mark.length, at + mark.length + 2)) === "--") break;
  }
  return out;
}

/** 内存里的假 Drive API v3 */
class FakeDrive {
  files = new Map<string, FFile>();
  /** 每页最多几条（比请求的 pageSize 小，测试翻页） */
  pageSize = 2;
  /** 服务器认可的令牌 */
  token = "t1";
  quota: { limit?: string; usage: string } = { limit: "1000", usage: "400" };
  /** 依次先返回这些响应（模拟限流、错误） */
  fail: HttpResponse[] = [];
  log: string[] = [];
  private sessions = new Map<string, Session>();
  private seq = 0;

  constructor() {
    this.files.set("root", { id: "root", name: "My Drive", mimeType: FOLDER, parents: [], data: new Uint8Array(0), createdTime: this.time(), modifiedTime: this.time(), version: 1 });
  }

  private time(): string {
    return new Date(Date.UTC(2026, 0, 1) + ++this.seq * 1000).toISOString();
  }

  /** 直接放一个条目（模拟别的设备或重复的同名条目）；返回 id */
  add(name: string, parent: string, data: string | null, created?: string): string {
    const id = "f" + ++this.seq;
    const t = created ?? this.time();
    this.files.set(id, { id, name, mimeType: data === null ? FOLDER : "application/octet-stream", parents: [parent], data: enc.encode(data ?? ""), createdTime: t, modifiedTime: t, version: 1 });
    return id;
  }

  /** 按名字找路径对应的条目（同名取最早的），测试断言用 */
  find(p: string): FFile | undefined {
    let cur = this.files.get("root");
    for (const s of p.split("/").filter(Boolean)) {
      cur = [...this.files.values()].filter((f) => f.parents.includes(cur!.id) && f.name === s).sort((a, b) => a.createdTime.localeCompare(b.createdTime))[0];
      if (!cur) return undefined;
    }
    return cur;
  }

  children(id: string): FFile[] {
    return [...this.files.values()].filter((f) => f.parents.includes(id));
  }

  remove(id: string): void {
    for (const c of this.children(id)) this.remove(c.id);
    this.files.delete(id);
  }

  meta(f: FFile) {
    const isDir = f.mimeType === FOLDER;
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      ...(isDir ? {} : { size: String(f.data.byteLength), md5Checksum: createHash("md5").update(f.data).digest("hex") }),
      modifiedTime: f.modifiedTime,
      createdTime: f.createdTime,
      version: String(f.version),
    };
  }

  private create(meta: { name: string; parents: string[]; mimeType?: string }, data: Uint8Array): HttpResponse {
    const parent = meta.parents[0] ?? "root";
    if (!this.files.has(parent)) return gerr(404, "notFound");
    const id = "f" + ++this.seq;
    const t = this.time();
    const f: FFile = { id, name: meta.name, mimeType: meta.mimeType ?? "application/octet-stream", parents: [parent], data, createdTime: t, modifiedTime: t, version: 1 };
    this.files.set(id, f);
    return json(200, this.meta(f));
  }

  private update(id: string, data: Uint8Array): HttpResponse {
    const f = this.files.get(id);
    if (!f) return gerr(404, "notFound");
    f.data = data;
    f.modifiedTime = this.time();
    f.version++;
    return json(200, this.meta(f));
  }

  http: HttpFn = async (req: HttpRequest) => {
    const url = new URL(req.url);
    const q = url.searchParams;
    this.log.push(`${req.method} ${url.pathname.replace(/^\/(upload\/)?drive\/v3\//, "$1")}${q.get("uploadType") ? " " + q.get("uploadType") : ""}`);
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) h[k.toLowerCase()] = v;
    const pending = this.fail.shift();
    if (pending) return pending;
    if (h.authorization !== `Bearer ${this.token}`) return gerr(401, "authError");
    const body = req.body ?? new Uint8Array(0);
    const m = /^\/(upload\/)?drive\/v3\/(files|about)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return gerr(404, "notFound");
    const upload = !!m[1];
    const id = m[3] ? decodeURIComponent(m[3]) : undefined;

    if (m[2] === "about") return json(200, { storageQuota: this.quota });

    // 可续传上传的分段
    if (upload && req.method === "PUT") {
      const s = this.sessions.get(q.get("upload_id") ?? "");
      if (!s) return gerr(404, "notFound");
      const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h["content-range"] ?? "");
      if (!cr || Number(cr[1]) !== s.received || Number(cr[3]) !== s.total || Number(cr[2]) - Number(cr[1]) + 1 !== body.byteLength) return gerr(400, "badContentRange");
      if (Number(cr[2]) + 1 < s.total && body.byteLength % (256 * 1024) !== 0) return gerr(400, "badChunkSize");
      s.got.push(body.slice());
      s.received += body.byteLength;
      if (s.received < s.total) return { status: 308, headers: { range: `bytes=0-${s.received - 1}` }, body: new Uint8Array(0) };
      const data = concat(s.got);
      return s.id ? this.update(s.id, data) : this.create(s.meta!, data);
    }

    if (upload) {
      const type = q.get("uploadType");
      if (type === "resumable") {
        const sid = "s" + ++this.seq;
        if (id && !this.files.has(id)) return gerr(404, "notFound");
        const meta = id ? undefined : (JSON.parse(dec.decode(body)) as { name: string; parents: string[] });
        if (meta && !this.files.has(meta.parents[0] ?? "")) return gerr(404, "notFound");
        this.sessions.set(sid, { id, meta, total: Number(h["x-upload-content-length"]), got: [], received: 0 });
        return { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` }, body: new Uint8Array(0) };
      }
      if (type === "media" && req.method === "PATCH" && id) return this.update(id, body.slice());
      if (type === "multipart" && req.method === "POST") {
        const boundary = /boundary=([^;]+)/.exec(h["content-type"] ?? "")?.[1] ?? "";
        const [metaPart, dataPart] = parseMultipart(body, boundary);
        if (!metaPart || !dataPart) return gerr(400, "badMultipart");
        return this.create(JSON.parse(dec.decode(metaPart)) as { name: string; parents: string[] }, dataPart);
      }
      return gerr(400, "badUpload");
    }

    if (!id && req.method === "GET") {
      const query = q.get("q") ?? "";
      const qm = /^'([^']+)' in parents(?: and name = '((?:[^'\\]|\\.)*)')? and trashed = false$/.exec(query);
      if (!qm) return gerr(400, "invalidQuery");
      const parent = qm[1]!;
      if (!this.files.has(parent)) return gerr(404, "notFound");
      const name = qm[2]?.replace(/\\(.)/g, "$1");
      // 新建的排在前面：结果顺序不保证，客户端要自己按创建时间挑
      const all = this.children(parent)
        .filter((f) => name === undefined || f.name === name)
        .reverse();
      const start = Number(q.get("pageToken") ?? 0);
      const size = Math.min(this.pageSize, Number(q.get("pageSize") ?? 100));
      const page = all.slice(start, start + size);
      return json(200, { files: page.map((f) => this.meta(f)), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
    }
    if (!id && req.method === "POST") {
      return this.create(JSON.parse(dec.decode(body)) as { name: string; parents: string[]; mimeType?: string }, new Uint8Array(0));
    }
    const f = id ? this.files.get(id) : undefined;
    if (!f || !id) return gerr(404, "notFound");
    if (req.method === "GET") return q.get("alt") === "media" ? { status: 200, headers: {}, body: f.data } : json(200, { ...this.meta(f), trashed: false });
    if (req.method === "DELETE") {
      this.remove(id);
      return { status: 204, headers: {}, body: new Uint8Array(0) };
    }
    if (req.method === "PATCH") {
      const add = q.get("addParents");
      const rem = q.get("removeParents");
      if (add && !this.files.has(add)) return gerr(404, "notFound");
      if (add) f.parents = [...f.parents.filter((x) => x !== rem), add];
      const meta = JSON.parse(dec.decode(body)) as { name?: string };
      if (meta.name) f.name = meta.name;
      f.version++;
      return json(200, this.meta(f));
    }
    return gerr(400, "badRequest");
  };
}

/** 假令牌：每次 invalidate 换下一个 */
function tokens(list: string[]): AccessToken & { invalidations: number } {
  let i = 0;
  const t = {
    invalidations: 0,
    get: async () => list[Math.min(i, list.length - 1)]!,
    invalidate: () => {
      i++;
      t.invalidations++;
    },
  };
  return t;
}

let drive: FakeDrive;
let sleeps: number[];
const make = (o: Partial<GoogleDriveOptions> = {}) =>
  new GoogleDriveFs({
    token: tokens(["t1"]),
    http: drive.http,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...o,
  });
const str = async (fsx: GoogleDriveFs, p: string) => dec.decode(await fsx.readFile(p));
const codeOf = (e: unknown) => (e as { code?: string }).code;

beforeEach(() => {
  drive = new FakeDrive();
  sleeps = [];
});

describe("Google Drive：路径与读写", () => {
  it("逐段查 id 并缓存：同一文件夹下第二次 stat 只查最后一段", async () => {
    const g = make();
    await g.mkdirp("/Multi Backup/My Notes");
    await g.writeFile("/Multi Backup/My Notes/a.md", enc.encode("A"));
    drive.log = [];
    const fresh = make();
    expect(await fresh.stat("/Multi Backup/My Notes/a.md")).toMatchObject({ isDir: false, size: 1 });
    expect(drive.log.length).toBe(3);
    drive.log = [];
    await fresh.stat("/Multi Backup/My Notes/a.md");
    expect(drive.log).toEqual(["GET files"]);
    expect(await str(fresh, "/Multi Backup/My Notes/a.md")).toBe("A");
  });

  it("stat 与 list：翻页、大小、修改时间、etag 用 md5", async () => {
    const g = make();
    await g.mkdirp("/d/sub");
    for (let i = 0; i < 5; i++) await g.writeFile(`/d/f${i}.md`, enc.encode("x".repeat(i)));
    const list = await make().list("/d");
    expect(list.map((e) => e.name).sort()).toEqual(["f0.md", "f1.md", "f2.md", "f3.md", "f4.md", "sub"]);
    const f3 = list.find((e) => e.name === "f3.md");
    expect(f3).toMatchObject({ isDir: false, size: 3, etag: createHash("md5").update("xxx").digest("hex") });
    expect(f3?.mtime).toBeGreaterThan(0);
    expect(list.find((e) => e.name === "sub")?.isDir).toBe(true);
    expect(await g.stat("/d/sub")).toMatchObject({ isDir: true });
    expect(await g.stat("/")).toEqual({ isDir: true, size: 0, mtime: 0 });
    expect(await g.stat("/d/nope.md")).toBeNull();
    expect(await g.stat("/nope/a.md")).toBeNull();
    expect(await g.list("/d/sub")).toEqual([]);
  });

  it("mkdirp：已存在时不重复创建（另一个实例也一样）", async () => {
    await make().mkdirp("/a/b/c");
    await make().mkdirp("/a/b/c");
    const g = make();
    await g.mkdirp("/a/b");
    await g.mkdirp("/a/b/c/d");
    expect([...drive.files.values()].filter((f) => f.mimeType === FOLDER).length).toBe(5);
    expect(drive.find("/a/b/c/d")?.mimeType).toBe(FOLDER);
  });

  it("新文件 multipart、覆盖用 media；中文、空格、单引号、反斜杠的名字", async () => {
    const g = make();
    const dir = "/it's 文件夹";
    const p = `${dir}/中文 笔记's \\1.md`;
    await g.mkdirp(dir);
    await g.writeFile(p, enc.encode("第一版"));
    expect(drive.log).toContain("POST upload/files multipart");
    await make().writeFile(p, enc.encode("第二版"));
    expect(drive.log).toContain("PATCH upload/files/" + drive.find(p)!.id + " media");
    expect(await str(make(), p)).toBe("第二版");
    expect(drive.children(drive.find(dir)!.id).length).toBe(1);
    expect((await g.list(dir)).map((e) => e.name)).toEqual(["中文 笔记's \\1.md"]);
  });

  it("大文件用可续传上传（分段为 256 KiB 的整数倍），新建与覆盖都行", async () => {
    const g = make({ resumableThreshold: 1024, chunkSize: 300 * 1024 });
    const big = new Uint8Array(600 * 1024 + 7).map((_, i) => i % 251);
    await g.mkdirp("/大");
    await g.writeFile("/大/b.bin", big);
    expect(drive.log.filter((l) => l.startsWith("PUT upload/files ")).length).toBe(3);
    expect(await g.readFile("/大/b.bin")).toEqual(big);
    const big2 = big.map((b) => 255 - b);
    await g.writeFile("/大/b.bin", big2);
    expect(drive.log.filter((l) => l.startsWith("PATCH upload/files/") && l.endsWith("resumable")).length).toBe(1);
    expect(await make().readFile("/大/b.bin")).toEqual(big2);
    expect(drive.children(drive.find("/大")!.id).length).toBe(1);
  }, 30_000); // 要处理约 1 MB 数据，CI 机器负载高时会超过默认的 5 秒

  it("openWrite：收集后一次上传", async () => {
    const g = make();
    const w = await g.openWrite("/z.zip");
    await w.write(enc.encode("ab"));
    await w.write(enc.encode("cd"));
    await w.close();
    expect(await str(g, "/z.zip")).toBe("abcd");
  });

  it("同名条目：取创建时间最早的，每个实例结果一致", async () => {
    const older = drive.add("Dup", "root", null, "2025-01-01T00:00:00.000Z");
    const newer = drive.add("Dup", "root", null, "2025-06-01T00:00:00.000Z");
    drive.add("x.md", older, "旧的", "2025-01-02T00:00:00.000Z");
    drive.add("x.md", older, "新的", "2025-07-01T00:00:00.000Z");
    drive.add("y.md", newer, "Y");
    for (const g of [make(), make()]) {
      expect(await str(g, "/Dup/x.md")).toBe("旧的");
      expect(await g.stat("/Dup/y.md")).toBeNull();
      expect((await g.list("/Dup")).map((e) => e.name)).toEqual(["x.md"]);
      expect((await g.list("/")).map((e) => e.name)).toEqual(["Dup"]);
    }
  });

  it("改名到已有文件上：先删掉目标；跨文件夹移动", async () => {
    const g = make();
    await g.mkdirp("/r/trash/2026-10-31");
    await g.writeFile("/r/a.md", enc.encode("A"));
    await g.writeFile("/r/b.md", enc.encode("B"));
    await g.rename("/r/a.md", "/r/b.md");
    expect(await g.stat("/r/a.md")).toBeNull();
    expect(await str(g, "/r/b.md")).toBe("A");
    expect(drive.children(drive.find("/r")!.id).filter((f) => f.name === "b.md").length).toBe(1);
    await g.rename("/r/b.md", "/r/trash/2026-10-31/b 2.md");
    expect(await g.stat("/r/b.md")).toBeNull();
    expect(await str(make(), "/r/trash/2026-10-31/b 2.md")).toBe("A");
    // 文件夹改名后，旧路径下缓存的子路径失效
    await g.rename("/r/trash", "/r/old");
    expect(await g.stat("/r/trash/2026-10-31/b 2.md")).toBeNull();
    expect(await str(g, "/r/old/2026-10-31/b 2.md")).toBe("A");
  });

  it("removeFile、removeDir（连同里面的内容）；不存在时不报错", async () => {
    const g = make();
    await g.mkdirp("/x/y");
    await g.writeFile("/x/y/1.md", enc.encode("1"));
    await g.writeFile("/x/2.md", enc.encode("2"));
    await g.removeFile("/x/2.md");
    await g.removeFile("/x/2.md");
    await g.removeFile("/nope/2.md");
    expect(await g.stat("/x/2.md")).toBeNull();
    await g.removeDir("/x");
    expect(await g.stat("/x/y/1.md")).toBeNull();
    expect(await g.stat("/x")).toBeNull();
    expect(drive.files.size).toBe(1);
  });

  it("找不到：readFile、list、rename 报 not-found；writeFile 自动建上级文件夹", async () => {
    const g = make();
    expect(codeOf(await g.readFile("/no.md").catch((e: unknown) => e))).toBe("not-found");
    expect(codeOf(await g.list("/no").catch((e: unknown) => e))).toBe("not-found");
    expect(codeOf(await g.rename("/no.md", "/b.md").catch((e: unknown) => e))).toBe("not-found");
    await g.writeFile("/new/dir/a.md", enc.encode("a"));
    expect(await str(make(), "/new/dir/a.md")).toBe("a");
  });

  it("缓存的 id 失效（别的设备删掉又重建）：404 后重新查一次", async () => {
    const a = make();
    await a.mkdirp("/X");
    await a.writeFile("/X/a.md", enc.encode("old"));
    expect(await str(a, "/X/a.md")).toBe("old");
    drive.remove(drive.find("/X")!.id);
    const b = make();
    await b.mkdirp("/X");
    await b.writeFile("/X/a.md", enc.encode("new"));
    expect(await str(a, "/X/a.md")).toBe("new");
    drive.remove(drive.find("/X")!.id);
    await b.mkdirp("/X");
    await b.writeFile("/X/c.md", enc.encode("C"));
    expect((await a.list("/X")).map((e) => e.name)).toEqual(["c.md"]);
    await a.writeFile("/X/c.md", enc.encode("C2"));
    expect(await str(b, "/X/c.md")).toBe("C2");
  });
});

describe("Google Drive：错误处理", () => {
  it("401：invalidate 后重试成功；仍然 401 报 auth-expired", async () => {
    drive.token = "t2";
    const t = tokens(["t1", "t2"]);
    const g = make({ token: t });
    await g.mkdirp("/a");
    expect(t.invalidations).toBe(1);
    expect(drive.find("/a")).toBeDefined();
    const bad = make({ token: tokens(["t1", "t1"]) });
    const err = await bad.stat("/a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DestinationError);
    expect(err).toMatchObject({ code: "auth-expired", path: "Google Drive" });
  });

  it("限流与 5xx：按 Retry-After 或 1、2、4 秒重试；超过 3 次报错", async () => {
    const g = make();
    drive.fail = [gerr(403, "userRateLimitExceeded"), gerr(429, "rateLimitExceeded", { "retry-after": "7" }), gerr(503, "backendError")];
    await g.mkdirp("/a");
    expect(sleeps).toEqual([1000, 7000, 4000]);
    sleeps = [];
    drive.fail = [gerr(500, "backendError"), gerr(500, "backendError"), gerr(500, "backendError"), gerr(500, "backendError")];
    expect(codeOf(await g.stat("/a/b.md").catch((e: unknown) => e))).toBe("io");
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("403：空间满报 quota，其他报 no-permission；网络异常报 network", async () => {
    const g = make();
    drive.fail = [gerr(403, "storageQuotaExceeded")];
    expect(codeOf(await g.writeFile("/a.md", enc.encode("a")).catch((e: unknown) => e))).toBe("quota");
    drive.fail = [gerr(403, "insufficientFilePermissions")];
    expect(codeOf(await g.stat("/a.md").catch((e: unknown) => e))).toBe("no-permission");
    const offline = make({
      http: () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    });
    expect(codeOf(await offline.stat("/a.md").catch((e: unknown) => e))).toBe("network");
    expect(sleeps).toEqual([]);
  });

  it("剩余空间：上限减已用；没有上限返回 null", async () => {
    expect(await make().freeSpace()).toBe(600);
    drive.quota = { usage: "400" };
    expect(await make().freeSpace()).toBeNull();
  });
});

describe("Google Drive 上的本地镜像", () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>;
  beforeEach(async () => {
    tmp = await makeTmp();
  });
  afterEach(() => tmp.cleanup());
  const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));

  it("备份：首次、增量（改、改名、删），历史版本与回收站在 .multi-backup/ 下", async () => {
    const fsx = make();
    const root = "/Multi Backup/My Notes";
    const vault = path.join(tmp.dir, "vault");
    await writeText(path.join(vault, "a.md"), "A1");
    await writeText(path.join(vault, "中文/笔记 1.md"), "N1");
    const state = new MemoryState();
    const mirror = () => new LocalMirror(fsx, { root, deletePolicy: "trash30", keepVersions: 10, createRoot: true });
    const run = () => runBackup({ vault: new NodeVaultFs(vault), state, matcher: matcher(), maxFileSize: 1 << 30 }, [{ id: "d", store: mirror(), extraExcludes: [] }]);

    const r1 = await run();
    expect(r1.destinations[0]).toMatchObject({ status: "ok", uploaded: 2 });
    expect(await str(fsx, `${root}/中文/笔记 1.md`)).toBe("N1");

    await writeText(path.join(vault, "a.md"), "A2");
    await renamePath(path.join(vault, "中文", "笔记 1.md"), path.join(vault, "中文", "笔记 2.md"));
    await writeText(path.join(vault, "gone.md"), "G");
    await run();
    await removePath(path.join(vault, "gone.md"));
    const r2 = await run();
    expect(r2.destinations[0]?.status).toBe("ok");
    expect((await fsx.list(root)).map((e) => e.name).sort()).toEqual([".multi-backup", "a.md", "中文"]);
    expect((await fsx.list(`${root}/中文`)).map((e) => e.name)).toEqual(["笔记 2.md"]);
    expect(await str(fsx, `${root}/a.md`)).toBe("A2");
    expect((await fsx.list(`${root}/.multi-backup/versions/a.md`)).length).toBe(1);
    expect((await fsx.list(`${root}/.multi-backup/trash`)).length).toBe(1);
    const src = mirror().restoreSource();
    expect([...(await src.files("current")).keys()].sort()).toEqual(["a.md", "中文/笔记 2.md"]);
    const vers = await src.fileVersions("a.md", 10);
    expect(vers.map((v) => v.pointId.slice(0, 2))).toEqual(["cu", "v:"]);
    expect(dec.decode(await src.read(vers[1]!.pointId, "a.md"))).toBe("A1");
  });

  it("主同步端：两台设备交替修改后一致，两边都改了保留两份", async () => {
    const root = "/primary";
    const device = (dev: string) => {
      const dir = path.join(tmp.dir, dev);
      // 每台设备有自己的 GoogleDriveFs（各自的 id 缓存）
      const fsx = make();
      let base = new Map<string, BaseEntry>();
      return {
        dir,
        async sync(t = new Date()) {
          await fs.mkdir(dir, { recursive: true });
          const store = new LocalMirror(fsx, { root, deletePolicy: "trash30", keepVersions: 10, createRoot: true }).asPrimary();
          await store.prepare();
          const vault = new NodeVaultFs(dir);
          const scan = await scanVault(vault, { matcher: matcher(), maxFileSize: 1 << 30, previous: { version: 1, updatedAt: 0, files: {} } });
          const res = await syncTwoWay({ vault, writer: new NodeVaultWriter(dir), store, local: scan.files, base, remote: await store.list(), matches: (d, id, p) => store.matches(d, id, p), remoteDevice: () => "other", now: () => t });
          await store.finish(t);
          base = res.base;
          return res;
        },
      };
    };
    const a = device("a");
    const b = device("b");
    await writeText(path.join(a.dir, "n.md"), "v1");
    await writeText(path.join(a.dir, "x.md"), "X");
    await a.sync();
    await b.sync();
    expect(await readText(path.join(b.dir, "x.md"))).toBe("X");
    await writeText(path.join(b.dir, "n.md"), "B 改的");
    await removePath(path.join(b.dir, "x.md"));
    await b.sync();
    await writeText(path.join(a.dir, "n.md"), "A 改的");
    const r = await a.sync(new Date(2026, 9, 31, 16, 0));
    expect(r.conflicts).toMatchObject([{ path: "n.md", kind: "both" }]);
    expect(await fs.stat(path.join(a.dir, "x.md")).then(() => true, () => false)).toBe(false);
    await b.sync();
    expect(await readText(path.join(b.dir, "n.md"))).toBe("A 改的");
    expect(await readText(path.join(b.dir, "n.conflict-other-2026-10-31-1600.md"))).toBe("B 改的");
  });
});
