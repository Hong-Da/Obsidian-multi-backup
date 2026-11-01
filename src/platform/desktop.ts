// 只在桌面端可用的功能：Node 文件系统、Vault 的本机路径、系统的文件夹选择框。
// 移动端调用时返回 null，由调用方提示“只能在桌面端使用”。

import { FileSystemAdapter, Platform, type DataAdapter } from "obsidian";
import type { PromiseFsClient } from "isomorphic-git";
import type { TargetFs } from "../destinations/types";
import { NodeTargetFs, type NodeFsPromises, type NodePath } from "./node-target-fs";

type Require = (id: string) => unknown;

function nodeRequire(): Require | null {
  if (!Platform.isDesktopApp) return null;
  const r = (window as unknown as { require?: Require }).require;
  return typeof r === "function" ? r : null;
}

let cached: TargetFs | null | undefined;

export function desktopTargetFs(): TargetFs | null {
  if (cached !== undefined) return cached;
  const req = nodeRequire();
  if (!req) return (cached = null);
  const fs = req("fs") as { promises: NodeFsPromises };
  const path = req("path") as NodePath;
  return (cached = new NodeTargetFs(fs.promises, path));
}

/** 给 isomorphic-git 用的 Node fs（桌面端） */
export function desktopGitFs(): PromiseFsClient | null {
  const req = nodeRequire();
  return req ? (req("fs") as PromiseFsClient) : null;
}

/** Vault 在本机上的绝对路径（桌面端） */
export function vaultBasePath(adapter: DataAdapter): string | null {
  return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}

interface ElectronDialog {
  showOpenDialog(o: { properties: string[]; defaultPath?: string }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

function electronDialog(): ElectronDialog | null {
  try {
    const electron = nodeRequire()?.("electron") as { remote?: { dialog?: ElectronDialog } } | undefined;
    return electron?.remote?.dialog ?? null;
  } catch {
    return null;
  }
}

/** 系统的文件夹选择框是否可用（Obsidian 没有公开接口，取不到时界面只保留手动输入） */
export function canPickFolder(): boolean {
  return electronDialog() !== null;
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const dialog = electronDialog();
  if (!dialog) return null;
  const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], defaultPath: defaultPath || undefined });
  return r.canceled ? null : (r.filePaths[0] ?? null);
}
