// 自动同步的触发判断（纯函数）：给定现在的时间、各目的地上次同步的时间、最后一次编辑的时间，算出该同步哪些目的地。
// 插件每隔几秒调用一次；正在同步时不调用（不会重复启动）。

export interface AutoConfig {
  id: string;
  enabled: boolean;
  auto: {
    enabled: boolean;
    interval: { on: boolean; minutes: number };
    afterEdit: { on: boolean; seconds: number };
    onStartup: boolean;
    daily: { on: boolean; time: string };
  };
}

export interface ScheduleState {
  now: number;
  /** 各目的地上次同步（不论成败）的结束时间；没同步过时没有 */
  lastSync: Record<string, number | undefined>;
  /** Vault 最后一次被用户编辑的时间；0 表示启动后还没编辑 */
  lastEdit: number;
  /** 这是启动后的第一次检查 */
  startup: boolean;
}

export type AutoReason = "startup" | "interval" | "edit" | "daily";

export function dueDestinations(dests: AutoConfig[], s: ScheduleState): { id: string; reason: AutoReason }[] {
  const out: { id: string; reason: AutoReason }[] = [];
  for (const d of dests) {
    if (!d.enabled || !d.auto.enabled) continue;
    const a = d.auto;
    const last = s.lastSync[d.id] ?? 0;
    let reason: AutoReason | null = null;
    if (s.startup && a.onStartup) reason = "startup";
    else if (a.daily.on && last < lastOccurrence(a.daily.time, s.now)) reason = "daily";
    else if (a.interval.on && s.now - last >= a.interval.minutes * 60_000) reason = "interval";
    else if (a.afterEdit.on && s.lastEdit > last && s.now - s.lastEdit >= a.afterEdit.seconds * 1000) reason = "edit";
    if (reason) out.push({ id: d.id, reason });
  }
  return out;
}

/** 每天 HH:MM 最近一次（不晚于 now）的时间点 */
export function lastOccurrence(time: string, now: number): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return today <= now ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m).getTime();
}
