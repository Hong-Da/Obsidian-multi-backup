import { getLanguage } from "obsidian";
import en, { type MessageKey } from "./en";
import zhCN from "./zh-CN";

export type Locale = "en" | "zh-CN";

const TABLES: Record<Locale, Record<MessageKey, string>> = { en, "zh-CN": zhCN };

let current: Locale = "en";

/** 按 Obsidian 的界面语言选择文案：中文（含繁体）用中文，其余用英文 */
export function resolveLocale(lang: string): Locale {
  return lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function initI18n(lang: string = getLanguage()): Locale {
  current = resolveLocale(lang);
  return current;
}

export function currentLocale(): Locale {
  return current;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let text = TABLES[current][key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

type PluralBase<K> = K extends `${infer B}.one` ? B : never;

/** 按数量选用 .one / .other 文案；vars 中自动加入 count */
export function tn(base: PluralBase<MessageKey>, count: number, vars: Record<string, string | number> = {}): string {
  return t(`${base}.${count === 1 ? "one" : "other"}` as MessageKey, { count, ...vars });
}
