import { describe, expect, it } from "vitest";
import en from "../../src/i18n/en";
import zhCN from "../../src/i18n/zh-CN";
import { initI18n, resolveLocale, t } from "../../src/i18n";

describe("i18n", () => {
  it("中英文文案键完全一致且不为空", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const table of [en, zhCN]) for (const v of Object.values(table)) expect(v.trim()).not.toBe("");
  });

  it("中英文的占位符一致", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(vars(zhCN[k])).toEqual(vars(en[k]));
  });

  it.each([
    ["zh", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["en", "en"],
    ["ja", "en"],
    ["pt-BR", "en"],
  ])("语言 %s → %s", (lang, locale) => {
    expect(resolveLocale(lang)).toBe(locale);
  });

  it("替换占位符", () => {
    initI18n("zh");
    expect(t("plugin.loaded", { version: "0.1.0" })).toBe("多点备份 0.1.0 已加载");
    initI18n("en");
    expect(t("plugin.loaded", { version: "0.1.0" })).toBe("Multi Backup 0.1.0 loaded");
  });
});
