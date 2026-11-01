// 单个文件的历史版本（按 M4 预览页 restore.html 的“单个文件的历史版本”实现）：
// 左边列出各目的地中这个文件的版本，右边显示内容并标出和现在不同的行；可以恢复选中的版本（可撤销）。
import { Modal, normalizePath, setIcon, type App } from "obsidian";
import { DestinationError } from "../core/errors";
import { sizeLabel, whenLabel } from "../core/format";
import { diffLines } from "../core/line-diff";
import { hashOf, type FileVersion, type RestoreSource } from "../core/restore";
import { currentLocale, t } from "../i18n";
import type { DestinationConfig } from "../settings";
import type { SyncService } from "../sync-service";
import { TEXT_EXT } from "./compare-modal";
import { destDisplayName, errorText } from "./messages";
import { TYPE_ICON } from "./restore-modal";

interface Item {
  dest: DestinationConfig;
  src: RestoreSource;
  v: FileVersion;
}

export class FileHistoryModal extends Modal {
  private items: Item[] = [];
  private errors: string[] = [];
  private pending = 0;
  private current: Item | null = null;
  private listEl!: HTMLElement;
  private viewEl!: HTMLElement;
  private viewHead!: HTMLElement;
  private restoreBtn!: HTMLButtonElement;
  private closed = false;

  constructor(
    app: App,
    private readonly sync: SyncService,
    private readonly path: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("mb-restore-modal");
    this.setTitle(t("fileHistory.title", { path: this.path }));
    const cols = this.contentEl.createDiv({ cls: "mb-restore-cols" });
    const left = cols.createDiv({ cls: "mb-restore-pane" });
    left.createDiv({ text: t("fileHistory.versions"), cls: "mb-restore-head" });
    this.listEl = left.createDiv({ cls: "mb-restore-body" });
    const right = cols.createDiv({ cls: "mb-restore-pane" });
    this.viewHead = right.createDiv({ text: t("fileHistory.pick"), cls: "mb-restore-head" });
    this.viewEl = right.createDiv({ cls: "mb-restore-body mb-restore-preview" });

    const f = this.contentEl.createDiv({ cls: "mb-restore-footer" });
    f.createSpan({ text: t("fileHistory.help"), cls: "mb-restore-help" });
    f.createEl("button", { text: t("fileHistory.close") }).addEventListener("click", () => this.close());
    this.restoreBtn = f.createEl("button", { text: t("fileHistory.restore"), cls: "mod-cta" });
    this.restoreBtn.disabled = true;
    this.restoreBtn.addEventListener("click", () => void this.restore());

    const dests = this.sync.restoreTargets();
    this.pending = dests.length;
    this.renderList();
    for (const d of dests) void this.load(d);
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async load(d: DestinationConfig): Promise<void> {
    try {
      const src = await this.sync.restoreSource(d);
      const vers = await src.fileVersions(this.path, 20);
      this.items.push(...vers.map((v) => ({ dest: d, src, v })));
      this.items.sort((a, b) => b.v.time - a.v.time);
    } catch (e) {
      // 用不了的目的地（没插硬盘、没网）不影响其他目的地
      this.errors.push(`${destDisplayName(d)}：${e instanceof DestinationError ? errorText(e.code, e.path) : errorText("io")}`);
    }
    this.pending--;
    if (this.closed) return;
    this.renderList();
    const newest = this.items[0];
    if (!this.pending && !this.current && newest) void this.show(newest);
  }

  private renderList(): void {
    const el = this.listEl;
    el.empty();
    const lang = currentLocale();
    for (const it of this.items) {
      const row = el.createDiv({ cls: ["mb-restore-item", it === this.current ? "is-active" : ""].filter(Boolean) });
      setIcon(row.createSpan({ cls: "mb-restore-icon" }), TYPE_ICON[it.dest.type]);
      const text = row.createDiv();
      const head = text.createDiv({ text: destDisplayName(it.dest) });
      if (it.v.short) {
        head.appendText(" · ");
        head.createEl("code", { text: it.v.short });
      }
      const kind = it.v.pointId === "current" ? t("fileHistory.current") : it.v.pointId.startsWith("v:") ? t("fileHistory.version") : "";
      text.createEl("small", { text: [whenLabel(it.v.time, Date.now(), lang), kind].filter(Boolean).join(" · ") });
      row.addEventListener("click", () => void this.show(it));
    }
    if (this.pending) el.createDiv({ text: t("restore.loading"), cls: "mb-restore-empty" });
    else if (!this.items.length) el.createDiv({ text: t("fileHistory.none"), cls: "mb-restore-empty" });
    for (const e of this.errors) el.createDiv({ text: e, cls: "mb-restore-empty mod-warning" });
  }

  private async show(it: Item): Promise<void> {
    this.current = it;
    this.renderList();
    this.restoreBtn.disabled = true;
    this.viewEl.empty();
    this.viewEl.createDiv({ text: t("restore.loading"), cls: "mb-restore-empty" });
    let data: Uint8Array;
    try {
      data = await it.src.read(it.v.pointId, this.path);
    } catch (e) {
      if (this.current !== it) return;
      this.viewEl.empty();
      this.viewEl.createDiv({ text: e instanceof DestinationError ? errorText(e.code, e.path) : errorText("io"), cls: "mb-restore-empty mod-warning" });
      return;
    }
    if (this.current !== it) return;
    const adapter = this.app.vault.adapter;
    const p = normalizePath(this.path);
    const local = (await adapter.exists(p)) ? new Uint8Array(await adapter.readBinary(p)) : null;
    const same = !!local && local.byteLength === data.byteLength && (await hashOf(local)) === (await hashOf(data));
    const when = whenLabel(it.v.time, Date.now(), currentLocale());
    this.viewHead.setText(same ? t("fileHistory.same", { when }) : t(TEXT_EXT.test(this.path) ? "fileHistory.content" : "fileHistory.contentBinary", { when }));
    this.viewEl.empty();
    if (TEXT_EXT.test(this.path)) {
      const dec = new TextDecoder();
      // 右边是这个版本：和现在不同的行标出来
      const { right } = diffLines(local ? dec.decode(local) : "", dec.decode(data));
      for (const l of right) this.viewEl.createDiv({ text: l.text || " ", cls: ["mb-restore-line", l.kind === "changed" ? "is-changed" : ""].filter(Boolean) });
    } else this.viewEl.createDiv({ text: t("fileHistory.binary", { size: sizeLabel(data.byteLength) }), cls: "mb-restore-empty" });
    this.restoreBtn.disabled = same;
  }

  private async restore(): Promise<void> {
    const it = this.current;
    if (!it) return;
    const exists = await this.app.vault.adapter.exists(normalizePath(this.path));
    const label = [whenLabel(it.v.time, Date.now(), currentLocale()), it.v.short].filter(Boolean).join(" · ");
    this.close();
    await this.sync.restore(it.dest, it.src, it.v.pointId, label, { add: exists ? [] : [this.path], overwrite: exists ? [this.path] : [], same: [], remove: [] });
  }
}
