import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../src/core/history";
import { doneCount, firstSuccess, onboardingTasks, requiredDone, shouldShowWelcome } from "../../src/core/onboarding";
import { defaultAuto, mergeSettings, newDestination, portableSettings } from "../../src/settings";

function entry(destId: string, status: "ok" | "failed" | "unchanged", uploaded = 10, at = 1): HistoryEntry {
  return {
    id: String(at),
    startedAt: at,
    finishedAt: at,
    trigger: "settings",
    skippedLarge: [],
    destinations: [{ id: destId, name: destId, type: "mirror", status, uploaded, moved: 0, deleted: 0, failedCount: 0, changes: [], changeCount: 0, failures: [], durationMs: 3200 }],
  };
}

describe("首次运行指导", () => {
  it("没有目的地时什么都没完成", () => {
    const t = onboardingTasks([], "", []);
    expect(t).toEqual({ dest: false, backed: false, auto: false, primary: false });
    expect(doneCount(t)).toBe(0);
  });

  it("按实际状态打勾：失败的同步不算备份过，已删除目的地的记录不算", () => {
    const d = { ...newDestination("webdav"), auto: { ...defaultAuto("backup"), enabled: false } };
    expect(onboardingTasks([d], "", [entry(d.id, "failed")]).backed).toBe(false);
    expect(onboardingTasks([d], "", [entry("gone", "ok")]).backed).toBe(false);
    expect(onboardingTasks([d], "", [entry(d.id, "unchanged")]).backed).toBe(true);
    expect(onboardingTasks([d], "", []).auto).toBe(false);
  });

  it("自动同步要目的地启用、总开关打开、至少一种触发方式", () => {
    const d = newDestination("webdav");
    expect(onboardingTasks([d], "", []).auto).toBe(true); // 新目的地默认每 30 分钟
    expect(onboardingTasks([{ ...d, enabled: false }], "", []).auto).toBe(false);
    const none = { ...defaultAuto("backup"), interval: { on: false, minutes: 30 } };
    expect(onboardingTasks([{ ...d, auto: none }], "", []).auto).toBe(false);
  });

  it("前三项完成即“基本设置都完成了”，主同步端可选", () => {
    const d = newDestination("webdav");
    const t = onboardingTasks([d], "", [entry(d.id, "ok")]);
    expect(requiredDone(t)).toBe(true);
    expect(doneCount(t)).toBe(3);
    expect(onboardingTasks([d], d.id, []).primary).toBe(true);
    expect(onboardingTasks([d], "other", []).primary).toBe(false);
  });

  it("欢迎窗口只在第一次、没有目的地时出现", () => {
    expect(shouldShowWelcome(false, 0)).toBe(true);
    expect(shouldShowWelcome(true, 0)).toBe(false);
    expect(shouldShowWelcome(false, 1)).toBe(false);
  });

  it("第一次成功的那条记录给出文件数和用时（历史按新到旧排列）", () => {
    const h = [entry("a", "ok", 3, 3), entry("a", "ok", 1284, 2), entry("a", "failed", 0, 1)];
    expect(firstSuccess(h, new Set(["a"]))).toEqual({ files: 1284, durationMs: 3200 });
    expect(firstSuccess(h, new Set(["b"]))).toBeNull();
  });
});

describe("首次运行指导的设置", () => {
  it("新安装：欢迎窗口和清单都会出现", () => {
    expect(mergeSettings(undefined).onboarding).toEqual({ welcomeDone: false, guideClosed: false });
  });

  it("升级前已有目的地的老用户：都不出现", () => {
    expect(mergeSettings({ destinations: [newDestination("webdav")] }).onboarding).toEqual({ welcomeDone: true, guideClosed: true });
  });

  it("保存过的值优先", () => {
    const s = mergeSettings({ destinations: [newDestination("webdav")], onboarding: { welcomeDone: true, guideClosed: false } });
    expect(s.onboarding.guideClosed).toBe(false);
  });

  it("随配置上传、导出的设置里没有这台设备的指导状态", () => {
    const s = mergeSettings(undefined);
    const p = portableSettings(s);
    expect("onboarding" in p).toBe(false);
    expect(s.onboarding).toBeDefined();
  });
});
