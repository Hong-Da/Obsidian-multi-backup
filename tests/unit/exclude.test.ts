import { describe, expect, it } from "vitest";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";

describe("排除规则：文件", () => {
  it.each([
    // [规则, 路径, 是否排除]
    ["*.tmp", "a.tmp", true],
    ["*.tmp", "Notes/deep/x.tmp", true],
    ["*.tmp", "Notes/x.tmp.md", false],
    ["Attachments/Videos/**", "Attachments/Videos/a.mp4", true],
    ["Attachments/Videos/**", "Attachments/Videos/2026/b.mp4", true],
    ["Attachments/Videos/**", "Attachments/Video.md", false],
    ["Attachments/Videos/**", "Other/Attachments/Videos/a.mp4", false],
    ["Archive/", "Archive/2019/x.md", true],
    ["Archive/", "Notes/Archive/x.md", true], // 与 .gitignore 相同：只有结尾的 / 不算锚定
    ["/Archive/", "Archive/x.md", true],
    ["/drafts/", "Projects/drafts/a.md", false],
    ["**/drafts/**", "Projects/drafts/a.md", true],
    ["**/drafts/**", "drafts/a.md", true],
    ["Daily/*.md", "Daily/2026-10-31.md", true],
    ["Daily/*.md", "Daily/2026/10-31.md", false],
    ["Daily/**/*.png", "Daily/2026/10/a.png", true],
    ["Daily/**/*.png", "Daily/a.png", true],
    ["note?.md", "note1.md", true],
    ["note?.md", "note10.md", false],
    ["ATTACHMENTS/**", "attachments/a.png", true],
    ["a+b(1).md", "a+b(1).md", true],
    ["# 注释", "# 注释", false],
    ["", "a.md", false],
  ])("规则 %s，路径 %s → %s", (rule, path, expected) => {
    expect(new ExcludeMatcher([rule]).isExcludedFile(path)).toBe(expected);
  });
});

describe("排除规则：文件夹", () => {
  it("被排除的文件夹及其子文件夹都不进入", () => {
    const m = new ExcludeMatcher(["Archive/", "node_modules"]);
    expect(m.isExcludedDir("Archive")).toBe(true);
    expect(m.isExcludedDir("Archive/2019")).toBe(true);
    expect(m.isExcludedDir("Projects/web/node_modules")).toBe(true);
    expect(m.isExcludedDir("Notes")).toBe(false);
  });

  it("文件规则不会让同名前缀的文件夹被排除", () => {
    const m = new ExcludeMatcher(["*.tmp"]);
    expect(m.isExcludedDir("Notes")).toBe(false);
  });
});

describe("内置规则", () => {
  const base = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/multi-backup" };

  it("总是排除回收站、根目录 .git、插件自己的数据、工作区布局、系统垃圾文件", () => {
    const m = new ExcludeMatcher(builtinRules({ ...base, includeConfigDir: true }));
    for (const p of [
      ".trash/old.md",
      ".git/config",
      ".obsidian/plugins/multi-backup/data.json",
      ".obsidian/plugins/multi-backup/state/m1.json",
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      "Notes/.DS_Store",
      "Pics/Thumbs.db",
      "desktop.ini",
    ]) expect(m.isExcludedFile(p), p).toBe(true);
  });

  it("包含配置文件夹时，其他插件和主题照常备份", () => {
    const m = new ExcludeMatcher(builtinRules({ ...base, includeConfigDir: true }));
    for (const p of [".obsidian/app.json", ".obsidian/plugins/calendar/data.json", ".obsidian/themes/Minimal/theme.css", "Projects/.git-notes.md"])
      expect(m.isExcludedFile(p), p).toBe(false);
  });

  it("不包含配置文件夹时整个跳过", () => {
    const m = new ExcludeMatcher(builtinRules({ ...base, includeConfigDir: false }));
    expect(m.isExcludedDir(".obsidian")).toBe(true);
    expect(m.isExcludedFile(".obsidian/app.json")).toBe(true);
  });

  it("配置文件夹改了名字也能识别", () => {
    const m = new ExcludeMatcher(builtinRules({ configDir: ".config-obs", pluginDir: ".config-obs/plugins/multi-backup", includeConfigDir: true }));
    expect(m.isExcludedFile(".config-obs/workspace.json")).toBe(true);
    expect(m.isExcludedFile(".config-obs/app.json")).toBe(false);
  });

  it("只排除根目录的 .git，子文件夹里的 .git 照常备份", () => {
    const m = new ExcludeMatcher(builtinRules({ ...base, includeConfigDir: true }));
    expect(m.isExcludedFile("Projects/repo/.git/HEAD")).toBe(false);
  });
});
