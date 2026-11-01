import { describe, expect, it } from "vitest";
import type { HistoryDestination, HistoryEntry } from "../../src/core/history";
import type { DestState } from "../../src/core/overview";
import { initI18n } from "../../src/i18n";
import { destStatusText, durationText, joinSentences, typeLabel } from "../../src/ui/messages";

const NOW = new Date(2026, 9, 31, 12, 0).getTime();

function state(dest: Partial<HistoryDestination>): DestState {
  const d: HistoryDestination = {
    id: "g1", name: "Repo", type: "git", status: "ok", uploaded: 0, moved: 0, deleted: 0, failedCount: 0,
    changes: [], changeCount: 0, failures: [], durationMs: 100, ...dest,
  };
  const entry: HistoryEntry = { id: "e", startedAt: NOW - 1000, finishedAt: NOW - 1000, trigger: "sidebar", skippedLarge: [], destinations: [d] };
  return { ring: "ok", last: { entry, dest: d } };
}

describe("目的地状态文字（git）", () => {
  it("有提交：显示提交号和变化的文件数", () => {
    const text = destStatusText(state({ commit: "a1b2c3d", uploaded: 10, moved: 1, deleted: 1 }), null, NOW);
    expect(text).toContain("a1b2c3d");
    expect(text).toContain("12 files changed");
  });

  it("没有变化：写明未提交", () => {
    expect(destStatusText(state({}), null, NOW)).toContain("no commit");
  });

  it("类型名称", () => {
    expect(typeLabel("git")).toBe("Local git");
  });
});

describe("界面文字的细节（M6-5 桌面检查）", () => {
  it("镜像成功但没有改动：和“没有变化”说法一致，不写“上传 0 个文件”", () => {
    const text = destStatusText(state({ type: "mirror" }), null, NOW);
    expect(text).not.toMatch(/0 files?/);
    expect(text).toBe(destStatusText(state({ type: "mirror", status: "unchanged" }), null, NOW));
  });

  it("耗时不到 1 秒时直接说不到 1 秒", () => {
    expect(durationText(40)).toBe("under a second");
    expect(durationText(3200)).toBe("3.2 s");
  });

  it("句子连接：英文加空格，中文不加", () => {
    expect(joinSentences("A.", "", "B.")).toBe("A. B.");
    initI18n("zh-CN");
    try {
      expect(joinSentences("甲。", "乙。")).toBe("甲。乙。");
      expect(durationText(40)).toBe("不到 1 秒");
    } finally {
      initI18n("en");
    }
  });
});
