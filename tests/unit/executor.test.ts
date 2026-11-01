import { describe, expect, it } from "vitest";
import { DestinationError } from "../../src/core/errors";
import { executeFilePlan } from "../../src/core/executor";
import { emptyManifest, type FileEntry, type Manifest } from "../../src/core/manifest";
import { planBackup } from "../../src/core/planner";
import type { FileStore } from "../../src/destinations/types";
import { MemoryVault } from "../support/memory-vault";

/** 内存中的文件存储；failOn 中的路径写入时报错 */
class FakeStore implements FileStore {
  readonly kind = "files" as const;
  files = new Map<string, string>();
  failOn = new Set<string>();
  removed: string[] = [];
  async test() {
    return { freeBytes: null, existing: this.files.size };
  }
  async prepare() {}
  async write(path: string, data: Uint8Array) {
    if (this.failOn.has(path)) throw new DestinationError("in-use", path);
    const text = new TextDecoder().decode(data);
    if (this.files.get(path) === text) return "identical" as const;
    this.files.set(path, text);
    return "written" as const;
  }
  async move(from: string, to: string) {
    const v = this.files.get(from);
    if (v === undefined) return false;
    this.files.delete(from);
    this.files.set(to, v);
    return true;
  }
  async remove(path: string) {
    this.files.delete(path);
    this.removed.push(path);
  }
  async finish() {}
}

const e = (hash: string, size = 1): FileEntry => ({ size, mtime: 1, hash });

async function run(vault: MemoryVault, store: FakeStore, current: Map<string, FileEntry>, previous: Manifest, signal?: AbortSignal) {
  return executeFilePlan({ vault, store, plan: planBackup(current, previous), current, previous, now: 50, signal });
}

describe("执行备份计划", () => {
  it("上传、移动、删除，清单与目标一致", async () => {
    const vault = new MemoryVault().set("new.md", "N").set("moved/m.md", "M");
    const store = new FakeStore();
    store.files.set("m.md", "M").set("gone.md", "G");
    const previous: Manifest = { version: 1, updatedAt: 1, files: { "m.md": e("hm"), "gone.md": e("hg") } };
    const current = new Map([["new.md", e("hn")], ["moved/m.md", e("hm")]]);
    const r = await run(vault, store, current, previous);
    expect([r.uploaded, r.moved, r.deleted, r.failed.length]).toEqual([1, 1, 1, 0]);
    expect([...store.files.keys()].sort()).toEqual(["moved/m.md", "new.md"]);
    expect(Object.keys(r.manifest.files).sort()).toEqual(["moved/m.md", "new.md"]);
    expect(r.manifest.updatedAt).toBe(50);
  });

  it("目标里已有相同内容：计为 identical，不重复写", async () => {
    const vault = new MemoryVault().set("a.md", "A");
    const store = new FakeStore();
    store.files.set("a.md", "A");
    const r = await run(vault, store, new Map([["a.md", e("ha")]]), emptyManifest());
    expect([r.uploaded, r.identical]).toEqual([0, 1]);
  });

  it("单个文件失败：其他照常完成，失败的不记入清单，下次重试", async () => {
    const vault = new MemoryVault().set("a.md", "A").set("b.md", "B");
    const store = new FakeStore();
    store.failOn.add("a.md");
    const current = new Map([["a.md", e("ha")], ["b.md", e("hb")]]);
    const r = await run(vault, store, current, emptyManifest());
    expect(r.failed.map((f) => [f.path, f.op, f.error.code])).toEqual([["a.md", "upload", "in-use"]]);
    expect(Object.keys(r.manifest.files)).toEqual(["b.md"]);

    store.failOn.clear();
    const again = await run(vault, store, current, r.manifest);
    expect(again.uploaded).toBe(1);
    expect(Object.keys(again.manifest.files).sort()).toEqual(["a.md", "b.md"]);
  });

  it("移动时目标里的旧文件已被手动删除：改为上传", async () => {
    const vault = new MemoryVault().set("new.md", "X");
    const store = new FakeStore();
    const previous: Manifest = { version: 1, updatedAt: 1, files: { "old.md": e("hx") } };
    const r = await run(vault, store, new Map([["new.md", e("hx")]]), previous);
    expect([r.moved, r.uploaded]).toEqual([0, 1]);
    expect(store.files.get("new.md")).toBe("X");
    expect(Object.keys(r.manifest.files)).toEqual(["new.md"]);
  });

  it("中断：停在当前位置，已完成的记入清单", async () => {
    const vault = new MemoryVault().set("a.md", "A").set("b.md", "B");
    const ctrl = new AbortController();
    const store = new FakeStore();
    const orig = store.write.bind(store);
    store.write = async (p, d) => {
      const res = await orig(p, d);
      ctrl.abort();
      return res;
    };
    const r = await run(vault, store, new Map([["a.md", e("ha")], ["b.md", e("hb")]]), emptyManifest(), ctrl.signal);
    expect(r.aborted).toBe(true);
    expect(Object.keys(r.manifest.files)).toEqual(["a.md"]);
  });

  it("内容没变、只是修改时间变了：清单更新修改时间", async () => {
    const vault = new MemoryVault();
    const previous: Manifest = { version: 1, updatedAt: 1, files: { "a.md": { size: 1, mtime: 1, hash: "h" } } };
    const r = await run(vault, new FakeStore(), new Map([["a.md", { size: 1, mtime: 9, hash: "h" }]]), previous);
    expect(r.manifest.files["a.md"]?.mtime).toBe(9);
  });

  it("目的地允许并发时同时上传，但移动在前、删除在所有上传之后", async () => {
    const vault = new MemoryVault();
    const current = new Map<string, FileEntry>();
    for (let i = 0; i < 10; i++) {
      vault.set(`f${i}.md`, `F${i}`);
      current.set(`f${i}.md`, e(`h${i}`));
    }
    vault.set("moved.md", "M");
    current.set("moved.md", e("hm"));
    const previous: Manifest = { version: 1, updatedAt: 1, files: { "old.md": e("hm"), "gone.md": e("hg") } };
    const log: string[] = [];
    let active = 0;
    let peak = 0;
    class Slow extends FakeStore {
      readonly parallel = 3;
      override async write(path: string, data: Uint8Array) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        log.push("up");
        return super.write(path, data);
      }
      override async move(from: string, to: string) {
        log.push("move");
        return super.move(from, to);
      }
      override async remove(path: string) {
        log.push("del");
        return super.remove(path);
      }
    }
    const store = new Slow();
    store.files.set("old.md", "M").set("gone.md", "G");
    const r = await run(vault, store, current, previous);
    expect(r).toMatchObject({ uploaded: 10, moved: 1, deleted: 1, failed: [] });
    expect(peak).toBe(3);
    expect(log[0]).toBe("move");
    expect(log[log.length - 1]).toBe("del");
    expect(Object.keys(r.manifest.files).sort()).toEqual([...current.keys()].sort());
  });
});
