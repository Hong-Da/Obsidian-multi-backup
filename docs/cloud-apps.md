# 注册网盘应用（OneDrive、Dropbox、Google Drive）

插件登录网盘需要在各平台注册一个“应用”，拿到应用 ID（client ID），填进 `src/destinations/cloud-providers.ts` 的 `CLIENT_IDS`（Google 还要填 `GDRIVE_CLIENT_SECRET`）后重新构建。应用 ID 是公开信息，不是凭据；插件用 PKCE 或设备代码登录，用户的登录凭据只保存在各自设备的密钥存储里。

| 网盘 | 登录方式 | 回调地址 | 权限 |
|---|---|---|---|
| OneDrive | 授权码 + PKCE | `obsidian://multi-backup-auth` | `Files.ReadWrite.AppFolder`、`User.Read`、`offline_access` |
| Dropbox | 授权码 + PKCE | `obsidian://multi-backup-auth` | 应用文件夹 |
| Google Drive | 设备代码（google.com/device） | 不需要 | `drive.file` |

## OneDrive（Microsoft Entra）

1. 打开 [Azure 门户 → 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)，点 **新注册**。
2. 名称填 `Multi Backup`；“受支持的帐户类型”选 **任何组织目录中的帐户和个人 Microsoft 帐户**。
3. “重定向 URI”平台选 **公共客户端/本机（移动和桌面）**，填 `obsidian://multi-backup-auth`，注册。
4. 在 **身份验证** 页把“允许公共客户端流”设为 **是**，保存。
5. 在 **API 权限** 页添加 Microsoft Graph 的委托权限：`Files.ReadWrite.AppFolder`、`User.Read`、`offline_access`。
6. 复制 **概述** 页的“应用程序(客户端) ID”，填到 `CLIENT_IDS.onedrive`。

## Dropbox

1. 打开 [Dropbox App Console](https://www.dropbox.com/developers/apps)，点 **Create app**。
2. 选 **Scoped access** → **App folder**，名称填 `Multi Backup`（备份会放在 Dropbox 的 `应用/Multi Backup/`）。
3. 在 **Permissions** 页勾选 `files.metadata.read`、`files.metadata.write`、`files.content.read`、`files.content.write`、`account_info.read`，点 Submit。
4. 在 **Settings** 页的 **OAuth 2 → Redirect URIs** 添加 `obsidian://multi-backup-auth`；**Allow public clients (Implicit Grant & PKCE)** 保持 Allow。
5. 复制 **App key**，填到 `CLIENT_IDS.dropbox`。
6. 应用默认是开发模式，最多 500 个用户；正式发布前在 Settings 页申请 **Production**。

## Google Drive（Google Cloud）

1. 打开 [Google Cloud 控制台](https://console.cloud.google.com/)，新建项目 `Multi Backup`。
2. **API 和服务 → 库**：启用 **Google Drive API**。
3. **OAuth 同意屏幕**：用户类型选“外部”，填应用名称和联系邮箱；范围添加 `.../auth/drive.file`；测试阶段把自己加为测试用户。
4. **凭据 → 创建凭据 → OAuth 客户端 ID**：应用类型选 **电视和输入受限设备**，创建。
5. 复制“客户端 ID”和“客户端密钥”，分别填到 `CLIENT_IDS.gdrive` 和 `GDRIVE_CLIENT_SECRET`（这类客户端的密钥按 Google 文档不算机密）。
6. 正式发布前提交 OAuth 同意屏幕审核；`drive.file` 属于非敏感范围，审核较简单。

## 填好之后

```bash
source scripts/env.sh
pnpm run build
```

然后在 Obsidian 中：设置 → 多点备份 → 添加目的地 → OneDrive / Dropbox / Google Drive → 登录。
