// 网盘登录：PKCE、授权地址、换令牌、自动续期、设备代码登录
import { describe, expect, it } from "vitest";
import { authorizeUrl, devicePoll, deviceStart, exchangeCode, parseTokens, pkcePair, tokenSource, type OAuthProvider, type OAuthTokens } from "../../src/core/oauth";
import type { HttpFn, HttpRequest } from "../../src/destinations/http";

const enc = new TextEncoder();
const json = (status: number, body: unknown) => ({ status, headers: {}, body: enc.encode(JSON.stringify(body)) });
const form = (r: HttpRequest) => Object.fromEntries(new URLSearchParams(new TextDecoder().decode(r.body)));
const P: OAuthProvider = { kind: "dropbox", authUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "app1", scope: "", extraAuth: { token_access_type: "offline" } };

describe("PKCE 与授权地址", () => {
  it("RFC 7636 样例：verifier 的 S256 challenge", async () => {
    // RFC 7636 附录 B 的 32 字节随机数
    const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    const { verifier, challenge } = await pkcePair(() => bytes);
    expect(verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("授权地址带上 PKCE、state 与额外参数", () => {
    const u = new URL(authorizeUrl(P, "obsidian://multi-backup-auth", "st", "ch"));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "app1",
      response_type: "code",
      redirect_uri: "obsidian://multi-backup-auth",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      token_access_type: "offline",
    });
  });
});

describe("令牌", () => {
  it("授权码换令牌；没有刷新令牌时报需要重新登录", async () => {
    let seen: Record<string, string> = {};
    const http: HttpFn = async (r) => {
      seen = form(r);
      return json(200, { access_token: "a1", refresh_token: "r1", expires_in: 3600 });
    };
    const t = await exchangeCode(http, P, "code1", "ver1", "obsidian://multi-backup-auth", 0);
    expect(t).toEqual({ access: "a1", refresh: "r1", expiresAt: 3600_000 });
    expect(seen).toMatchObject({ grant_type: "authorization_code", code: "code1", code_verifier: "ver1", client_id: "app1" });
    await expect(exchangeCode(async () => json(200, { access_token: "a" }), P, "c", "v", "x")).rejects.toMatchObject({ code: "auth-expired" });
  });

  it("快过期时自动续期并保存；没给新刷新令牌时沿用旧的；invalidate 后强制续期", async () => {
    let saved: OAuthTokens | null = { access: "a0", refresh: "r0", expiresAt: 1000_000 };
    let calls = 0;
    const http: HttpFn = async (r) => {
      calls++;
      expect(form(r)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r0" });
      return json(200, { access_token: `a${calls}`, expires_in: 3600 });
    };
    let now = 0;
    const src = tokenSource({ http, provider: P, load: () => saved, save: (t) => (saved = t), now: () => now });
    expect(await src.get()).toBe("a0");
    now = 1000_000 - 60_000;
    expect(await src.get()).toBe("a1");
    expect(saved).toMatchObject({ access: "a1", refresh: "r0" });
    src.invalidate();
    expect(await src.get()).toBe("a2");
    expect(calls).toBe(2);
  });

  it("刷新令牌失效：报需要重新登录；没登录：报未登录", async () => {
    const src = tokenSource({ http: async () => json(400, { error: "invalid_grant" }), provider: P, load: () => ({ access: "", refresh: "r", expiresAt: 0 }), save: () => undefined });
    await expect(src.get()).rejects.toMatchObject({ code: "auth-expired" });
    const none = tokenSource({ http: async () => json(200, {}), provider: P, load: () => null, save: () => undefined });
    await expect(none.get()).rejects.toMatchObject({ code: "not-signed-in" });
    expect(parseTokens("{}")).toBeNull();
    expect(parseTokens(JSON.stringify({ refresh: "r", access: "a", expiresAt: 5, account: "me" }))).toEqual({ refresh: "r", access: "a", expiresAt: 5, account: "me" });
  });
});

describe("设备代码登录（Google）", () => {
  const G: OAuthProvider = { kind: "gdrive", authUrl: "", tokenUrl: "https://oauth2.example/token", deviceUrl: "https://oauth2.example/device/code", clientId: "g1", clientSecret: "s1", scope: "drive.file" };

  it("等待用户同意，遇到 slow_down 放慢，拿到令牌", async () => {
    const answers = [{ error: "authorization_pending" }, { error: "slow_down" }, { access_token: "ga", refresh_token: "gr", expires_in: 3599 }];
    const waits: number[] = [];
    let t = 0;
    const http: HttpFn = async (r) => {
      if (r.url.endsWith("/device/code")) return json(200, { device_code: "dev", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 });
      expect(form(r)).toMatchObject({ client_id: "g1", client_secret: "s1", device_code: "dev", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      return json(answers[0] && "error" in answers[0] ? 428 : 200, answers.shift());
    };
    const dc = await deviceStart(http, G, 0);
    expect(dc).toMatchObject({ userCode: "ABCD-EFGH", verifyUrl: "https://www.google.com/device", interval: 5000 });
    const tok = await devicePoll(http, G, dc, { sleep: async (ms) => void waits.push(ms), now: () => (t += 1000) });
    expect(tok).toMatchObject({ access: "ga", refresh: "gr" });
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  it("用户拒绝时报错；取消时返回 null", async () => {
    const dc = { deviceCode: "d", userCode: "U", verifyUrl: "", expiresAt: Date.now() + 1e9, interval: 1 };
    await expect(devicePoll(async () => json(403, { error: "access_denied" }), G, dc, { sleep: async () => undefined })).rejects.toMatchObject({ code: "auth-expired" });
    expect(await devicePoll(async () => json(428, { error: "authorization_pending" }), G, dc, { sleep: async () => undefined, cancelled: () => true })).toBeNull();
  });
});
