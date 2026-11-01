import { describe, expect, it } from "vitest";
import { ExcludeMatcher } from "../../src/core/exclude";
import { sha256Hex } from "../../src/core/hash";
import { scanVault } from "../../src/core/scanner";
import { MemoryVault } from "../support/memory-vault";

const none = new ExcludeMatcher([]);

describe("sha256Hex", () => {
  it("与已知值一致", async () => {
    const data = new TextEncoder().encode("abc").buffer;
    expect(await sha256Hex(data)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("扫描 Vault", () => {
  it("列出全部文件并计算哈希，结果按路径排序", async () => {
    const v = new MemoryVault().set("b.md", "B").set("a.md", "A").set(".obsidian/app.json", "{}");
    const r = await scanVault(v, { matcher: none, maxFileSize: 1e6 });
    expect([...r.files.keys()]).toEqual([".obsidian/app.json", "a.md", "b.md"]);
    expect(r.files.get("a.md")?.hash).toBe(await sha256Hex(new TextEncoder().encode("A").buffer));
    expect(r.hashed).toBe(3);
  });

  it("大小和修改时间没变时沿用上次的哈希，不读文件", async () => {
    const v = new MemoryVault().set("a.md", "A", 1000).set("b.md", "B", 1000);
    const first = await scanVault(v, { matcher: none, maxFileSize: 1e6 });
    const previous = { version: 1 as const, updatedAt: 1, files: Object.fromEntries(first.files) };
    v.reads = [];
    v.set("b.md", "B2", 2000);
    const second = await scanVault(v, { matcher: none, maxFileSize: 1e6, previous });
    expect(v.reads).toEqual(["b.md"]);
    expect(second.hashed).toBe(1);
  });

  it("修改时间变了但内容没变，哈希相同", async () => {
    const v = new MemoryVault().set("a.md", "A", 1000);
    const first = await scanVault(v, { matcher: none, maxFileSize: 1e6 });
    v.set("a.md", "A", 5000);
    const previous = { version: 1 as const, updatedAt: 1, files: Object.fromEntries(first.files) };
    const second = await scanVault(v, { matcher: none, maxFileSize: 1e6, previous });
    expect(second.files.get("a.md")?.hash).toBe(first.files.get("a.md")?.hash);
    expect(second.files.get("a.md")?.mtime).toBe(5000);
  });

  it("超过大小上限的文件跳过并列出", async () => {
    const v = new MemoryVault().set("small.md", "x").set("big.mp4", "0123456789");
    const r = await scanVault(v, { matcher: none, maxFileSize: 5 });
    expect([...r.files.keys()]).toEqual(["small.md"]);
    expect(r.skipped).toEqual([{ path: "big.mp4", reason: "too-large", size: 10 }]);
    expect(v.reads).not.toContain("big.mp4");
  });

  it("被排除的文件夹不进入，文件不读取", async () => {
    const v = new MemoryVault().set("Notes/a.md", "A").set("Archive/2019/x.md", "X").set("Archive/y.md", "Y").set("c.tmp", "T");
    const r = await scanVault(v, { matcher: new ExcludeMatcher(["Archive/", "*.tmp"]), maxFileSize: 1e6 });
    expect([...r.files.keys()]).toEqual(["Notes/a.md"]);
    expect(v.visitedDirs).not.toContain("Archive");
    expect(v.visitedDirs).not.toContain("Archive/2019");
    expect(v.reads).toEqual(["Notes/a.md"]);
  });

  it("空 Vault", async () => {
    const r = await scanVault(new MemoryVault(), { matcher: none, maxFileSize: 1e6 });
    expect(r.files.size).toBe(0);
    expect(r.skipped).toEqual([]);
  });
});
