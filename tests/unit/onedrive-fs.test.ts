// OneDriveFs：用内存中的模拟 Microsoft Graph 测试（按路径寻址、子项翻页、上传会话、下载地址、移动、错误格式），
// 再让本地镜像（备份、历史版本、回收站、主同步端）跑在它上面。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DestinationError } from "../../src/core/errors";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import type { AccessToken } from "../../src/core/oauth";
import { scanVault } from "../../src/core/scanner";
import { runBackup } from "../../src/core/sync";
import type { BaseEntry } from "../../src/core/sync-planner";
import { syncTwoWay } from "../../src/core/two-way";
import type { HttpRequest, HttpResponse } from "../../src/destinations/http";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { CHUNK, OneDriveFs, SMALL_UPLOAD } from "../../src/destinations/onedrive-fs";
import { fs, makeTmp, MemoryState, NodeVaultFs, NodeVaultWriter, path, readText, removePath, renamePath, writeText } from "../support/node";

const GRAPH = "https://graph.microsoft.com/v1.0";
const BASE = `${GRAPH}/me/drive/special/approot`;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Node {
  id: string;
  isDir: boolean;
  data: Uint8Array;
  mtime: number;
  ver: number;
}

interface Session {
  path: string;
  total: number;
  got: Uint8Array[];
  next: number;
}

/** 内存中的模拟 Graph：只实现 OneDriveFs 用到的接口 */
class FakeGraph {
  items = new Map<string, Node>([["/", { id: "root", isDir: true, data: new Uint8Array(), mtime: 0, ver: 1 }]]);
  validToken = "t1";
  pageSize = 2;
  /** 个人版 OneDrive 的移动不接受 replace，目标已存在时报 409 */
  moveReplace = true;
  /** 接下来的请求先依次返回这些响应 */
  inject: HttpResponse[] = [];
  log: HttpRequest[] = [];
  remaining: number | undefined = 5_000_000;
  chunkSizes: number[] = [];
  private seq = 0;
  private clock = Date.UTC(2026, 9, 31, 8, 0, 0);
  private sessions = new Map<string, Session>();
  private pages = new Map<string, string[]>();

  http = async (req: HttpRequest): Promise<HttpResponse> => {
    this.log.push(req);
    const injected = this.inject.shift();
    if (injected) return injected;
    const [url = "", query = ""] = req.url.split("?");
    const auth = req.headers?.Authorization;
    // 预签名地址：不能带令牌
    if (url.startsWith("https://upload.fake/") || url.startsWith("https://download.fake/")) {
      if (auth) return json(400, { error: { code: "invalidRequest", message: "no auth on presigned url" } });
      if (url.startsWith("https://download.fake/")) {
        const n = [...this.items.values()].find((x) => x.id === url.slice("https://download.fake/".length));
        return n ? { status: 200, headers: {}, body: n.data.slice() } : json(404, notFound());
      }
      return this.chunk(url, req);
    }
    if (auth !== `Bearer ${this.validToken}`) return json(401, { error: { code: "InvalidAuthenticationToken", message: "expired" } });
    if (url.startsWith(`${GRAPH}/next/`)) return this.page(url.slice(`${GRAPH}/next/`.length));
    if (url === `${GRAPH}/me/drive`) return json(200, { quota: this.remaining === undefined ? {} : { remaining: this.remaining, total: 1e10 } });
    if (url.startsWith(`${GRAPH}/me/drive/items/`) && req.method === "PATCH") return this.move(decodeURIComponent(url.slice(`${GRAPH}/me/drive/items/`.length)), req, query);
    if (!url.startsWith(BASE)) return json(400, { error: { code: "invalidRequest", message: url } });
    let rest = url.slice(BASE.length);
    let p = "/";
    if (rest.startsWith(":/")) {
      const end = rest.indexOf(":", 2);
      p = "/" + rest.slice(2, end).split("/").map(decodeURIComponent).join("/");
      rest = rest.slice(end + 1);
    }
    const node = this.items.get(p);
    if (rest === "/children" && req.method === "GET") {
      if (!node) return json(404, notFound());
      const kids = [...this.items.keys()].filter((k) => k !== "/" && parent(k) === p);
      const token = String(++this.seq);
      this.pages.set(token, kids);
      return this.page(token);
    }
    if (rest === "/children" && req.method === "POST") {
      if (!node?.isDir) return json(404, notFound());
      const b = JSON.parse(dec.decode(req.body)) as { name: string; folder?: object };
      const child = join(p, b.name);
      if (this.items.has(child)) return json(409, { error: { code: "nameAlreadyExists", message: "exists" } });
      this.items.set(child, this.newNode(true));
      return json(201, this.item(child));
    }
    if (rest === "/content" && req.method === "PUT") {
      if (node?.isDir) return json(409, { error: { code: "nameAlreadyExists", message: "folder" } });
      this.put(p, req.body ?? new Uint8Array());
      return json(node ? 200 : 201, this.item(p));
    }
    if (rest === "/content" && req.method === "GET") {
      return node && !node.isDir ? { status: 200, headers: {}, body: node.data.slice() } : json(404, notFound());
    }
    if (rest === "/createUploadSession" && req.method === "POST") {
      const id = `https://upload.fake/s${++this.seq}`;
      this.sessions.set(id, { path: p, total: -1, got: [], next: 0 });
      return json(200, { uploadUrl: id, expirationDateTime: "2026-11-01T00:00:00Z" });
    }
    if (rest === "" && req.method === "GET") {
      if (!node) return json(404, notFound());
      const it = this.item(p);
      if (query.includes("downloadUrl") && !node.isDir) it["@microsoft.graph.downloadUrl"] = `https://download.fake/${node.id}`;
      return json(200, it);
    }
    if (rest === "" && req.method === "DELETE") {
      if (!node) return json(404, notFound());
      for (const k of [...this.items.keys()]) if (k === p || k.startsWith(p + "/")) this.items.delete(k);
      return { status: 204, headers: {}, body: new Uint8Array() };
    }
    return json(400, { error: { code: "invalidRequest", message: `${req.method} ${rest}` } });
  };

  file(p: string): string | undefined {
    const n = this.items.get(p);
    return n && !n.isDir ? dec.decode(n.data) : undefined;
  }

  private newNode(isDir: boolean, data = new Uint8Array()): Node {
    return { id: `id${++this.seq}`, isDir, data, mtime: (this.clock += 1000), ver: 1 };
  }

  private put(p: string, data: Uint8Array) {
    // 和 Graph 一样：缺的上级文件夹自动建
    const segs = p.split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const d = "/" + segs.slice(0, i).join("/");
      if (!this.items.has(d)) this.items.set(d, this.newNode(true));
    }
    const old = this.items.get(p);
    if (old) Object.assign(old, { data: data.slice(), mtime: (this.clock += 1000), ver: old.ver + 1 });
    else this.items.set(p, this.newNode(false, data.slice()));
  }

  private item(p: string): Record<string, unknown> {
    const n = this.items.get(p) as Node;
    const base: Record<string, unknown> = { id: n.id, name: p === "/" ? "root" : p.slice(p.lastIndexOf("/") + 1), lastModifiedDateTime: new Date(n.mtime).toISOString(), eTag: `"{${n.id}},${n.ver + 100}"` };
    if (n.isDir) return { ...base, size: 0, folder: { childCount: 0 } };
    return { ...base, size: n.data.byteLength, cTag: `"c:{${n.id}},${n.ver}"`, file: { mimeType: "application/octet-stream" } };
  }

  private page(token: string): HttpResponse {
    const all = this.pages.get(token) ?? [];
    const now = all.slice(0, this.pageSize);
    const rest = all.slice(this.pageSize);
    const body: Record<string, unknown> = { value: now.map((k) => this.item(k)) };
    if (rest.length) {
      const next = String(++this.seq);
      this.pages.set(next, rest);
      body["@odata.nextLink"] = `${GRAPH}/next/${next}`;
    }
    return json(200, body);
  }

  private chunk(url: string, req: HttpRequest): HttpResponse {
    const s = this.sessions.get(url);
    if (!s) return json(404, notFound());
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers?.["Content-Range"] ?? "");
    if (!m || Number(m[1]) !== s.next) return json(416, { error: { code: "invalidRange", message: "range" } });
    const len = Number(m[2]) - Number(m[1]) + 1;
    const total = Number(m[3]);
    const body = req.body ?? new Uint8Array();
    if (body.byteLength !== len) return json(400, { error: { code: "invalidRange", message: "length" } });
    const last = Number(m[2]) + 1 === total;
    if (!last && len % (320 * 1024) !== 0) return json(400, { error: { code: "invalidRange", message: "not 320 KiB multiple" } });
    this.chunkSizes.push(len);
    s.got.push(body.slice());
    s.next += len;
    if (!last) return json(202, { nextExpectedRanges: [`${s.next}-`] });
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of s.got) {
      all.set(c, at);
      at += c.byteLength;
    }
    this.sessions.delete(url);
    const existed = this.items.has(s.path);
    this.put(s.path, all);
    return json(existed ? 200 : 201, this.item(s.path));
  }

  private move(id: string, req: HttpRequest, query: string): HttpResponse {
    const from = [...this.items.entries()].find(([, n]) => n.id === id)?.[0];
    if (!from) return json(404, notFound());
    const b = JSON.parse(dec.decode(req.body)) as { parentReference?: { id: string }; name?: string };
    const dir = b.parentReference ? [...this.items.entries()].find(([, n]) => n.id === b.parentReference?.id)?.[0] : parent(from);
    if (!dir) return json(400, { error: { code: "invalidRequest", message: "parent" } });
    const to = join(dir, b.name ?? from.slice(from.lastIndexOf("/") + 1));
    if (this.items.has(to)) {
      if (!this.moveReplace || !query.includes("conflictBehavior=replace")) return json(409, { error: { code: "nameAlreadyExists", message: "exists" } });
      this.items.delete(to);
    }
    for (const k of [...this.items.keys()]) {
      if (k === from || k.startsWith(from + "/")) {
        const n = this.items.get(k) as Node;
        this.items.delete(k);
        this.items.set(to + k.slice(from.length), n);
      }
    }
    return json(200, this.item(to));
  }
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: enc.encode(JSON.stringify(body)) };
}
const notFound = () => ({ error: { code: "itemNotFound", message: "not found" } });
const parent = (p: string) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));
const join = (d: string, n: string) => (d === "/" ? `/${n}` : `${d}/${n}`);

/** 令牌：t1、t2…，invalidate 后换下一个 */
function fakeToken() {
  let n = 1;
  let invalidated = 0;
  const t: AccessToken & { invalidated: () => number } = {
    get: async () => `t${n}`,
    invalidate: () => {
      n++;
      invalidated++;
    },
    invalidated: () => invalidated,
  };
  return t;
}

function setup() {
  const g = new FakeGraph();
  const token = fakeToken();
  const slept: number[] = [];
  const fsx = new OneDriveFs({ token, http: g.http, sleep: async (ms) => void slept.push(ms) });
  return { g, token, slept, fsx };
}

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const codeOf = (e: unknown) => (e as DestinationError).code;

describe("OneDriveFs", () => {
  it("小文件：中文、空格、#、% 文件名上传、读取、stat，cTag 作为 etag", async () => {
    const { g, fsx } = setup();
    const p = "/Multi Backup/中文 笔记/a #1 100%.md";
    await fsx.writeFile(p, enc.encode("你好"));
    expect(g.file(p)).toBe("你好");
    const put = g.log.find((r) => r.method === "PUT");
    expect(put?.url).toBe(`${BASE}:/Multi%20Backup/%E4%B8%AD%E6%96%87%20%E7%AC%94%E8%AE%B0/a%20%231%20100%25.md:/content`);
    expect(dec.decode(await fsx.readFile(p))).toBe("你好");
    const st = await fsx.stat(p);
    expect(st).toMatchObject({ isDir: false, size: 6 });
    expect(st?.etag).toMatch(/^c:\{id\d+\},1$/);
    expect(st?.mtime).toBeGreaterThan(0);
    expect(await fsx.stat("/Multi Backup/中文 笔记")).toMatchObject({ isDir: true });
    expect(await fsx.stat("/")).toMatchObject({ isDir: true });
    // 下载走预签名地址，不带令牌
    const dl = g.log.find((r) => r.url.startsWith("https://download.fake/"));
    expect(dl?.headers?.Authorization).toBeUndefined();
  });

  it("大文件：上传会话分块（320 KiB 整数倍、不带令牌），读回一致；覆盖已有文件", async () => {
    const { g, fsx } = setup();
    const p = "/大 文件/#big%.bin";
    const data = bytes(SMALL_UPLOAD + 12345);
    await fsx.writeFile(p, enc.encode("old"));
    await fsx.writeFile(p, data);
    expect(g.chunkSizes).toEqual([CHUNK, data.byteLength - CHUNK]);
    expect(g.log.filter((r) => r.url.startsWith("https://upload.fake/")).every((r) => !r.headers?.Authorization)).toBe(true);
    const back = await fsx.readFile(p);
    expect(back.byteLength).toBe(data.byteLength);
    expect(same(back, data)).toBe(true);
    expect(SMALL_UPLOAD).toBe(4 * 1024 * 1024);
    expect(CHUNK % (320 * 1024)).toBe(0);
  });

  it("list：跟随 @odata.nextLink 翻页，带大小、时间、etag", async () => {
    const { fsx } = setup();
    for (const n of ["a.md", "b c.md", "#d.md", "e%.md", "中.md"]) await fsx.writeFile(`/r/${n}`, enc.encode(n));
    await fsx.mkdirp("/r/sub");
    const items = await fsx.list("/r");
    expect(items.map((e) => e.name).sort()).toEqual(["#d.md", "a.md", "b c.md", "e%.md", "sub", "中.md"]);
    expect(items.find((e) => e.name === "sub")).toMatchObject({ isDir: true });
    expect(items.find((e) => e.name === "a.md")).toMatchObject({ isDir: false, size: 4 });
    expect(items.find((e) => e.name === "a.md")?.etag).toBeTruthy();
    expect((await fsx.list("/")).map((e) => e.name)).toEqual(["r"]);
  });

  it("mkdirp：逐级建，已存在不报错", async () => {
    const { g, fsx } = setup();
    await fsx.mkdirp("/x/y 1/z#");
    expect(g.items.get("/x/y 1/z#")?.isDir).toBe(true);
    await fsx.mkdirp("/x/y 1/z#");
    await fsx.mkdirp("/x/y 1/w");
    expect(g.items.get("/x/y 1/w")?.isDir).toBe(true);
  });

  it("rename：移到新文件夹并改名、覆盖已有文件；不接受 replace 时先删目标", async () => {
    const { g, fsx } = setup();
    await fsx.writeFile("/a/1.md", enc.encode("one"));
    await fsx.rename("/a/1.md", "/b/新 名%.md");
    expect(g.file("/a/1.md")).toBeUndefined();
    expect(g.file("/b/新 名%.md")).toBe("one");
    await fsx.writeFile("/a/2.md", enc.encode("two"));
    await fsx.rename("/a/2.md", "/b/新 名%.md");
    expect(g.file("/b/新 名%.md")).toBe("two");
    g.moveReplace = false;
    await fsx.writeFile("/a/3.md", enc.encode("three"));
    await fsx.rename("/a/3.md", "/b/新 名%.md");
    expect(g.file("/b/新 名%.md")).toBe("three");
    expect(g.file("/a/3.md")).toBeUndefined();
    expect(codeOf(await fsx.rename("/nope.md", "/x.md").catch((e: unknown) => e))).toBe("not-found");
  });

  it("removeFile、removeDir（连同内容）；不存在不报错", async () => {
    const { g, fsx } = setup();
    await fsx.writeFile("/d/e/f.md", enc.encode("f"));
    await fsx.writeFile("/d/g.md", enc.encode("g"));
    await fsx.removeFile("/d/g.md");
    expect(g.file("/d/g.md")).toBeUndefined();
    await fsx.removeFile("/d/g.md");
    await fsx.removeDir("/d");
    expect([...g.items.keys()]).toEqual(["/"]);
    await fsx.removeDir("/d");
  });

  it("不存在：stat 返回 null，readFile、list 报 not-found", async () => {
    const { fsx } = setup();
    expect(await fsx.stat("/没有.md")).toBeNull();
    expect(codeOf(await fsx.readFile("/没有.md").catch((e: unknown) => e))).toBe("not-found");
    expect(codeOf(await fsx.list("/没有").catch((e: unknown) => e))).toBe("not-found");
  });

  it("401：作废令牌后重试一次成功；仍然 401 报 auth-expired", async () => {
    const { g, token, fsx } = setup();
    g.validToken = "t2";
    await fsx.writeFile("/a.md", enc.encode("A"));
    expect(token.invalidated()).toBe(1);
    expect(g.file("/a.md")).toBe("A");
    g.validToken = "never";
    const err = await fsx.stat("/a.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DestinationError);
    expect(codeOf(err)).toBe("auth-expired");
    expect(token.invalidated()).toBe(2);
  });

  it("429、503：按 Retry-After 等待后重试，最多 3 次", async () => {
    const { g, slept, fsx } = setup();
    g.inject.push(json(429, { error: { code: "activityLimitReached" } }), { ...json(503, {}), headers: { "retry-after": "2" } });
    await fsx.writeFile("/a.md", enc.encode("A"));
    expect(slept).toEqual([1000, 2000]);
    expect(g.file("/a.md")).toBe("A");
    g.inject.push(...[1, 2, 3, 4].map(() => json(429, {})));
    expect(codeOf(await fsx.stat("/a.md").catch((e: unknown) => e))).toBe("io");
    expect(slept).toHaveLength(5);
  });

  it("错误映射：403、507、quotaLimitReached、网络错误", async () => {
    const { g, fsx } = setup();
    g.inject.push(json(403, { error: { code: "accessDenied" } }));
    expect(codeOf(await fsx.writeFile("/a.md", enc.encode("A")).catch((e: unknown) => e))).toBe("no-permission");
    g.inject.push(json(507, { error: { code: "insufficientStorage" } }));
    expect(codeOf(await fsx.writeFile("/a.md", enc.encode("A")).catch((e: unknown) => e))).toBe("quota");
    g.inject.push(json(403, { error: { code: "quotaLimitReached" } }));
    expect(codeOf(await fsx.writeFile("/a.md", enc.encode("A")).catch((e: unknown) => e))).toBe("quota");
    const down = new OneDriveFs({ token: fakeToken(), http: () => Promise.reject(Object.assign(new Error("offline"), { code: "ENOTFOUND" })) });
    expect(codeOf(await down.stat("/a.md").catch((e: unknown) => e))).toBe("network");
  });

  it("freeSpace：quota.remaining，没有时返回 null", async () => {
    const { g, fsx } = setup();
    expect(await fsx.freeSpace()).toBe(5_000_000);
    g.remaining = undefined;
    expect(await fsx.freeSpace()).toBeNull();
  });

  it("openWrite：收集后一次上传", async () => {
    const { g, fsx } = setup();
    const w = await fsx.openWrite("/z.zip");
    await w.write(enc.encode("ab"));
    await w.write(enc.encode("cd"));
    await w.close();
    expect(g.file("/z.zip")).toBe("abcd");
  });
});

describe("OneDriveFs 上的本地镜像", () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>;
  beforeEach(async () => {
    tmp = await makeTmp();
  });
  afterEach(() => tmp.cleanup());

  const matcher = () => new ExcludeMatcher(builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }));

  it("备份：首次、增量（改、改名、删），历史版本与回收站在 .multi-backup/ 下", async () => {
    const { fsx } = setup();
    const root = "/Multi Backup/My Notes";
    const vault = path.join(tmp.dir, "vault");
    await writeText(path.join(vault, "a.md"), "A1");
    await writeText(path.join(vault, "中文/笔记 #1.md"), "N1");
    const state = new MemoryState();
    const mirror = () => new LocalMirror(fsx, { root, deletePolicy: "trash30", keepVersions: 10, createRoot: true });
    const run = () => runBackup({ vault: new NodeVaultFs(vault), state, matcher: matcher(), maxFileSize: 1 << 30 }, [{ id: "d", store: mirror(), extraExcludes: [] }]);

    const r1 = await run();
    expect(r1.destinations[0]).toMatchObject({ status: "ok", uploaded: 2 });
    expect(dec.decode(await fsx.readFile(`${root}/中文/笔记 #1.md`))).toBe("N1");

    await writeText(path.join(vault, "a.md"), "A2");
    await renamePath(path.join(vault, "中文", "笔记 #1.md"), path.join(vault, "中文", "笔记 2%.md"));
    await writeText(path.join(vault, "gone.md"), "G");
    await run();
    await removePath(path.join(vault, "gone.md"));
    const r2 = await run();
    expect(r2.destinations[0]?.status).toBe("ok");
    expect((await fsx.list(root)).map((e) => e.name).sort()).toEqual([".multi-backup", "a.md", "中文"]);
    expect((await fsx.list(`${root}/中文`)).map((e) => e.name)).toEqual(["笔记 2%.md"]);
    expect(dec.decode(await fsx.readFile(`${root}/a.md`))).toBe("A2");
    expect((await fsx.list(`${root}/.multi-backup/versions/a.md`)).length).toBe(1);
    expect((await fsx.list(`${root}/.multi-backup/trash`)).length).toBe(1);
    const src = mirror().restoreSource();
    expect([...(await src.files("current")).keys()].sort()).toEqual(["a.md", "中文/笔记 2%.md"]);
    const vers = await src.fileVersions("a.md", 10);
    expect(vers.map((v) => v.pointId.slice(0, 2))).toEqual(["cu", "v:"]);
    expect(dec.decode(await src.read(vers[1]!.pointId, "a.md"))).toBe("A1");
  });

  it("主同步端：两台设备交替修改后一致，两边都改了保留两份", async () => {
    const { fsx } = setup();
    const root = "/primary";
    const device = (dev: string) => {
      const dir = path.join(tmp.dir, dev);
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
