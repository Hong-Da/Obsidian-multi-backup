// 目的地错误：带错误码，界面按错误码显示可读的原因与解决办法。

export type DestinationErrorCode =
  | "not-found" // 目标文件夹不存在（例如移动硬盘没插）
  | "not-writable" // 没有写入权限
  | "no-space" // 空间不足
  | "in-use" // 文件被其他程序占用
  | "inside-vault" // 目标文件夹在 Vault 里面
  | "not-configured" // 必填项没填
  | "desktop-only" // 本地文件夹只能在桌面端使用
  | "unsupported-repo" // .git 是文件（git worktree 或子模块），isomorphic-git 不支持
  | "no-token" // 远程 Git 还没有选择令牌
  | "auth-failed" // 令牌无效或已过期（401）
  | "no-permission" // 令牌没有推送权限（403）
  | "repo-not-found" // 找不到仓库（404）
  | "app-not-installed" // 用 GitHub 登录：应用没装到这个仓库（403 / 404）
  | "network" // 连不上服务器
  | "push-rejected" // 服务器拒绝了推送（例如分支保护、文件过大）
  | "local-changed" // 同步过程中本机文件又被编辑，跳过，下次再同步
  | "remote-moved" // 主同步端：推送时远程刚被别的设备更新，下次同步重新合并
  | "not-webdav" // 地址不是 WebDAV 服务
  | "no-bucket" // S3 桶不存在
  | "auth-expired" // 网盘登录已失效，需要重新登录
  | "not-signed-in" // 网盘还没有登录
  | "quota" // 目的地空间不足
  | "case-clash" // 远程文件与本机文件只差大小写，跳过
  | "io"; // 其他读写错误

export class DestinationError extends Error {
  constructor(
    readonly code: DestinationErrorCode,
    /** 出错的路径（目标文件夹或具体文件） */
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `${code}: ${path}`);
    this.name = "DestinationError";
  }
}

/** 把 Node 文件系统错误转成 DestinationError */
export function toDestinationError(e: unknown, path: string): DestinationError {
  if (e instanceof DestinationError) return e;
  const code = (e as { code?: string } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return new DestinationError("not-found", path, msg);
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return new DestinationError("not-writable", path, msg);
    case "ENOSPC":
    case "EDQUOT":
      return new DestinationError("no-space", path, msg);
    case "EBUSY":
    case "ETXTBSY":
      return new DestinationError("in-use", path, msg);
    default:
      return new DestinationError("io", path, msg);
  }
}
