import { describe, expect, it } from "vitest";
import { emptyManifest, type FileEntry, type Manifest } from "../../src/core/manifest";
import { manifestAfter, planBackup } from "../../src/core/planner";

// 用简短写法描述文件：{ 路径: "哈希" } 或 { 路径: ["哈希", 大小] }
type Spec = Record<string, string | [string, number]>;
const entry = (v: string | [string, number], mtime = 1): FileEntry =>
  typeof v === "string" ? { size: 10, mtime, hash: v } : { size: v[1], mtime, hash: v[0] };
const cur = (s: Spec, mtime = 1) => new Map(Object.entries(s).map(([p, v]) => [p, entry(v, mtime)]));
const man = (s: Spec): Manifest => ({ version: 1, updatedAt: 1, files: Object.fromEntries(Object.entries(s).map(([p, v]) => [p, entry(v)])) });

describe("备份计划", () => {
  it("首次同步：全部上传", () => {
    const p = planBackup(cur({ "b.md": "h2", "a.md": "h1" }), emptyManifest());
    expect(p.ops).toEqual([
      { type: "upload", path: "a.md", reason: "new" },
      { type: "upload", path: "b.md", reason: "new" },
    ]);
    expect(p.unchanged).toBe(0);
  });

  it("没有变化：没有操作", () => {
    const p = planBackup(cur({ "a.md": "h1" }), man({ "a.md": "h1" }));
    expect(p.ops).toEqual([]);
    expect(p.unchanged).toBe(1);
  });

  it("只是修改时间变了：不上传", () => {
    const p = planBackup(cur({ "a.md": "h1" }, 999), man({ "a.md": "h1" }));
    expect(p.ops).toEqual([]);
  });

  it("内容变了：上传", () => {
    const p = planBackup(cur({ "a.md": "h1b" }), man({ "a.md": "h1" }));
    expect(p.ops).toEqual([{ type: "upload", path: "a.md", reason: "changed" }]);
  });

  it("本地删除：删除", () => {
    const p = planBackup(cur({ "a.md": "h1" }), man({ "a.md": "h1", "gone.md": "h9" }));
    expect(p.ops).toEqual([{ type: "delete", path: "gone.md" }]);
  });

  it("重命名（内容不变）：移动，不重新上传", () => {
    const p = planBackup(cur({ "Notes/new.md": "h1" }), man({ "old.md": "h1" }));
    expect(p.ops).toEqual([{ type: "move", from: "old.md", to: "Notes/new.md" }]);
  });

  it("只改大小写：也是移动", () => {
    const p = planBackup(cur({ "Readme.md": "h1" }), man({ "readme.md": "h1" }));
    expect(p.ops).toEqual([{ type: "move", from: "readme.md", to: "Readme.md" }]);
  });

  it("重命名同时修改了内容：删除旧的、上传新的", () => {
    const p = planBackup(cur({ "new.md": "h2" }), man({ "old.md": "h1" }));
    expect(p.ops).toEqual([
      { type: "upload", path: "new.md", reason: "new" },
      { type: "delete", path: "old.md" },
    ]);
  });

  it("多个文件内容相同：按路径排序一一配对，多出来的上传", () => {
    const p = planBackup(cur({ "x/1.md": "same", "x/2.md": "same", "x/3.md": "same" }), man({ "a.md": "same", "b.md": "same" }));
    expect(p.ops).toEqual([
      { type: "move", from: "a.md", to: "x/1.md" },
      { type: "move", from: "b.md", to: "x/2.md" },
      { type: "upload", path: "x/3.md", reason: "new" },
    ]);
  });

  it("复制了一份（旧文件还在）：上传新文件，不移动", () => {
    const p = planBackup(cur({ "a.md": "h1", "copy.md": "h1" }), man({ "a.md": "h1" }));
    expect(p.ops).toEqual([{ type: "upload", path: "copy.md", reason: "new" }]);
  });

  it("空文件不按内容配对", () => {
    const p = planBackup(cur({ "new-empty.md": ["e", 0] }), man({ "old-empty.md": ["e", 0] }));
    expect(p.ops).toEqual([
      { type: "upload", path: "new-empty.md", reason: "new" },
      { type: "delete", path: "old-empty.md" },
    ]);
  });

  it("综合：顺序为 移动 → 上传 → 删除", () => {
    const p = planBackup(
      cur({ "keep.md": "k", "edit.md": "e2", "moved/m.md": "m", "added.md": "n" }),
      man({ "keep.md": "k", "edit.md": "e1", "m.md": "m", "removed.md": "r" }),
    );
    expect(p.ops.map((o) => o.type)).toEqual(["move", "upload", "upload", "delete"]);
    expect(p.ops).toContainEqual({ type: "upload", path: "added.md", reason: "new" });
    expect(p.ops).toContainEqual({ type: "upload", path: "edit.md", reason: "changed" });
    expect(p.unchanged).toBe(1);
  });

  it("Vault 被清空：全部删除（是否真的删除由目的地按设置决定）", () => {
    const p = planBackup(new Map(), man({ "a.md": "h1", "b.md": "h2" }));
    expect(p.ops).toEqual([
      { type: "delete", path: "a.md" },
      { type: "delete", path: "b.md" },
    ]);
  });
});

describe("同步后的清单", () => {
  it("以本次扫描结果为准", () => {
    const c = cur({ "a.md": "h1" }, 42);
    expect(manifestAfter(c, 99)).toEqual({ version: 1, updatedAt: 99, files: { "a.md": { size: 10, mtime: 42, hash: "h1" } } });
  });
});
