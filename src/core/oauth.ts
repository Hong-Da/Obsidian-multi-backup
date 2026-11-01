// 网盘登录（OAuth 2.0 授权码 + PKCE，公共客户端，不需要也不保存 client secret）。
// 只用 WebCrypto 与传入的 HttpFn，桌面和手机都能用；令牌由调用方存进本机密钥存储。

import { DestinationError } from "./errors";
import type { HttpFn } from "../destinations/http";

export type CloudKind = "onedrive" | "dropbox" | "gdrive";

export interface OAuthProvider {
  kind: CloudKind;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  /** 空格分隔；Dropbox 的权限在注册应用时选定，这里留空 */
  scope: string;
  /** 授权地址上的额外参数（例如 Dropbox 的 token_access_type=offline） */
  extraAuth?: Record<string, string>;
  /** Google 的“电视和输入受限设备”客户端要求带上（Google 文档说明这类客户端的 secret 不算机密） */
  clientSecret?: string;
  /** 设备代码登录（Google）：申请设备代码的地址 */
  deviceUrl?: string;
}

export interface OAuthTokens {
  access: string;
  refresh: string;
  /** 毫秒 */
  expiresAt: number;
  /** 登录的账号（邮箱或名称），只用于界面显示 */
  account?: string;
}

/** 网盘文件系统用来取访问令牌：过期前自动续期；服务器回 401 时调用 invalidate 再取一次 */
export interface AccessToken {
  get(): Promise<string>;
  invalidate(): void;
}

const enc = new TextEncoder();
/** JSON 里的字符串字段，不是字符串时为空 */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE：随机 verifier 与它的 SHA-256 challenge（RFC 7636，S256） */
export async function pkcePair(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(random(32));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

export function randomState(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return base64url(random(16));
}

export function authorizeUrl(p: OAuthProvider, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (p.scope) q.set("scope", p.scope);
  for (const [k, v] of Object.entries(p.extraAuth ?? {})) q.set(k, v);
  return `${p.authUrl}?${q.toString()}`;
}

async function tokenRequest(http: HttpFn, p: OAuthProvider, form: Record<string, string>, now: number): Promise<OAuthTokens & { refreshGiven: boolean }> {
  const body = enc.encode(new URLSearchParams({ client_id: p.clientId, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}), ...form }).toString());
  let res;
  try {
    res = await http({ url: p.tokenUrl, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  } catch (e) {
    throw new DestinationError("network", new URL(p.tokenUrl).host, String(e));
  }
  const text = new TextDecoder().decode(res.body);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (res.status >= 400 || typeof json.access_token !== "string") {
    // invalid_grant：刷新令牌已失效（网页上取消了授权、改了密码、太久没用），需要重新登录
    const code = json.error === "invalid_grant" || res.status === 400 || res.status === 401 ? "auth-expired" : "io";
    throw new DestinationError(code, new URL(p.tokenUrl).host, `${res.status} ${str(json.error)} ${str(json.error_description).slice(0, 200)}`);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in ?? 3600) || 3600;
  return {
    access: json.access_token,
    refresh: typeof json.refresh_token === "string" ? json.refresh_token : "",
    refreshGiven: typeof json.refresh_token === "string",
    expiresAt: now + expiresIn * 1000,
  };
}

/** 用授权码换令牌 */
export async function exchangeCode(http: HttpFn, p: OAuthProvider, code: string, verifier: string, redirectUri: string, now = Date.now()): Promise<OAuthTokens> {
  const t = await tokenRequest(http, p, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, now);
  if (!t.refresh) throw new DestinationError("auth-expired", new URL(p.tokenUrl).host, "no refresh token");
  return { access: t.access, refresh: t.refresh, expiresAt: t.expiresAt };
}

/** 续期；有的服务商会同时换一个新的刷新令牌，没给时沿用旧的 */
export async function refreshTokens(http: HttpFn, p: OAuthProvider, old: OAuthTokens, now = Date.now()): Promise<OAuthTokens> {
  const t = await tokenRequest(http, p, { grant_type: "refresh_token", refresh_token: old.refresh }, now);
  return { ...old, access: t.access, refresh: t.refreshGiven ? t.refresh : old.refresh, expiresAt: t.expiresAt };
}

/** 设备代码登录第一步：拿到让用户在浏览器里输入的短代码 */
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  /** 毫秒 */
  expiresAt: number;
  /** 轮询间隔，毫秒 */
  interval: number;
}

export async function deviceStart(http: HttpFn, p: OAuthProvider, now = Date.now()): Promise<DeviceCode> {
  if (!p.deviceUrl) throw new DestinationError("io", p.kind, "no device flow");
  const host = new URL(p.deviceUrl).host;
  let res;
  try {
    res = await http({ url: p.deviceUrl, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: enc.encode(new URLSearchParams({ client_id: p.clientId, scope: p.scope }).toString()) });
  } catch (e) {
    throw new DestinationError("network", host, String(e));
  }
  const j = JSON.parse(new TextDecoder().decode(res.body) || "{}") as Record<string, unknown>;
  if (res.status >= 400 || typeof j.device_code !== "string" || typeof j.user_code !== "string") throw new DestinationError("io", host, `${res.status} ${str(j.error)}`);
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verifyUrl: typeof j.verification_url === "string" ? j.verification_url : typeof j.verification_uri === "string" ? j.verification_uri : "https://www.google.com/device",
    expiresAt: now + (Number(j.expires_in) || 1800) * 1000,
    interval: (Number(j.interval) || 5) * 1000,
  };
}

/**
 * 设备代码登录第二步：按间隔轮询，用户在浏览器里同意后返回令牌。
 * 用户拒绝、代码过期时报 auth-expired；cancelled() 返回 true 时停止并返回 null。
 */
export async function devicePoll(
  http: HttpFn,
  p: OAuthProvider,
  dc: DeviceCode,
  o: { sleep: (ms: number) => Promise<void>; now?: () => number; cancelled?: () => boolean },
): Promise<OAuthTokens | null> {
  const now = o.now ?? (() => Date.now());
  let interval = dc.interval;
  while (now() < dc.expiresAt) {
    await o.sleep(interval);
    if (o.cancelled?.()) return null;
    const body = enc.encode(
      new URLSearchParams({
        client_id: p.clientId,
        ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
        device_code: dc.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    );
    let res;
    try {
      res = await http({ url: p.tokenUrl, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    } catch {
      continue; // 网络抖动时下一轮再试
    }
    const j = JSON.parse(new TextDecoder().decode(res.body) || "{}") as Record<string, unknown>;
    if (typeof j.access_token === "string" && typeof j.refresh_token === "string")
      return { access: j.access_token, refresh: j.refresh_token, expiresAt: now() + (Number(j.expires_in) || 3600) * 1000 };
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new DestinationError("auth-expired", new URL(p.tokenUrl).host, str(j.error) || String(res.status));
  }
  throw new DestinationError("auth-expired", new URL(p.tokenUrl).host, "device code expired");
}

/**
 * 访问令牌：读出保存的令牌，离过期不到 2 分钟或被 invalidate 后先续期，续期结果再保存。
 * 没有保存的令牌时报 not-signed-in。
 */
export function tokenSource(o: {
  http: HttpFn;
  provider: OAuthProvider;
  load(): OAuthTokens | null;
  save(t: OAuthTokens): void;
  now?: () => number;
}): AccessToken {
  const now = o.now ?? (() => Date.now());
  let stale = false;
  let pending: Promise<string> | null = null;
  return {
    invalidate: () => {
      stale = true;
    },
    get: () => {
      // 同时有多个请求要令牌时只续期一次
      pending ??= (async () => {
        const t = o.load();
        if (!t?.refresh) throw new DestinationError("not-signed-in", o.provider.kind);
        if (!stale && t.access && t.expiresAt - now() > 120_000) return t.access;
        const next = await refreshTokens(o.http, o.provider, t, now());
        o.save(next);
        stale = false;
        return next.access;
      })().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}

export function parseTokens(raw: string | null): OAuthTokens | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<OAuthTokens>;
    if (typeof t.refresh !== "string" || !t.refresh) return null;
    return { access: typeof t.access === "string" ? t.access : "", refresh: t.refresh, expiresAt: typeof t.expiresAt === "number" ? t.expiresAt : 0, account: typeof t.account === "string" ? t.account : undefined };
  } catch {
    return null;
  }
}
