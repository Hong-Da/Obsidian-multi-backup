// 设为主同步端（按 M3 预览页 primary-confirm.html 实现）：先只读比较，列出首次同步会做什么，确认后才开始
import { Modal, setIcon, type App } from "obsidian";
import { DestinationError } from "../core/errors";
import type { SyncPlan } from "../core/sync-planner";
import { t } from "../i18n";
import type { DestinationConfig } from "../settings";
import type { SyncService } from "../sync-service";
import { destDisplayName, errorText } from "./messages";

export class PrimaryModal extends Modal {
  constructor(
    app: App,
    private readonly sync: SyncService,
    private readonly cfg: DestinationConfig,
    /** 现在的主同步端（替换时提示） */
    private readonly current: DestinationConfig | null,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("mb-primary-modal");
    this.setTitle(t("primary.title", { name: destDisplayName(this.cfg) }));
    const { contentEl } = this;
    contentEl.createEl("p", { text: t("primary.lead"), cls: "mb-modal-sub" });
    const plan = contentEl.createDiv({ cls: "mb-plan" });
    plan.createDiv({ text: t("primary.checking"), cls: "mb-plan-checking" });
    const notes = contentEl.createDiv();
    const footer = contentEl.createDiv({ cls: "mb-plan-footer" });
    footer.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => this.close());
    const start = footer.createEl("button", { text: t("primary.start"), cls: "mod-cta" });
    start.disabled = true;
    start.addEventListener("click", () => {
      this.close();
      void this.onConfirm();
    });

    this.sync
      .previewPrimary(this.cfg)
      .then(({ plan: p, localCount, remoteCount }) => {
        plan.empty();
        this.renderPlan(plan, notes, p, localCount, remoteCount);
        start.disabled = false;
      })
      .catch((e: unknown) => {
        plan.empty();
        const err = e instanceof DestinationError ? e : new DestinationError("io", "");
        plan.createDiv({ text: errorText(err.code, err.path), cls: "mb-plan-error" });
      });
  }

  private renderPlan(el: HTMLElement, notes: HTMLElement, p: SyncPlan, localCount: number, remoteCount: number): void {
    const count = (type: string) => p.ops.filter((o) => o.type === type).length;
    const conflicts = p.ops.filter((o) => o.type === "conflict").map((o) => o.path);
    el.createDiv({ text: t("primary.willDo"), cls: "mb-plan-head" });
    const row = (icon: string, label: string, n: number, detail?: string, warn = false) => {
      if (!n) return;
      const r = el.createDiv({ cls: ["mb-plan-row", warn ? "is-conflict" : ""].filter(Boolean) });
      setIcon(r.createSpan(), icon);
      r.createSpan({ text: label });
      r.createEl("b", { text: n.toLocaleString() });
      if (detail) r.createEl("small", { text: detail });
    };
    const down = count("download");
    const up = count("upload");
    row("arrow-down", remoteCount && !localCount ? t("primary.downloadAll") : t("primary.download"), down);
    row("arrow-up", !remoteCount ? t("primary.uploadAll") : t("primary.upload"), up);
    row("check", t("primary.same"), count("link") + p.unchanged);
    const shown = conflicts.slice(0, 3).join("、") + (conflicts.length > 3 ? " …" : "");
    row("git-compare", t("primary.conflict"), conflicts.length, t("primary.conflictDetail", { files: shown }), true);
    if (!down && !up && !conflicts.length) el.createDiv({ text: t("primary.nothing"), cls: ["mb-plan-row", "is-text"] });

    const note = (icon: string, text: string, warn = false) => {
      const n = notes.createDiv({ cls: ["mb-plan-note", warn ? "is-warn" : ""].filter(Boolean) });
      setIcon(n.createSpan(), icon);
      n.createSpan({ text });
    };
    if (!localCount && remoteCount) note("smartphone", t("primary.noteNewDevice"));
    else if (!remoteCount) note("smartphone", t("primary.noteEmptyRemote"));
    else note("check", t("primary.noteNoDelete"));
    if (this.current && this.current.id !== this.cfg.id) note("alert-triangle", t("primary.noteSwitch", { name: destDisplayName(this.current) }), true);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
