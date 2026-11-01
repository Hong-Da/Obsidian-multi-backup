// 三个网盘的登录参数。应用 ID（client ID）由插件作者在各平台注册后填入；没有填时界面提示“这个版本还不能登录”。
// 这些 ID 是公开信息（公共客户端，用 PKCE），不是凭据；Google 的设备登录客户端按 Google 文档也不把 secret 当机密。

import type { CloudKind, OAuthProvider } from "../core/oauth";
import type { HttpFn } from "./http";

/** 发布前填入（见 docs/cloud-apps.md） */
export const CLIENT_IDS: Record<CloudKind, string> = {
  onedrive: "",
  dropbox: "tzg0bbwkb3fy43o",
  gdrive: "",
};

/** Google“电视和输入受限设备”客户端的 secret（同上，发布前填入） */
export const GDRIVE_CLIENT_SECRET = "";

export const REDIRECT_URI = "obsidian://multi-backup-auth";

export function cloudProvider(kind: CloudKind): OAuthProvider {
  switch (kind) {
    case "onedrive":
      return {
        kind,
        authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        clientId: CLIENT_IDS.onedrive,
        // 只能访问网盘里的“应用/Multi Backup”文件夹
        scope: "Files.ReadWrite.AppFolder User.Read offline_access",
      };
    case "dropbox":
      return {
        kind,
        authUrl: "https://www.dropbox.com/oauth2/authorize",
        tokenUrl: "https://api.dropboxapi.com/oauth2/token",
        clientId: CLIENT_IDS.dropbox,
        scope: "",
        extraAuth: { token_access_type: "offline" },
      };
    case "gdrive":
      return {
        kind,
        authUrl: "",
        tokenUrl: "https://oauth2.googleapis.com/token",
        deviceUrl: "https://oauth2.googleapis.com/device/code",
        clientId: CLIENT_IDS.gdrive,
        clientSecret: GDRIVE_CLIENT_SECRET,
        // 只能看到插件自己建的文件
        scope: "https://www.googleapis.com/auth/drive.file",
      };
  }
}

export function cloudConfigured(kind: CloudKind): boolean {
  return !!CLIENT_IDS[kind] && (kind !== "gdrive" || !!GDRIVE_CLIENT_SECRET);
}

/** 登录后读出账号（邮箱或名称），只用于界面显示 */
export async function fetchAccount(http: HttpFn, kind: CloudKind, access: string): Promise<string> {
  const auth = { Authorization: `Bearer ${access}` };
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const read = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body) || "{}") as Record<string, unknown>;
  if (kind === "onedrive") {
    const r = await http({ url: "https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail,displayName", method: "GET", headers: auth });
    const j = read(r.body);
    return str(j.mail) || str(j.userPrincipalName) || str(j.displayName);
  }
  if (kind === "dropbox") {
    const r = await http({ url: "https://api.dropboxapi.com/2/users/get_current_account", method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: new TextEncoder().encode("null") });
    const j = read(r.body);
    return str(j.email) || str((j.name as { display_name?: unknown } | undefined)?.display_name);
  }
  const r = await http({ url: "https://www.googleapis.com/drive/v3/about?fields=user", method: "GET", headers: auth });
  const u = read(r.body).user as { emailAddress?: string; displayName?: string } | undefined;
  return u?.emailAddress ?? u?.displayName ?? "";
}
