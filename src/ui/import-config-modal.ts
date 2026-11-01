// 导入插件配置（按 M5 预览页 config.html 实现）：1 选来源（文件或目的地）→ 2 选版本（有多台设备上传过时）→ 3 确认后导入。
import { Modal, Notice, setIcon, type App } from "obsidian";
import type { ConfigFile } from "../core/config-backup";
import { DestinationError } from "../core/errors";
import { whenLabel } from "../core/format";
import { currentLocale, t, tn } from "../i18n";
import type { DestinationConfig } from "../settings";
import type { SyncService } from "../sync-service";
import { destDisplayName, errorText, typeLabel } from "./messages";
import { TYPE_ICON } from "./restore-modal";

type Source = { kind: "file"; path: string } | { kind: "dest"; dest: DestinationConfig };

export class ImportConfigModal extends Modal {
  private step: 1 | 2 | 3 = 1;
  private source: Source | null = null;
  private configs: ConfigFile[] = [];
  private chosen: ConfigFile | null = null;
  private loading = false;
  private error = "";
  private ticket = 0;

  constructor(
    app: App,
    private readonly sync: SyncService,
    private readonly onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("mb-restore-modal", "mb-import-modal");
    this.setTitle(t("importConfig.title"));
    this.render();
  }

  override onClose(): void {
    this.ticket++;
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    if (this.step === 1) this.renderSource(el);
    else if (this.step === 2) this.renderVersions(el);
    else this.renderConfirm(el);
  }

  private renderSource(el: HTMLElement): void {
    el.createEl("p", { text: t("importConfig.desc"), cls: "mb-modal-sub" });
    const box = el.createDiv({ cls: "mb-restore-pane" });
    box.createDiv({ text: t("importConfig.from"), cls: "mb-restore-head" });
    const body = box.createDiv({ cls: "mb-restore-body" });
    const item = (icon: string, title: string, sub: string, src: Source) => {
      const active = JSON.stringify(src) === JSON.stringify(this.source);
      const row = body.createDiv({ cls: ["mb-restore-item", active ? "is-active" : ""].filter(Boolean) });
      setIcon(row.createSpan({ cls: "mb-restore-icon" }), icon);
      const text = row.createDiv();
      text.createDiv({ text: title });
      text.createEl("small", { text: sub });
      row.addEventListener("click", () => {
        this.source = src;
        this.render();
      });
    };
    const files = this.sync.configFilesInVault();
    for (const f of files) item("file-json", t("importConfig.file"), f, { kind: "file", path: f });
    if (!files.length) body.createDiv({ text: t("importConfig.noFile"), cls: "mb-restore-empty" });
    for (const d of this.sync.restoreTargets()) item(TYPE_ICON[d.type], destDisplayName(d), typeLabel(d.type), { kind: "dest", dest: d });
    this.footer(el, null, this.source ? () => void this.load() : null);
  }

  private async load(): Promise<void> {
    const src = this.source;
    if (!src) return;
    const my = ++this.ticket;
    this.step = 2;
    this.loading = true;
    this.error = "";
    this.configs = [];
    this.render();
    try {
      let list: ConfigFile[];
      if (src.kind === "file") {
        const c = await this.sync.readConfigFile(src.path);
        list = c ? [c] : [];
      } else list = await this.sync.readConfigs(src.dest);
      if (my !== this.ticket) return;
      this.configs = list;
      this.chosen = list[0] ?? null;
      this.loading = false;
      // 只有一份时直接到确认
      if (list.length === 1) this.step = 3;
    } catch (e) {
      if (my !== this.ticket) return;
      this.loading = false;
      this.error = e instanceof DestinationError ? errorText(e.code, e.path) : errorText("io");
    }
    this.render();
  }

  private back(to: 1 | 2): void {
    this.ticket++;
    this.step = to === 2 && this.configs.length > 1 ? 2 : 1;
    this.render();
  }

  private renderVersions(el: HTMLElement): void {
    const box = el.createDiv({ cls: "mb-restore-pane" });
    box.createDiv({ text: t("importConfig.versions"), cls: "mb-restore-head" });
    const body = box.createDiv({ cls: "mb-restore-body" });
    if (this.loading) body.createDiv({ text: t("restore.loading"), cls: "mb-restore-empty" });
    else if (this.error) body.createDiv({ text: this.error, cls: "mb-restore-empty mod-warning" });
    else if (!this.configs.length) body.createDiv({ text: t(this.source?.kind === "file" ? "importConfig.badFile" : "importConfig.none"), cls: "mb-restore-empty" });
    const lang = currentLocale();
    for (const c of this.configs) {
      const row = body.createDiv({ cls: ["mb-restore-item", c === this.chosen ? "is-active" : ""].filter(Boolean) });
      setIcon(row.createSpan({ cls: "mb-restore-icon" }), "laptop");
      const text = row.createDiv();
      text.createDiv({ text: c.device || t("importConfig.unknownDevice") });
      const n = Array.isArray(c.settings.destinations) ? c.settings.destinations.length : 0;
      text.createEl("small", { text: [c.time ? t("importConfig.changed", { when: whenLabel(c.time, Date.now(), lang) }) : "", tn("importConfig.destCount", n), c.plugin ? t("importConfig.plugin", { version: c.plugin }) : ""].filter(Boolean).join(" · ") });
      row.addEventListener("click", () => {
        this.chosen = c;
        this.render();
      });
    }
    this.footer(el, () => this.back(1), this.chosen && !this.loading ? () => ((this.step = 3), this.render()) : null);
  }

  private renderConfirm(el: HTMLElement): void {
    const c = this.chosen;
    if (!c) return this.back(1);
    const info = this.sync.describeImport(c);
    const lang = currentLocale();
    el.createEl("p", {
      text: !c.device
        ? t("importConfig.fromFile")
        : c.time
          ? t("importConfig.fromDevice", { device: c.device, when: whenLabel(c.time, Date.now(), lang) })
          : t("importConfig.fromDeviceNoTime", { device: c.device }),
      cls: "mb-modal-sub",
    });
    const rows = el.createDiv({ cls: "mb-import-rows" });
    const row = (icon: string, title: string, sub: string) => {
      const r = rows.createDiv({ cls: "mb-import-row" });
      setIcon(r.createSpan({ cls: "mb-restore-icon" }), icon);
      const text = r.createDiv();
      text.createDiv({ text: title });
      if (sub) text.createEl("small", { text: sub });
    };
    row("folder", tn("importConfig.dests", info.dests.length), info.dests.join(t("importConfig.sep")));
    if (info.needSecret.length) row("key", tn("importConfig.needSecret", info.needSecret.length), t("importConfig.needSecretDesc", { names: info.needSecret.join(t("importConfig.sep")) }));
    if (info.desktopOnly.length) row("laptop", tn("importConfig.desktopOnly", info.desktopOnly.length), t("importConfig.desktopOnlyDesc", { names: info.desktopOnly.join(t("importConfig.sep")) }));
    if (info.primary) row("refresh-cw", t("importConfig.primary"), t("importConfig.primaryDesc", { name: info.primary }));
    const note = el.createDiv({ cls: "mb-restore-note" });
    setIcon(note.createSpan({ cls: "mb-restore-icon" }), "undo-2");
    note.createSpan({ text: t("importConfig.backupNote") });
    this.footer(
      el,
      () => this.back(2),
      () => void this.run(c, info.needSecret, info.primary),
      t("importConfig.go"),
      t("importConfig.help"),
    );
  }

  private async run(c: ConfigFile, needSecret: string[], primary: string): Promise<void> {
    this.close();
    try {
      await this.sync.importConfig(c);
    } catch {
      new Notice(t("notice.unexpected"), 0);
      return;
    }
    const parts = [tn("importConfig.doneDests", Array.isArray(c.settings.destinations) ? c.settings.destinations.length : 0)];
    if (needSecret.length) parts.push(t("importConfig.doneSecret", { names: needSecret.join(t("importConfig.sep")) }));
    if (primary) parts.push(t("importConfig.donePrimary"));
    new Notice(
      createFragment((f) => {
        f.createEl("b", { text: t("importConfig.done") });
        f.createEl("br");
        f.appendText(parts.join(" "));
      }),
      needSecret.length || primary ? 0 : 6000,
    );
    this.onDone();
  }

  private footer(el: HTMLElement, back: (() => void) | null, next: (() => void) | null, nextText = t("restore.next"), help = ""): void {
    const f = el.createDiv({ cls: "mb-restore-footer" });
    f.createSpan({ text: help, cls: "mb-restore-help" });
    f.createEl("button", { text: back ? t("restore.back") : t("common.cancel") }).addEventListener("click", () => (back ? back() : this.close()));
    const b = f.createEl("button", { text: nextText, cls: "mod-cta" });
    b.disabled = !next;
    if (next) b.addEventListener("click", next);
  }
}
