/// <reference types="node" />
// 测试用的 Node 工具：项目内临时目录、真实文件夹上的 VaultFs、内存中的 StateStore
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { emptyManifest, type Manifest } from "../../src/core/manifest";
import type { FileStat, VaultFs } from "../../src/core/platform";
import type { StateStore } from "../../src/core/sync";
import type { BaseEntry } from "../../src/core/sync-planner";
import type { ConflictRecord } from "../../src/core/two-way";
import { NodeTargetFs, type NodeFsPromises } from "../../src/platform/node-target-fs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 在项目 tmp/ 下创建临时目录（不写系统临时目录） */
export async function makeTmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = path.join(ROOT, "tmp", "test-" + randomUUID().slice(0, 8));
  await fs.mkdir(dir, { recursive: true });
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const nodeFs: NodeFsPromises = fs;
export const nodeTargetFs = () => new NodeTargetFs(nodeFs, path);

export async function writeText(file: string, text: string, mtime?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  if (mtime) await fs.utimes(file, new Date(mtime), new Date(mtime));
}

export const readText = (file: string) => fs.readFile(file, "utf8");
export const exists = (file: string) => fs.stat(file).then(() => true, () => false);
export const removePath = (p: string) => fs.rm(p, { recursive: true, force: true });
export const renamePath = (a: string, b: string) => fs.rename(a, b);
export { fs, path };

/** 列出文件夹下全部文件（相对路径，/ 分隔，排序） */
export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  await walk(dir, "");
  return out.sort();
}

/** 真实文件夹上的 VaultFs */
export class NodeVaultFs implements VaultFs {
  constructor(private readonly root: string) {}

  async listFiles(descend: (folderPath: string) => boolean): Promise<FileStat[]> {
    const out: FileStat[] = [];
    const walk = async (rel: string) => {
      for (const e of await fs.readdir(path.join(this.root, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (descend(r)) await walk(r);
        } else {
          const st = await fs.stat(path.join(this.root, r));
          out.push({ path: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
        }
      }
    };
    await walk("");
    return out;
  }

  async readBinary(p: string): Promise<ArrayBuffer> {
    const b = await fs.readFile(path.join(this.root, ...p.split("/")));
    return new Uint8Array(b).buffer;
  }
}

export class MemoryState implements StateStore {
  manifests = new Map<string, Manifest>();
  cache: Manifest = emptyManifest();
  bases = new Map<string, Map<string, BaseEntry>>();
  conflicts: ConflictRecord[] = [];
  async loadBase(id: string) {
    return new Map(this.bases.get(id) ?? []);
  }
  async saveBase(id: string, b: Map<string, BaseEntry>) {
    this.bases.set(id, new Map(b));
  }
  async loadConflicts() {
    return [...this.conflicts];
  }
  async saveConflicts(list: ConflictRecord[]) {
    this.conflicts = [...list];
  }
  async loadManifest(id: string) {
    return this.manifests.get(id) ?? emptyManifest();
  }
  async saveManifest(id: string, m: Manifest) {
    this.manifests.set(id, JSON.parse(JSON.stringify(m)) as Manifest);
  }
  async loadHashCache() {
    return this.cache;
  }
  async saveHashCache(m: Manifest) {
    this.cache = m;
  }
}

/** 真实文件夹上的 VaultWriter：回收站放在 .trash/multi-backup/ */
export class NodeVaultWriter {
  trashed: string[] = [];
  constructor(private readonly root: string) {}
  private full(p: string) {
    return path.join(this.root, ...p.split("/"));
  }
  async exists(p: string) {
    return fs.stat(this.full(p)).then(() => true, () => false);
  }
  async write(p: string, data: Uint8Array) {
    await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
    await fs.writeFile(this.full(p), data);
  }
  async trash(p: string, move: boolean) {
    const dst = path.join(this.root, ".trash", "multi-backup", ...p.split("/"));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(this.full(p), dst);
    if (move) await fs.rm(this.full(p));
    this.trashed.push(p);
  }
  async read(p: string) {
    return new Uint8Array(await fs.readFile(this.full(p)));
  }
  /** 恢复用：复制到 dir/<原路径>，move 时删除原文件 */
  async stash(p: string, dir: string, move: boolean) {
    const dst = this.full(`${dir}/${p}`);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(this.full(p), dst);
    if (move) await fs.rm(this.full(p));
  }
}
