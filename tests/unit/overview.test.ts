import { describe, expect, it } from "vitest";
import { agoLabel, dayLabel, sizeLabel, whenLabel } from "../../src/core/format";
import { appendHistory, lastResultOf, parseHistory, toHistoryEntry, type HistoryEntry } from "../../src/core/history";
import { destState, overview } from "../../src/core/overview";
import { conflictsWithVault } from "../../src/core/paths";
import type { BackupResult, DestinationResult } from "../../src/core/sync";
import { DestinationError } from "../../src/core/errors";

const res = (id: string, status: DestinationResult["status"], extra: Partial<DestinationResult> = {}): DestinationResult => ({
  id, status, uploaded: 0, identical: 0, moved: 0, deleted: 0, failed: [], changes: [], durationMs: 10, ...extra,
});
const backup = (at: number, dests: DestinationResult[]): BackupResult => ({ startedAt: at - 100, finishedAt: at, skippedLarge: [], destinations: dests });
const names = { a: { name: "镜像", type: "mirror" }, b: { name: "快照", type: "zip" } };

describe("同步历史", () => {
  it("转换结果并只保留前 20 条明细", () => {
    const changes = Array.from({ length: 30 }, (_, i) => ({ op: "upload" as const, path: `f${i}.md` }));
    const e = toHistoryEntry(backup(1000, [res("a", "ok", { uploaded: 30, changes })]), "ribbon", names);
    expect(e.destinations[0]).toMatchObject({ name: "镜像", type: "mirror", uploaded: 30, changeCount: 30 });
    expect(e.destinations[0]?.changes).toHaveLength(20);
  });

  it("失败原因来自整体错误或第一个失败的文件", () => {
    const e = toHistoryEntry(
      backup(1000, [
        res("a", "failed", { error: new DestinationError("not-found", "E:\\B") }),
        res("b", "partial", { failed: [{ path: "x.md", op: "upload", error: new DestinationError("in-use", "x.md") }] }),
      ]),
      "command",
      names,
    );
    expect(e.destinations.map((d) => [d.errorCode, d.errorPath])).toEqual([["not-found", "E:\\B"], ["in-use", "x.md"]]);
  });

  it("新记录在最前，超出上限丢弃", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < 5; i++) list = appendHistory(list, toHistoryEntry(backup(i, []), "ribbon", names), 3);
    expect(list.map((e) => e.finishedAt)).toEqual([4, 3, 2]);
  });

  it("解析时丢弃格式不对的条目", () => {
    expect(parseHistory([{ startedAt: 1, destinations: [] }, { x: 1 }, null]).length).toBe(1);
    expect(parseHistory("x")).toEqual([]);
  });

  it("找到某个目的地最近一次结果", () => {
    const list = [toHistoryEntry(backup(2, [res("b", "ok")]), "ribbon", names), toHistoryEntry(backup(1, [res("a", "failed")]), "ribbon", names)];
    expect(lastResultOf(list, "a")?.dest.status).toBe("failed");
    expect(lastResultOf(list, "z")).toBeNull();
  });
});

describe("状态汇总", () => {
  const hist = [toHistoryEntry(backup(2000, [res("a", "ok"), res("b", "failed")]), "ribbon", names)];

  it("单个目的地的状态", () => {
    expect(destState({ id: "a", enabled: true }, hist, null).ring).toBe("ok");
    expect(destState({ id: "b", enabled: true }, hist, null).ring).toBe("error");
    expect(destState({ id: "c", enabled: true }, hist, null).ring).toBe("idle");
    expect(destState({ id: "a", enabled: false }, hist, null).ring).toBe("paused");
    expect(destState({ id: "a", enabled: true }, hist, "a").ring).toBe("busy");
  });

  it("整体状态", () => {
    expect(overview([], [], null, false).state).toBe("none");
    expect(overview([{ id: "c", enabled: true }], [], null, false).state).toBe("idle");
    expect(overview([{ id: "a", enabled: true }], hist, null, false)).toMatchObject({ state: "ok", lastAt: 2000 });
    const o = overview([{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "c", enabled: false }], hist, null, false);
    expect(o).toMatchObject({ state: "error", failedIds: ["b"], counts: { ok: 1, failed: 1, paused: 1, never: 0 } });
    expect(overview([{ id: "a", enabled: true }], hist, null, true).state).toBe("busy");
  });

  it("暂停的目的地失败过也不算失败", () => {
    expect(overview([{ id: "b", enabled: false }], hist, null, false).state).toBe("ok");
  });
});

describe("时间与大小格式", () => {
  const now = new Date(2026, 9, 31, 12, 0).getTime();
  it.each([
    [new Date(2026, 9, 31, 11, 59, 40).getTime(), "刚刚", "Just now"],
    [new Date(2026, 9, 31, 11, 55).getTime(), "5 分钟前", "5 min ago"],
    [new Date(2026, 9, 31, 8, 3).getTime(), "08:03", "08:03"],
    [new Date(2026, 9, 30, 22, 15).getTime(), "昨天", "Yesterday"],
    [new Date(2026, 9, 29, 9, 0).getTime(), "10月29日", "Oct 29"],
    [new Date(2025, 11, 31, 9, 0).getTime(), "2025年12月31日", "Dec 31, 2025"],
  ])("%s", (ts, zh, en) => {
    expect(agoLabel(ts, now, "zh-CN")).toBe(zh);
    expect(agoLabel(ts, now, "en")).toBe(en);
  });

  it("日期与时间点", () => {
    expect(dayLabel(now, now, "zh-CN")).toBe("今天");
    expect(whenLabel(new Date(2026, 9, 31, 10, 42).getTime(), now, "zh-CN")).toBe("今天 10:42");
    expect(whenLabel(new Date(2026, 9, 30, 22, 15).getTime(), now, "en")).toBe("Yesterday at 22:15");
  });

  it("大小", () => {
    expect(sizeLabel(512)).toBe("512 B");
    expect(sizeLabel(1536)).toBe("1.5 KB");
    expect(sizeLabel(412 * 1024 ** 3)).toBe("412 GB");
  });
});

describe("目标文件夹与 Vault 冲突", () => {
  it.each([
    ["E:\\Notes\\backup", true],
    ["E:\\", true], // 包含 Vault
    ["E:\\Backup", false],
    ["", false],
  ])("%s → %s", (target, expected) => {
    expect(conflictsWithVault(target, "E:\\Notes")).toBe(expected);
  });

  it("拿不到 Vault 路径时不判断", () => {
    expect(conflictsWithVault("E:\\Notes", null)).toBe(false);
  });
});
