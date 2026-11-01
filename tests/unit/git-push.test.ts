import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import type { HttpClient } from "isomorphic-git";
import { basicAuth, parsePktLines, pktLine, sendPack, ZERO_OID } from "../../src/destinations/git-push";

const enc = new TextEncoder();
const reply = (lines: string[], status = 200): HttpClient => ({
  async request() {
    const body = lines.length
      ? new Uint8Array([...lines.flatMap((l) => [...pktLine(l + "\n")]), ...enc.encode("0000")])
      : enc.encode("denied");
    return {
      url: "",
      method: "POST",
      statusCode: status,
      statusMessage: "",
      headers: {},
      body: (async function* () {
        yield body;
      })(),
    };
  },
});
const args = (http: HttpClient) => ({
  http,
  url: "http://x/r.git/",
  auth: basicAuth("u", "p"),
  ref: "refs/heads/main",
  oldOid: ZERO_OID,
  newOid: "a".repeat(40),
  packfile: new Uint8Array([1]),
});

describe("git 推送（receive-pack）", () => {
  it("pkt-line 编码与解析", () => {
    expect(new TextDecoder().decode(pktLine("abc\n"))).toBe("0008abc\n");
    const data = new Uint8Array([...pktLine("unpack ok\n"), ...enc.encode("0000"), ...pktLine("ok refs/heads/main\n")]);
    expect(parsePktLines(data)).toEqual(["unpack ok", "ok refs/heads/main"]);
  });

  it("请求：地址、命令行、认证头", async () => {
    let seen: { url: string; headers?: Record<string, string>; body?: unknown } = { url: "" };
    const http: HttpClient = {
      async request(req) {
        seen = req;
        return reply(["unpack ok", "ok refs/heads/main"]).request(req);
      },
    };
    expect(await sendPack(args(http))).toEqual({ ok: true });
    expect(seen.url).toBe("http://x/r.git/git-receive-pack");
    expect(seen.headers?.Authorization).toBe("Basic dTpw");
    const body = new TextDecoder().decode((seen.body as Uint8Array[])[0]);
    expect(body).toContain(`${ZERO_OID} ${"a".repeat(40)} refs/heads/main\0report-status`);
  });

  it("被拒、解包失败、HTTP 错误", async () => {
    expect(await sendPack(args(reply(["unpack ok", "ng refs/heads/main fetch first"])))).toEqual({
      ok: false,
      reason: "fetch first",
    });
    expect(await sendPack(args(reply(["unpack index-pack failed", "ng refs/heads/main unpacker error"])))).toEqual({
      ok: false,
      reason: "unpack index-pack failed",
    });
    expect(await sendPack(args(reply([], 403)))).toMatchObject({ ok: false, status: 403 });
  });

  it("用户名、令牌含非 ASCII 字符也能编码", () => {
    expect(basicAuth("张", "p")).toBe("Basic " + Buffer.from("张:p").toString("base64"));
  });
});
