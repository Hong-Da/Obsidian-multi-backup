// 用 GitHub 登录：通过插件注册的 GitHub App 走设备码登录，拿到代表用户的令牌。
// 这个令牌只能访问用户装了这个应用的仓库，权限只有 Contents 读写；应用设置里关掉了令牌过期，所以没有刷新令牌。
// 不需要 client secret。令牌由调用方存进本机密钥存储。

import { DestinationError } from "./errors";
import type { DeviceCode } from "./oauth";
import type { HttpFn, HttpResponse } from "../destinations/http";

export const GITHUB_APP = {
  clientId: "Iv23liFEVkuBL0Cd2ynr",
  slug: "obsidian-multi-backup",
  name: "Obsidian Multi Backup",
} as const;

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";

/** 安装到仓库的页面：GitHub 会让用户选账号和仓库 */
export const GITHUB_INSTALL_URL = `https://github.com/apps/${GITHUB_APP.slug}/installations/new`;

/** 保存在本机密钥存储里的登录信息；login 只用于界面显示 */
export interface GithubLogin {
  token: string;
  login: string;
}

export function parseGithubLogin(raw: string | null): GithubLogin | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<GithubLogin>;
    if (typeof j.token !== "string" || !j.token) return null;
    return { token: j.token, login: typeof j.login === "string" ? j.login : "" };
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function json(res: HttpResponse): Record<string, unknown> {
  try {
    const v = JSON.parse(new TextDecoder().decode(res.body) || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function post(http: HttpFn, url: string, form: Record<string, string>): Promise<HttpResponse> {
  try {
    return await http({
      url,
      method: "POST",
      // 不带 accept: application/json 时 GitHub 返回的是表单格式
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: enc.encode(new URLSearchParams(form).toString()),
    });
  } catch (e) {
    throw new DestinationError("network", "github.com", String(e));
  }
}

/** 第一步：申请让用户在 github.com/login/device 输入的代码 */
export async function githubDeviceStart(http: HttpFn, now = Date.now()): Promise<DeviceCode> {
  const res = await post(http, DEVICE_URL, { client_id: GITHUB_APP.clientId });
  const j = json(res);
  if (res.status >= 400 || typeof j.device_code !== "string" || typeof j.user_code !== "string")
    throw new DestinationError("io", "github.com", `${res.status} ${str(j.error)}`);
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verifyUrl: str(j.verification_uri) || "https://github.com/login/device",
    expiresAt: now + (Number(j.expires_in) || 900) * 1000,
    interval: (Number(j.interval) || 5) * 1000,
  };
}

/**
 * 第二步：按间隔轮询，用户在浏览器里授权后返回令牌。
 * GitHub 在等待时也回 200，靠 error 字段区分；用户拒绝、代码过期时报 auth-expired；cancelled() 为真时返回 null。
 */
export async function githubDevicePoll(
  http: HttpFn,
  dc: DeviceCode,
  o: { sleep: (ms: number) => Promise<void>; now?: () => number; cancelled?: () => boolean },
): Promise<string | null> {
  const now = o.now ?? (() => Date.now());
  let interval = dc.interval;
  while (now() < dc.expiresAt) {
    await o.sleep(interval);
    if (o.cancelled?.()) return null;
    let res;
    try {
      res = await post(http, TOKEN_URL, { client_id: GITHUB_APP.clientId, device_code: dc.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    } catch {
      continue; // 网络抖动时下一轮再试
    }
    const j = json(res);
    if (typeof j.access_token === "string" && j.access_token) return j.access_token;
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") {
      interval = (Number(j.interval) || interval / 1000 + 5) * 1000;
      continue;
    }
    throw new DestinationError("auth-expired", "GitHub", str(j.error) || String(res.status));
  }
  throw new DestinationError("auth-expired", "GitHub", "device code expired");
}

async function api(http: HttpFn, token: string, path: string): Promise<HttpResponse> {
  try {
    return await http({
      url: API + path,
      method: "GET",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    });
  } catch (e) {
    throw new DestinationError("network", "api.github.com", String(e));
  }
}

function apiError(res: HttpResponse): DestinationError {
  if (res.status === 401) return new DestinationError("auth-expired", "GitHub", String(res.status));
  return new DestinationError("io", "api.github.com", `${res.status} ${str(json(res).message).slice(0, 200)}`);
}

/** 登录的 GitHub 用户名 */
export async function githubUser(http: HttpFn, token: string): Promise<string> {
  const res = await api(http, token, "/user");
  if (res.status !== 200) throw apiError(res);
  return str(json(res).login);
}

/** 从仓库地址里取 owner/repo；不是 github.com 的地址返回 null */
export function githubRepo(url: string): { owner: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== "github.com") return null;
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/i, "") };
}

/**
 * 这个仓库能不能用：ok 可以读写；not-installed 应用没装到这个仓库（或者仓库不存在，GitHub 不让应用看到装了之外的仓库）；
 * not-found 应用装到了所有仓库，但找不到这个仓库。
 */
export type RepoAccess = "ok" | "not-installed" | "not-found";

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function githubRepoAccess(http: HttpFn, token: string, owner: string, repo: string): Promise<RepoAccess> {
  const res = await api(http, token, "/user/installations?per_page=100");
  if (res.status !== 200) throw apiError(res);
  const list = Array.isArray(json(res).installations) ? (json(res).installations as Record<string, unknown>[]) : [];
  const ours = list.filter((i) => i.app_slug === GITHUB_APP.slug);
  const inst = ours.find((i) => sameName(str((i.account as Record<string, unknown> | null)?.login), owner));
  if (!inst) return "not-installed";
  if (inst.repository_selection === "all") {
    const r = await api(http, token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if (r.status === 200) return "ok";
    if (r.status === 404) return "not-found";
    throw apiError(r);
  }
  // 只装到选定仓库：逐页看列表里有没有这个仓库
  for (let page = 1; page <= 20; page++) {
    const r = await api(http, token, `/user/installations/${String(inst.id)}/repositories?per_page=100&page=${page}`);
    if (r.status !== 200) throw apiError(r);
    const repos = Array.isArray(json(r).repositories) ? (json(r).repositories as Record<string, unknown>[]) : [];
    if (repos.some((x) => sameName(str(x.name), repo))) return "ok";
    if (repos.length < 100) break;
  }
  return "not-installed";
}
