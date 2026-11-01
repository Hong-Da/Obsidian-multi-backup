// 界面上的时间与大小格式（纯函数，按语言输出）

export type Lang = "zh-CN" | "en";

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayDiff(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((db - da) / 86_400_000);
}

/** 日期标签：今天 / 昨天 / 10月29日（跨年加年份） */
export function dayLabel(ts: number, now: number, lang: Lang): string {
  const d = new Date(ts);
  const n = new Date(now);
  const diff = dayDiff(d, n);
  if (diff === 0) return lang === "zh-CN" ? "今天" : "Today";
  if (diff === 1) return lang === "zh-CN" ? "昨天" : "Yesterday";
  const sameYear = d.getFullYear() === n.getFullYear();
  if (lang === "zh-CN") return `${sameYear ? "" : d.getFullYear() + "年"}${d.getMonth() + 1}月${d.getDate()}日`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : ", " + d.getFullYear()}`;
}

/** 时间点：今天 10:42 / 昨天 22:15 / 10月29日 21:03 */
export function whenLabel(ts: number, now: number, lang: Lang): string {
  const label = dayLabel(ts, now, lang);
  const sep = lang === "zh-CN" ? " " : " at ";
  return `${label}${sep}${hm(new Date(ts))}`;
}

/** 状态栏用的简短时间：刚刚 / 5 分钟前 / 10:42 / 昨天 / 10月29日 */
export function agoLabel(ts: number, now: number, lang: Lang): string {
  const min = Math.floor((now - ts) / 60_000);
  const zh = lang === "zh-CN";
  if (min < 1) return zh ? "刚刚" : "Just now";
  if (min < 60) return zh ? `${min} 分钟前` : `${min} min ago`;
  const diff = dayDiff(new Date(ts), new Date(now));
  if (diff === 0) return hm(new Date(ts));
  return dayLabel(ts, now, lang);
}

export function timeOnly(ts: number): string {
  return hm(new Date(ts));
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function secondsLabel(ms: number): string {
  return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
}
