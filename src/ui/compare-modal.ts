// 冲突对比（按 M3 预览页 compare.html 实现）：左边本机版本，右边远程版本（冲突副本），按行标出不同；手机上用标签切换
import { Modal, normalizePath, Platform, setIcon, type App } from "obsidian";
import type { ConflictChoice } from "../core/conflict";
import { diffLines, type DiffLine } from "../core/line-diff";
import type { ConflictRecord } from "../core/two-way";
import { t } from "../i18n";
import type { SyncService } from "../sync-service";

/** 能按行对比的文件 */
export const TEXT_EXT = /\.(md|txt|canvas|json|css|js|ts|csv|html?|xml|ya?ml|base)$/i;

export class CompareModal extends Modal {
  private show: "local" | "remote" = "local";

  constructor(
    app: App,
    private readonly sync: SyncService,
    private readonly c: ConflictRecord,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.modalEl.addClass("mb-compare-modal");
    this.setTitle(t("compare.title"));
    const { contentEl } = this;
    contentEl.createDiv({ text: this.c.path, cls: "mb-compare-path" });
    const adapter = this.app.vault.adapter;
    const copy = this.c.copy ?? "";
    const text = TEXT_EXT.test(this.c.path);
    const [local, remote] = text
      ? await Promise.all([adapter.read(normalizePath(this.c.path)).catch(() => ""), adapter.read(normalizePath(copy)).catch(() => "")])
      : ["", ""];

    let colsEl: HTMLElement | null = null;
    if (Platform.isPhone) {
      const tabs = contentEl.createDiv({ cls: "mb-compare-tabs" });
      for (const side of ["local", "remote"] as const) {
        const b = tabs.createEl("button", { text: t(side === "local" ? "compare.tabLocal" : "compare.tabRemote") });
        b.toggleClass("is-active", this.show === side);
        b.addEventListener("click", () => {
          this.show = side;
          tabs.querySelectorAll("button").forEach((x) => x.toggleClass("is-active", x === b));
          colsEl?.setAttr("data-show", side);
        });
      }
    }
    colsEl = contentEl.createDiv({ cls: "mb-compare-cols", attr: { "data-show": this.show } });
    const { left, right } = text ? diffLines(local, remote) : { left: [], right: [] };
    this.column(colsEl, "local", "laptop", t("compare.local"), left, text);
    this.column(colsEl, "remote", "smartphone", t("compare.remote", { device: this.c.device ?? "remote" }), right, text);
    if (text) contentEl.createDiv({ text: t("compare.legend"), cls: "mb-compare-legend" });
    else contentEl.createDiv({ text: t("compare.binary"), cls: "mb-compare-legend" });

    const footer = contentEl.createDiv({ cls: "mb-compare-footer" });
    footer.createSpan({ text: t("compare.help"), cls: "mb-compare-help" });
    const act = (label: string, choice: ConflictChoice | null, cta = false) => {
      const b = footer.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
      b.addEventListener("click", () => {
        if (choice) void this.sync.resolve(this.c, choice);
        this.close();
      });
    };
    act(t("conflicts.keepMine"), "mine");
    act(t("conflicts.keepRemote"), "remote");
    act(t("conflicts.keepBoth"), "both");
    act(t("compare.later"), null, true);
  }

  private column(parent: HTMLElement, side: "local" | "remote", icon: string, title: string, lines: DiffLine[], text: boolean): void {
    const col = parent.createDiv({ cls: `mb-compare-col mb-compare-${side}` });
    const head = col.createDiv({ cls: "mb-compare-head" });
    setIcon(head.createSpan(), icon);
    head.createSpan({ text: title });
    const body = col.createDiv({ cls: "mb-compare-code" });
    if (!text) {
      const path = side === "local" ? this.c.path : (this.c.copy ?? "");
      const b = body.createEl("button", { text: t("compare.open") });
      b.addEventListener("click", () => void this.app.workspace.openLinkText(path, "", true));
      return;
    }
    lines.forEach((l, i) => {
      const row = body.createDiv({ cls: `mb-compare-line${l.kind === "changed" ? " is-changed" : ""}` });
      row.createSpan({ text: String(i + 1), cls: "mb-compare-ln" });
      row.createSpan({ text: l.text || " " });
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
