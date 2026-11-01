// 带按钮的提示：标题、说明和几个按钮；点任一按钮后提示消失
import { Notice } from "obsidian";

export interface NoticeButton {
  text: string;
  cta?: boolean;
  onClick?: () => void;
}

export function actionNotice(title: string, body: string, buttons: NoticeButton[], timeoutMs = 0): Notice {
  const frag = createFragment();
  frag.createEl("b", { text: title });
  frag.createDiv({ text: body, cls: "mb-notice-body" });
  const row = frag.createDiv({ cls: "mb-notice-buttons" });
  const notice = new Notice(frag, timeoutMs);
  for (const b of buttons) {
    const el = row.createEl("button", { text: b.text, cls: b.cta ? "mod-cta" : "" });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      notice.hide();
      b.onClick?.();
    });
  }
  return notice;
}
