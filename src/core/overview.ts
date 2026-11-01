// 汇总各目的地的状态，供状态栏、设置页、菜单使用（与语言无关）

import { lastResultOf, type HistoryDestination, type HistoryEntry } from "./history";

export type RingState = "ok" | "busy" | "error" | "idle" | "paused";

export interface DestLike {
  id: string;
  enabled: boolean;
}

export interface DestState {
  ring: RingState;
  last: { entry: HistoryEntry; dest: HistoryDestination } | null;
}

export function destState(d: DestLike, history: HistoryEntry[], runningId: string | null): DestState {
  const last = lastResultOf(history, d.id);
  if (runningId === d.id) return { ring: "busy", last };
  if (!d.enabled) return { ring: "paused", last };
  if (!last) return { ring: "idle", last };
  return { ring: last.dest.status === "failed" || last.dest.status === "partial" ? "error" : "ok", last };
}

export interface Overview {
  /** none：没有目的地；busy：同步中；error：有启用的目的地上次失败；ok：有成功记录；idle：都还没同步过 */
  state: "none" | "busy" | "error" | "ok" | "idle";
  failedIds: string[];
  lastAt: number | null;
  counts: { ok: number; failed: number; paused: number; never: number };
}

export function overview(dests: DestLike[], history: HistoryEntry[], runningId: string | null, running: boolean): Overview {
  const counts = { ok: 0, failed: 0, paused: 0, never: 0 };
  const failedIds: string[] = [];
  for (const d of dests) {
    const s = destState(d, history, null);
    if (s.ring === "paused") counts.paused++;
    else if (s.ring === "idle") counts.never++;
    else if (s.ring === "error") {
      counts.failed++;
      failedIds.push(d.id);
    } else counts.ok++;
  }
  const lastAt = history[0]?.finishedAt ?? null;
  let state: Overview["state"];
  if (running || runningId) state = "busy";
  else if (!dests.length) state = "none";
  else if (failedIds.length) state = "error";
  else if (counts.ok || lastAt) state = "ok"; // 全部暂停但以前同步过：显示上次同步时间
  else state = "idle";
  return { state, failedIds, lastAt, counts };
}
