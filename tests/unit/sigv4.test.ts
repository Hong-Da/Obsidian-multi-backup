import { describe, expect, it } from "vitest";
import { rfc3986, signV4 } from "../../src/core/sigv4";

// AWS 文档 “Signature Calculations for the Authorization Header” 中的样例
const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3" };
const now = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));

describe("SigV4 签名（AWS 文档样例）", () => {
  it("GET Object（带 Range 头）", async () => {
    const h = await signV4({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { Range: "bytes=0-9" } }, creds, now);
    expect(h.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("PUT Object（带内容与额外头）", async () => {
    const body = new TextEncoder().encode("Welcome to Amazon S3.");
    const h = await signV4(
      { method: "PUT", url: "https://examplebucket.s3.amazonaws.com/test$file.text", headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, body },
      creds,
      now,
    );
    expect(h.Authorization).toContain("Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("GET Bucket（List Objects，带查询参数）", async () => {
    const h = await signV4({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", headers: {} }, creds, now);
    expect(h.Authorization).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("RFC 3986 编码补上 !'()*", () => {
    expect(rfc3986("a b!'()*~.md")).toBe("a%20b%21%27%28%29%2A~.md");
  });
});
