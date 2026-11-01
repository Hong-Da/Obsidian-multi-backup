// Dropbox 目标文件系统：用内存中的假 Dropbox（实现 HttpFn）验证接口调用、错误处理，并跑一遍本地镜像的备份与主同步。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import type { AccessToken } from "../../src/core/oauth";
import { scanVault } from "../../src/core/scanner";
import { runBackup } from "../../src/core/sync";
import type { BaseEntry } from "../../src/core/sync-planner";
import { syncTwoWay } from "../../src/core/two-way";
import { asciiJson, DropboxFs } from "../../src/destinations/dropbox-fs";
import type { HttpRequest, HttpResponse } from "../../src/destinations/http";
import { LocalMirror } from "../../src/destinations/local-mirror";
import {
  fs,
  makeTmp,
  MemoryState,
  NodeVaultFs,
  NodeVaultWriter,
  path,
  readText,
  removePath,
  renamePath,
  writeText,
} from "../support/node";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Node {
  /** 显示用的路径（保留大小写） */
  path: string;
  folder: boolean;
  data: Uint8Array;
  rev: string;
  mtime: number;
}

/** 内存中的假 Dropbox：键为小写路径（Dropbox 不区分大小写） */
class FakeDropbox {
  nodes = new Map<string, Node>();
  sessions = new Map<string, Uint8Array>();
  /** 有效的访问令牌 */
  valid = "t1";
  /** 每页最多几条，用来测翻页 */
  limit = 2;
  /** 依次插入的故障响应 */
  inject: { status: number; headers?: Record<string, string> }[] = [];
  calls: { endpoint: string; arg: unknown; apiArg?: string }[] = [];
  private seq = 0;

  http = async (req: HttpRequest): Promise<HttpResponse> => {
    const endpoint = req.url.replace(/^https:\/\/(api|content)\.dropboxapi\.com\/2\//, "");
    const apiArg = req.headers?.["Dropbox-API-Arg"];
    const arg: unknown =
      apiArg !== undefined ? JSON.parse(apiArg) : JSON.parse(dec.decode(req.body ?? new Uint8Array()));
    this.calls.push({ endpoint, arg, apiArg });
    const bad = this.inject.shift();
    if (bad) return { status: bad.status, headers: bad.headers ?? {}, body: enc.encode("{}") };
    if (req.headers?.Authorization !== `Bearer ${this.valid}`)
      return json(401, { error_summary: "expired_access_token/" });
    return this.handle(endpoint, arg as Record<string, unknown>, req.body ?? new Uint8Array());
  };

  private handle(endpoint: string, a: Record<string, unknown>, body: Uint8Array): HttpResponse {
    const p = (k = "path") => {
      const v = a[k];
      return typeof v === "string" ? v : "";
    };
    switch (endpoint) {
      case "files/get_metadata": {
        const n = this.nodes.get(p().toLowerCase());
        return n ? json(200, meta(n)) : err("path/not_found/");
      }
      case "files/list_folder": {
        const dir = p().toLowerCase();
        if (dir && !this.nodes.get(dir)?.folder) return err("path/not_found/");
        return this.page(dir, 0);
      }
      case "files/list_folder/continue": {
        const c = JSON.parse(p("cursor")) as { dir: string; at: number };
        return this.page(c.dir, c.at);
      }
      case "files/create_folder_v2": {
        const n = this.nodes.get(p().toLowerCase());
        if (n) return err(n.folder ? "path/conflict/folder/" : "path/conflict/file/");
        this.put(p(), true, new Uint8Array());
        return json(200, { metadata: { ".tag": "folder", name: p().split("/").pop() } });
      }
      case "files/upload":
        return this.upload(p(), body);
      case "files/upload_session/start": {
        const id = `s${++this.seq}`;
        this.sessions.set(id, body.slice());
        return json(200, { session_id: id });
      }
      case "files/upload_session/append_v2":
      case "files/upload_session/finish": {
        const c = a.cursor as { session_id: string; offset: number };
        const old = this.sessions.get(c.session_id);
        if (!old || old.byteLength !== c.offset) return err("lookup_failed/incorrect_offset/");
        const all = new Uint8Array(old.byteLength + body.byteLength);
        all.set(old);
        all.set(body, old.byteLength);
        this.sessions.set(c.session_id, all);
        if (endpoint.endsWith("append_v2")) return json(200, null);
        this.sessions.delete(c.session_id);
        return this.upload(String((a.commit as { path: string }).path), all);
      }
      case "files/download": {
        const n = this.nodes.get(p().toLowerCase());
        if (!n) return err("path/not_found/");
        if (n.folder) return err("path/not_file/");
        return { status: 200, headers: { "dropbox-api-result": JSON.stringify(meta(n)) }, body: n.data };
      }
      case "files/move_v2": {
        const from = p("from_path").toLowerCase();
        const to = p("to_path");
        const src = this.nodes.get(from);
        if (!src) return err("from_lookup/not_found/");
        if (this.nodes.has(to.toLowerCase())) return err("to/conflict/file/");
        for (const [k, n] of [...this.nodes]) {
          if (k !== from && !k.startsWith(from + "/")) continue;
          this.nodes.delete(k);
          const np = to + n.path.slice(from.length);
          this.nodes.set(np.toLowerCase(), { ...n, path: np });
        }
        this.ensureParents(to);
        return json(200, { metadata: meta(this.nodes.get(to.toLowerCase()) as Node) });
      }
      case "files/delete_v2": {
        const k = p().toLowerCase();
        const n = this.nodes.get(k);
        if (!n) return err("path_lookup/not_found/");
        for (const key of [...this.nodes.keys()]) if (key === k || key.startsWith(k + "/")) this.nodes.delete(key);
        return json(200, { metadata: meta(n) });
      }
      case "users/get_space_usage":
        return json(200, { used: 1000, allocation: { ".tag": "individual", allocated: 5000 } });
      default:
        return { status: 400, headers: {}, body: enc.encode(`unknown endpoint ${endpoint}`) };
    }
  }

  private page(dir: string, at: number): HttpResponse {
    const kids = [...this.nodes].filter(([k]) => k.slice(0, k.lastIndexOf("/")) === dir).map(([, n]) => n);
    const entries = kids.slice(at, at + this.limit).map(meta);
    const next = at + this.limit;
    return json(200, { entries, cursor: JSON.stringify({ dir, at: next }), has_more: next < kids.length });
  }

  private upload(p: string, data: Uint8Array): HttpResponse {
    const parent = this.nodes.get(p.slice(0, p.lastIndexOf("/")).toLowerCase());
    if (parent && !parent.folder) return err("path/conflict/file/");
    if (this.nodes.get(p.toLowerCase())?.folder) return err("path/conflict/folder/");
    this.put(p, false, data.slice());
    return json(200, meta(this.nodes.get(p.toLowerCase()) as Node));
  }

  private put(p: string, folder: boolean, data: Uint8Array) {
    this.ensureParents(p);
    this.nodes.set(p.toLowerCase(), {
      path: p,
      folder,
      data,
      rev: `r${++this.seq}`,
      mtime: Date.UTC(2026, 9, 1) + this.seq * 1000,
    });
  }

  private ensureParents(p: string) {
    const segs = p.split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const d = "/" + segs.slice(0, i).join("/");
      if (!this.nodes.has(d.toLowerCase()))
        this.nodes.set(d.toLowerCase(), { path: d, folder: true, data: new Uint8Array(), rev: "", mtime: 0 });
    }
  }

  text(p: string): string | undefined {
    const n = this.nodes.get(p.toLowerCase());
    return n && !n.folder ? dec.decode(n.data) : undefined;
  }
}

function json(status: number, v: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: enc.encode(JSON.stringify(v)) };
}

const err = (summary: string) => json(409, { error_summary: summary, error: {} });

function meta(n: Node) {
  const name = n.path.slice(n.path.lastIndexOf("/") + 1);
  if (n.folder) return { ".tag": "folder", name, path_display: n.path };
  return {
    ".tag": "file",
    name,
    path_display: n.path,
    size: n.data.byteLength,
    server_modified: new Date(n.mtime).toISOString().replace(/\.\d+Z$/, "Z"),
    rev: n.rev,
    content_hash: "x",
  };
}

function setup(o: { sessionThreshold?: number; chunkSize?: number } = {}) {
  const fake = new FakeDropbox();
  let tok = "t1";
  let invalidated = 0;
  const token: AccessToken = {
    get: async () => tok,
    invalidate: () => {
      invalidated++;
      tok = fake.valid;
    },
  };
  const slept: number[] = [];
  const dfs = new DropboxFs({ token, http: fake.http, sleep: async (ms) => void slept.push(ms), ...o });
  return { fake, dfs, slept, invalidated: () => invalidated };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code,
  );

describe("DropboxFs", () => {
  it("Dropbox-API-Arg 头只含 ASCII，中文按 \\uXXXX 转义且能还原", () => {
    const s = asciiJson({ path: "/中文/笔记 1.md", x: "\u007f😀" });
    expect(/^[\x20-\x7e]*$/.test(s)).toBe(true);
    expect(JSON.parse(s)).toEqual({ path: "/中文/笔记 1.md", x: "\u007f😀" });
  });

  it("写入与读取：中文与空格的文件名，覆盖写入", async () => {
    const { fake, dfs } = setup();
    const p = "/Multi Backup/我的 笔记/日记 1.md";
    await dfs.writeFile(p, enc.encode("一"));
    await dfs.writeFile(p, enc.encode("二"));
    expect(dec.decode(await dfs.readFile(p))).toBe("二");
    expect(fake.text("/multi backup/我的 笔记/日记 1.md")).toBe("二");
    const up = fake.calls.filter((c) => c.endpoint === "files/upload");
    expect(up).toHaveLength(2);
    for (const c of fake.calls.filter((x) => x.apiArg !== undefined))
      expect(/^[\x20-\x7e]*$/.test(c.apiArg as string)).toBe(true);
    expect(up[0]?.arg).toEqual({ path: p, mode: "overwrite", mute: true });
  });

  it("stat：文件给出大小、时间、rev；文件夹；根目录；不存在返回 null", async () => {
    const { dfs } = setup();
    await dfs.writeFile("/a/b.md", enc.encode("hello"));
    const st = await dfs.stat("/a/b.md");
    expect(st).toMatchObject({ isDir: false, size: 5 });
    expect(st?.etag).toMatch(/^r\d+$/);
    expect(st?.mtime).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(await dfs.stat("/a")).toEqual({ isDir: true, size: 0, mtime: 0 });
    expect(await dfs.stat("/")).toEqual({ isDir: true, size: 0, mtime: 0 });
    expect(await dfs.stat("/nope.md")).toBeNull();
  });

  it("list：翻页取全，根目录用空字符串；不存在的文件夹报 not-found", async () => {
    const { fake, dfs } = setup();
    for (const n of ["1", "2", "3", "4", "5"]) await dfs.writeFile(`/d/f${n}.md`, enc.encode(n));
    await dfs.mkdirp("/d/sub");
    const items = await dfs.list("/d");
    expect(items.map((e) => e.name).sort()).toEqual(["f1.md", "f2.md", "f3.md", "f4.md", "f5.md", "sub"]);
    expect(items.find((e) => e.name === "sub")?.isDir).toBe(true);
    expect(items.find((e) => e.name === "f3.md")).toMatchObject({ isDir: false, size: 1 });
    expect(fake.calls.filter((c) => c.endpoint === "files/list_folder/continue")).toHaveLength(2);
    expect((await dfs.list("/")).map((e) => e.name)).toEqual(["d"]);
    expect(fake.calls.some((c) => c.endpoint === "files/list_folder" && (c.arg as { path: string }).path === "")).toBe(
      true,
    );
    expect(await codeOf(dfs.list("/none"))).toBe("not-found");
  });

  it("mkdirp：逐层创建，已存在时不报错", async () => {
    const { fake, dfs } = setup();
    await dfs.mkdirp("/x/y/z");
    expect(fake.nodes.get("/x/y/z")?.folder).toBe(true);
    await dfs.mkdirp("/x/y/z");
    await dfs.mkdirp("/x/y/w");
    expect(fake.nodes.get("/x/y/w")?.folder).toBe(true);
  });

  it("rename：目标已存在时先删再移；源不存在报 not-found", async () => {
    const { fake, dfs } = setup();
    await dfs.writeFile("/a.md", enc.encode("A"));
    await dfs.writeFile("/b.md", enc.encode("B"));
    await dfs.rename("/a.md", "/b.md");
    expect(fake.text("/b.md")).toBe("A");
    expect(await dfs.stat("/a.md")).toBeNull();
    await dfs.rename("/b.md", "/新/c.md");
    expect(fake.text("/新/c.md")).toBe("A");
    expect(await codeOf(dfs.rename("/none.md", "/x.md"))).toBe("not-found");
  });

  it("removeFile、removeDir；不存在时不报错；读不存在的文件报 not-found", async () => {
    const { fake, dfs } = setup();
    await dfs.writeFile("/r/a.md", enc.encode("A"));
    await dfs.writeFile("/r/s/b.md", enc.encode("B"));
    await dfs.removeFile("/r/a.md");
    expect(fake.text("/r/a.md")).toBeUndefined();
    await dfs.removeDir("/r");
    expect(fake.nodes.size).toBe(0);
    await dfs.removeFile("/r/a.md");
    await dfs.removeDir("/r");
    expect(await codeOf(dfs.readFile("/r/a.md"))).toBe("not-found");
  });

  it("401：续期令牌后重试一次成功；仍然 401 报 auth-expired", async () => {
    const { fake, dfs, invalidated } = setup();
    fake.valid = "t2";
    await dfs.writeFile("/a.md", enc.encode("A"));
    expect(invalidated()).toBe(1);
    expect(fake.text("/a.md")).toBe("A");
    fake.valid = "t3";
    fake.inject.push({ status: 401 }, { status: 401 });
    expect(await codeOf(dfs.readFile("/a.md"))).toBe("auth-expired");
  });

  it("429、503：按 Retry-After 等待后重试，超过 3 次放弃", async () => {
    const { fake, dfs, slept } = setup();
    fake.inject.push({ status: 429, headers: { "retry-after": "2" } }, { status: 503 });
    await dfs.writeFile("/a.md", enc.encode("A"));
    expect(slept).toEqual([2000, 1000]);
    expect(fake.text("/a.md")).toBe("A");
    fake.inject.push({ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 });
    expect(await codeOf(dfs.readFile("/a.md"))).toBe("io");
  });

  it("错误映射：403 → no-permission，空间不足 → quota，网络异常 → network", async () => {
    const { fake, dfs } = setup();
    fake.inject.push({ status: 403 });
    expect(await codeOf(dfs.readFile("/a.md"))).toBe("no-permission");
    const orig = fake.http;
    fake.http = async () => err("path/insufficient_space/..");
    const quota = new DropboxFs({ token: { get: async () => "t1", invalidate: () => {} }, http: (r) => fake.http(r) });
    expect(await codeOf(quota.writeFile("/a.md", enc.encode("A")))).toBe("quota");
    fake.http = async () => {
      throw Object.assign(new Error("offline"), { code: "ENETWORK" });
    };
    expect(await codeOf(quota.stat("/a.md"))).toBe("network");
    fake.http = orig;
  });

  it("freeSpace：分配减已用；团队空间返回 null", async () => {
    const { dfs } = setup();
    expect(await dfs.freeSpace()).toBe(4000);
    const team = new DropboxFs({
      token: { get: async () => "t", invalidate: () => {} },
      http: async () => json(200, { used: 1, allocation: { ".tag": "team", allocated: 10, used: 1 } }),
    });
    expect(await team.freeSpace()).toBeNull();
  });

  it("大文件分段上传；openWrite 关闭时上传", async () => {
    const { fake, dfs } = setup({ sessionThreshold: 10, chunkSize: 4 });
    const data = enc.encode("0123456789abcdefghij");
    await dfs.writeFile("/big.bin", data);
    expect(fake.text("/big.bin")).toBe("0123456789abcdefghij");
    expect(fake.calls.map((c) => c.endpoint).filter((e) => e.startsWith("files/upload"))).toEqual([
      "files/upload_session/start",
      "files/upload_session/append_v2",
      "files/upload_session/append_v2",
      "files/upload_session/append_v2",
      "files/upload_session/finish",
    ]);
    const w = await dfs.openWrite("/w.txt");
    await w.write(enc.encode("ab"));
    await w.write(enc.encode("c"));
    await w.close();
    expect(fake.text("/w.txt")).toBe("abc");
  });
});

describe("DropboxFs 上的本地镜像", () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>;
  beforeEach(async () => {
    tmp = await makeTmp();
  });
  afterEach(() => tmp.cleanup());

  const matcher = () =>
    new ExcludeMatcher(
      builtinRules({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup", includeConfigDir: true }),
    );

  it("备份：首次、增量（改、改名、删），历史版本与回收站在 .multi-backup/ 下", async () => {
    const { dfs } = setup();
    const root = "/Multi Backup/库";
    const vault = path.join(tmp.dir, "vault");
    await writeText(path.join(vault, "a.md"), "A1");
    await writeText(path.join(vault, "中文/笔记 1.md"), "N1");
    const state = new MemoryState();
    const mirror = () => new LocalMirror(dfs, { root, deletePolicy: "trash30", keepVersions: 10, createRoot: true });
    const run = () =>
      runBackup({ vault: new NodeVaultFs(vault), state, matcher: matcher(), maxFileSize: 1 << 30 }, [
        { id: "d", store: mirror(), extraExcludes: [] },
      ]);

    const r1 = await run();
    expect(r1.destinations[0]).toMatchObject({ status: "ok", uploaded: 2 });
    expect(dec.decode(await dfs.readFile(`${root}/中文/笔记 1.md`))).toBe("N1");

    await writeText(path.join(vault, "a.md"), "A2");
    await renamePath(path.join(vault, "中文", "笔记 1.md"), path.join(vault, "中文", "笔记 2.md"));
    await writeText(path.join(vault, "gone.md"), "G");
    await run();
    await removePath(path.join(vault, "gone.md"));
    const r2 = await run();
    expect(r2.destinations[0]?.status).toBe("ok");
    expect((await dfs.list(root)).map((e) => e.name).sort()).toEqual([".multi-backup", "a.md", "中文"]);
    expect((await dfs.list(`${root}/中文`)).map((e) => e.name)).toEqual(["笔记 2.md"]);
    expect(dec.decode(await dfs.readFile(`${root}/a.md`))).toBe("A2");
    expect((await dfs.list(`${root}/.multi-backup/versions/a.md`)).length).toBe(1);
    expect((await dfs.list(`${root}/.multi-backup/trash`)).length).toBe(1);
    const src = mirror().restoreSource();
    expect([...(await src.files("current")).keys()].sort()).toEqual(["a.md", "中文/笔记 2.md"]);
    const vers = await src.fileVersions("a.md", 10);
    expect(dec.decode(await src.read(vers[1]!.pointId, "a.md"))).toBe("A1");
  });

  it("主同步端：两台设备交替修改后一致，两边都改了保留两份", async () => {
    const { dfs } = setup();
    const root = "/primary";
    const device = (dev: string) => {
      const dir = path.join(tmp.dir, dev);
      let base = new Map<string, BaseEntry>();
      return {
        dir,
        async sync(t = new Date()) {
          await fs.mkdir(dir, { recursive: true });
          const store = new LocalMirror(dfs, {
            root,
            deletePolicy: "trash30",
            keepVersions: 10,
            createRoot: true,
          }).asPrimary();
          await store.prepare();
          const vault = new NodeVaultFs(dir);
          const scan = await scanVault(vault, {
            matcher: matcher(),
            maxFileSize: 1 << 30,
            previous: { version: 1, updatedAt: 0, files: {} },
          });
          const res = await syncTwoWay({
            vault,
            writer: new NodeVaultWriter(dir),
            store,
            local: scan.files,
            base,
            remote: await store.list(),
            matches: (d, id, p) => store.matches(d, id, p),
            remoteDevice: () => "other",
            now: () => t,
          });
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
    expect(
      await fs.stat(path.join(a.dir, "x.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await b.sync();
    expect(await readText(path.join(b.dir, "n.md"))).toBe("A 改的");
    expect(await readText(path.join(b.dir, "n.conflict-other-2026-10-31-1600.md"))).toBe("B 改的");
  });
});
