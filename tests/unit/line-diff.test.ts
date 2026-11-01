import { describe, expect, it } from "vitest";
import { diffLines } from "../../src/core/line-diff";

const marks = (l: { kind: string }[]) => l.map((x) => (x.kind === "same" ? "=" : "*")).join("");

describe("逐行对比", () => {
  it("改了一行、各自新增一行", () => {
    const { left, right } = diffLines("# 标题\n- 待办 A\n- 买牛奶\n本机加的", "# 标题\n- 待办 A（改到 4 点）\n- 买牛奶\n手机加的");
    expect(marks(left)).toBe("=*=*");
    expect(marks(right)).toBe("=*=*");
  });

  it("相同内容全部相同，Windows 换行也当作同一行", () => {
    const { left, right } = diffLines("a\r\nb", "a\nb");
    expect(marks(left) + marks(right)).toBe("====");
  });

  it("太大时整份标为不同，不卡住", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const { left } = diffLines(big, big + "\nmore");
    expect(left.every((l) => l.kind === "changed")).toBe(true);
  });
});
