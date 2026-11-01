// 首次运行指导（M6 预览页 onboarding.html）：根据设置和同步历史判断上手清单每一项是否完成

import type { HistoryEntry } from "./history";

export interface OnboardingDest {
  id: string;
  enabled: boolean;
  auto: { enabled: boolean; interval: { on: boolean }; afterEdit: { on: boolean }; onStartup: boolean; daily: { on: boolean } };
}

export interface OnboardingTasks {
  /** 至少有一个目的地 */
  dest: boolean;
  /** 现有的某个目的地成功同步过一次 */
  backed: boolean;
  /** 某个启用的目的地打开了自动同步（至少一种触发方式） */
  auto: boolean;
  /** 设了主同步端（可选） */
  primary: boolean;
}

export function hasAutoSync(d: OnboardingDest): boolean {
  const a = d.auto;
  return d.enabled && a.enabled && (a.interval.on || a.afterEdit.on || a.onStartup || a.daily.on);
}

export function onboardingTasks(dests: OnboardingDest[], primaryId: string, history: HistoryEntry[]): OnboardingTasks {
  const ids = new Set(dests.map((d) => d.id));
  const backed = history.some((e) => e.destinations.some((d) => ids.has(d.id) && (d.status === "ok" || d.status === "unchanged")));
  return {
    dest: dests.length > 0,
    backed,
    auto: dests.some(hasAutoSync),
    primary: primaryId !== "" && ids.has(primaryId),
  };
}

/** 必做的前三项都完成了 */
export function requiredDone(t: OnboardingTasks): boolean {
  return t.dest && t.backed && t.auto;
}

/** 完成的项数（共 4 项） */
export function doneCount(t: OnboardingTasks): number {
  return [t.dest, t.backed, t.auto, t.primary].filter(Boolean).length;
}

/** 欢迎窗口只在第一次启用、还没有任何目的地时出现 */
export function shouldShowWelcome(welcomeDone: boolean, destCount: number): boolean {
  return !welcomeDone && destCount === 0;
}

/** 历史里第一次出现成功记录时返回那一条（用于“第一次备份完成”的提示） */
export function firstSuccess(history: HistoryEntry[], ids: Set<string>): { files: number; durationMs: number } | null {
  for (const entry of [...history].reverse()) {
    for (const d of entry.destinations) {
      if (ids.has(d.id) && (d.status === "ok" || d.status === "unchanged")) return { files: d.uploaded, durationMs: d.durationMs };
    }
  }
  return null;
}
