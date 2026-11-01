import { normalizePath, type DataAdapter } from "obsidian";
import type { FileStat, VaultFs } from "../core/platform";

/** 用 Obsidian 的 DataAdapter 访问 Vault；能看到 .obsidian 等以点开头的文件夹（vault.getFiles() 看不到） */
export class ObsidianVaultFs implements VaultFs {
  constructor(private readonly adapter: DataAdapter) {}

  async listFiles(descend: (folderPath: string) => boolean): Promise<FileStat[]> {
    const out: FileStat[] = [];
    const walk = async (folder: string): Promise<void> => {
      const { files, folders } = await this.adapter.list(folder);
      for (const raw of files) {
        const path = clean(raw);
        const st = await this.adapter.stat(path);
        if (st && st.type === "file") out.push({ path, size: st.size, mtime: st.mtime });
      }
      for (const raw of folders) {
        const path = clean(raw);
        if (descend(path)) await walk(path);
      }
    };
    await walk("/");
    return out;
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(normalizePath(path));
  }
}

function clean(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}
