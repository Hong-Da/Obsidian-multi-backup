import { describe, expect, it } from "vitest";
import { expiredLogFiles, logFileName } from "../../src/core/log-retention";

describe("日志保留", () => {
  it("文件名使用本地日期", () => {
    expect(logFileName(new Date(2026, 9, 31, 23, 59))).toBe("2026-10-31.log");
  });

  it("保留最近 N 天（含今天），删除更早的", () => {
    const today = new Date(2026, 9, 31, 10);
    const names = ["2026-10-18.log", "2026-10-17.log", "2026-10-31.log", "2026-10-01.log"];
    expect(expiredLogFiles(names, today, 14).sort()).toEqual(["2026-10-01.log", "2026-10-17.log"]);
  });

  it("跨月、跨年正确计算", () => {
    expect(expiredLogFiles(["2025-12-31.log", "2026-01-01.log"], new Date(2026, 0, 2), 2)).toEqual(["2025-12-31.log"]);
  });

  it("不认识的文件不删除", () => {
    expect(expiredLogFiles(["notes.txt", "2020-01-01.log.bak"], new Date(2026, 9, 31), 14)).toEqual([]);
  });
});
