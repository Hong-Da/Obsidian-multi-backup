// 按网盘种类创建目标文件系统（每次同步新建，Google Drive 的路径 id 缓存不跨同步）
import type { AccessToken, CloudKind } from "../core/oauth";
import { DropboxFs } from "./dropbox-fs";
import { GoogleDriveFs } from "./gdrive-fs";
import type { HttpFn } from "./http";
import { OneDriveFs } from "./onedrive-fs";
import type { TargetFs } from "./types";

export function cloudFs(kind: CloudKind, o: { token: AccessToken; http: HttpFn }): TargetFs {
  if (kind === "dropbox") return new DropboxFs(o);
  if (kind === "gdrive") return new GoogleDriveFs(o);
  return new OneDriveFs(o);
}
