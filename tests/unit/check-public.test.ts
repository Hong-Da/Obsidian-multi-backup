import { describe, expect, it } from "vitest";
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { isPrivatePath, PATTERNS, scanText } from "../../scripts/check-public.mjs";

type Hit = { line: number; label: string };
const scan = scanText as (text: string, patterns: unknown) => Hit[];
const priv = isPrivatePath as (f: string) => boolean;

describe("公开内容检查", () => {
  it("内部目录和本机配置不推送", () => {
    expect(priv("InternalDocs/spec/project-spec.md")).toBe(true);
    expect(priv("DevelopDocs/TASK.md")).toBe(true);
    expect(priv("CLAUDE.md")).toBe(true);
    expect(priv(".claude/settings.json")).toBe(true);
    expect(priv("docs/CLAUDE.md")).toBe(false);
    expect(priv("src/main.ts")).toBe(false);
  });

  it("发现令牌、私钥和决策编号，并给出行号", () => {
    const token = "ghp_" + "a".repeat(36);
    const text = ["正常的一行", `token = "${token}"`, "-----BEGIN OPENSSH " + "PRIVATE KEY-----", "见 D-" + "0052"].join("\n");
    expect(scan(text, PATTERNS).map((h) => [h.line, h.label])).toEqual([
      [2, "GitHub 令牌"],
      [3, "私钥"],
      [4, "内部决策编号"],
    ]);
  });

  it("AWS 文档的示例密钥不算", () => {
    expect(scan('accessKeyId: "AKIAIOSFODNN7EXAMPLE"', PATTERNS)).toEqual([]);
    expect(scan('accessKeyId: "AKIA' + "Q".repeat(16) + '"', PATTERNS)).toHaveLength(1);
  });
});
