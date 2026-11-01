// 本地 git 仓库：目标文件夹是一个 git 仓库，每次备份有变化时提交一次，旧版本都在 git 历史里。
// 工作区的读写复用本地镜像（不留历史版本、直接删除，因为 git 已经保存了），提交用 isomorphic-git。
//
// 同步中途退出时，已经写进工作区的文件还没提交。为此第一次改动工作区前先在 .git 里放一个标记文件，
// 提交成功后删除；下次同步发现标记还在，就把工作区的全部变化补提交。

import { add, commit, init, log, remove, resolveRef, statusMatrix, type PromiseFsClient } from "isomorphic-git";
import { DestinationError, toDestinationError } from "../core/errors";
import { commitMessage } from "../core/paths";
import type { RestoreSource } from "../core/restore";
import { gitRestoreSource } from "./git-restore";
import { LocalMirror } from "./local-mirror";
import type { FileStore, FinishInfo, TargetFs, TestInfo } from "./types";

export interface LocalGitOptions {
  /** 目标文件夹（本机绝对路径），也是 git 仓库的工作区 */
  root: string;
  vaultName: string;
  /** 提交说明模板：{vault} {date} {time} */
  message: string;
  author: { name: string; email: string };
  now?: () => Date;
}

const PENDING = "multi-backup-pending";
/** NodeTargetFs 写文件时用的临时文件后缀，不提交 */
const TMP_SUFFIX = ".mb-tmp";
/** 测试连接时最多数这么多个提交 */
const COUNT_LIMIT = 10000;

export class LocalGit implements FileStore {
  readonly kind = "files" as const;
  private readonly tree: LocalMirror;
  private readonly now: () => Date;
  /** 本次同步改动过工作区，或上次同步没有提交完 */
  private dirty = false;
  private marked = false;
  private readonly cache = {};

  constructor(
    private readonly fs: TargetFs,
    private readonly gitFs: PromiseFsClient,
    private readonly o: LocalGitOptions,
  ) {
    this.now = o.now ?? (() => new Date());
    this.tree = new LocalMirror(fs, { root: o.root, deletePolicy: "delete", keepVersions: 0, now: this.now });
  }

  private get gitdir(): string {
    return this.fs.join(this.o.root, ".git");
  }

  private get marker(): string {
    return this.fs.join(this.gitdir, PENDING);
  }

  async test(): Promise<TestInfo> {
    const info = await this.tree.test();
    const st = await this.fs.stat(this.gitdir);
    if (st && !st.isDir) throw new DestinationError("unsupported-repo", this.o.root);
    const { count, newest } = await this.history();
    return { freeBytes: info.freeBytes, existing: count, newest, isRepo: !!st };
  }

  async prepare(): Promise<void> {
    await this.tree.prepare();
    try {
      const st = await this.fs.stat(this.gitdir);
      if (!st) await init({ fs: this.gitFs, dir: this.o.root, defaultBranch: "main" });
      // .git 是文件时是 git worktree 或子模块，isomorphic-git 不支持
      else if (!st.isDir) throw new DestinationError("unsupported-repo", this.o.root);
      if (await this.fs.stat(this.marker)) this.dirty = this.marked = true;
    } catch (e) {
      throw toDestinationError(e, this.o.root);
    }
  }

  async write(path: string, data: Uint8Array, mtime: number): Promise<"written" | "identical"> {
    // 内容相同时不打标记（例如每次同步都写一遍的插件配置），免得每次都扫描整个工作区
    if (await this.tree.matches(data, path).catch(() => false)) return "identical";
    await this.mark();
    return this.tree.write(path, data, mtime);
  }

  async move(from: string, to: string): Promise<boolean> {
    await this.mark();
    return this.tree.move(from, to);
  }

  async remove(path: string): Promise<void> {
    await this.mark();
    await this.tree.remove(path);
  }

  async finish(): Promise<FinishInfo | void> {
    if (!this.dirty) return;
    const dir = this.o.root;
    try {
      // ignored: true：工作区里的文件都按本插件的排除规则来，Vault 里自带的 .gitignore 不再起作用。
      // 这样 isomorphic-git 会连 .git 一起遍历，所以给它的 fs 在列根目录时去掉 .git
      const rows = await statusMatrix({
        fs: hideDotGit(this.gitFs, dir),
        dir,
        cache: this.cache,
        ignored: true,
        filter: (p) => !p.endsWith(TMP_SUFFIX),
      });
      // 每行为 [路径, HEAD, 工作区, 暂存区]；工作区 0 删除、1 与 HEAD 相同、2 有改动
      const toAdd = rows.filter(([, , w, s]) => w !== 0 && s !== w).map(([p]) => p);
      const toRemove = rows.filter(([, , w, s]) => w === 0 && s !== 0).map(([p]) => p);
      const changed = rows.some(([, h, w]) => !((h === 1 && w === 1) || (h === 0 && w === 0)));
      if (toAdd.length) await add({ fs: this.gitFs, dir, filepath: toAdd, cache: this.cache, force: true });
      for (const p of toRemove) await remove({ fs: this.gitFs, dir, filepath: p, cache: this.cache });

      let oid: string | undefined;
      if (changed) {
        const t = this.now();
        oid = await commit({
          fs: this.gitFs,
          dir,
          cache: this.cache,
          message: commitMessage(this.o.message, this.o.vaultName, t),
          author: { name: this.o.author.name, email: this.o.author.email, timestamp: Math.floor(t.getTime() / 1000) },
        });
      }
      await this.fs.removeFile(this.marker).catch(() => undefined);
      this.dirty = this.marked = false;
      return oid ? { commit: oid.slice(0, 7) } : undefined;
    } catch (e) {
      throw toDestinationError(e, dir);
    }
  }

  /** 第一次改动工作区前放标记文件 */
  private async mark(): Promise<void> {
    this.dirty = true;
    if (this.marked) return;
    await this.fs.writeFile(this.marker, new Uint8Array(0)).catch((e: unknown) => {
      throw toDestinationError(e, this.marker);
    });
    this.marked = true;
  }

  /** 工作区里各设备上传的插件配置 */
  listConfigs(): Promise<Uint8Array[]> {
    return this.tree.listConfigs();
  }

  /** 作为恢复来源：每个提交是一个时间点 */
  restoreSource(): RestoreSource {
    return gitRestoreSource({
      fs: this.gitFs,
      gitdir: this.gitdir,
      wrap: async (fn) => {
        try {
          return await fn();
        } catch (e) {
          throw toDestinationError(e, this.o.root);
        }
      },
      head: async () => {
        if (!(await this.fs.stat(this.gitdir))) return null;
        return resolveRef({ fs: this.gitFs, gitdir: this.gitdir, ref: "HEAD" }).catch(() => null);
      },
    });
  }

  /** 已有的提交数与最近一次提交的时间；还没有仓库或提交时为 0 */
  private async history(): Promise<{ count: number; newest?: number }> {
    if (!(await this.fs.stat(this.gitdir))) return { count: 0 };
    try {
      const commits = await log({ fs: this.gitFs, dir: this.o.root, depth: COUNT_LIMIT, cache: this.cache });
      const first = commits[0];
      return { count: commits.length, newest: first ? first.commit.author.timestamp * 1000 : undefined };
    } catch {
      return { count: 0 };
    }
  }
}

type Readdir = (path: string, ...rest: unknown[]) => Promise<string[]>;

/** 包一层 fs：列出仓库根目录时去掉 .git，其余操作原样转发 */
export function hideDotGit(client: PromiseFsClient, root: string): PromiseFsClient {
  const p = client.promises;
  const norm = (s: string) => s.split("\\").join("/").replace(/(\/\.)+$/, "").replace(/\/+$/, "");
  const top = norm(root);
  const readdir: Readdir = async (path, ...rest) => {
    const names = await (p.readdir as Readdir)(path, ...rest);
    return norm(path) === top ? names.filter((n) => n !== ".git") : names;
  };
  return { promises: { ...p, readdir } };
}
