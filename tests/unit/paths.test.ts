import { describe, expect, it } from "vitest";
import { toDestinationError } from "../../src/core/errors";
import { extOf, isInsideOrSame, localStamp, sanitizeFileName, snapshotFileName } from "../../src/core/paths";

describe("路径判断", () => {
  it.each([
    ["E:\\Notes\\backup", "E:\\Notes", true],
    ["e:/notes/Backup/", "E:\\Notes", true],
    ["E:\\Notes", "E:\\Notes\\", true],
    ["E:\\Notes2", "E:\\Notes", false],
    ["E:\\Backup", "E:\\Notes", false],
    ["/home/me/vault/bak", "/home/me/vault", true],
    ["/home/me/Vault", "/home/me/vault", false], // Linux 区分大小写
    ["\\\\nas\\share\\notes", "\\\\NAS\\share", true],
  ])("%s 在 %s 里面 → %s", (target, base, expected) => {
    expect(isInsideOrSame(target, base)).toBe(expected);
  });
});

describe("文件名", () => {
  it("去掉非法字符", () => {
    expect(sanitizeFileName('My: "Notes"?')).toBe("My_ _Notes__");
    expect(sanitizeFileName("...")).toBe("vault");
  });

  it("快照文件名按模板生成", () => {
    const t = new Date(2026, 9, 31, 10, 42, 5);
    expect(snapshotFileName("{vault}_{date}_{time}.zip", "My Notes", t)).toBe("My Notes_2026-10-31_1042.zip");
    expect(snapshotFileName("backup-{date}", "V", t)).toBe("backup-2026-10-31.zip");
    expect(snapshotFileName("", "V", t)).toBe("V_2026-10-31_1042.zip");
    expect(snapshotFileName("{vault}.zip", "a/b", t)).toBe("a_b.zip");
  });

  it("时间戳与扩展名", () => {
    expect(localStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02_030405");
    expect(extOf("Notes/a.b/c.md")).toBe(".md");
    expect(extOf("Notes/.gitignore")).toBe("");
    expect(extOf("README")).toBe("");
  });
});

describe("错误转换", () => {
  it.each([
    ["ENOENT", "not-found"],
    ["EACCES", "not-writable"],
    ["EPERM", "not-writable"],
    ["ENOSPC", "no-space"],
    ["EBUSY", "in-use"],
    ["EIO", "io"],
  ])("%s → %s", (code, expected) => {
    expect(toDestinationError(Object.assign(new Error("x"), { code }), "p").code).toBe(expected);
  });
});
