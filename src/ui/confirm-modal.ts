import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n";

/** 简单的确认弹窗，用于删除目的地、清空历史 */
export function confirmAction(app: App, title: string, body: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.setTitle(title);
        this.contentEl.createEl("p", { text: body });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
          .addButton((b) =>
            b
              .setButtonText(ok)
              .setWarning()
              .onClick(() => {
                done = true;
                this.close();
              }),
          );
      }
      override onClose(): void {
        this.contentEl.empty();
        resolve(done);
      }
    })(app);
    modal.open();
  });
}
