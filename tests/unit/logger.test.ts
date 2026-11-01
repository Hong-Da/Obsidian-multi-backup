import { describe, expect, it } from "vitest";
import { Logger, type LogLevel, type LogSink } from "../../src/core/logger";

class MemorySink implements LogSink {
  lines: string[] = [];
  write(_level: LogLevel, line: string): void {
    this.lines.push(line);
  }
}

const fixed = () => new Date("2026-10-31T04:00:00.000Z");

function make(level: LogLevel = "debug") {
  const sink = new MemorySink();
  return { sink, logger: new Logger([sink], level, fixed) };
}

describe("Logger", () => {
  it("按级别过滤", () => {
    const { sink, logger } = make("info");
    logger.debug("hidden");
    logger.info("shown");
    logger.error("also shown");
    expect(sink.lines).toEqual([
      "2026-10-31T04:00:00.000Z [INFO] shown",
      "2026-10-31T04:00:00.000Z [ERROR] also shown",
    ]);
  });

  it("登记过的凭据值被替换", () => {
    const { sink, logger } = make();
    logger.addSecret("ghp_abcdef123456");
    logger.info("push with ghp_abcdef123456 done");
    expect(sink.lines[0]).toContain("push with *** done");
    expect(sink.lines[0]).not.toContain("ghp_abcdef123456");
  });

  it.each([
    ["Authorization: Bearer abcdefgh12345678", "abcdefgh12345678"],
    ['{"token":"s3cr3t-value"}', "s3cr3t-value"],
    ["password=hunter22&user=a", "hunter22"],
    ["https://alice:pa55word@example.com/repo.git", "pa55word"],
    ["secret_key: AKIAxxxxSECRET", "AKIAxxxxSECRET"],
  ])("常见凭据写法被隐藏：%s", (input, secret) => {
    const { sink, logger } = make();
    logger.info(input);
    expect(sink.lines[0]).not.toContain(secret);
    expect(sink.lines[0]).toContain("***");
  });

  it("附加数据也会脱敏", () => {
    const { sink, logger } = make();
    logger.warn("request failed", { url: "https://x.com", token: "abc12345xyz" });
    expect(sink.lines[0]).not.toContain("abc12345xyz");
  });

  it("Error 输出名称与信息", () => {
    const { sink, logger } = make();
    logger.error("sync failed", new TypeError("boom"));
    expect(sink.lines[0]).toBe("2026-10-31T04:00:00.000Z [ERROR] sync failed TypeError: boom");
  });

  it("太短的值不登记，避免误伤普通文字", () => {
    const { sink, logger } = make();
    logger.addSecret("ab");
    logger.info("about");
    expect(sink.lines[0]).toContain("about");
  });
});
