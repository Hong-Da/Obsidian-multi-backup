// 路径与时间格式的小工具（纯函数）

/** 规范化本机绝对路径用于比较：统一分隔符、去掉结尾分隔符；Windows 风格路径转小写 */
export function normalizeNative(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  const unc = s.startsWith("//"); // 网络共享路径 \\server\share：保留开头的两个分隔符
  s = (unc ? "/" : "") + s.replace(/\/+/g, "/");
  if (s.length > 2) s = s.replace(/\/$/, "");
  // Windows 盘符路径（含磁盘根目录 E:）与网络共享路径不区分大小写
  return /^[a-z]:(\/|$)/i.test(s) || s.startsWith("//") ? s.toLowerCase() : s;
}

/** target 是否等于 base 或在 base 里面 */
export function isInsideOrSame(target: string, base: string): boolean {
  const t = normalizeNative(target);
  const b = normalizeNative(base);
  return t === b || t.startsWith(b.endsWith("/") ? b : b + "/");
}

/** 去掉文件名中各系统都不允许的字符 */
export function sanitizeFileName(name: string): string {
  const cleaned = Array.from(name, (c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? "_" : c))
    .join("")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned || "vault";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地日期 YYYY-MM-DD */
export function localDate(t: Date): string {
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** 本地时间戳 YYYY-MM-DD_HHmmss，用于历史版本文件名 */
export function localStamp(t: Date): string {
  return `${localDate(t)}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
}

/** 按模板生成快照文件名：{vault} {date} {time}（HHmm）；结果保证以 .zip 结尾 */
export function snapshotFileName(template: string, vaultName: string, t: Date): string {
  const time = `${pad(t.getHours())}${pad(t.getMinutes())}`;
  let name = (template.trim() || "{vault}_{date}_{time}.zip")
    .split("{vault}").join(vaultName)
    .split("{date}").join(localDate(t))
    .split("{time}").join(time);
  name = sanitizeFileName(name);
  return name.toLowerCase().endsWith(".zip") ? name : name + ".zip";
}

/** 文件扩展名（含点），没有时返回空串 */
/** 按模板生成提交说明：{vault} {date} {time}（HH:mm） */
export function commitMessage(template: string, vaultName: string, t: Date): string {
  const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return (template.trim() || "Backup {date} {time}")
    .split("{vault}").join(vaultName)
    .split("{date}").join(localDate(t))
    .split("{time}").join(time);
}

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}

/** 目标文件夹与 Vault 是否冲突：目标在 Vault 里面，或目标包含 Vault（镜像可能写进 Vault 自己） */
export function conflictsWithVault(target: string, vault: string | null): boolean {
  if (!vault || !target.trim()) return false;
  return isInsideOrSame(target, vault) || isInsideOrSame(vault, target);
}
