// 用 GitHub 登录（插件层）：设备码登录，令牌和用户名存进本机密钥存储；检查仓库有没有装上应用。

import type { App } from "obsidian";
import type { Logger } from "../core/logger";
import type { DeviceCode } from "../core/oauth";
import { githubDevicePoll, githubDeviceStart, githubRepo, githubRepoAccess, githubUser, parseGithubLogin, type GithubLogin, type RepoAccess } from "../core/github-app";
import type { HttpFn } from "../destinations/http";

export class GithubAuth {
  constructor(
    private readonly app: App,
    private readonly http: HttpFn,
    private readonly logger: Logger,
  ) {}

  /** 第一步：申请代码 */
  deviceCode(): Promise<DeviceCode> {
    return githubDeviceStart(this.http);
  }

  /** 第二步：等用户在浏览器里授权，保存令牌；cancelled 为真时返回 null */
  async wait(secretName: string, dc: DeviceCode, cancelled: () => boolean): Promise<GithubLogin | null> {
    const token = await githubDevicePoll(this.http, dc, { sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)), cancelled });
    if (!token) return null;
    this.logger.addSecret(token);
    const login = await githubUser(this.http, token).catch(() => "");
    const full = { token, login };
    this.app.secretStorage.setSecret(secretName, JSON.stringify(full));
    this.logger.info("signed in to GitHub");
    return full;
  }

  load(secretName: string): GithubLogin | null {
    const l = parseGithubLogin(this.app.secretStorage.getSecret(secretName));
    if (l) this.logger.addSecret(l.token);
    return l;
  }

  /** 退出登录：只删本机保存的令牌（GitHub 上的授权可在 Settings → Applications 里取消） */
  signOut(secretName: string): void {
    this.app.secretStorage.setSecret(secretName, "");
  }

  /** 仓库地址不是 github.com 的仓库时返回 null */
  async repoAccess(secretName: string, url: string): Promise<RepoAccess | null> {
    const r = githubRepo(url);
    const l = this.load(secretName);
    if (!r || !l) return null;
    return githubRepoAccess(this.http, l.token, r.owner, r.repo);
  }
}
