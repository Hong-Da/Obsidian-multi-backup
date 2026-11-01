// 平台接口：核心逻辑通过它访问 Vault，Obsidian 与 Node（测试）各有一个实现。

/** Vault 中的一个文件；path 为 Vault 内的相对路径，用 / 分隔，不以 / 开头 */
export interface FileStat {
  path: string;
  size: number;
  /** 修改时间，毫秒 */
  mtime: number;
}

export interface VaultFs {
  /**
   * 递归列出全部文件（包括 .obsidian 等以点开头的文件夹）。
   * descend 返回 false 的文件夹不进入，用于提前跳过被排除的大文件夹。
   */
  listFiles(descend: (folderPath: string) => boolean): Promise<FileStat[]>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

/** 主同步端改动本机文件用。覆盖或删除前，原文件先移进回收站（.trash/multi-backup/<日期>/）。 */
export interface VaultWriter {
  exists(path: string): Promise<boolean>;
  /** 写入文件，缺少的文件夹自动创建；已存在时覆盖 */
  write(path: string, data: Uint8Array): Promise<void>;
  /** 把文件复制一份进回收站；move 为 true 时随后删除原文件 */
  trash(path: string, move: boolean): Promise<void>;
}
