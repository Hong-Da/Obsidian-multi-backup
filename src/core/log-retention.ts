// 日志文件按日期命名（YYYY-MM-DD.log），超过保留天数的删除。

export function logFileName(time: Date): string {
  return `${localDate(time)}.log`;
}

/** 返回应删除的日志文件名：日期早于 today 往前 keepDays 天的文件；不认识的文件名不动 */
export function expiredLogFiles(names: string[], today: Date, keepDays: number): string[] {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (keepDays - 1));
  const cutoffName = localDate(cutoff);
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.log$/.test(n) && n.slice(0, 10) < cutoffName);
}

function localDate(t: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}
