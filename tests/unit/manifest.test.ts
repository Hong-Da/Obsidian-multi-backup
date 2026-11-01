import { describe, expect, it } from "vitest";
import { emptyManifest, parseManifest } from "../../src/core/manifest";

describe("清单解析", () => {
  it("正常读取", () => {
    const m = { version: 1, updatedAt: 5, files: { "a.md": { size: 1, mtime: 2, hash: "h" } } };
    expect(parseManifest(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it.each([null, undefined, "x", 3, {}, { version: 2, files: {} }, { version: 1 }, { version: 1, files: null }])(
    "格式不对时返回空清单：%j",
    (raw) => {
      expect(parseManifest(raw)).toEqual(emptyManifest());
    },
  );

  it("丢弃字段不完整的条目，保留其他条目", () => {
    const m = parseManifest({
      version: 1,
      updatedAt: 1,
      files: { "ok.md": { size: 1, mtime: 2, hash: "h" }, "bad.md": { size: "1", mtime: 2, hash: "h" }, "nohash.md": { size: 1, mtime: 2, hash: "" } },
    });
    expect(Object.keys(m.files)).toEqual(["ok.md"]);
  });
});
