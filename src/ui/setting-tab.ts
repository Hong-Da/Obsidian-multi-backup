// 设置页（按 M1 预览页 settings.html 实现）：同步概况、目的地、文件范围、日志
import { ExtraButtonComponent, Menu, Platform, PluginSettingTab, Setting, setIcon, ToggleComponent, type App } from "obsidian";
import { whenLabel } from "../core/format";
import { doneCount, requiredDone } from "../core/onboarding";
import { destState, overview } from "../core/overview";
import { currentLocale, t, tn } from "../i18n";
import type MultiBackupPlugin from "../main";
import { canBePrimary, CLOUD_NAMES, defaultAuto, isRemote, newDestination, newDestinationId, type DestinationConfig, type DestinationType } from "../settings";
import { PrimaryModal } from "./primary-modal";
import { confirmAction } from "./confirm-modal";
import { destDisplayName, destStatusText, destWhere, typeLabel } from "./messages";
import { renderRing } from "./ring";

// 最低支持 Obsidian 1.11.4，声明式设置（getSettingDefinitions）需要 1.13，暂不使用
export class MultiBackupSettingTab extends PluginSettingTab {
  private destBox: HTMLElement | null = null;
  private guideBox: HTMLElement | null = null;
  private summaryName: HTMLElement | null = null;
  private summaryDesc: HTMLElement | null = null;
  private syncAllBtn: HTMLButtonElement | null = null;
  private conflictsBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly plugin: MultiBackupPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("mb-settings");
    const s = this.plugin.settings;

    // —— 上手清单（M6 预览页 onboarding.html）——
    this.guideBox = containerEl.createDiv();

    // —— 同步 ——
    new Setting(containerEl).setName(t("settings.sync.heading")).setHeading();
    const summary = new Setting(containerEl);
    summary.controlEl.addClass("mb-summary-actions");
    summary.addButton((b) => {
      b.onClick(() => void this.plugin.openConflicts());
      setIcon(b.buttonEl.createSpan({ cls: "mb-btn-icon" }), "git-compare");
      b.buttonEl.createSpan({ text: t("settings.resolveConflicts") });
      this.conflictsBtn = b.buttonEl;
    });
    summary.addButton((b) => {
      // setIcon 会替换掉按钮文字，所以图标单独放在文字前面
      b.setCta().onClick(() => void this.plugin.sync.syncAll("settings"));
      setIcon(b.buttonEl.createSpan({ cls: "mb-btn-icon" }), "refresh-cw");
      b.buttonEl.createSpan({ text: t("settings.syncAll") });
      this.syncAllBtn = b.buttonEl;
    });
    this.summaryName = summary.nameEl;
    this.summaryDesc = summary.descEl;

    // —— 目的地 ——
    new Setting(containerEl).setName(t("settings.dest.heading")).setDesc(t("settings.dest.desc")).setHeading();
    this.destBox = containerEl.createDiv();
    const addRow = containerEl.createDiv({ cls: "mb-add-row" });
    const addBtn = addRow.createEl("button", { text: t("settings.dest.add") });
    addBtn.addEventListener("click", (e) => this.showAddMenu(e));

    // —— 本设备 ——
    new Setting(containerEl).setName(t("settings.device.heading")).setHeading();
    new Setting(containerEl)
      .setName(t("settings.device.name"))
      .setDesc(t("settings.device.desc"))
      .addText((c) => c.setValue(this.plugin.sync.deviceName()).onChange((v) => this.plugin.sync.setDeviceName(v)));

    // —— 同步行为 ——
    new Setting(containerEl).setName(t("settings.behavior.heading")).setHeading();
    const trash = new Setting(containerEl).setName(t("settings.trash.name")).setDesc(t("settings.trash.desc"));
    trash.controlEl.createSpan({ text: t("settings.trash.prefix") });
    trash.addText((c) => {
      c.inputEl.type = "number";
      c.inputEl.min = "1";
      c.inputEl.addClass("mb-number");
      c.setValue(String(s.trashKeepDays)).onChange(async (v) => {
        const n = Math.floor(Number(v));
        if (Number.isFinite(n) && n >= 1) {
          s.trashKeepDays = n;
          await this.plugin.saveSettings();
        }
      });
    });
    trash.controlEl.createSpan({ text: t("settings.trash.suffix") });
    new Setting(containerEl)
      .setName(t("settings.beforeClose.name"))
      .setDesc(t("settings.beforeClose.desc"))
      .addToggle((c) =>
        c.setValue(s.syncBeforeClose).onChange(async (v) => {
          s.syncBeforeClose = v;
          await this.plugin.saveSettings();
        }),
      );

    // —— 文件范围 ——
    new Setting(containerEl).setName(t("settings.scope.heading")).setDesc(t("settings.scope.desc")).setHeading();
    const configDir = this.app.vault.configDir;
    new Setting(containerEl)
      .setName(t("settings.config.name"))
      .setDesc(t("settings.config.desc", { dir: configDir + "/" }))
      .addToggle((c) =>
        c.setValue(s.includeConfigDir).onChange(async (v) => {
          s.includeConfigDir = v;
          await this.plugin.saveSettings();
        }),
      );
    const ex = new Setting(containerEl).setName(t("settings.excludes.name")).setDesc(t("settings.excludes.desc"));
    ex.settingEl.addClass("mb-stacked");
    ex.addTextArea((c) => {
      c.setValue(s.excludes)
        .setPlaceholder("Attachments/Videos/**\n*.tmp")
        .onChange(async (v) => {
          s.excludes = v;
          await this.plugin.saveSettings();
        });
      c.inputEl.rows = 5;
      c.inputEl.addClass("mb-mono");
      c.inputEl.spellcheck = false;
    });
    const size = new Setting(containerEl).setName(t("settings.maxSize.name")).setDesc(t("settings.maxSize.desc"));
    size.addText((c) => {
      c.inputEl.type = "number";
      c.inputEl.min = "1";
      c.inputEl.addClass("mb-number");
      c.setValue(String(s.maxFileSizeMB));
      c.inputEl.addEventListener("change", () => {
        const n = Math.floor(Number(c.inputEl.value));
        s.maxFileSizeMB = Number.isFinite(n) && n >= 1 ? Math.min(n, 10240) : 50;
        c.setValue(String(s.maxFileSizeMB));
        void this.plugin.saveSettings();
      });
    });
    size.controlEl.createSpan({ text: "MB" });

    // —— 插件配置（M5 预览页 config.html）——
    new Setting(containerEl).setName(t("settings.config.heading")).setHeading();
    new Setting(containerEl)
      .setName(t("settings.config.export"))
      .setDesc(t("settings.config.exportDesc"))
      .addButton((b) => b.setButtonText(t("settings.config.exportButton")).onClick(() => void this.plugin.exportConfig()));
    new Setting(containerEl)
      .setName(t("settings.config.import"))
      .setDesc(t("settings.config.importDesc"))
      .addButton((b) => b.setButtonText(t("settings.config.importButton")).onClick(() => this.plugin.openImportConfig()));

    // —— 日志 ——
    new Setting(containerEl).setName(t("settings.logging.heading")).setHeading();
    new Setting(containerEl)
      .setName(t("settings.debugLog.name"))
      .setDesc(t("settings.debugLog.desc"))
      .addToggle((c) =>
        c.setValue(s.debugLog).onChange(async (v) => {
          s.debugLog = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName(t("settings.exportLogs.name"))
      .setDesc(t("settings.exportLogs.desc", { days: s.logKeepDays }))
      .addButton((b) => b.setButtonText(t("settings.exportLogs.button")).onClick(() => void this.plugin.sync.exportLogs()));

    this.refresh();
  }

  /** 导入配置后整页重画（排除规则等输入框也要换成新值） */
  reload(): void {
    this.display();
  }

  /** 同步状态变化时只刷新概况和目的地列表，不打断正在编辑的输入框 */
  refresh(): void {
    if (!this.destBox || !this.summaryName || !this.summaryDesc) return;
    const s = this.plugin.settings;
    this.renderGuide();
    const sync = this.plugin.sync;
    const running = sync.running;
    const ov = overview(s.destinations, sync.history, running?.progress?.destId ?? null, !!running);
    const lang = currentLocale();

    this.summaryName.empty();
    this.summaryName.addClass("mb-summary");
    renderRing(this.summaryName, ov.state === "none" ? "idle" : ov.state);
    let title: string;
    let desc: string;
    if (!s.destinations.length || (!ov.lastAt && ov.state !== "busy")) {
      title = t("settings.summary.never");
      desc = t("settings.summary.neverDesc");
    } else {
      const c = ov.counts;
      const parts = [
        c.ok && t("settings.summary.part.ok", { n: c.ok }),
        c.failed && t("settings.summary.part.failed", { n: c.failed }),
        c.paused && t("settings.summary.part.paused", { n: c.paused }),
        c.never && t("settings.summary.part.never", { n: c.never }),
      ].filter(Boolean);
      desc = tn("settings.summary.total", s.destinations.length, { total: s.destinations.length }) + parts.join(t("settings.summary.sep")) + t("settings.summary.end");
      if (ov.state === "error") {
        title = tn("settings.summary.failed", ov.failedIds.length);
        desc += " " + t("settings.summary.retry");
      } else title = ov.state === "busy" ? t("status.busyStart") : t("settings.summary.last", { when: whenLabel(ov.lastAt as number, Date.now(), lang) });
    }
    const conflicts = sync.conflicts.length;
    if (conflicts && ov.state !== "busy") {
      title = tn("settings.summary.conflicts", conflicts);
      desc = t("settings.summary.conflictsDesc");
    }
    this.summaryName.createSpan({ text: title, cls: conflicts ? "mb-summary-conflicts" : "" });
    this.summaryDesc.setText(desc);
    this.conflictsBtn?.toggle(conflicts > 0);
    if (this.syncAllBtn) this.syncAllBtn.disabled = !s.destinations.some((d) => d.enabled) || !!running;

    this.destBox.empty();
    if (!s.destinations.length) {
      const empty = this.destBox.createDiv({ cls: "mb-empty" });
      empty.createEl("p", { text: t("settings.dest.empty") });
      const b = empty.createEl("button", { text: t("settings.dest.add"), cls: "mod-cta" });
      b.addEventListener("click", (e) => this.showAddMenu(e));
      return;
    }
    const list = this.destBox.createDiv({ cls: "mb-dest-list" });
    for (const d of s.destinations) this.renderDest(list, d);
  }

  private renderGuide(): void {
    const box = this.guideBox;
    if (!box) return;
    box.empty();
    if (this.plugin.settings.onboarding.guideClosed) return;
    const tasks = this.plugin.onboarding();
    const card = box.createDiv({ cls: "mb-guide" });
    const close = () => void this.plugin.saveOnboarding((o) => (o.guideClosed = true)).then(() => this.refresh());

    if (requiredDone(tasks)) {
      const done = card.createDiv({ cls: "mb-guide-done" });
      renderRing(done, "ok");
      const text = done.createDiv();
      text.createEl("b", { text: t("guide.allSet") });
      text.createDiv({ text: t("guide.allSetDesc"), cls: "mb-guide-desc" });
      done.createEl("button", { text: t("guide.close") }).addEventListener("click", close);
      return;
    }

    const n = doneCount(tasks);
    const head = card.createDiv({ cls: "mb-guide-head" });
    head.createEl("b", { text: t("guide.title") });
    head.createSpan({ text: `${n} / 4`, cls: "mb-guide-count" });
    head.createDiv({ cls: "mb-guide-bar" }).createDiv().setCssProps({ width: `${n * 25}%` });
    new ExtraButtonComponent(head).setIcon("x").setTooltip(t("guide.close")).onClick(close);

    const s = this.plugin.settings;
    const first = s.destinations.find((d) => d.enabled) ?? s.destinations[0];
    const primaryCandidate = s.destinations.find((d) => d.enabled && isRemote(d) && canBePrimary(d));
    const rows: [boolean, string, string, string, (e: MouseEvent) => void, boolean][] = [
      [tasks.dest, t("guide.dest"), t("guide.destDesc"), t("guide.destButton"), (e) => this.showAddMenu(e), false],
      [tasks.backed, t("guide.backed"), t("guide.backedDesc"), t("guide.backedButton"), () => void this.plugin.sync.syncAll("settings"), false],
      [tasks.auto, t("guide.auto"), t("guide.autoDesc"), t("guide.autoButton"), () => first && this.plugin.editDestination(first.id), false],
      [tasks.primary, t("guide.primary"), t("guide.primaryDesc"), t("guide.primaryButton"), (e) => (primaryCandidate ? this.makePrimary(primaryCandidate) : this.showAddMenu(e)), true],
    ];
    rows.forEach(([done, title, desc, button, action, optional], i) => {
      const row = card.createDiv({ cls: ["mb-guide-task", done ? "is-done" : ""].filter(Boolean) });
      const mark = row.createSpan({ cls: "mb-guide-mark" });
      if (done) setIcon(mark, "check");
      const text = row.createDiv();
      const name = text.createSpan({ text: title, cls: "mb-guide-name" });
      if (optional) name.createSpan({ text: t("guide.optional"), cls: "mb-guide-optional" });
      if (!done) text.createDiv({ text: desc, cls: "mb-guide-desc" });
      if (done) {
        row.createSpan();
        return;
      }
      // 前面的必做项都完成时，这一项是下一步，按钮突出显示
      const next = rows.slice(0, i).every((r) => r[0]);
      const b = row.createEl("button", { text: button, cls: next ? "mod-cta" : "" });
      b.disabled = i > 0 && i < 3 && !tasks.dest;
      b.addEventListener("click", (e) => action(e));
    });
  }

  private renderDest(list: HTMLElement, d: DestinationConfig): void {
    const sync = this.plugin.sync;
    const runningId = sync.running?.progress?.destId ?? null;
    const st = destState(d, sync.history, runningId);
    const row = list.createDiv({ cls: ["mb-dest", d.enabled ? "" : "is-paused"].filter(Boolean) });
    renderRing(row, st.ring);
    const head = row.createDiv({ cls: "mb-dest-name" });
    head.createEl("b", { text: destDisplayName(d), attr: { title: destDisplayName(d) } });
    if (this.plugin.settings.primaryId === d.id && canBePrimary(d)) {
      const badge = head.createSpan({ cls: "mb-primary-badge" });
      setIcon(badge.createSpan(), "arrow-down-up");
      badge.createSpan({ text: t("dest.primary") });
    }
    head.createSpan({ text: typeLabel(d.type), cls: "mb-dest-type" });

    const actions = row.createDiv({ cls: "mb-dest-actions" });
    new ToggleComponent(actions)
      .setValue(d.enabled)
      .setTooltip(t("dest.action.enabled"))
      .onChange(async (v) => {
        d.enabled = v;
        await this.plugin.saveSettings();
        this.refresh();
      });
    new ExtraButtonComponent(actions)
      .setIcon("refresh-cw")
      .setTooltip(t("dest.action.sync"))
      .setDisabled(!d.enabled || !!sync.running)
      .onClick(() => void sync.syncOne(d.id, "settings"));
    new ExtraButtonComponent(actions)
      .setIcon("pencil")
      .setTooltip(t("dest.action.edit"))
      .onClick(() => this.plugin.editDestination(d.id));
    const more = new ExtraButtonComponent(actions).setIcon("more-horizontal").setTooltip(t("dest.action.more"));
    more.extraSettingsEl.addEventListener("click", (e) => this.showRowMenu(e, d));

    const where = destWhere(d);
    row.createDiv({ text: where || "—", cls: "mb-dest-path", attr: { title: where } });
    const progress = runningId === d.id ? sync.running?.progress ?? null : null;
    row.createDiv({ text: destStatusText(st, progress), cls: ["mb-dest-status", st.ring === "error" ? "is-error" : ""].filter(Boolean) });
  }

  private showAddMenu(e: MouseEvent): void {
    const menu = new Menu();
    const desktop = Platform.isDesktopApp;
    menu.addItem((i) => i.setTitle(t("settings.dest.groupLocal")).setIsLabel(true));
    const add = (type: DestinationType, icon: string, title: string) =>
      menu.addItem((i) => i.setTitle(title).setIcon(icon).setDisabled(!desktop).onClick(() => this.plugin.addDestination(newDestination(type))));
    add("mirror", "folder", t("type.mirror.add"));
    add("zip", "archive", t("type.zip"));
    add("git", "git-branch", t("type.git.add"));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(t("type.gitRemote")).setIcon("git-branch").onClick(() => this.plugin.addDestination(newDestination("git-remote"))));
    menu.addItem((i) => i.setTitle(t("type.webdav")).setIcon("server").onClick(() => this.plugin.addDestination(newDestination("webdav"))));
    menu.addItem((i) => i.setTitle(t("type.s3")).setIcon("database").onClick(() => this.plugin.addDestination(newDestination("s3"))));
    menu.addSeparator();
    for (const kind of ["onedrive", "dropbox", "gdrive"] as const)
      menu.addItem((i) => i.setTitle(CLOUD_NAMES[kind]).setIcon("cloud").onClick(() => this.plugin.addDestination(newDestination("cloud", kind))));
    menu.showAtMouseEvent(e);
  }

  private showRowMenu(e: MouseEvent, d: DestinationConfig): void {
    const menu = new Menu();
    const s = this.plugin.settings;
    if (s.primaryId === d.id && canBePrimary(d)) {
      menu.addItem((i) =>
        i
          .setTitle(t("dest.menu.makeBackup"))
          .setIcon("arrow-down-up")
          .onClick(async () => {
            s.primaryId = "";
            await this.plugin.saveSettings();
            this.refresh();
          }),
      );
    } else if (canBePrimary(d)) {
      menu.addItem((i) => i.setTitle(t("dest.menu.makePrimary")).setIcon("arrow-down-up").onClick(() => this.makePrimary(d)));
    } else {
      menu.addItem((i) =>
        i
          .setTitle(t("dest.menu.makePrimary") + " · " + t(d.type === "zip" ? "dest.menu.zipBackupOnly" : "dest.menu.gitBackupOnly"))
          .setIcon("arrow-down-up")
          .setDisabled(true),
      );
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(t("dest.menu.history")).setIcon("history").onClick(() => this.plugin.openHistory(d.id)));
    menu.addItem((i) =>
      i
        .setTitle(t("dest.menu.duplicate"))
        .setIcon("copy")
        .onClick(async () => {
          const copy = { ...structuredClone(d), id: newDestinationId(), name: destDisplayName(d) + t("dest.copySuffix") };
          this.plugin.settings.destinations.push(copy);
          await this.plugin.saveSettings();
          this.refresh();
        }),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(t("dest.menu.delete"))
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(async () => {
          const ok = await confirmAction(this.app, t("confirm.delete.title", { name: destDisplayName(d) }), t("confirm.delete.body"), t("confirm.delete.ok"));
          if (!ok) return;
          this.plugin.settings.destinations = this.plugin.settings.destinations.filter((x) => x.id !== d.id);
          if (this.plugin.settings.primaryId === d.id) this.plugin.settings.primaryId = "";
          await this.plugin.saveSettings();
          await this.plugin.sync.forgetDestination(d.id);
          this.refresh();
        }),
    );
    menu.showAtMouseEvent(e);
  }

  /** 先只读比较，确认后设为主同步端并立即做首次同步 */
  private makePrimary(d: DestinationConfig): void {
    const s = this.plugin.settings;
    const current = s.destinations.find((x) => x.id === s.primaryId) ?? null;
    new PrimaryModal(this.app, this.plugin.sync, d, current, async () => {
      s.primaryId = d.id;
      // 还是备份端的默认自动同步时，换成主同步端的默认值
      if (JSON.stringify(d.auto) === JSON.stringify(defaultAuto("backup"))) d.auto = defaultAuto("primary");
      await this.plugin.saveSettings();
      this.refresh();
      await this.plugin.sync.syncOne(d.id, "settings");
    }).open();
  }

  override hide(): void {
    this.destBox = null;
    this.guideBox = null;
    this.summaryName = null;
    this.summaryDesc = null;
    super.hide();
  }
}
