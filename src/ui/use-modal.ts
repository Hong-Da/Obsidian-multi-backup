// 新的在线目的地怎么用（按 M6 预览页 primary-default.html 实现）：默认主同步端，也可以只做备份。
// 打开时只读查看目的地，已有其他设备的笔记时写明能下载多少。
import { Modal, setIcon, type App } from "obsidian";
import { t, tn } from "../i18n";
import type { DestinationConfig } from "../settings";
import type { SyncService } from "../sync-service";
import { destDisplayName } from "./messages";

export interface UseChoice {
  /** 选了主同步端：接着打开比较窗口 */
  primary(): void;
  /** 选了只做备份：立即备份 */
  backup(): void;
}

export class UseModal extends Modal {
  private choice: "primary" | "backup" = "primary";
  private closed = false;

  constructor(
    app: App,
    private readonly sync: SyncService,
    private readonly cfg: DestinationConfig,
    private readonly next: UseChoice,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("mb-use-modal");
    this.setTitle(t("use.title", { name: destDisplayName(this.cfg) }));
    const { contentEl } = this;
    contentEl.createEl("p", { text: t("use.lead"), cls: "mb-modal-sub" });

    const option = (value: "primary" | "backup", icon: string, title: string, desc: string, recommended: boolean) => {
      const box = contentEl.createEl("label", { cls: "mb-use-opt" });
      const radio = box.createEl("input", { type: "radio", attr: { name: "mb-use" } });
      radio.checked = this.choice === value;
      const head = box.createEl("b");
      setIcon(head.createSpan({ cls: "mb-use-icon" }), icon);
      head.createSpan({ text: title });
      if (recommended) head.createSpan({ text: t("use.recommended"), cls: "mb-use-rec" });
      box.createEl("p", { text: desc });
      radio.addEventListener("change", () => {
        this.choice = value;
        contentEl.querySelectorAll(".mb-use-opt").forEach((x) => x.toggleClass("is-selected", x === box));
        go.setText(value === "primary" ? t("use.nextCompare") : t("use.backUpNow"));
      });
      box.toggleClass("is-selected", radio.checked);
      return box;
    };
    const primary = option("primary", "arrow-down-up", t("use.primary"), t("use.primaryDesc"), true);
    const found = primary.createDiv({ cls: "mb-use-found is-checking" });
    setIcon(found.createSpan({ cls: "mb-use-icon" }), "refresh-cw");
    found.createSpan({ text: t("use.checking") });
    option("backup", "upload", t("use.backup"), t("use.backupDesc"), false);

    const footer = contentEl.createDiv({ cls: "mb-plan-footer" });
    footer.createSpan({ text: t("use.help"), cls: "mb-use-help" });
    footer.createEl("button", { text: t("notice.later") }).addEventListener("click", () => this.close());
    const go = footer.createEl("button", { text: t("use.nextCompare"), cls: "mod-cta" });
    go.addEventListener("click", () => {
      this.close();
      if (this.choice === "primary") this.next.primary();
      else this.next.backup();
    });

    void this.check(found);
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  /** 只读查看：远程有、本机没有的文件数，以及上传过配置的其他设备 */
  private async check(el: HTMLElement): Promise<void> {
    const [preview, configs] = await Promise.all([this.sync.previewPrimary(this.cfg).catch(() => null), this.sync.readConfigs(this.cfg).catch(() => [])]);
    if (this.closed) return;
    const down = preview ? preview.plan.ops.filter((o) => o.type === "download").length : 0;
    if (!down) {
      el.remove();
      return;
    }
    const me = this.sync.deviceName();
    const devices = [...new Set(configs.map((c) => c.device).filter((d) => d && d !== me))];
    el.empty();
    el.removeClass("is-checking");
    setIcon(el.createSpan({ cls: "mb-use-icon" }), "download");
    el.createSpan({ text: devices.length ? tn("use.foundFrom", down, { device: devices.join(t("importConfig.sep")) }) : tn("use.found", down) });
  }
}
