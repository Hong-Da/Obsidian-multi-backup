// 冲突列表（按 M3 预览页 conflicts.html 实现）：右侧边栏，列出还没处理的冲突与各自的处理按钮
import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { ConflictChoice } from "../core/conflict";
import { whenLabel } from "../core/format";
import type { ConflictRecord } from "../core/two-way";
import { currentLocale, t, tn } from "../i18n";
import type MultiBackupPlugin from "../main";
import { CompareModal } from "./compare-modal";

export const CONFLICTS_VIEW_TYPE = "multi-backup-conflicts";

export class ConflictsView extends ItemView {
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MultiBackupPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CONFLICTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("conflicts.title");
  }

  override getIcon(): string {
    return "git-compare";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mb-conflicts");
    const head = root.createDiv({ cls: "mb-conflicts-head" });
    this.countEl = head.createSpan({ cls: "mb-conflicts-count" });
    this.listEl = root.createDiv({ cls: "mb-conflicts-list" });
    this.registerEvent(this.plugin.sync.on("changed", () => this.render()));
    this.render();
  }

  private render(): void {
    const list = this.plugin.sync.conflicts;
    this.countEl.setText(list.length ? tn("conflicts.count", list.length) : "");
    this.listEl.empty();
    if (!list.length) {
      this.listEl.createDiv({ text: t("conflicts.empty"), cls: "mb-conflicts-empty" });
      return;
    }
    for (const c of [...list].sort((a, b) => b.time - a.time)) this.item(c);
  }

  private item(c: ConflictRecord): void {
    const el = this.listEl.createDiv({ cls: "mb-conflict" });
    el.createDiv({ text: c.path, cls: "mb-conflict-path" });
    const kind = el.createDiv({ cls: "mb-conflict-kind" });
    setIcon(kind.createSpan(), c.kind === "both" ? "git-compare" : "alert-triangle");
    kind.createSpan({ text: t(`conflicts.kind.${c.kind}`) });
    const meta = el.createDiv({ cls: "mb-conflict-meta" });
    const when = whenLabel(c.time, Date.now(), currentLocale());
    meta.createDiv({ text: t("conflicts.meta.found", { when, device: c.device ?? "remote" }) });
    if (c.copy) {
      const line = meta.createDiv();
      line.appendText(t("conflicts.meta.copy") + " ");
      line.createEl("code", { text: c.copy.slice(c.copy.lastIndexOf("/") + 1) });
    }
    const actions = el.createDiv({ cls: "mb-conflict-actions" });
    const btn = (label: string, choice: ConflictChoice | null, cta = false) => {
      const b = actions.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
      b.addEventListener("click", () => {
        if (choice === null) new CompareModal(this.app, this.plugin.sync, c).open();
        else void this.plugin.sync.resolve(c, choice);
      });
    };
    if (c.kind === "both") {
      btn(t("conflicts.compare"), null, true);
      btn(t("conflicts.keepMine"), "mine");
      btn(t("conflicts.keepRemote"), "remote");
      btn(t("conflicts.keepBoth"), "both");
    } else {
      btn(t("conflicts.keep"), "keep");
      btn(t(c.kind === "keepLocal" ? "conflicts.deleteToo" : "conflicts.delete"), "delete");
    }
  }
}
