import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 视图、弹窗、设置页继承自 Obsidian 的基类。字段与基类的方法或属性同名时会把它覆盖掉：
// 同步历史视图曾有一个叫 open 的字段，覆盖了 View.open()，Obsidian 1.14 上侧栏打开后一片空白。
const RESERVED = ["open", "close", "load", "unload", "onload", "onunload", "leaf", "app", "scope", "icon", "navigation", "containerEl", "contentEl", "modalEl", "titleEl", "plugin"];
const FIELD = new RegExp(`^\\s*(?:private|protected|public)?\\s*(?:readonly\\s+)?(${RESERVED.join("|")})\\s*[!?]?\\s*[=:]`, "m");

const uiDir = fileURLToPath(new URL("../../src/ui/", import.meta.url));

describe("界面类的字段名", () => {
  it("不与 Obsidian 基类的方法或属性重名", () => {
    const hits: string[] = [];
    for (const f of readdirSync(uiDir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(path.join(uiDir, f), "utf8");
      if (!/extends\s+(?:ItemView|View|Modal|FuzzySuggestModal|SuggestModal|PluginSettingTab)\b/.test(src)) continue;
      // 只看类体里的字段声明；构造函数参数里的 private readonly plugin 是给子类用的，单独允许
      const body = src
        .replace(/constructor\([\s\S]*?\)\s*\{/g, "constructor() {")
        .replace(/(?:interface\s+\w+[^{]*|type\s+\w+\s*=\s*)\{[^}]*\}/g, "") // 接口和类型定义不是类字段
        .replace(/\([^()]*\)/g, "()"); // 函数参数（含对象类型参数）不是类字段
      const m = FIELD.exec(body);
      if (m) hits.push(`${f}: ${m[0].trim()}`);
    }
    expect(hits).toEqual([]);
  });
});
