import { describe, expect, it } from "vitest";
import { adapterGitFs } from "../../src/platform/adapter-git-fs";
import { MemoryAdapter } from "../support/memory-adapter";

type Fs = {
  writeFile(p: string, d: Uint8Array | string): Promise<void>;
  readFile(p: string, o?: unknown): Promise<Uint8Array | string>;
  stat(p: string): Promise<{ size: number }>;
};

function setup() {
  const mem = new MemoryAdapter();
  mem.dirs.add("repo");
  mem.dirs.add("repo/objects");
  mem.dirs.add("repo/objects/ab");
  const fs = adapterGitFs(mem.asAdapter()).promises as unknown as Fs;
  return { mem, fs };
}

const OBJ = "repo/objects/ab/" + "c".repeat(38);
const bytes = (n: number) => new Uint8Array(n).fill(7);

describe("DataAdapter 文件系统（M2-1 在 Android 上发现的问题）", () => {
  it("写出空文件时自动重写，最终内容正确", async () => {
    const { mem, fs } = setup();
    let first = true;
    mem.dropWrite = () => {
      const drop = first;
      first = false;
      return drop;
    };
    await fs.writeFile(OBJ, bytes(100));
    expect(mem.files.get(OBJ)?.byteLength).toBe(100);
    expect(mem.writes).toBe(2);
  });

  it("一直写不进去时报错，不假装成功", async () => {
    const { mem, fs } = setup();
    mem.dropWrite = () => true;
    await expect(fs.writeFile(OBJ, bytes(10))).rejects.toMatchObject({ code: "EIO" });
    expect(mem.writes).toBe(3);
  });

  it("已经留下的 0 字节对象文件当作不存在，其他 0 字节文件照常", async () => {
    const { mem, fs } = setup();
    mem.files.set(OBJ, new Uint8Array(0));
    mem.files.set("repo/description", new Uint8Array(0));
    await expect(fs.stat(OBJ)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(OBJ)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat("repo/description")).size).toBe(0);
  });
});
