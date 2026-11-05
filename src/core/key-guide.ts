// 创建密钥的指导：各平台 / 服务商的创建页面地址，以及只允许一个桶的 S3 权限策略。
// 不依赖 obsidian，界面在 src/ui/key-guide.ts。

export type KeyGuideId =
  | "github"
  | "gitee"
  | "gitOther"
  | "jianguo"
  | "nextcloud"
  | "alist"
  | "davOther"
  | "aws"
  | "oss"
  | "cos"
  | "r2"
  | "minio";

const APP_NAME = "Obsidian Multi Backup";

/** GitHub 细粒度令牌：预填名称、说明、不过期、Contents 读写；仓库要在页面上自己选（GitHub 不支持预填） */
export const GITHUB_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?" +
  new URLSearchParams({ name: APP_NAME, description: "Backups from the Obsidian plugin Multi Backup", expires_in: "none", contents: "write" }).toString();

export const FIXED_URLS: Partial<Record<KeyGuideId, string>> = {
  github: GITHUB_TOKEN_URL,
  gitee: "https://gitee.com/profile/personal_access_tokens",
  jianguo: "https://www.jianguoyun.com/",
  aws: "https://console.aws.amazon.com/iam/home#/users",
  oss: "https://ram.console.aliyun.com/users",
  cos: "https://console.cloud.tencent.com/cam",
  r2: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens",
};

function origin(url: string): URL | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** 其他 Git 托管：按仓库地址生成令牌页面。主机名带 gitlab 的按 GitLab，其余按 Gitea / Forgejo */
export function gitHostTokenUrl(repoUrl: string): string | null {
  const u = origin(repoUrl);
  if (!u) return null;
  if (/(^|\.)gitlab\./i.test(u.hostname)) {
    return `${u.origin}/-/user_settings/personal_access_tokens?${new URLSearchParams({ name: APP_NAME, scopes: "write_repository" }).toString()}`;
  }
  return `${u.origin}/user/settings/applications`;
}

/** Nextcloud：按 WebDAV 地址找到“个人设置 → 安全”页面（地址里 /remote.php 之前是 Nextcloud 的根） */
export function nextcloudSecurityUrl(davUrl: string): string | null {
  const u = origin(davUrl);
  if (!u) return null;
  const i = u.pathname.indexOf("/remote.php");
  const base = i >= 0 ? u.pathname.slice(0, i) : "";
  return `${u.origin}${base}/index.php/settings/user/security`;
}

export function guideHost(url: string): string {
  return origin(url)?.host ?? "";
}

export type PolicyResult = { policy: string } | { missing: "bucket" | "appid" };

/**
 * 只允许一个桶的权限策略。插件只用到：列出文件、读、写（含复制）、删除对象。
 * 腾讯云 COS 的桶名带 APPID（如 notes-1250000000），资源路径要用到 APPID 和地域。
 */
export function s3Policy(kind: "aws" | "oss" | "cos", bucketRaw: string, region = ""): PolicyResult {
  const bucket = bucketRaw.trim();
  if (!bucket) return { missing: "bucket" };
  let doc: unknown;
  if (kind === "aws") {
    doc = {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: [`arn:aws:s3:::${bucket}`] },
        { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: [`arn:aws:s3:::${bucket}/*`] },
      ],
    };
  } else if (kind === "oss") {
    doc = {
      Version: "1",
      Statement: [
        { Effect: "Allow", Action: ["oss:ListObjects"], Resource: [`acs:oss:*:*:${bucket}`] },
        { Effect: "Allow", Action: ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"], Resource: [`acs:oss:*:*:${bucket}/*`] },
      ],
    };
  } else {
    const appid = /-(\d{6,})$/.exec(bucket)?.[1];
    if (!appid) return { missing: "appid" };
    const r = region.trim() || "*";
    doc = {
      version: "2.0",
      statement: [
        {
          effect: "allow",
          action: ["name/cos:GetBucket", "name/cos:GetObject", "name/cos:PutObject", "name/cos:DeleteObject"],
          resource: [`qcs::cos:${r}:uid/${appid}:${bucket}/`, `qcs::cos:${r}:uid/${appid}:${bucket}/*`],
        },
      ],
    };
  }
  return { policy: JSON.stringify(doc, null, 2) };
}
