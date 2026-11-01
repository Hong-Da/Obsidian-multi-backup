// 插件配置备份（任务文档 F-K1～F-K5）：同步设置随备份写到目的地，或导出为文件，换设备时导入。
// 设置里只有密钥名，没有令牌和密码本身，所以配置文件里也没有任何凭据（用户决定：凭据不上传）。

import { safeDeviceName } from "./conflict";

/** 目的地里放配置的文件夹：每台设备一个文件 */
export const CONFIG_DIR = ".multi-backup/config";

const FORMAT = "multi-backup-config";

export interface ConfigFile {
  format: typeof FORMAT;
  version: 1;
  /** 上传这份配置的设备名称 */
  device: string;
  /** 设置最后一次修改的时间（毫秒）；内容不变时不变，同步时不会重写 */
  time: number;
  /** 插件版本 */
  plugin: string;
  /** 插件设置（data.json 的内容） */
  settings: Record<string, unknown>;
}

export function configPath(device: string): string {
  return `${CONFIG_DIR}/${safeDeviceName(device) || "device"}.json`;
}

export function buildConfig(settings: object, device: string, plugin: string, time: number): ConfigFile {
  return { format: FORMAT, version: 1, device, time, plugin, settings: JSON.parse(JSON.stringify(settings)) as Record<string, unknown> };
}

export function encodeConfig(c: ConfigFile): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(c, null, 2) + "\n");
}

/** 读出配置文件；不是本插件的配置或格式不对时返回 null */
export function parseConfig(data: Uint8Array | string): ConfigFile | null {
  try {
    const raw = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Partial<ConfigFile> | null;
    if (!raw || raw.format !== FORMAT || raw.version !== 1) return null;
    if (typeof raw.settings !== "object" || raw.settings === null || Array.isArray(raw.settings)) return null;
    return {
      format: FORMAT,
      version: 1,
      device: typeof raw.device === "string" ? raw.device : "",
      time: typeof raw.time === "number" ? raw.time : 0,
      plugin: typeof raw.plugin === "string" ? raw.plugin : "",
      settings: raw.settings,
    };
  } catch {
    return null;
  }
}

/** 同一个设备只留最新一份，按修改时间从新到旧 */
export function newestPerDevice(list: ConfigFile[]): ConfigFile[] {
  const byDevice = new Map<string, ConfigFile>();
  for (const c of list) {
    const old = byDevice.get(c.device);
    if (!old || c.time > old.time) byDevice.set(c.device, c);
  }
  return [...byDevice.values()].sort((a, b) => b.time - a.time);
}
