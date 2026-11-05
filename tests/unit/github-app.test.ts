// 用 GitHub 登录：设备码、轮询、仓库地址解析、检查应用有没有装到仓库、保存格式、设置里的连接方式
import { describe, expect, it } from "vitest";
import { GITHUB_APP, githubDevicePoll, githubDeviceStart, githubRepo, githubRepoAccess, githubUser, parseGithubLogin } from "../../src/core/github-app";
import type { HttpFn, HttpRequest } from "../../src/destinations/http";
import { toRemoteError } from "../../src/destinations/remote-git";
import { githubSecretName, mergeSettings, newDestination, usesGithubApp, type GitRemoteConfig } from "../../src/settings";

const enc = new TextEncoder();
const json = (status: number, body: unknown) => ({ status, headers: {}, body: enc.encode(JSON.stringify(body)) });
const form = (r: HttpRequest) => Object.fromEntries(new URLSearchParams(new TextDecoder().decode(r.body)));
const dc = { deviceCode: "dev", userCode: "WDJB-MJHT", verifyUrl: "https://github.com/login/device", expiresAt: Date.now() + 1e9, interval: 5000 };

describe("设备码登录", () => {
  it("申请代码：只带 client_id，要求返回 JSON", async () => {
    let req: HttpRequest | null = null;
    const http: HttpFn = async (r) => {
      req = r;
      return json(200, { device_code: "dev", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 899, interval: 5 });
    };
    const got = await githubDeviceStart(http, 0);
    expect(got).toEqual({ deviceCode: "dev", userCode: "WDJB-MJHT", verifyUrl: "https://github.com/login/device", expiresAt: 899_000, interval: 5000 });
    const r = req as unknown as HttpRequest;
    expect(r.url).toBe("https://github.com/login/device/code");
    expect(r.headers?.accept).toBe("application/json");
    expect(form(r)).toEqual({ client_id: GITHUB_APP.clientId });
  });

  it("等待时回 200 加 error；slow_down 按返回的间隔放慢；授权后拿到令牌", async () => {
    const replies = [{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: "ghu_x", token_type: "bearer", scope: "" }];
    const waits: number[] = [];
    const http: HttpFn = async (r) => {
      expect(form(r)).toEqual({ client_id: GITHUB_APP.clientId, device_code: "dev", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      return json(200, replies.shift());
    };
    expect(await githubDevicePoll(http, dc, { sleep: async (ms) => void waits.push(ms) })).toBe("ghu_x");
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  it("用户拒绝、代码过期时报 auth-expired；取消时返回 null", async () => {
    await expect(githubDevicePoll(async () => json(200, { error: "access_denied" }), dc, { sleep: async () => undefined })).rejects.toMatchObject({ code: "auth-expired" });
    await expect(githubDevicePoll(async () => json(200, { error: "authorization_pending" }), { ...dc, expiresAt: 10 }, { sleep: async () => undefined, now: () => 20 })).rejects.toMatchObject({ code: "auth-expired" });
    expect(await githubDevicePoll(async () => json(200, {}), dc, { sleep: async () => undefined, cancelled: () => true })).toBeNull();
  });

  it("网络抖动时继续轮询", async () => {
    let n = 0;
    const http: HttpFn = async () => {
      if (n++ === 0) throw Object.assign(new Error("down"), { code: "ENETWORK" });
      return json(200, { access_token: "ghu_y" });
    };
    expect(await githubDevicePoll(http, dc, { sleep: async () => undefined })).toBe("ghu_y");
  });
});

describe("仓库", () => {
  it("从地址取 owner/repo，只认 github.com", () => {
    expect(githubRepo("https://github.com/me/notes-backup.git")).toEqual({ owner: "me", repo: "notes-backup" });
    expect(githubRepo(" https://GitHub.com/me/notes ")).toEqual({ owner: "me", repo: "notes" });
    expect(githubRepo("https://gitee.com/me/notes.git")).toBeNull();
    expect(githubRepo("https://github.com/me")).toBeNull();
    expect(githubRepo("not a url")).toBeNull();
  });

  const api = (routes: Record<string, unknown>): HttpFn =>
    async (r) => {
      expect(r.headers?.authorization).toBe("Bearer ghu_x");
      const path = r.url.replace("https://api.github.com", "");
      return path in routes ? json(200, routes[path]) : json(404, { message: "Not Found" });
    };
  const inst = (selection: "all" | "selected", login = "Me") => ({ installations: [{ id: 7, app_slug: GITHUB_APP.slug, account: { login }, repository_selection: selection }, { id: 8, app_slug: "other-app", account: { login: "me" } }] });

  it("没装应用、装了但没选这个仓库：not-installed", async () => {
    expect(await githubRepoAccess(api({ "/user/installations?per_page=100": { installations: [] } }), "ghu_x", "me", "notes")).toBe("not-installed");
    expect(await githubRepoAccess(api({ "/user/installations?per_page=100": inst("selected", "someone-else") }), "ghu_x", "me", "notes")).toBe("not-installed");
    const routes = { "/user/installations?per_page=100": inst("selected"), "/user/installations/7/repositories?per_page=100&page=1": { repositories: [{ name: "other" }] } };
    expect(await githubRepoAccess(api(routes), "ghu_x", "me", "notes")).toBe("not-installed");
  });

  it("选了这个仓库：ok（不分大小写）", async () => {
    const routes = { "/user/installations?per_page=100": inst("selected"), "/user/installations/7/repositories?per_page=100&page=1": { repositories: [{ name: "Notes" }] } };
    expect(await githubRepoAccess(api(routes), "ghu_x", "me", "notes")).toBe("ok");
  });

  it("装到所有仓库：仓库存在为 ok，不存在为 not-found", async () => {
    expect(await githubRepoAccess(api({ "/user/installations?per_page=100": inst("all"), "/repos/me/notes": { full_name: "me/notes" } }), "ghu_x", "me", "notes")).toBe("ok");
    expect(await githubRepoAccess(api({ "/user/installations?per_page=100": inst("all") }), "ghu_x", "me", "notes")).toBe("not-found");
  });

  it("令牌失效时报 auth-expired", async () => {
    await expect(githubUser(async () => json(401, { message: "Bad credentials" }), "ghu_x")).rejects.toMatchObject({ code: "auth-expired" });
    expect(await githubUser(async () => json(200, { login: "hong-da" }), "ghu_x")).toBe("hong-da");
  });
});

describe("保存与设置", () => {
  it("密钥里存令牌和用户名；格式不对时当作没登录", () => {
    expect(parseGithubLogin(JSON.stringify({ token: "ghu_x", login: "me" }))).toEqual({ token: "ghu_x", login: "me" });
    expect(parseGithubLogin(JSON.stringify({ token: "" }))).toBeNull();
    expect(parseGithubLogin("ghu_plain")).toBeNull();
    expect(parseGithubLogin(null)).toBeNull();
    expect(githubSecretName("Abc_1")).toBe("mb-github-abc-1");
  });

  it("新建的 GitHub 目的地默认用 GitHub 登录；旧设置没有这一项时保持手动填令牌", () => {
    const fresh = newDestination("git-remote") as GitRemoteConfig;
    expect(fresh.auth).toBe("app");
    const saved = { ...fresh } as Partial<GitRemoteConfig>;
    delete saved.auth;
    const s = mergeSettings({ destinations: [saved, { ...fresh, id: "b" }] });
    expect((s.destinations[0] as GitRemoteConfig).auth).toBe("token");
    expect((s.destinations[1] as GitRemoteConfig).auth).toBe("app");
    expect(usesGithubApp(s.destinations[1]!)).toBe(true);
    expect(usesGithubApp({ ...fresh, provider: "gitee" })).toBe(false);
  });

  it("用 GitHub 登录时，401 提示重新登录，403 / 404 提示安装应用", () => {
    const e = (status: number) => ({ message: "x", data: { statusCode: status } });
    expect(toRemoteError(e(401), "github.com", true).code).toBe("auth-expired");
    expect(toRemoteError(e(404), "github.com", true).code).toBe("app-not-installed");
    expect(toRemoteError(e(403), "github.com", true).code).toBe("app-not-installed");
    expect(toRemoteError(e(401), "github.com").code).toBe("auth-failed");
    expect(toRemoteError(e(404), "github.com").code).toBe("repo-not-found");
  });
});
