// 主同步端改动本机文件：普通笔记走 Vault 接口（编辑器与索引会同步更新），
// 以点开头的文件夹（例如 .obsidian/）不在 Vault 索引里，走 DataAdapter。
// 覆盖或删除前，原文件先复制到 .trash/multi-backup/<日期>/<原路径>，过了保留天数自动清理。
// 恢复时被覆盖的文件另存到 .trash/multi-backup/restore-<时间>/，撤销时的到 undo-<时间>/，同样按天数清理。

import { normalizePath, type App } from "obsidian";
import { localDate } from "../core/paths";
import type { VaultWriter } from "../core/platform";

export const TRASH_DIR = ".trash/multi-backup";

/** 以点开头的文件夹或文件不在 Vault 索引里 */
const hidden = (path: string) => path.split("/").some((p) => p.startsWith("."));

export class ObsidianVaultWriter implements VaultWriter {
  constructor(
    private readonly app: App,
    private readonly now: () => Date = () => new Date(),
    /** 插件自己改动了这个文件（用来区分用户的编辑） */
    private readonly onTouch?: (path: string) => void,
  ) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const p = normalizePath(path);
    this.onTouch?.(p);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const file = hidden(p) ? null : this.app.vault.getFileByPath(p);
    if (file) return this.app.vault.modifyBinary(file, buf);
    await this.ensureFolder(parentOf(p));
    if (hidden(p) || (await this.adapter.exists(p))) await this.adapter.writeBinary(p, buf);
    else await this.app.vault.createBinary(p, buf);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(normalizePath(path)));
  }

  trash(path: string, move: boolean): Promise<void> {
    return this.stash(path, `${TRASH_DIR}/${localDate(this.now())}`, move);
  }

  /** 复制到 dir/<原路径>（重名时加编号）；move 为 true 时随后移走原文件 */
  async stash(path: string, dir: string, move: boolean): Promise<void> {
    const p = normalizePath(path);
    if (move) this.onTouch?.(p);
    let dst = normalizePath(`${dir}/${p}`);
    for (let n = 2; await this.adapter.exists(dst); n++) dst = normalizePath(`${dir}/${withNumber(p, n)}`);
    await this.ensureFolder(parentOf(dst), true);
    await this.adapter.copy(p, dst);
    if (!move) return;
    const file = hidden(p) ? null : this.app.vault.getFileByPath(p);
    // 已经复制进了 .trash/multi-backup/，原文件按用户的“删除文件”设置处理
    if (file) await this.app.fileManager.trashFile(file);
    else await this.adapter.remove(p);
  }

  /** 删除超过保留天数的日期文件夹，以及 restore-、undo- 文件夹 */
  async cleanup(keepDays: number): Promise<void> {
    if (!(await this.adapter.exists(TRASH_DIR))) return;
    const t = this.now();
    const cutoff = localDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() - keepDays));
    for (const dir of (await this.adapter.list(TRASH_DIR)).folders) {
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      const day = /^(?:restore-|undo-)?(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
      if (day && day < cutoff) await this.adapter.rmdir(dir, true);
    }
  }

  private async ensureFolder(dir: string, viaAdapter = false): Promise<void> {
    if (!dir || (await this.adapter.exists(dir))) return;
    await this.ensureFolder(parentOf(dir), viaAdapter);
    if (viaAdapter || hidden(dir)) await this.adapter.mkdir(dir);
    else await this.app.vault.createFolder(dir);
  }
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function withNumber(p: string, n: number): string {
  const slash = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  return dot > slash + 1 ? `${p.slice(0, dot)} (${n})${p.slice(dot)}` : `${p} (${n})`;
}
