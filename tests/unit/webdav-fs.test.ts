import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/destinations/http";
import { parseMultistatus, WebDavFs } from "../../src/destinations/webdav-fs";

/** 假的 WebDAV 服务：记录请求；dirs 里的文件夹存在；locked 次数内 PUT 返回 423 */
function fakeDav(o: { dirs?: string[]; locked?: number } = {}) {
  const dirs = new Set(o.dirs ?? []);
  const calls: string[] = [];
  let locked = o.locked ?? 0;
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    const path = decodeURIComponent(new URL(req.url).pathname).replace(/\/$/, "") || "/";
    calls.push(`${req.method} ${path}`);
    const res = (status: number, body = "") => ({ status, headers: {}, body: new TextEncoder().encode(body) });
    if (req.method === "PROPFIND") return dirs.has(path) ? res(207, `<multistatus xmlns="DAV:"><response><href>${path}/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response></multistatus>`) : res(404);
    if (req.method === "MKCOL") {
      if (dirs.has(path)) return res(405);
      dirs.add(path);
      return res(201);
    }
    if (req.method === "PUT") return locked-- > 0 ? res(423) : res(201);
    return res(204);
  };
  return { http, calls };
}

describe("WebDAV 请求", () => {
  it("建过或查过的文件夹记住，不再逐个查询", async () => {
    const { http, calls } = fakeDav({ dirs: ["/v"] });
    const dav = new WebDavFs({ url: "http://dav/", username: "u", password: "p", http });
    await dav.mkdirp("/v/a/b");
    await dav.mkdirp("/v/a/b");
    await dav.mkdirp("/v/a");
    expect(calls).toEqual(["PROPFIND /v/a/b", "MKCOL /v", "MKCOL /v/a", "MKCOL /v/a/b"]);
    // 删掉之后要重新建
    await dav.removeDir("/v/a");
    calls.length = 0;
    await dav.mkdirp("/v/a/b");
    expect(calls[0]).toBe("PROPFIND /v/a/b");
  });

  it("423 Locked、429、503 等一会儿重试，超过次数才报错", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const ok = fakeDav({ locked: 2 });
    await new WebDavFs({ url: "http://dav/", username: "u", password: "p", http: ok.http, sleep }).writeFile("/a.md", new Uint8Array([1]));
    expect(waits).toEqual([500, 1000]);
    const bad = fakeDav({ locked: 10 });
    await expect(new WebDavFs({ url: "http://dav/", username: "u", password: "p", http: bad.http, sleep }).writeFile("/a.md", new Uint8Array([1]))).rejects.toMatchObject({ code: "in-use" });
    expect(bad.calls).toHaveLength(4);
  });
});

describe("PROPFIND 结果解析", () => {
  it("Nextcloud 风格（d: 前缀）：文件夹、文件、etag、中文名", () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/remote.php/dav/files/me/Obsidian/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Sat, 31 Oct 2026 10:42:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/me/Obsidian/%E6%97%A5%E8%AE%B0.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>123</d:getcontentlength><d:getlastmodified>Sat, 31 Oct 2026 10:42:05 GMT</d:getlastmodified><d:getetag>&quot;abc123&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
    const r = parseMultistatus(xml);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ isDir: true });
    expect(r[1]).toMatchObject({ isDir: false, size: 123, etag: "abc123", mtime: Date.UTC(2026, 9, 31, 10, 42, 5) });
  });

  it("坚果云 / Apache 风格（D: 或 lp1: 前缀、弱 etag、没写出的属性）", () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:"><D:response><D:href>/dav/a%20b.md</D:href><D:propstat><D:prop><lp1:resourcetype/><lp1:getcontentlength>7</lp1:getcontentlength><lp1:getetag>W/"77-5f"</lp1:getetag></D:prop></D:propstat><D:propstat><D:prop><D:quota-available-bytes/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`;
    const [e] = parseMultistatus(xml);
    expect(e).toMatchObject({ href: "/dav/a%20b.md", isDir: false, size: 7, etag: "77-5f", quota: undefined });
  });

  it("剩余空间", () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><quota-available-bytes>1048576</quota-available-bytes></prop></propstat></response></multistatus>`;
    expect(parseMultistatus(xml)[0]?.quota).toBe(1048576);
  });
});
