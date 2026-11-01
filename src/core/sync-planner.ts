// 主同步端的三方比较：本机现状、上次同步时的状态（base）、远程现状，得出这次要做的操作。纯函数。
//
// 本机用内容哈希（sha256）判断有没有变，远程用目的地自己的版本号（git 的对象号、镜像的大小与修改时间等）判断。
// base 同时记下两边的值，所以两边不用算同一种哈希。两边都有、又说不准内容是否相同的文件（没有 base，或两边都变了），
// 由调用方先比对内容，把相同的路径放进 same 传进来（compareCandidates 给出要比对的路径）。

export interface LocalFile {
  hash: string;
  size: number;
}

export interface RemoteFile {
  /** 目的地的版本号：内容变了它就变 */
  id: string;
  size?: number;
}

/** 上次同步成功时，这个文件在两边的状态（两边内容相同） */
export interface BaseEntry {
  hash: string;
  remoteId: string;
}

export type SyncOp =
  /** 本机新增或修改，远程没变：上传 */
  | { type: "upload"; path: string }
  /** 远程新增或修改，本机没变：下载（覆盖前本机旧版先进回收站） */
  | { type: "download"; path: string }
  /** 远程删了，本机没改：删除本机（进回收站） */
  | { type: "deleteLocal"; path: string }
  /** 本机删了，远程没改：删除远程 */
  | { type: "deleteRemote"; path: string }
  /** 两边都改了（或都新增了）且内容不同：远程版本另存为冲突副本，本机版本上传 */
  | { type: "conflict"; path: string }
  /** 本机改了，远程删了：保留本机并重新上传，提醒 */
  | { type: "keepLocal"; path: string }
  /** 远程改了，本机删了：从远程恢复，提醒 */
  | { type: "restoreRemote"; path: string }
  /** 两边内容相同：只记下状态 */
  | { type: "link"; path: string }
  /** 两边都删了：清掉记录 */
  | { type: "forget"; path: string }
  /** 要下载的文件和本机一个只差大小写的文件撞名：跳过并报告（大小写不敏感的系统上会互相覆盖） */
  | { type: "caseClash"; path: string; local: string };

export interface SyncPlan {
  ops: SyncOp[];
  unchanged: number;
}

type Files<T> = ReadonlyMap<string, T>;

/** 两边都有、需要比对内容才能决定的路径 */
export function compareCandidates(local: Files<LocalFile>, base: Files<BaseEntry>, remote: Files<RemoteFile>): string[] {
  const out: string[] = [];
  for (const [path, l] of local) {
    const r = remote.get(path);
    if (!r) continue;
    const b = base.get(path);
    if (!b || (l.hash !== b.hash && r.id !== b.remoteId)) out.push(path);
  }
  return out.sort(cmp);
}

/** 执行顺序：冲突副本 → 删除本机 → 下载 → 上传 → 删除远程。
 *  先删本机再下载：大小写不敏感的系统上 Note.md 改名为 note.md 时，先下载会被随后的删除连带删掉。
 *  远程的删除放最后：中途失败时远程不会先丢文件。 */
const ORDER: Record<SyncOp["type"], number> = {
  conflict: 0,
  deleteLocal: 1,
  download: 2,
  restoreRemote: 2,
  upload: 3,
  keepLocal: 3,
  link: 4,
  forget: 4,
  caseClash: 4,
  deleteRemote: 5,
};

export function planSync(local: Files<LocalFile>, base: Files<BaseEntry>, remote: Files<RemoteFile>, same: ReadonlySet<string>): SyncPlan {
  const ops: SyncOp[] = [];
  let unchanged = 0;
  const paths = new Set<string>([...local.keys(), ...base.keys(), ...remote.keys()]);

  for (const path of paths) {
    const l = local.get(path);
    const b = base.get(path);
    const r = remote.get(path);
    const lChanged = !!l && (!b || l.hash !== b.hash);
    const rChanged = !!r && (!b || r.id !== b.remoteId);

    if (l && r) {
      if (!b) ops.push({ type: same.has(path) ? "link" : "conflict", path });
      else if (!lChanged && !rChanged) unchanged++;
      else if (lChanged && !rChanged) ops.push({ type: "upload", path });
      else if (!lChanged && rChanged) ops.push({ type: "download", path });
      else ops.push({ type: same.has(path) ? "link" : "conflict", path });
    } else if (l && !r) {
      if (!b) ops.push({ type: "upload", path });
      else ops.push({ type: lChanged ? "keepLocal" : "deleteLocal", path });
    } else if (!l && r) {
      if (!b) ops.push({ type: "download", path });
      else ops.push({ type: rChanged ? "restoreRemote" : "deleteRemote", path });
    } else if (b) {
      ops.push({ type: "forget", path });
    }
  }

  // 大小写撞名：要写到本机的路径，和本机一个不会被删掉的文件只差大小写
  const deletingLocal = new Set(ops.filter((o) => o.type === "deleteLocal").map((o) => o.path.toLowerCase()));
  const localByLower = new Map<string, string>();
  for (const p of local.keys()) localByLower.set(p.toLowerCase(), p);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as SyncOp;
    if (op.type !== "download" && op.type !== "restoreRemote") continue;
    const twin = localByLower.get(op.path.toLowerCase());
    if (twin && twin !== op.path && !deletingLocal.has(twin.toLowerCase())) ops[i] = { type: "caseClash", path: op.path, local: twin };
  }

  ops.sort((a, b) => ORDER[a.type] - ORDER[b.type] || cmp(a.path, b.path));
  return { ops, unchanged };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
