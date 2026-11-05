// 创建密钥的指导卡片：放在密钥那一行正下方，按平台 / 服务商给出步骤、最小权限、
// “只显示一次”的提醒、打开创建页面的按钮，S3 还能复制只允许这个桶的权限策略。
// 文案里 **粗体** 是网站上的按钮或菜单名，`代码` 是要填的值。

import { Notice, setIcon } from "obsidian";
import { FIXED_URLS, s3Policy, type KeyGuideId, type PolicyResult } from "../core/key-guide";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";

interface Spec {
  steps: number;
  /** 示例密钥 ID（只能小写字母、数字、横线） */
  secretId: string;
  scope: boolean;
  once: boolean;
  policy?: "aws" | "oss" | "cos";
}

const SPECS: Record<KeyGuideId, Spec> = {
  github: { steps: 4, secretId: "github-backup", scope: true, once: true },
  gitee: { steps: 3, secretId: "gitee-backup", scope: true, once: true },
  gitOther: { steps: 3, secretId: "git-backup", scope: true, once: true },
  jianguo: { steps: 3, secretId: "jianguoyun", scope: true, once: false },
  nextcloud: { steps: 3, secretId: "nextcloud", scope: true, once: true },
  alist: { steps: 3, secretId: "alist", scope: true, once: false },
  davOther: { steps: 2, secretId: "nas-webdav", scope: false, once: false },
  aws: { steps: 4, secretId: "aws-backup", scope: true, once: true, policy: "aws" },
  oss: { steps: 3, secretId: "aliyun-oss", scope: true, once: true, policy: "oss" },
  cos: { steps: 3, secretId: "tencent-cos", scope: true, once: true, policy: "cos" },
  r2: { steps: 3, secretId: "cloudflare-r2", scope: true, once: true },
  minio: { steps: 3, secretId: "minio", scope: true, once: true, policy: "aws" },
};

export interface KeyGuideOptions {
  id: KeyGuideId;
  /** 密钥那一行的名称，例如“令牌”，用在最后一步 */
  field: string;
  /** 自建服务：点按钮时按当前填写的地址生成页面；地址还没填时提示先填地址 */
  url?: () => string | null;
  /** 额外的说明链接，例如 Alist 接入说明 */
  docUrl?: string;
  /** 点“复制权限策略”时读取当前填写的桶名和地域 */
  bucket?: () => string;
  region?: () => string;
}

const k = (id: KeyGuideId, part: string) => `guide.${id}.${part}` as MessageKey;

/** 把 **粗体** 和 `代码` 渲染成元素，其余是纯文本 */
export function richText(el: HTMLElement, text: string): void {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith("**")) el.createEl("b", { text: part.slice(2, -2) });
    else if (part.startsWith("`")) el.createEl("code", { text: part.slice(1, -1) });
    else el.appendText(part);
  }
}

function button(parent: HTMLElement, icon: string, text: string, cta: boolean, onClick: () => void): HTMLButtonElement {
  const b = parent.createEl("button", { cls: cta ? "mod-cta" : "" });
  setIcon(b.createSpan({ cls: "mb-btn-icon" }), icon);
  b.appendText(text);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

function policyFor(o: KeyGuideOptions, kind: "aws" | "oss" | "cos"): PolicyResult {
  return s3Policy(kind, o.bucket?.() ?? "", o.region?.() ?? "");
}

function policyProblem(r: PolicyResult): string | null {
  if ("policy" in r) return null;
  return t(r.missing === "bucket" ? "guide.policy.needBucket" : "guide.policy.needAppid");
}

export function renderKeyGuide(parent: HTMLElement, o: KeyGuideOptions): HTMLElement {
  const spec = SPECS[o.id];
  const card = parent.createDiv({ cls: "mb-key-guide" });
  const head = card.createDiv({ cls: "mb-key-guide-head" });
  setIcon(head.createSpan({ cls: "mb-key-guide-icon" }), "key-round");
  head.createEl("b", { text: t(k(o.id, "title")) });

  const facts = card.createDiv({ cls: "mb-key-guide-facts" });
  const fact = (icon: string, text: string, warn = false) => {
    const f = facts.createSpan({ cls: ["mb-key-guide-fact", warn ? "is-warning" : ""].filter(Boolean) });
    setIcon(f.createSpan({ cls: "mb-key-guide-fact-icon" }), icon);
    f.appendText(text);
  };
  if (spec.scope) fact(o.id === "jianguo" ? "alert-triangle" : "lock", t(k(o.id, "scope")), o.id === "jianguo");
  if (spec.once) fact("alert-triangle", t("guide.once"), true);
  if (!facts.hasChildNodes()) facts.remove();

  const ol = card.createEl("ol");
  for (let i = 1; i <= spec.steps; i++) {
    const li = ol.createEl("li");
    richText(li, t(k(o.id, String(i))));
    if (i === 1) addActions(li, o, spec);
  }
  const last = ol.createEl("li", { cls: "mb-key-guide-final" });
  richText(last, t("guide.final", { field: o.field, id: spec.secretId }));
  return card;
}

function addActions(li: HTMLElement, o: KeyGuideOptions, spec: Spec): void {
  const fixed = FIXED_URLS[o.id];
  const kind = spec.policy;
  if (!fixed && !o.url && !kind && !o.docUrl) return;
  const row = li.createDiv({ cls: "mb-key-guide-actions" });
  if (fixed || o.url) {
    button(row, "external-link", t(k(o.id, "open")), true, () => {
      const url = fixed ?? o.url?.() ?? null;
      if (url) window.open(url, "_blank");
      else new Notice(t("guide.needUrl"));
    });
  }
  if (o.docUrl) {
    const a = row.createEl("a", { text: t("guide.alist.doc"), href: o.docUrl });
    a.setAttr("target", "_blank");
  }
  if (!kind) return;
  let pre: HTMLElement | null = null;
  button(row, "copy", t("guide.policy.copy"), false, () => {
    const r = policyFor(o, kind);
    const problem = policyProblem(r);
    if (problem || !("policy" in r)) return void new Notice(problem ?? "");
    void navigator.clipboard.writeText(r.policy).then(
      () => new Notice(t("guide.policy.copied")),
      () => new Notice(t("guide.policy.copyFailed")),
    );
  });
  const show = row.createEl("a", { text: t("guide.policy.show"), href: "#", cls: "mb-key-guide-show" });
  show.addEventListener("click", (e) => {
    e.preventDefault();
    if (pre) {
      pre.remove();
      pre = null;
      show.setText(t("guide.policy.show"));
      return;
    }
    const r = policyFor(o, kind);
    const problem = policyProblem(r);
    if (problem || !("policy" in r)) return void new Notice(problem ?? "");
    pre = li.createEl("pre", { cls: "mb-key-guide-policy", text: r.policy });
    show.setText(t("guide.policy.hide"));
  });
}
