import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../../src/destinations/http";
import { parseListObjects, S3Fs } from "../../src/destinations/s3-fs";

describe("ListObjectsV2 结果解析", () => {
  it("对象、公共前缀（文件夹）、翻页标记、XML 转义", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>true</IsTruncated>
<Contents><Key>obsidian/a &amp; b.md</Key><LastModified>2026-10-31T10:42:05.000Z</LastModified><ETag>&quot;9b2cf535f27731c974343645a3985328&quot;</ETag><Size>12</Size></Contents>
<CommonPrefixes><Prefix>obsidian/Daily/</Prefix></CommonPrefixes>
<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken></ListBucketResult>`;
    const r = parseListObjects(xml);
    expect(r.objects).toEqual([{ key: "obsidian/a & b.md", size: 12, mtime: Date.UTC(2026, 9, 31, 10, 42, 5), etag: "9b2cf535f27731c974343645a3985328" }]);
    expect(r.prefixes).toEqual(["obsidian/Daily/"]);
    expect(r.next).toBe("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=");
  });

  it("最后一页没有翻页标记", () => {
    expect(parseListObjects("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").next).toBeUndefined();
  });
});

describe("S3 查看文件信息", () => {
  it("不用 HEAD（Android 上读不了没有正文的 404），按前缀列 1 个对象：文件、文件夹、不存在", async () => {
    const keys = ["v/a.md", "v/a.md.bak", "v/dir/x.md"];
    const methods: string[] = [];
    const http = async (req: HttpRequest) => {
      methods.push(req.method);
      const q = new URL(req.url).searchParams;
      const prefix = q.get("prefix") ?? "";
      const delim = q.get("delimiter");
      const max = Number(q.get("max-keys"));
      const hits = keys.filter((k) => k.startsWith(prefix)).sort();
      const objects = delim ? hits.filter((k) => !k.slice(prefix.length).includes(delim)) : hits;
      const prefixes = delim ? [...new Set(hits.filter((k) => k.slice(prefix.length).includes(delim)).map((k) => prefix + k.slice(prefix.length).split(delim)[0] + delim))] : [];
      const xml = `<ListBucketResult>${objects.slice(0, max).map((k) => `<Contents><Key>${k}</Key><LastModified>2026-10-31T10:00:00.000Z</LastModified><ETag>"e1"</ETag><Size>5</Size></Contents>`).join("")}${prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
      return { status: 200, headers: {}, body: new TextEncoder().encode(xml) };
    };
    const s3 = new S3Fs({ endpoint: "http://s3", region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s", pathStyle: true, http });
    expect(await s3.stat("/v/a.md")).toEqual({ isDir: false, size: 5, mtime: Date.UTC(2026, 9, 31, 10), etag: "e1" });
    expect(await s3.stat("/v/dir")).toMatchObject({ isDir: true });
    expect(await s3.stat("/v/none.md")).toBeNull();
    expect(methods).not.toContain("HEAD");
  });
});
