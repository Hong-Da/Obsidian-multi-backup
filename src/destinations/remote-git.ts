// 远程 Git（GitHub / Gitee / 其他）：每次同步有变化时提交一次并推送。
//
// 本机只保存 git 对象（插件目录 repos/<目的地>/，裸仓库），不在本机再放一份 Vault 的文件：
// 以远程分支最新提交的文件树为底，按本次的写入、移动、删除改动文件树，直接写出提交再推送。
// 远程分支在这期间被别处推进时，重新拉取最新提交，把本次的改动重放到上面再推送一次。
//
// 推送失败时 finish 抛错，同步流程不保存这次的清单，下次同步会重新提交这些改动。
// 每次同步开始都会查询一次远程分支（没有变化时也要一次请求），以便连不上时整体报错。
//
// 性能（M6-1）：
// - 文件树缓存在本机仓库的 multi-backup-tree.json（按提交号）：远程分支没变时不拉取、不读树；
// - 提交时只重写改动过的目录对象，其余沿用；
// - 推送只打包本次新写的对象（见 git-push.ts），不让 isomorphic-git 遍历整棵树；
// - 新写入的内容累计到 CHECKPOINT_BYTES 就先提交推送一次，首次备份大 Vault 时内存里不会有整个数据包。

import {
  addRemote,
  fetch,
  getRemoteInfo,
  hashBlob,
  init,
  packObjects,
  readBlob,
  readCommit,
  readTree,
  writeBlob,
  writeCommit,
  writeRef,
  writeTree,
  type GitAuth,
  type HttpClient,
  type PromiseFsClient,
  type TreeEntry,
} from "isomorphic-git";
import { DestinationError } from "../core/errors";
import { commitMessage } from "../core/paths";
import type { RestoreSource } from "../core/restore";
import { gitRestoreSource } from "./git-restore";
import { basicAuth, sendPack, ZERO_OID } from "./git-push";
import {
  RESERVED_DIR,
  type FileStore,
  type FinishInfo,
  type PrimaryStore,
  type RemoteEntry,
  type TestInfo,
} from "./types";

export interface RemoteGitOptions {
  /** 本机裸仓库的位置（插件目录 repos/<目的地>） */
  gitdir: string;
  url: string;
  branch: string;
  /** 用户名；GitHub 可以留空 */
  username: string;
  token: string;
  vaultName: string;
  message: string;
  author: { name: string; email: string };
  now?: () => Date;
  /** 新写入多少字节就先推送一次（默认 CHECKPOINT_BYTES，测试时调小） */
  checkpointBytes?: number;
}

interface Entry {
  oid: string;
  mode: string;
}

type Op = { kind: "set"; path: string; entry: Entry } | { kind: "del"; path: string };

/** 新写入的内容累计到这么多就先提交推送一次 */
export const CHECKPOINT_BYTES = 32 * 1024 * 1024;
/** 文件树缓存（在本机裸仓库里） */
const TREE_CACHE = "multi-backup-tree.json";

/** isomorphic-git 的 fs 类型里方法是 Function，这里写明读写文本的签名 */
interface TextFs {
  readFile(path: string, o: { encoding: "utf8" }): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
}

interface TreeCache {
  v: 1;
  commit: string;
  files: [string, string, string][];
  dirs: [string, string][];
}

export class RemoteGit implements FileStore {
  readonly kind = "files" as const;
  private readonly now: () => Date;
  private readonly cache = {};
  /** 远程分支最新提交；空仓库或还没有这个分支时为 null */
  private base: string | null = null;
  /** 本次同步后的文件树（路径 → 对象），同步开始时从远程加载 */
  private files: Map<string, Entry> | null = null;
  private ops: Op[] = [];
  /** 目录（"" 为根）→ 与 files 一致的目录对象；dirty 中的目录提交时要重写 */
  private dirs = new Map<string, string>();
  private dirty = new Set<string>();
  /** 本次新写、远程还没有的对象 */
  private readonly newOids = new Set<string>();
  /** 上次推送后新写入的字节数 */
  private pending = 0;
  /** 本次同步推送过的最新提交 */
  private pushed: string | null = null;
  /** 作为主同步端：推送被拒时不重放，让这次同步失败、下次重新三方比较（避免覆盖别的设备刚推的修改） */
  private primary = false;

  constructor(
    private readonly fs: PromiseFsClient,
    private readonly http: HttpClient,
    private readonly o: RemoteGitOptions,
  ) {
    this.now = o.now ?? (() => new Date());
  }

  private get ref(): string {
    return `refs/heads/${this.o.branch}`;
  }

  private onAuth = (): GitAuth => ({ username: this.o.username || "x-access-token", password: this.o.token });
  /** 认证失败时不重试，直接报错 */
  private onAuthFailure = (): GitAuth => ({ cancel: true });

  async test(): Promise<TestInfo> {
    const heads = await this.remoteHeads(true);
    const names = Object.keys(heads);
    const remote = names.length === 0 ? "empty" : heads[this.o.branch] ? "branch" : "no-branch";
    return { freeBytes: null, existing: remote === "branch" ? 1 : 0, isRepo: remote !== "empty", remote };
  }

  async prepare(): Promise<void> {
    if (!this.o.url.trim()) throw new DestinationError("not-configured", "");
    if (!this.o.token) throw new DestinationError("no-token", this.host());
    await this.wrap(async () => {
      await init({ fs: this.fs, gitdir: this.o.gitdir, bare: true, defaultBranch: this.o.branch });
      // 拉取需要 origin 的配置；地址改过时覆盖
      await addRemote({ fs: this.fs, gitdir: this.o.gitdir, remote: "origin", url: this.o.url, force: true });
    });
    // 连不上、令牌不对时在这里整体失败，不逐个文件报错
    await this.load();
  }

  async write(path: string, data: Uint8Array): Promise<"written" | "identical"> {
    const files = await this.load();
    const old = files.get(path);
    const oid = await this.put(path, data);
    return old?.oid === oid ? "identical" : "written";
  }

  /** 写入并返回对象号（内容没变时不产生改动） */
  async put(path: string, data: Uint8Array): Promise<string> {
    const files = await this.load();
    const { oid } = await hashBlob({ object: data });
    const old = files.get(path);
    if (old?.oid === oid) return oid;
    await this.wrap(() => writeBlob({ fs: this.fs, gitdir: this.o.gitdir, blob: data }));
    this.newOids.add(oid);
    this.apply({ kind: "set", path, entry: { oid, mode: old?.mode ?? "100644" } });
    this.pending += data.byteLength;
    // 分批推送；这一批失败时不影响这个文件，finish 会把全部改动再推一次
    if (this.pending >= (this.o.checkpointBytes ?? CHECKPOINT_BYTES))
      await this.flush().catch(() => (this.pending = 0));
    return oid;
  }

  /** 远程分支现有的文件（不含 .multi-backup/）；prepare 之后可用 */
  async list(): Promise<Map<string, RemoteEntry>> {
    const files = await this.load();
    const out = new Map<string, RemoteEntry>();
    for (const [path, e] of files) if (!path.startsWith(RESERVED_DIR + "/")) out.set(path, { id: e.oid });
    return out;
  }

  /** 读取远程分支上的文件（对象在拉取或推送时已经在本机；本机仓库缺对象时重新拉取一次） */
  async read(path: string): Promise<Uint8Array> {
    const e = (await this.load()).get(path);
    if (!e) throw new DestinationError("not-found", path);
    return this.blob(e.oid);
  }

  private async blob(oid: string): Promise<Uint8Array> {
    return this.wrap(async () => {
      try {
        return (await readBlob({ fs: this.fs, gitdir: this.o.gitdir, oid, cache: this.cache })).blob;
      } catch (e) {
        if ((e as { code?: string }).code !== "NotFoundError" || !this.base) throw e;
        await this.fetchHead();
        return (await readBlob({ fs: this.fs, gitdir: this.o.gitdir, oid, cache: this.cache })).blob;
      }
    });
  }

  /** 本机内容与远程某个对象号是否相同（算 git 对象号比较，不用下载） */
  async matches(data: Uint8Array, id: string): Promise<boolean> {
    return (await hashBlob({ object: data })).oid === id;
  }

  /** 作为主同步端使用 */
  asPrimary(): PrimaryStore {
    this.primary = true;
    return {
      kind: "primary",
      test: () => this.test(),
      prepare: () => this.prepare(),
      list: () => this.list(),
      read: (path) => this.read(path),
      matches: (data, id) => this.matches(data, id),
      put: (path, data) => this.put(path, data),
      remove: (path) => this.remove(path),
      finish: () => this.finish(),
    };
  }

  async move(from: string, to: string): Promise<boolean> {
    const files = await this.load();
    const entry = files.get(from);
    if (!entry) return false;
    this.apply({ kind: "del", path: from });
    this.apply({ kind: "set", path: to, entry });
    return true;
  }

  async remove(path: string): Promise<void> {
    const files = await this.load();
    if (files.has(path)) this.apply({ kind: "del", path });
  }

  async finish(): Promise<FinishInfo | void> {
    await this.flush();
    if (this.pushed) return { commit: this.pushed.slice(0, 7) };
  }

  /** 提交并推送目前为止的改动 */
  private async flush(): Promise<void> {
    if (!this.ops.length || !this.files) return;
    await this.wrap(async () => {
      let oid = await this.commit();
      if (!(await this.push(oid))) {
        if (this.primary) throw new DestinationError("remote-moved", this.host());
        // 远程分支被别处推进了：以最新提交为底重放本次改动（load 里重放），再推一次
        this.files = null;
        await this.load();
        oid = await this.commit();
        if (!(await this.push(oid))) throw new DestinationError("io", this.host(), "push rejected twice");
      }
      this.base = oid;
      this.pushed = oid;
      this.ops = [];
      this.pending = 0;
      this.newOids.clear();
      await this.saveCache();
    });
  }

  private apply(op: Op): void {
    this.ops.push(op);
    if (this.files) this.applyTo(this.files, op);
  }

  private applyTo(files: Map<string, Entry>, op: Op): void {
    if (op.kind === "set") files.set(op.path, op.entry);
    else files.delete(op.path);
    // 文件所在的各层目录都要重写（上层已标记时更上层一定也标记了）
    for (let i = op.path.lastIndexOf("/"); ; i = op.path.lastIndexOf("/", i - 1)) {
      const d = i < 0 ? "" : op.path.slice(0, i);
      if (this.dirty.has(d)) break;
      this.dirty.add(d);
      if (i < 0) break;
    }
  }

  /** 读出远程分支最新提交的文件树：本机缓存的就是这个提交时直接用，否则（需要时拉取后）读树 */
  private async load(): Promise<Map<string, Entry>> {
    if (this.files) return this.files;
    const files = new Map<string, Entry>();
    const dirs = new Map<string, string>();
    await this.wrap(async () => {
      const heads = await this.remoteHeads(false);
      this.base = heads[this.o.branch] ?? null;
      if (!this.base) return;
      const cached = await this.readCache(this.base);
      if (cached) {
        for (const [p, oid, mode] of cached.files) files.set(p, { oid, mode });
        for (const [p, oid] of cached.dirs) dirs.set(p, oid);
        return;
      }
      let commit;
      try {
        commit = (await readCommit({ fs: this.fs, gitdir: this.o.gitdir, oid: this.base, cache: this.cache })).commit;
      } catch {
        await this.fetchHead();
        commit = (await readCommit({ fs: this.fs, gitdir: this.o.gitdir, oid: this.base, cache: this.cache })).commit;
      }
      await this.readTreeInto(files, dirs, commit.tree, "");
    });
    this.files = files;
    this.dirs = dirs;
    this.dirty = new Set();
    if (this.base) await this.saveCache();
    // 还没推送成功的改动（远程被推进后重新加载时）放到新的文件树上
    for (const op of this.ops) this.applyTo(files, op);
    return files;
  }

  /** 浅拉取远程分支最新提交 */
  private async fetchHead(): Promise<void> {
    await fetch({
      fs: this.fs,
      http: this.http,
      gitdir: this.o.gitdir,
      remote: "origin",
      ref: this.o.branch,
      singleBranch: true,
      depth: 1,
      tags: false,
      onAuth: this.onAuth,
      onAuthFailure: this.onAuthFailure,
      cache: this.cache,
    });
  }

  private async readTreeInto(
    files: Map<string, Entry>,
    dirs: Map<string, string>,
    treeOid: string,
    dir: string,
  ): Promise<void> {
    dirs.set(dir, treeOid);
    const { tree } = await readTree({ fs: this.fs, gitdir: this.o.gitdir, oid: treeOid, cache: this.cache });
    for (const e of tree) {
      const p = dir ? `${dir}/${e.path}` : e.path;
      if (e.type === "tree") await this.readTreeInto(files, dirs, e.oid, p);
      else if (e.type === "blob") files.set(p, { oid: e.oid, mode: e.mode });
    }
  }

  /** isomorphic-git 的 fs 类型里方法是 Function，这里写明读写文本的签名 */
  private textFs(): TextFs {
    return this.fs.promises as unknown as TextFs;
  }

  private get cacheFile(): string {
    return `${this.o.gitdir}/${TREE_CACHE}`;
  }

  private async readCache(commit: string): Promise<TreeCache | null> {
    try {
      const c = JSON.parse(await this.textFs().readFile(this.cacheFile, { encoding: "utf8" })) as TreeCache;
      return c?.v === 1 && c.commit === commit && Array.isArray(c.files) && Array.isArray(c.dirs) ? c : null;
    } catch {
      return null;
    }
  }

  /** 记下 base 提交的文件树；写不进去不影响同步（下次重新读树） */
  private async saveCache(): Promise<void> {
    if (!this.base || !this.files || this.dirty.size) return;
    const c: TreeCache = {
      v: 1,
      commit: this.base,
      files: [...this.files].map(([p, e]) => [p, e.oid, e.mode]),
      dirs: [...this.dirs],
    };
    await this.textFs()
      .writeFile(this.cacheFile, JSON.stringify(c))
      .catch(() => undefined);
  }

  /** 按当前文件树写出改动过的目录对象和提交，并更新本机分支 */
  private async commit(): Promise<string> {
    const dirs = new Map<string, string>();
    const tree = await this.writeDir(buildDirs(this.files ?? new Map<string, Entry>()), "", dirs);
    this.dirs = dirs;
    this.dirty = new Set();
    const t = this.now();
    const who = {
      name: this.o.author.name,
      email: this.o.author.email,
      timestamp: Math.floor(t.getTime() / 1000),
      timezoneOffset: t.getTimezoneOffset(),
    };
    const oid = await writeCommit({
      fs: this.fs,
      gitdir: this.o.gitdir,
      commit: {
        message: commitMessage(this.o.message, this.o.vaultName, t) + "\n",
        tree,
        parent: this.base ? [this.base] : [],
        author: who,
        committer: who,
      },
    });
    this.newOids.add(oid);
    await writeRef({ fs: this.fs, gitdir: this.o.gitdir, ref: this.ref, value: oid, force: true });
    return oid;
  }

  /** 没改动的目录沿用原来的对象，只重写 dirty 中的目录；out 收集提交后各目录的对象 */
  private async writeDir(dir: Dir, path: string, out: Map<string, string>): Promise<string> {
    const entries: TreeEntry[] = [];
    for (const [name, child] of dir.dirs)
      entries.push({
        mode: "040000",
        path: name,
        type: "tree",
        oid: await this.writeDir(child, path ? `${path}/${name}` : name, out),
      });
    let oid = this.dirty.has(path) ? undefined : this.dirs.get(path);
    if (!oid) {
      for (const [name, e] of dir.files) entries.push({ mode: e.mode, path: name, type: "blob", oid: e.oid });
      oid = await writeTree({ fs: this.fs, gitdir: this.o.gitdir, tree: entries });
      this.newOids.add(oid);
    }
    out.set(path, oid);
    return oid;
  }

  /** 推送新提交；远程分支已被别处推进时返回 false */
  private async push(oid: string): Promise<boolean> {
    const { packfile } = await packObjects({
      fs: this.fs,
      gitdir: this.o.gitdir,
      oids: [...this.newOids],
      cache: this.cache,
    });
    const r = await sendPack({
      http: this.http,
      url: this.o.url,
      auth: basicAuth(this.o.username || "x-access-token", this.o.token),
      ref: this.ref,
      oldOid: this.base ?? ZERO_OID,
      newOid: oid,
      packfile: packfile ?? new Uint8Array(0),
    });
    if (r.ok) return true;
    if ("status" in r) throw toRemoteError({ message: r.reason, data: { statusCode: r.status } }, this.host());
    // 被拒：远程分支已经不是推送前的那个提交，说明别处推送过
    const now = (await this.remoteHeads(true))[this.o.branch] ?? null;
    if (now !== this.base) return false;
    throw new DestinationError("push-rejected", this.host(), r.reason);
  }

  /** 远程的分支列表（分支名 → 提交） */
  private async remoteHeads(forPush: boolean): Promise<Record<string, string>> {
    return this.wrap(async () => {
      const info = await getRemoteInfo({
        http: this.http,
        url: this.o.url,
        onAuth: this.onAuth,
        onAuthFailure: this.onAuthFailure,
        forPush,
      });
      const heads = (info.refs as { heads?: Record<string, string> } | undefined)?.heads ?? {};
      return heads;
    });
  }

  private host(): string {
    try {
      return new URL(this.o.url).host;
    } catch {
      return this.o.url;
    }
  }

  /** 远程最新提交里各设备上传的插件配置 */
  async listConfigs(): Promise<Uint8Array[]> {
    await this.prepare();
    const prefix = RESERVED_DIR + "/config/";
    const out: Uint8Array[] = [];
    for (const [path, e] of await this.load()) {
      if (path.startsWith(prefix) && path.endsWith(".json")) out.push(await this.blob(e.oid));
    }
    return out;
  }

  /** 作为恢复来源：同步用的是只取最新提交的浅克隆，查看更早的提交时按需加深 */
  restoreSource(): RestoreSource {
    let ready: Promise<void> | null = null;
    return gitRestoreSource({
      fs: this.fs,
      gitdir: this.o.gitdir,
      wrap: (fn) => this.wrap(fn),
      head: async () => {
        ready ??= this.prepare();
        await ready;
        return this.base;
      },
      ensureDepth: async (n) => {
        ready ??= this.prepare();
        await ready;
        if (!this.base || n <= 1) return;
        await fetch({
          fs: this.fs,
          http: this.http,
          gitdir: this.o.gitdir,
          remote: "origin",
          ref: this.o.branch,
          singleBranch: true,
          depth: n,
          tags: false,
          onAuth: this.onAuth,
          onAuthFailure: this.onAuthFailure,
          cache: this.cache,
        });
      },
    });
  }

  /** 把 isomorphic-git 与网络错误转成目的地错误 */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toRemoteError(e, this.host());
    }
  }
}

export function toRemoteError(e: unknown, host: string): DestinationError {
  if (e instanceof DestinationError) return e;
  const err = e as { code?: string; message?: string; data?: { statusCode?: number } };
  const msg = err?.message ?? String(e);
  if (err?.code === "UserCanceledError") return new DestinationError("auth-failed", host, msg);
  const status = err?.data?.statusCode;
  if (status === 401) return new DestinationError("auth-failed", host, msg);
  if (status === 403) return new DestinationError("no-permission", host, msg);
  if (status === 404) return new DestinationError("repo-not-found", host, msg);
  if (err?.code && ["ENETWORK", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(err.code))
    return new DestinationError("network", host, msg);
  return new DestinationError("io", host, msg);
}

interface Dir {
  dirs: Map<string, Dir>;
  files: Map<string, Entry>;
}

/** 把“路径 → 对象”的平铺列表整理成目录层级 */
function buildDirs(files: Map<string, Entry>): Dir {
  const root: Dir = { dirs: new Map(), files: new Map() };
  for (const [path, e] of files) {
    const parts = path.split("/");
    let d = root;
    for (const part of parts.slice(0, -1)) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = { dirs: new Map(), files: new Map() }));
      d = next;
    }
    d.files.set(parts[parts.length - 1] as string, e);
  }
  return root;
}
