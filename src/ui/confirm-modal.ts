import { Modal, Setting, requireApiVersion, type App, type ButtonComponent } from "obsidian";
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
              .then(destructive)
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

/** 危险操作的按钮：1.13 起用 setDestructive；更早的版本加上原来的红色样式（setWarning 已弃用） */
function destructive(b: ButtonComponent): void {
  if (requireApiVersion("1.13.0")) b.setDestructive();
  else b.buttonEl.addClass("mod-warning");
}
