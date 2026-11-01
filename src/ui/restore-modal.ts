// 从备份恢复（按 M4 预览页 restore.html 实现）：1 选择目的地和版本 → 2 选择范围 → 3 预览并恢复。
// 只把备份里的文件写回本机，不改动任何目的地。
import { Modal, setIcon, type App } from "obsidian";
import { DestinationError } from "../core/errors";
import { whenLabel } from "../core/format";
import type { RestorePlan, RestorePoint, RestoreSource } from "../core/restore";
import { currentLocale, t, tn } from "../i18n";
import type { DestinationConfig } from "../settings";
import type { SyncService } from "../sync-service";
import { destDisplayName, destWhere, errorText, typeLabel } from "./messages";

/** 各类型目的地的图标 */
export const TYPE_ICON: Record<DestinationConfig["type"], string> = {
  mirror: "folder",
  zip: "archive",
  git: "git-branch",
  "git-remote": "git-branch",
  webdav: "server",
  s3: "database",
  cloud: "cloud",
};

const PAGE = 20;

interface Folder {
  dirs: Map<string, Folder>;
  files: string[];
  /** 这个文件夹下（含子文件夹）的全部文件 */
  all: string[];
}

export class RestoreModal extends Modal {
  private step: 1 | 2 | 3 = 1;
  private dest: DestinationConfig | null = null;
  private src: RestoreSource | null = null;
  private points: RestorePoint[] = [];
  private limit = PAGE;
  private point: RestorePoint | null = null;
  private loadError = "";
  private loading = false;
  private files: string[] = [];
  private tree: Folder | null = null;
  private whole = true;
  private selected = new Set<string>();
  private expanded = new Set<string>();
  private query = "";
  private plan: RestorePlan | null = null;
  private removeExtra = false;
  /** 每次切换都加一，旧的异步结果到达时丢弃 */
  private ticket = 0;
  /** 第 2 步勾选、展开时只重画文件树和计数，不重画整个弹窗（保留滚动位置） */
  private redrawScope: (() => void) | null = null;

  constructor(
    app: App,
    private readonly sync: SyncService,
    private readonly preselect?: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("mb-restore-modal", "mb-restore-wizard");
    this.setTitle(t("restore.title"));
    const first = this.sync.restoreTargets().find((d) => d.id === this.preselect) ?? this.sync.restoreTargets()[0];
    if (first) void this.choose(first);
    else this.render();
  }

  override onClose(): void {
    this.ticket++;
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    const steps = el.createDiv({ cls: "mb-steps" });
    ["restore.step1", "restore.step2", "restore.step3"].forEach((k, i) => {
      const n = i + 1;
      steps.createSpan({ text: `${n}. ${t(k as "restore.step1")}`, cls: ["mb-step", n === this.step ? "is-active" : n < this.step ? "is-done" : ""].filter(Boolean) });
    });
    if (this.step === 1) this.renderSource(el);
    else if (this.step === 2) this.renderScope(el);
    else this.renderPreview(el);
  }

  // —— 第 1 步：目的地与版本 ——

  private async choose(d: DestinationConfig): Promise<void> {
    const my = ++this.ticket;
    this.dest = d;
    this.src = null;
    this.points = [];
    this.point = null;
    this.limit = PAGE;
    this.loadError = "";
    this.loading = true;
    this.render();
    try {
      const src = await this.sync.restoreSource(d);
      const points = await src.points(this.limit);
      if (my !== this.ticket) return;
      this.src = src;
      this.points = points;
      this.point = points[0] ?? null;
    } catch (e) {
      if (my !== this.ticket) return;
      this.loadError = e instanceof DestinationError ? errorText(e.code, e.path || destWhere(d)) : errorText("io", destWhere(d));
    }
    this.loading = false;
    this.render();
  }

  private async more(): Promise<void> {
    if (!this.src) return;
    const my = ++this.ticket;
    this.limit += PAGE;
    this.loading = true;
    this.render();
    try {
      const points = await this.src.points(this.limit);
      if (my !== this.ticket) return;
      this.points = points;
    } catch (e) {
      if (my !== this.ticket) return;
      this.loadError = e instanceof DestinationError ? errorText(e.code, e.path) : errorText("io");
    }
    this.loading = false;
    this.render();
  }

  private renderSource(el: HTMLElement): void {
    const targets = this.sync.restoreTargets();
    if (!targets.length) {
      el.createDiv({ text: t("restore.noDest"), cls: "mb-restore-empty" });
      this.footer(el, null, null);
      return;
    }
    const cols = el.createDiv({ cls: "mb-restore-cols" });
    const left = pane(cols, t("restore.dest"));
    for (const d of targets) {
      const item = left.createDiv({ cls: ["mb-restore-item", d === this.dest ? "is-active" : ""].filter(Boolean) });
      setIcon(item.createSpan({ cls: "mb-restore-icon" }), TYPE_ICON[d.type]);
      const text = item.createDiv();
      text.createDiv({ text: destDisplayName(d) });
      text.createEl("small", { text: `${typeLabel(d.type)} · ${destWhere(d) || "—"}` });
      item.addEventListener("click", () => {
        if (d !== this.dest) void this.choose(d);
      });
    }
    const mode = this.src?.mode;
    const right = pane(cols, t(mode === "snapshots" ? "restore.pickSnapshot" : mode === "current" ? "restore.pickCurrent" : "restore.pickCommit"));
    if (this.loading && !this.points.length) right.createDiv({ text: t("restore.loading"), cls: "mb-restore-empty" });
    else if (this.loadError) right.createDiv({ text: this.loadError, cls: "mb-restore-empty mod-warning" });
    else if (!this.points.length) right.createDiv({ text: t("restore.noVersions"), cls: "mb-restore-empty" });
    for (const p of this.points) {
      const item = right.createDiv({ cls: ["mb-restore-item", p === this.point ? "is-active" : ""].filter(Boolean) });
      setIcon(item.createSpan({ cls: "mb-restore-icon" }), "clock");
      const text = item.createDiv();
      const head = text.createDiv({ text: this.pointWhen(p) });
      if (p.short) {
        head.appendText(" · ");
        head.createEl("code", { text: p.short });
      }
      text.createEl("small", { text: mode === "current" ? t("restore.currentHint") : p.title });
      item.addEventListener("click", () => {
        this.point = p;
        this.render();
      });
    }
    if (mode !== "current" && this.points.length >= this.limit) {
      const item = right.createDiv({ cls: "mb-restore-item" });
      setIcon(item.createSpan({ cls: "mb-restore-icon" }), "more-horizontal");
      item.createEl("small", { text: this.loading ? t("restore.loading") : t("restore.more", { count: PAGE }) });
      item.addEventListener("click", () => void this.more());
    }
    this.footer(el, null, this.point ? () => void this.toScope() : null);
  }

  /** 时间点的时间；镜像的当前备份用这个目的地上次同步成功的时间 */
  private pointWhen(p: RestorePoint): string {
    const lang = currentLocale();
    if (p.time) return whenLabel(p.time, Date.now(), lang);
    const last = this.sync.history.find((e) => e.destinations.some((d) => d.id === this.dest?.id && d.status !== "failed"));
    return last ? t("restore.current", { when: whenLabel(last.finishedAt, Date.now(), lang) }) : t("restore.currentNever");
  }

  private pointLabel(): string {
    if (!this.point) return "";
    return this.point.short ? `${this.pointWhen(this.point)} · ${this.point.short}` : this.pointWhen(this.point);
  }

  // —— 第 2 步：范围 ——

  private async toScope(): Promise<void> {
    if (!this.src || !this.point || !this.dest) return;
    const my = ++this.ticket;
    this.step = 2;
    this.files = [];
    this.tree = null;
    this.selected.clear();
    this.loading = true;
    this.loadError = "";
    this.render();
    try {
      const keep = this.sync.restoreFilter(this.dest);
      const files = [...(await this.src.files(this.point.id)).keys()].filter(keep).sort();
      if (my !== this.ticket) return;
      this.files = files;
      this.tree = buildTree(files);
    } catch (e) {
      if (my !== this.ticket) return;
      this.loadError = e instanceof DestinationError ? errorText(e.code, e.path) : errorText("io");
    }
    this.loading = false;
    this.render();
  }

  private renderScope(el: HTMLElement): void {
    const box = el.createDiv({ cls: "mb-restore-pane" });
    box.createDiv({ text: t("restore.version", { dest: this.dest ? destDisplayName(this.dest) : "", point: this.pointLabel() }), cls: "mb-restore-head" });
    const modes = box.createDiv({ cls: "mb-restore-modes" });
    for (const whole of [true, false]) {
      const label = modes.createEl("label");
      const r = label.createEl("input", { type: "radio", attr: { name: "mb-restore-mode" } });
      r.checked = this.whole === whole;
      label.appendText(t(whole ? "restore.whole" : "restore.choose"));
      r.addEventListener("change", () => {
        this.whole = whole;
        this.render();
      });
    }
    if (this.loading) box.createDiv({ text: t("restore.loading"), cls: "mb-restore-empty" });
    else if (this.loadError) box.createDiv({ text: this.loadError, cls: "mb-restore-empty mod-warning" });
    let list: HTMLElement | null = null;
    if (!this.loading && !this.loadError && !this.whole && this.tree) {
      const search = box.createDiv({ cls: "mb-restore-search" }).createEl("input", { type: "search", attr: { placeholder: t("restore.search") } });
      search.value = this.query;
      list = box.createDiv({ cls: "mb-restore-tree" });
      search.addEventListener("input", () => {
        this.query = search.value;
        this.redrawScope?.();
      });
    }
    const countEl = this.loading || this.loadError ? null : box.createDiv({ cls: "mb-restore-head" });
    const next = this.footer(el, () => {
      this.step = 1;
      this.render();
    }, () => void this.toPreview());
    this.redrawScope = () => {
      if (list) {
        const top = list.scrollTop;
        list.empty();
        if (this.query.trim()) this.renderMatches(list);
        else this.renderFolder(list, this.tree as Folder, "", 0);
        list.scrollTop = top;
      }
      const count = this.whole ? this.files.length : this.selected.size;
      countEl?.setText(tn(this.whole ? "restore.countAll" : "restore.countSelected", count));
      next.disabled = !count || this.loading || !!this.loadError;
    };
    this.redrawScope();
  }

  private renderFolder(list: HTMLElement, f: Folder, prefix: string, level: number): void {
    for (const [name, sub] of [...f.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name;
      const open = this.expanded.has(path);
      this.node(list, level, open ? "folder-open" : "folder", name, sub.all, String(sub.all.length), open, () => {
        if (open) this.expanded.delete(path);
        else this.expanded.add(path);
        this.redrawScope?.();
      });
      if (open) this.renderFolder(list, sub, path + "/", level + 1);
    }
    for (const file of f.files) this.node(list, level, "file", file.slice(prefix.length), [file], "", false);
  }

  private renderMatches(list: HTMLElement): void {
    const q = this.query.trim().toLowerCase();
    const hits = this.files.filter((p) => p.toLowerCase().includes(q));
    for (const p of hits.slice(0, 200)) this.node(list, 0, "file", p, [p], "", false);
    if (hits.length > 200) list.createDiv({ text: t("restore.tooMany", { count: hits.length }), cls: "mb-restore-empty" });
    if (!hits.length) list.createDiv({ text: t("restore.noMatch"), cls: "mb-restore-empty" });
  }

  /** 树的一行：勾选框（文件夹按其下文件全选、部分选、未选三态）、图标、名称、文件数 */
  private node(list: HTMLElement, level: number, icon: string, name: string, files: string[], count: string, open: boolean, toggleOpen?: () => void): void {
    const row = list.createDiv({ cls: "mb-restore-node" });
    row.style.setProperty("--mb-level", String(level));
    // 文件夹前面是展开箭头，文件前面留同样宽的空位，保持对齐
    const chevron = row.createSpan({ cls: ["mb-restore-chevron", toggleOpen ? "is-folder" : ""].filter(Boolean) });
    if (toggleOpen) {
      setIcon(chevron, open ? "chevron-down" : "chevron-right");
      chevron.addEventListener("click", toggleOpen);
    }
    const box = row.createEl("input", { type: "checkbox" });
    const n = files.filter((p) => this.selected.has(p)).length;
    box.checked = n > 0 && n === files.length;
    box.indeterminate = n > 0 && n < files.length;
    box.addEventListener("change", () => {
      for (const p of files) {
        if (box.checked) this.selected.add(p);
        else this.selected.delete(p);
      }
      this.redrawScope?.();
    });
    setIcon(row.createSpan({ cls: "mb-restore-icon" }), icon);
    const label = row.createSpan({ text: name, cls: "mb-restore-name" });
    if (toggleOpen) {
      label.addClass("is-folder");
      label.addEventListener("click", toggleOpen);
    }
    if (count) row.createEl("small", { text: count });
  }

  // —— 第 3 步：预览并恢复 ——

  private async toPreview(): Promise<void> {
    if (!this.src || !this.point || !this.dest) return;
    const my = ++this.ticket;
    this.step = 3;
    this.plan = null;
    this.loadError = "";
    this.render();
    const progressEl = this.contentEl.querySelector(".mb-restore-progress");
    try {
      // 整个 Vault 时一并算出“本机多出的文件”，勾选与否只影响执行
      const plan = await this.sync.previewRestore(this.dest, this.src, this.point.id, this.whole ? null : [...this.selected], this.whole, (done, total) => {
        if (my === this.ticket) progressEl?.setText(t("restore.comparing", { done, total }));
      });
      if (my !== this.ticket) return;
      this.plan = plan;
    } catch (e) {
      if (my !== this.ticket) return;
      this.loadError = e instanceof DestinationError ? errorText(e.code, e.path) : errorText("io");
    }
    this.render();
  }

  private renderPreview(el: HTMLElement): void {
    const back = () => {
      this.ticket++;
      this.step = 2;
      this.render();
    };
    const box = el.createDiv({ cls: "mb-restore-pane" });
    const plan = this.plan;
    if (!plan) {
      box.createDiv({ text: this.loadError || t("restore.loading"), cls: ["mb-restore-empty", "mb-restore-progress", this.loadError ? "mod-warning" : ""].filter(Boolean) });
      this.footer(el, back, null);
      return;
    }
    const total = plan.add.length + plan.overwrite.length + plan.same.length;
    box.createDiv({ text: tn("restore.planHead", total, { when: this.pointLabel() }), cls: "mb-restore-head" });
    const row = (icon: string, label: string, list: string[], note?: string, over = false) => {
      const r = box.createDiv({ cls: ["mb-plan-row", over ? "is-over" : ""].filter(Boolean) });
      setIcon(r.createSpan({ cls: "mb-restore-icon" }), icon);
      r.createSpan({ text: label });
      r.createEl("b", { text: list.length.toLocaleString() });
      if (list.length && note !== undefined) {
        const s = r.createEl("small");
        s.appendText(t("restore.example") + " ");
        s.createEl("code", { text: list[0] as string });
        if (list.length > 1) s.appendText(" " + t("restore.andMore"));
        if (note) s.appendText(" " + note);
      }
    };
    row("plus", t("restore.add"), plan.add, "");
    row("refresh-cw", t("restore.overwrite"), plan.overwrite, t("restore.overwriteNote"), true);
    row("check", t("restore.same"), plan.same);
    if (this.whole && this.removeExtra) row("trash-2", t("restore.remove"), plan.remove, "", true);

    const saved = plan.overwrite.length + (this.whole && this.removeExtra ? plan.remove.length : 0);
    if (saved) {
      const note = el.createDiv({ cls: "mb-restore-note" });
      setIcon(note.createSpan({ cls: "mb-restore-icon" }), "undo-2");
      note.createSpan({ text: tn("restore.savedNote", saved) });
    }
    if (this.whole) {
      const opt = el.createEl("label", { cls: "mb-restore-opt" });
      const c = opt.createEl("input", { type: "checkbox" });
      c.checked = this.removeExtra;
      c.addEventListener("change", () => {
        this.removeExtra = c.checked;
        this.render();
      });
      const text = opt.createSpan({ text: tn("restore.removeExtra", plan.remove.length) });
      text.createEl("small", { text: t("restore.removeExtraNote") });
    }

    const n = plan.add.length + plan.overwrite.length + (this.whole && this.removeExtra ? plan.remove.length : 0);
    this.footer(
      el,
      back,
      n
        ? () => {
            const run: RestorePlan = { ...plan, remove: this.whole && this.removeExtra ? plan.remove : [] };
            this.close();
            if (this.dest && this.src && this.point) void this.sync.restore(this.dest, this.src, this.point.id, this.pointLabel(), run);
          }
        : null,
      n ? tn("restore.go", n) : t("restore.nothing"),
      t("restore.help"),
    );
  }

  private footer(el: HTMLElement, back: (() => void) | null, next: (() => void) | null, nextText = t("restore.next"), help = ""): HTMLButtonElement {
    const f = el.createDiv({ cls: "mb-restore-footer" });
    f.createSpan({ text: help, cls: "mb-restore-help" });
    const b1 = f.createEl("button", { text: back ? t("restore.back") : t("common.cancel") });
    b1.addEventListener("click", () => (back ? back() : this.close()));
    const b2 = f.createEl("button", { text: nextText, cls: "mod-cta" });
    b2.disabled = !next;
    if (next) b2.addEventListener("click", next);
    return b2;
  }
}

function pane(parent: HTMLElement, title: string): HTMLElement {
  const p = parent.createDiv({ cls: "mb-restore-pane" });
  p.createDiv({ text: title, cls: "mb-restore-head" });
  return p.createDiv({ cls: "mb-restore-body" });
}

export function buildTree(files: string[]): Folder {
  const root: Folder = { dirs: new Map(), files: [], all: [] };
  for (const p of files) {
    const parts = p.split("/");
    let f = root;
    f.all.push(p);
    for (const part of parts.slice(0, -1)) {
      let next = f.dirs.get(part);
      if (!next) f.dirs.set(part, (next = { dirs: new Map(), files: [], all: [] }));
      f = next;
      f.all.push(p);
    }
    f.files.push(p);
  }
  return root;
}
