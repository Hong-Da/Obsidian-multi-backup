// 冲突副本：两边都改了同一文件时，远程版本另存为 <文件名>.conflict-<设备名>-<时间><扩展名>，放在原文件旁边。

import { extOf, localDate } from "./paths";

const pad = (n: number) => String(n).padStart(2, "0");

/** 设备名里不能出现在文件名中的字符换成“-” */
export function safeDeviceName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "device";
}

/** 例如 Daily/2026-10-31.md → Daily/2026-10-31.conflict-手机-2B9C-2026-10-31-1042.md */
export function conflictName(path: string, device: string, t: Date): string {
  const ext = extOf(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  const time = `${localDate(t)}-${pad(t.getHours())}${pad(t.getMinutes())}`;
  return `${stem}.conflict-${safeDeviceName(device)}-${time}${ext}`;
}

/** 是不是本插件生成的冲突副本 */
export function isConflictCopy(path: string): boolean {
  return /\.conflict-[^/]+-\d{4}-\d{2}-\d{2}-\d{4}(\.[^./]+)?$/.test(path);
}

/** 文件名已被占用时加序号：x.conflict-…-1042.md → x.conflict-…-1042-2.md */
export function withSuffix(path: string, n: number): string {
  const ext = extOf(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  return `${stem}-${n}${ext}`;
}

/** 新设备的默认名称：桌面-XXXX / 手机-XXXX（也用于英文界面：Desktop-XXXX / Phone-XXXX） */
export function defaultDeviceName(mobile: boolean, label: { desktop: string; phone: string }, random: () => number = Math.random): string {
  const chars = "0123456789ABCDEF";
  let id = "";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(random() * 16)];
  return `${mobile ? label.phone : label.desktop}-${id}`;
}

export type ConflictChoice = "mine" | "remote" | "both" | "keep" | "delete";

export interface ResolveIo {
  read(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** 复制进回收站；move 为 true 时随后删除原文件 */
  trash(path: string, move: boolean): Promise<void>;
}

/**
 * 处理一个冲突。改动只发生在本机，下次同步时照常传到其他设备。
 * - mine：冲突副本移进回收站
 * - remote：本机原文件先进回收站，用副本的内容覆盖它，再把副本移进回收站
 * - both：两份都留下（副本当普通文件）
 * - keep：（一边删了一边改了）保留文件
 * - delete：（一边删了一边改了）文件移进回收站
 */
export async function resolveConflict(c: { path: string; copy?: string }, choice: ConflictChoice, io: ResolveIo): Promise<void> {
  const copyExists = !!c.copy && (await io.exists(c.copy));
  switch (choice) {
    case "mine":
      if (copyExists) await io.trash(c.copy as string, true);
      return;
    case "remote":
      if (!copyExists) return;
      if (await io.exists(c.path)) await io.trash(c.path, false);
      await io.write(c.path, await io.read(c.copy as string));
      await io.trash(c.copy as string, true);
      return;
    case "delete":
      if (await io.exists(c.path)) await io.trash(c.path, true);
      return;
    case "both":
    case "keep":
      return;
  }
}
