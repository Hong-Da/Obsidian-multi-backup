// 同步历史视图（按 M1 预览页 history.html 实现）：右侧边栏，按天分组，可展开看文件与错误
import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { dayLabel, timeOnly, whenLabel } from "../core/format";
import { HISTORY_LIMIT, type HistoryDestination, type HistoryEntry } from "../core/history";
import type { RingState } from "../core/overview";
import { currentLocale, t, type Locale } from "../i18n";
import type MultiBackupPlugin from "../main";
import { confirmAction } from "./confirm-modal";
import { errorText, durationText } from "./messages";
import { renderRing } from "./ring";

export const HISTORY_VIEW_TYPE = "multi-backup-history";

export class HistoryView extends ItemView {
  private destFilter = "";
  private onlyFailed = false;
  private readonly expanded = new Set<string>();
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private selectEl!: HTMLSelectElement;
  private restoresEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MultiBackupPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("history.title");
  }

  override getIcon(): string {
    return "history";
  }

  /** 从目的地菜单打开时只看这个目的地 */
  setDestination(id: string): void {
    this.destFilter = id;
    this.render();
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mb-history");
    this.restoresEl = root.createDiv({ cls: "mb-history-restores" });
    const filters = root.createDiv({ cls: "mb-history-filters" });
    this.selectEl = filters.createEl("select", { cls: "dropdown" });
    this.selectEl.addEventListener("change", () => {
      this.destFilter = this.selectEl.value;
      this.render();
    });
    const seg = filters.createDiv({ cls: "mb-seg" });
    for (const [failed, label] of [
      [false, t("history.all")],
      [true, t("history.failed")],
    ] as const) {
      const b = seg.createEl("button", { text: label, attr: { "aria-pressed": String(this.onlyFailed === failed) } });
      b.addEventListener("click", () => {
        this.onlyFailed = failed;
        seg.querySelectorAll("button").forEach((x) => x.setAttr("aria-pressed", String(x === b)));
        this.render();
      });
    }
    // 立即同步、恢复：放在内容里，侧栏会隐藏视图标题栏，addAction 的按钮看不到
    for (const [icon, label, run] of [
      ["refresh-cw", t("menu.syncAll"), () => void this.plugin.sync.syncAll("sidebar")],
      ["undo-2", t("menu.restore"), () => this.plugin.openRestore(this.destFilter || undefined)],
    ] as const) {
      const b = filters.createEl("button", { cls: "clickable-icon mb-history-action", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", run);
    }
    this.listEl = root.createDiv({ cls: "mb-history-runs" });
    const footer = root.createDiv({ cls: "mb-history-footer" });
    this.countEl = footer.createSpan();
    footer.createDiv({ cls: "mb-spacer" });
    const clear = footer.createEl("button", { text: t("history.clear"), cls: "mb-link-button" });
    clear.addEventListener("click", () => {
      void confirmAction(this.app, t("confirm.clear.title"), t("confirm.clear.body"), t("confirm.clear.ok")).then(async (ok) => {
        if (ok) await this.plugin.sync.clearHistory();
      });
    });
    this.registerEvent(this.plugin.sync.on("changed", () => this.render()));
    this.render();
  }

  render(): void {
    if (!this.listEl) return;
    const lang = currentLocale();
    const history = this.plugin.sync.history;

    // 目的地下拉：当前设置中的 + 历史里出现过的
    const names = new Map<string, string>();
    for (const e of history) for (const d of e.destinations) if (!names.has(d.id)) names.set(d.id, d.name);
    this.selectEl.empty();
    this.selectEl.createEl("option", { text: t("history.allDest"), value: "" });
    for (const [id, name] of names) this.selectEl.createEl("option", { text: name, value: id });
    this.selectEl.value = names.has(this.destFilter) ? this.destFilter : "";

    this.renderRestores(lang);
    this.listEl.empty();
    const now = Date.now();
    let shown = 0;
    let lastDay = "";
    for (const entry of history) {
      for (const d of entry.destinations) {
        if (this.destFilter && d.id !== this.destFilter) continue;
        const failed = d.status === "failed" || d.status === "partial";
        if (this.onlyFailed && !failed) continue;
        const day = dayLabel(entry.finishedAt, now, lang);
        if (day !== lastDay) {
          this.listEl.createDiv({ text: day, cls: "mb-history-day" });
          lastDay = day;
        }
        this.renderRun(entry, d, lang);
        shown++;
      }
    }
    if (!shown) {
      const empty = this.listEl.createDiv({ cls: "mb-history-empty" });
      if (!history.length) {
        renderRing(empty, "idle");
        empty.createEl("p", { text: t("history.empty") });
      } else empty.createEl("p", { text: t("history.noMatch") });
    }
    this.countEl.setText(t("history.count", { count: history.length, limit: HISTORY_LIMIT }));
  }

  /** 最近 3 天内还能撤销的恢复，可以一键撤销 */
  private renderRestores(lang: Locale): void {
    const el = this.restoresEl;
    el.empty();
    const sync = this.plugin.sync;
    const recent = sync.restores.filter((r) => !r.undone && Date.now() - r.time < 3 * 86400_000).slice(0, 3);
    for (const r of recent) {
      const row = el.createDiv({ cls: "mb-history-restore" });
      setIcon(row.createSpan({ cls: "mb-run-icon" }), "undo-2");
      const text = row.createDiv({ cls: "mb-history-restore-text" });
      text.createDiv({ text: t("history.restored", { count: r.added.length + r.overwritten.length, dest: r.destName }) });
      text.createEl("small", { text: `${whenLabel(r.time, Date.now(), lang)} · ${t("history.restoredFrom", { point: r.point })}` });
      const b = row.createEl("button", { text: t("restore.undo") });
      b.disabled = sync.restoring || !!sync.running;
      b.addEventListener("click", () => void sync.undoRestore(r));
    }
  }

  private renderRun(entry: HistoryEntry, d: HistoryDestination, lang: Locale): void {
    const key = `${entry.id}:${d.id}`;
    const failed = d.status === "failed" || d.status === "partial";
    const run = this.listEl.createDiv({ cls: ["mb-run", failed ? "is-error" : "", this.expanded.has(key) ? "is-open" : ""].filter(Boolean) });
    const head = run.createEl("button", { cls: "mb-run-head", attr: { "aria-expanded": String(this.expanded.has(key)) } });
    const ring: RingState = failed ? "error" : "ok";
    renderRing(head, ring);
    head.createSpan({ text: timeOnly(entry.finishedAt), cls: "mb-run-time" });
    const dest = head.createSpan({ cls: "mb-run-dest" });
    dest.appendText(d.name);
    dest.createEl("small", { text: t(`history.trigger.${entry.trigger}`) });
    const counts = head.createSpan({ cls: "mb-run-counts" });
    if (d.status === "failed") counts.setText(t("history.failed"));
    // 成功但没有任何改动（如镜像重新连上后核对一致）也写“没有变化”，不留空白
    else if (d.status === "unchanged" || (d.uploaded + d.moved + d.deleted + d.failedCount === 0 && !d.primary?.downloaded)) counts.setText(t("history.unchanged"));
    else {
      const add = (icon: string, n: number) => {
        if (!n) return;
        const s = counts.createSpan();
        setIcon(s.createSpan({ cls: "mb-run-icon" }), icon);
        s.appendText(n.toLocaleString());
      };
      add("arrow-down", d.primary?.downloaded ?? 0);
      add("arrow-up", d.uploaded);
      add("move-right", d.moved);
      add("trash-2", d.deleted);
      add("alert-triangle", d.failedCount);
    }
    head.addEventListener("click", () => {
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      this.render();
    });

    const body = run.createDiv({ cls: "mb-run-body" });
    if (failed) body.createDiv({ text: errorText(d.errorCode, d.errorPath), cls: "mb-run-error" });
    const meta = body.createDiv({ cls: "mb-run-meta" });
    meta.createSpan({ text: t("history.took", { dur: durationText(d.durationMs) }) });
    meta.createSpan({ text: t("history.uploaded", { n: d.uploaded }) });
    if (d.moved) meta.createSpan({ text: t("history.moved", { n: d.moved }) });
    meta.createSpan({ text: t("history.deleted", { n: d.deleted }) });
    if (d.failedCount) meta.createSpan({ text: t("history.failedN", { n: d.failedCount }) });
    if (entry.skippedLarge.length) meta.createSpan({ text: t("history.skipped", { n: entry.skippedLarge.length }) });
    if (d.snapshot) body.createDiv({ text: t("history.snapshot", { name: d.snapshot }), cls: "mb-run-snapshot" });
    if ((d.type === "git" || d.type === "git-remote") && d.status !== "failed") body.createDiv({ text: d.commit ? t("history.commit", { commit: d.commit }) : t("history.noCommit"), cls: "mb-run-snapshot" });
    if (d.changes.length || d.failures.length) {
      const ul = body.createEl("ul");
      for (const f of d.failures) {
        const li = ul.createEl("li", { cls: "is-error" });
        li.createSpan({ text: t(`history.op.${f.op as "upload" | "move" | "delete"}`), cls: "mb-op" });
        li.appendText(f.path);
      }
      for (const c of d.changes) {
        const li = ul.createEl("li");
        li.createSpan({ text: t(`history.op.${c.op}`), cls: "mb-op" });
        li.appendText(c.path);
      }
    }
    const rest = d.changeCount - d.changes.length;
    if (rest > 0) body.createDiv({ text: t("history.more", { n: rest.toLocaleString() }), cls: "mb-run-more" });
    if (failed) {
      const copy = body.createEl("button", { text: t("history.copyError") });
      copy.addEventListener("click", () => {
        const text = [`${d.name} ${new Date(entry.finishedAt).toISOString()}`, errorText(d.errorCode, d.errorPath), ...d.failures.map((f) => `${f.op} ${f.path}: ${f.code}`)].join("\n");
        void navigator.clipboard.writeText(text).then(() => copy.setText(t("history.copied")));
      });
    }
    void lang;
  }
}
