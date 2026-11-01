import { describe, expect, it } from "vitest";
import { compareCandidates, planSync, type BaseEntry, type LocalFile, type RemoteFile, type SyncOp } from "../../src/core/sync-planner";

// 简写：本机文件用内容名作哈希，远程用版本号；base 记两边
const L = (o: Record<string, string>) => new Map<string, LocalFile>(Object.entries(o).map(([p, h]) => [p, { hash: h, size: 1 }]));
const R = (o: Record<string, string>) => new Map<string, RemoteFile>(Object.entries(o).map(([p, id]) => [p, { id }]));
const B = (o: Record<string, [string, string]>) => new Map<string, BaseEntry>(Object.entries(o).map(([p, [hash, remoteId]]) => [p, { hash, remoteId }]));
const types = (ops: SyncOp[]) => ops.map((o) => `${o.type} ${o.path}`);

describe("三方比较：单个文件的每种情况", () => {
  it.each([
    // 说明, 本机, 上次, 远程, same, 期望
    ["本机新增", { a: "h1" }, {}, {}, [], ["upload a"]],
    ["远程新增", {}, {}, { a: "r1" }, [], ["download a"]],
    ["两边都新增，内容相同", { a: "h1" }, {}, { a: "r1" }, ["a"], ["link a"]],
    ["两边都新增，内容不同", { a: "h1" }, {}, { a: "r1" }, [], ["conflict a"]],
    ["都没变", { a: "h1" }, { a: ["h1", "r1"] }, { a: "r1" }, [], []],
    ["本机改了", { a: "h2" }, { a: ["h1", "r1"] }, { a: "r1" }, [], ["upload a"]],
    ["远程改了", { a: "h1" }, { a: ["h1", "r1"] }, { a: "r2" }, [], ["download a"]],
    ["两边都改了，内容不同", { a: "h2" }, { a: ["h1", "r1"] }, { a: "r2" }, [], ["conflict a"]],
    ["两边都改成了一样的内容", { a: "h2" }, { a: ["h1", "r1"] }, { a: "r2" }, ["a"], ["link a"]],
    ["远程删了，本机没改", { a: "h1" }, { a: ["h1", "r1"] }, {}, [], ["deleteLocal a"]],
    ["远程删了，本机改了", { a: "h2" }, { a: ["h1", "r1"] }, {}, [], ["keepLocal a"]],
    ["本机删了，远程没改", {}, { a: ["h1", "r1"] }, { a: "r1" }, [], ["deleteRemote a"]],
    ["本机删了，远程改了", {}, { a: ["h1", "r1"] }, { a: "r2" }, [], ["restoreRemote a"]],
    ["两边都删了", {}, { a: ["h1", "r1"] }, {}, [], ["forget a"]],
  ] as [string, Record<string, string>, Record<string, [string, string]>, Record<string, string>, string[], string[]][])(
    "%s",
    (_name, local, base, remote, same, want) => {
      const plan = planSync(L(local), B(base), R(remote), new Set(same));
      expect(types(plan.ops)).toEqual(want);
    },
  );

  it("都没变的文件计入 unchanged", () => {
    const plan = planSync(L({ a: "h1", b: "h2" }), B({ a: ["h1", "r1"], b: ["h2", "r2"] }), R({ a: "r1", b: "r2" }), new Set());
    expect(plan).toEqual({ ops: [], unchanged: 2 });
  });
});

describe("需要比对内容的路径", () => {
  it("只列出两边都有、且没有 base 或两边都变了的", () => {
    const local = L({ new: "h", both: "h2", localOnly: "h1", same: "h1", remoteChanged: "h1" });
    const base = B({ both: ["h1", "r1"], same: ["h1", "r1"], remoteChanged: ["h1", "r1"] });
    const remote = R({ new: "r", both: "r2", same: "r1", remoteChanged: "r2", remoteOnly: "r" });
    expect(compareCandidates(local, base, remote)).toEqual(["both", "new"]);
  });
});

describe("执行顺序", () => {
  it("冲突 → 删除本机 → 下载 → 上传 → 删除远程", () => {
    const local = L({ c: "h2", up: "h2", delR: "h1", keep: "h2" });
    const base = B({ c: ["h1", "r1"], up: ["h1", "r1"], delL: ["h1", "r1"], delR: ["h1", "r1"], down: ["h1", "r1"], keep: ["h1", "r1"] });
    const local2 = new Map(local);
    local2.set("delL", { hash: "h1", size: 1 });
    local2.set("down", { hash: "h1", size: 1 });
    local2.delete("delR");
    const remote = R({ c: "r2", up: "r1", delR: "r1", down: "r2" });
    const plan = planSync(local2, base, remote, new Set());
    expect(types(plan.ops)).toEqual(["conflict c", "deleteLocal delL", "download down", "keepLocal keep", "upload up", "deleteRemote delR"]);
  });
});

describe("大小写", () => {
  it("别的设备把 Note.md 改名为 note.md：先删本机旧名再下载新名，不会把文件删掉", () => {
    const plan = planSync(L({ "Note.md": "h1" }), B({ "Note.md": ["h1", "r1"] }), R({ "note.md": "r1" }), new Set());
    expect(types(plan.ops)).toEqual(["deleteLocal Note.md", "download note.md"]);
  });

  it("两边各新增了只差大小写的文件：下载跳过并报告，本机的照常上传", () => {
    const plan = planSync(L({ "A.md": "h1" }), B({}), R({ "a.md": "r1" }), new Set());
    expect(plan.ops).toEqual([
      { type: "upload", path: "A.md" },
      { type: "caseClash", path: "a.md", local: "A.md" },
    ]);
  });
});

describe("综合：两台设备交替修改", () => {
  it("一次同步里多种情况同时出现", () => {
    const local = L({ "keep.md": "k", "edit.md": "e2", "new-here.md": "n", "conflict.md": "c2", "same.md": "s2" });
    const base = B({ "keep.md": ["k", "rk"], "edit.md": ["e1", "re"], "conflict.md": ["c1", "rc"], "same.md": ["s1", "rs"], "gone-there.md": ["g", "rg"], "gone-here.md": ["x", "rx"] });
    const remote = R({ "keep.md": "rk", "edit.md": "re", "conflict.md": "rc2", "same.md": "rs2", "gone-here.md": "rx", "new-there.md": "rn" });
    // 本机还有 gone-there.md（远程删了，本机没改）
    const local2 = new Map(local);
    local2.set("gone-there.md", { hash: "g", size: 1 });
    const same = new Set(compareCandidates(local2, base, remote).filter((p) => p === "same.md"));
    const plan = planSync(local2, base, remote, same);
    expect(types(plan.ops)).toEqual([
      "conflict conflict.md",
      "deleteLocal gone-there.md",
      "download new-there.md",
      "upload edit.md",
      "upload new-here.md",
      "link same.md",
      "deleteRemote gone-here.md",
    ]);
    expect(plan.unchanged).toBe(1);
  });
});
