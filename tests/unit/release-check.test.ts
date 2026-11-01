import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { checkRelease } from "../../scripts/release-check.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const check = checkRelease as (root: string, tag?: string) => string[];

describe("上架检查", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  /** 复制项目的上架文件到 tmp/ 下，按需改 manifest 后检查 */
  function withManifest(change: (m: Record<string, unknown>) => void, tag?: string): string[] {
    dir = mkdtempSync(path.join(root, "tmp", "release-check-"));
    for (const f of ["manifest.json", "versions.json", "package.json", "README.md", "LICENSE", "styles.css"]) {
      cpSync(path.join(root, f), path.join(dir, f));
    }
    const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
    change(m);
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
    return check(dir, tag);
  }

  it("当前项目通过", () => {
    expect(check(root)).toEqual([]);
  });

  it("标签带不带 v 都与版本号比较", () => {
    const v = (JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as { version: string }).version;
    expect(check(root, `v${v}`)).toEqual([]);
    expect(check(root, v)).toEqual([]);
    expect(check(root, "v9.9.9")).toHaveLength(1);
  });

  it("发现常见的提交问题", () => {
    const problems = withManifest((m) => {
      m.id = "obsidian-backup-plugin";
      m.description = "This plugin backs up your Obsidian vault";
      m.version = "1.0";
    });
    expect(problems.join("\n")).toMatch(/Obsidian/);
    expect(problems.join("\n")).toMatch(/plugin 结尾/);
    expect(problems.join("\n")).toMatch(/句号/);
    expect(problems.join("\n")).toMatch(/This plugin/);
    expect(problems.join("\n")).toMatch(/x\.y\.z/);
    expect(problems.join("\n")).toMatch(/不一致/);
  });
});
