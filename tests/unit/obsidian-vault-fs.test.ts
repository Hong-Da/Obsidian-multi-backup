import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { ObsidianVaultFs } from "../../src/platform/obsidian-vault-fs";

// 模拟 DataAdapter 的 list / stat：根目录用 "/"，返回的路径可能带前导 /
function fakeAdapter(tree: Record<string, number>): DataAdapter {
  const listCalls: string[] = [];
  const adapter = {
    listCalls,
    async list(folder: string) {
      listCalls.push(folder);
      const prefix = folder === "/" ? "" : folder + "/";
      const files = new Set<string>();
      const folders = new Set<string>();
      for (const p of Object.keys(tree)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const i = rest.indexOf("/");
        if (i < 0) files.add(prefix + rest);
        else folders.add(prefix + rest.slice(0, i));
      }
      const lead = folder === "/" ? "/" : "";
      return { files: [...files].map((f) => lead + f), folders: [...folders].map((f) => lead + f) };
    },
    async stat(path: string) {
      const size = tree[path];
      return size === undefined ? null : { type: "file", ctime: 1, mtime: 2, size };
    },
  };
  return adapter as unknown as DataAdapter;
}

describe("ObsidianVaultFs", () => {
  it("递归列出文件，包括 .obsidian，路径去掉前导 /", async () => {
    const fs = new ObsidianVaultFs(fakeAdapter({ "a.md": 1, ".obsidian/app.json": 2, "Notes/sub/b.md": 3 }));
    const files = await fs.listFiles(() => true);
    expect(files.map((f) => f.path).sort()).toEqual([".obsidian/app.json", "Notes/sub/b.md", "a.md"]);
    expect(files.find((f) => f.path === "Notes/sub/b.md")).toEqual({ path: "Notes/sub/b.md", size: 3, mtime: 2 });
  });

  it("descend 返回 false 的文件夹不进入", async () => {
    const adapter = fakeAdapter({ "a.md": 1, "Archive/x.md": 2, "Archive/deep/y.md": 3 });
    const files = await new ObsidianVaultFs(adapter).listFiles((d) => d !== "Archive");
    expect(files.map((f) => f.path)).toEqual(["a.md"]);
    expect((adapter as unknown as { listCalls: string[] }).listCalls).toEqual(["/"]);
  });
});
