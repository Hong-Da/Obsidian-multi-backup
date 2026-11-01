// git 类目的地作为恢复来源：每个提交是一个时间点，从提交的文件树里读出文件。本地 git 与远程 Git 共用。
import { log, readBlob, readCommit, readTree, type PromiseFsClient } from "isomorphic-git";
import type { FileVersion, RestorePoint, RestoreSource } from "../core/restore";
import { RESERVED_DIR } from "./types";

export interface GitRestoreOptions {
  fs: PromiseFsClient;
  gitdir: string;
  /** 当前分支最新提交；还没有提交时为 null */
  head(): Promise<string | null>;
  /** 远程 Git：确保本机至少有最近 n 个提交（浅克隆按需加深） */
  ensureDepth?(n: number): Promise<void>;
  /** 把 isomorphic-git 的错误转成 DestinationError */
  wrap<T>(fn: () => Promise<T>): Promise<T>;
}

interface Blob {
  oid: string;
}

export function gitRestoreSource(o: GitRestoreOptions): RestoreSource {
  const cache = {};
  const trees = new Map<string, Map<string, Blob>>();
  let depth = 0;

  const commits = (limit: number) =>
    o.wrap(async () => {
      if (o.ensureDepth && limit > depth) {
        await o.ensureDepth(limit);
        depth = limit;
      }
      const head = await o.head();
      if (!head) return [];
      return log({ fs: o.fs, gitdir: o.gitdir, ref: head, depth: limit, cache });
    });

  const walk = async (treeOid: string, prefix: string, out: Map<string, Blob>): Promise<void> => {
    const { tree } = await readTree({ fs: o.fs, gitdir: o.gitdir, oid: treeOid, cache });
    for (const e of tree) {
      if (!prefix && e.path === RESERVED_DIR) continue;
      const p = prefix + e.path;
      if (e.type === "tree") await walk(e.oid, p + "/", out);
      else if (e.type === "blob") out.set(p, { oid: e.oid });
    }
  };

  const filesAt = (commitOid: string) =>
    o.wrap(async () => {
      const hit = trees.get(commitOid);
      if (hit) return hit;
      const { commit } = await readCommit({ fs: o.fs, gitdir: o.gitdir, oid: commitOid, cache });
      const out = new Map<string, Blob>();
      await walk(commit.tree, "", out);
      // 只缓存最近用到的一个提交，整个 Vault 的文件树可能很大
      trees.clear();
      trees.set(commitOid, out);
      return out;
    });

  /** 某个提交里这个路径的对象号（逐层读目录，不读整棵树） */
  const blobAt = async (treeOid: string, path: string): Promise<string | null> => {
    let oid = treeOid;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const { tree } = await readTree({ fs: o.fs, gitdir: o.gitdir, oid, cache });
      const e = tree.find((x) => x.path === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e.type === "blob" ? e.oid : null;
      if (e.type !== "tree") return null;
      oid = e.oid;
    }
    return null;
  };

  return {
    mode: "commits",
    async points(limit): Promise<RestorePoint[]> {
      return (await commits(limit)).map((c) => ({
        id: c.oid,
        time: c.commit.author.timestamp * 1000,
        title: c.commit.message.split("\n")[0] ?? "",
        short: c.oid.slice(0, 7),
      }));
    },
    async files(pointId) {
      return new Map([...(await filesAt(pointId)).keys()].map((p) => [p, {}]));
    },
    async read(pointId, path) {
      const e = (await filesAt(pointId)).get(path);
      if (!e) throw new Error(`${path} not in ${pointId}`);
      return o.wrap(async () => (await readBlob({ fs: o.fs, gitdir: o.gitdir, oid: e.oid, cache })).blob);
    },
    /** 内容发生变化的那些提交，就是这个文件的各个版本 */
    async fileVersions(path, limit): Promise<FileVersion[]> {
      const list = await commits(Math.max(limit * 5, 50));
      const oids = await o.wrap(() => Promise.all(list.map((c) => blobAt(c.commit.tree, path))));
      const out: FileVersion[] = [];
      for (let i = 0; i < list.length && out.length < limit; i++) {
        const c = list[i];
        if (!c || !oids[i] || oids[i] === oids[i + 1]) continue;
        out.push({ pointId: c.oid, time: c.commit.author.timestamp * 1000, title: c.commit.message.split("\n")[0] ?? "", short: c.oid.slice(0, 7) });
      }
      return out;
    },
  };
}
