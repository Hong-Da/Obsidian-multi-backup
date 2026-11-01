// 网盘登录（插件层）：打开浏览器授权，等 obsidian://multi-backup-auth 回调，用授权码换令牌，存进本机密钥存储。
// Google Drive 用设备代码登录：显示短代码，用户在浏览器里输入后轮询拿到令牌。

import type { App, ObsidianProtocolData } from "obsidian";
import { DestinationError } from "../core/errors";
import type { Logger } from "../core/logger";
import { authorizeUrl, devicePoll, deviceStart, exchangeCode, parseTokens, pkcePair, randomState, tokenSource, type AccessToken, type CloudKind, type DeviceCode, type OAuthTokens } from "../core/oauth";
import { cloudProvider, fetchAccount, REDIRECT_URI } from "../destinations/cloud-providers";
import type { HttpFn } from "../destinations/http";

interface Waiting {
  resolve: (code: string) => void;
  reject: (e: Error) => void;
}

export class CloudAuth {
  private readonly waiting = new Map<string, Waiting>();

  constructor(
    private readonly app: App,
    private readonly http: HttpFn,
    private readonly logger: Logger,
  ) {}

  /** obsidian://multi-backup-auth?code=…&state=… */
  handleCallback(params: ObsidianProtocolData): void {
    const state = params.state ?? "";
    const w = this.waiting.get(state);
    if (!w) return;
    this.waiting.delete(state);
    if (params.code) w.resolve(params.code);
    else w.reject(new DestinationError("auth-failed", "", params.error_description ?? params.error ?? "no code"));
  }

  /** 取消正在等待的浏览器授权 */
  cancel(): void {
    for (const w of this.waiting.values()) w.reject(new DestinationError("auth-failed", "", "cancelled"));
    this.waiting.clear();
  }

  /** OneDrive、Dropbox：打开浏览器，等回调（最多 10 分钟），换令牌并保存 */
  async signIn(kind: CloudKind, secretName: string): Promise<OAuthTokens> {
    const p = cloudProvider(kind);
    const { verifier, challenge } = await pkcePair();
    const state = randomState();
    const code = new Promise<string>((resolve, reject) => {
      this.waiting.set(state, { resolve, reject });
      window.setTimeout(() => {
        if (this.waiting.delete(state)) reject(new DestinationError("auth-failed", "", "timeout"));
      }, 10 * 60_000);
    });
    window.open(authorizeUrl(p, REDIRECT_URI, state, challenge));
    const t = await exchangeCode(this.http, p, await code, verifier, REDIRECT_URI);
    return this.finish(kind, secretName, t);
  }

  /** Google Drive 第一步：申请设备代码 */
  deviceCode(kind: CloudKind): Promise<DeviceCode> {
    return deviceStart(this.http, cloudProvider(kind));
  }

  /** Google Drive 第二步：等用户在浏览器里输入代码并同意；cancelled 为真时返回 null */
  async waitDevice(kind: CloudKind, secretName: string, dc: DeviceCode, cancelled: () => boolean): Promise<OAuthTokens | null> {
    const t = await devicePoll(this.http, cloudProvider(kind), dc, { sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)), cancelled });
    return t ? this.finish(kind, secretName, t) : null;
  }

  private async finish(kind: CloudKind, secretName: string, t: OAuthTokens): Promise<OAuthTokens> {
    this.logger.addSecret(t.access);
    this.logger.addSecret(t.refresh);
    const account = await fetchAccount(this.http, kind, t.access).catch(() => "");
    const full = { ...t, account };
    this.save(secretName, full);
    this.logger.info(`signed in to ${kind}`);
    return full;
  }

  load(secretName: string): OAuthTokens | null {
    const t = parseTokens(this.app.secretStorage.getSecret(secretName));
    if (t) {
      this.logger.addSecret(t.access);
      this.logger.addSecret(t.refresh);
    }
    return t;
  }

  private save(secretName: string, t: OAuthTokens): void {
    this.app.secretStorage.setSecret(secretName, JSON.stringify(t));
  }

  /** 退出登录：只删本机保存的凭据（网盘网页上的授权可另行取消） */
  signOut(secretName: string): void {
    this.app.secretStorage.setSecret(secretName, "");
  }

  /** 网盘文件系统用的访问令牌：自动续期，续期结果写回密钥存储 */
  token(kind: CloudKind, secretName: string): AccessToken {
    return tokenSource({
      http: this.http,
      provider: cloudProvider(kind),
      load: () => this.load(secretName),
      save: (t) => {
        this.logger.addSecret(t.access);
        this.save(secretName, t);
      },
    });
  }
}
