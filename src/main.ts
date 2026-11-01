import { addIcon, FuzzySuggestModal, Notice, Plugin, TFile, type App, type TAbstractFile } from "obsidian";
import { Logger } from "./core/logger";
import { firstSuccess, hasAutoSync, onboardingTasks, shouldShowWelcome, type OnboardingTasks } from "./core/onboarding";
import { initI18n, t } from "./i18n";
import { ObsidianState } from "./platform/obsidian-state";
import { CloudAuth } from "./platform/cloud-auth";
import { obsidianRequest } from "./platform/obsidian-request";
import { ConsoleSink, LogFileSink } from "./platform/log-file-sink";
import { mergeSettings, type DestinationConfig, type MultiBackupSettings } from "./settings";
import { SyncService } from "./sync-service";
import { actionNotice } from "./ui/action-notice";
import { DestinationModal } from "./ui/destination-modal";
import { FileHistoryModal } from "./ui/file-history-modal";
import { ImportConfigModal } from "./ui/import-config-modal";
import { RestoreModal } from "./ui/restore-modal";
import { CONFLICTS_VIEW_TYPE, ConflictsView } from "./ui/conflicts-view";
import { HISTORY_VIEW_TYPE, HistoryView } from "./ui/history-view";
import { destDisplayName, durationText, joinSentences } from "./ui/messages";
import { RIBBON_ICON_ID, RIBBON_ICON_SVG } from "./ui/ring";
import { MultiBackupSettingTab } from "./ui/setting-tab";
import { StatusBar } from "./ui/status-bar";
import { WelcomeModal } from "./ui/welcome-modal";

export default class MultiBackupPlugin extends Plugin {
  // Obsidian 1.13+ 在基类中声明了 settings?: unknown，这里只收窄类型
  declare settings: MultiBackupSettings;
  logger!: Logger;
  sync!: SyncService;
  private logSink!: LogFileSink;
  private statusBar!: StatusBar;
  private settingTab!: MultiBackupSettingTab;
  /** 上一次看到的“完成过备份”状态，用来发现第一次备份完成 */
  private wasBacked = false;

  override async onload(): Promise<void> {
    initI18n();
    this.settings = mergeSettings(await this.loadData());

    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.logSink = new LogFileSink(this.app.vault.adapter, pluginDir);
    this.logger = new Logger([this.logSink, new ConsoleSink(() => this.settings.debugLog)], this.settings.debugLog ? "debug" : "info");
    await this.logSink.cleanup(new Date(), this.settings.logKeepDays);

    const cloud = new CloudAuth(this.app, obsidianRequest, this.logger);
    // 网盘授权后浏览器跳回 obsidian://multi-backup-auth
    this.registerObsidianProtocolHandler("multi-backup-auth", (params) => cloud.handleCallback(params));
    this.sync = new SyncService({
      app: this.app,
      pluginDir,
      logger: this.logger,
      state: new ObsidianState(this.app.vault.adapter, pluginDir),
      settings: () => this.settings,
      replaceSettings: async (s) => {
        this.settings = s;
        await this.saveData(this.settings);
        this.statusBar?.render();
        this.settingTab?.reload();
      },
      pluginVersion: this.manifest.version,
      cloud,
      openHistory: () => void this.openHistory(),
      openConflicts: () => void this.openConflicts(),
      editDestination: (id) => this.editDestination(id),
    });
    await this.sync.load();

    this.settingTab = new MultiBackupSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryView(leaf, this));
    this.registerView(CONFLICTS_VIEW_TYPE, (leaf) => new ConflictsView(leaf, this));

    addIcon(RIBBON_ICON_ID, RIBBON_ICON_SVG);
    // 功能区只放一个按钮：打开侧边栏（同步在侧边栏顶部、状态栏菜单或命令面板中进行）
    this.addRibbonIcon(RIBBON_ICON_ID, t("ribbon.openHistory"), () => void this.openHistory());

    this.statusBar = new StatusBar(this.addStatusBarItem(), this.sync, () => this.settings, {
      openHistory: () => void this.openHistory(),
      openConflicts: () => void this.openConflicts(),
      openSettings: () => this.openSettings(),
      openRestore: () => this.openRestore(),
    });

    this.addCommand({ id: "sync-all", name: t("command.syncAll"), callback: () => void this.sync.syncAll("command") });
    this.addCommand({
      id: "sync-one",
      name: t("command.syncOne"),
      checkCallback: (checking) => {
        const dests = this.settings.destinations.filter((d) => d.enabled);
        if (!dests.length) return false;
        if (!checking) new DestinationSuggest(this.app, dests, (d) => void this.sync.syncOne(d.id, "command")).open();
        return true;
      },
    });
    this.addCommand({ id: "open-history", name: t("command.openHistory"), callback: () => void this.openHistory() });
    this.addCommand({ id: "open-conflicts", name: t("command.openConflicts"), callback: () => void this.openConflicts() });
    this.addCommand({ id: "export-logs", name: t("command.exportLogs"), callback: () => void this.sync.exportLogs() });
    this.addCommand({ id: "restore", name: t("command.restore"), callback: () => this.openRestore() });
    this.addCommand({ id: "export-config", name: t("command.exportConfig"), callback: () => void this.exportConfig() });
    this.addCommand({ id: "import-config", name: t("command.importConfig"), callback: () => this.openImportConfig() });
    this.addCommand({ id: "show-guide", name: t("command.showGuide"), callback: () => void this.showGuide() });
    this.addCommand({
      id: "file-history",
      name: t("command.fileHistory"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openFileHistory(file.path);
        return true;
      },
    });
    // 文件的右键菜单：历史版本…
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile) menu.addItem((i) => i.setTitle(t("menu.fileHistory")).setIcon("history").onClick(() => this.openFileHistory(file.path)));
      }),
    );

    this.registerEvent(
      this.sync.on("changed", () => {
        this.statusBar.render();
        this.settingTab.refresh();
        this.checkFirstBackup();
      }),
    );
    // 像反向链接、大纲一样，在右侧边栏常驻一个“同步历史”标签页（不抢焦点、不展开侧边栏）
    this.wasBacked = this.onboarding().backed;
    this.app.workspace.onLayoutReady(() => {
      void this.ensureHistoryTab();
      if (shouldShowWelcome(this.settings.onboarding.welcomeDone, this.settings.destinations.length)) this.openWelcome();
      // 自动同步：启动后检查一次，之后每 5 秒检查一次
      void this.sync.autoTick();
      this.registerInterval(window.setInterval(() => void this.sync.autoTick(), 5000));
      const edited = (file: TAbstractFile) => this.sync.markEdit(file.path);
      this.registerEvent(this.app.vault.on("modify", edited));
      this.registerEvent(this.app.vault.on("create", edited));
      this.registerEvent(this.app.vault.on("delete", edited));
      this.registerEvent(this.app.vault.on("rename", edited));
    });
    // 关闭前同步（桌面端尽量完成；手机上系统可能直接结束 Obsidian）
    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        if (this.settings.syncBeforeClose && this.sync.hasUnsyncedEdits()) tasks.add(() => this.sync.syncAll("quit"));
      }),
    );
    // 状态栏的“5 分钟前”每分钟刷新一次
    this.registerInterval(window.setInterval(() => this.statusBar.render(), 60_000));
    this.logger.info(t("plugin.loaded", { version: this.manifest.version }));
  }

  override onunload(): void {
    void this.logSink?.flush();
  }

  async saveSettings(): Promise<void> {
    this.logger.level = this.settings.debugLog ? "debug" : "info";
    // 随配置上传：内容不变时目的地不重写，所以只在设置真的保存时更新时间
    this.settings.updatedAt = Date.now();
    await this.saveData(this.settings);
    this.statusBar?.render();
  }

  /** 添加目的地；afterSave 给出时保存后调用它（如“在别的设备上用过”接着导入配置），否则在还没备份过时提示做第一次备份 */
  addDestination(draft: DestinationConfig, afterSave?: () => void): void {
    new DestinationModal(this.app, this.sync, draft, true, async (d) => {
      this.settings.destinations.push(d);
      await this.saveSettings();
      this.settingTab.refresh();
      if (afterSave) afterSave();
      else if (!this.onboarding().backed && d.enabled) this.askFirstBackup(d);
    }).open();
  }

  // —— 首次运行指导 ——

  onboarding(): OnboardingTasks {
    return onboardingTasks(this.settings.destinations, this.settings.primaryId, this.sync.history);
  }

  /** 只属于这台设备的界面状态：不改 updatedAt，不触发配置重新上传 */
  async saveOnboarding(change: (o: MultiBackupSettings["onboarding"]) => void): Promise<void> {
    change(this.settings.onboarding);
    await this.saveData(this.settings);
  }

  openWelcome(): void {
    new WelcomeModal(this.app, {
      addDestination: (d, after) => this.addDestination(d, after),
      openImportConfig: () => this.openImportConfig(),
      markWelcomeDone: () => void this.saveOnboarding((o) => (o.welcomeDone = true)),
    }).open();
  }

  async showGuide(): Promise<void> {
    await this.saveOnboarding((o) => (o.guideClosed = false));
    if (!this.settings.destinations.length) this.openWelcome();
    else this.openSettings();
    this.settingTab.reload();
  }

  private askFirstBackup(d: DestinationConfig): void {
    actionNotice(t("notice.added", { name: destDisplayName(d) }), t("notice.addedAsk"), [
      { text: t("notice.backUpNow"), cta: true, onClick: () => void this.sync.syncOne(d.id, "settings") },
      { text: t("notice.later") },
    ]);
  }

  /** 第一次备份成功后提示一次：自动同步没开时引导打开，开了就说明一下 */
  private checkFirstBackup(): void {
    const backed = this.onboarding().backed;
    if (backed && !this.wasBacked && !this.settings.onboarding.guideClosed) {
      const ids = new Set(this.settings.destinations.map((d) => d.id));
      const first = firstSuccess(this.sync.history, ids);
      const dest = this.settings.destinations.find((d) => d.enabled) ?? this.settings.destinations[0];
      const autoOn = this.settings.destinations.some(hasAutoSync);
      const stats = first ? t("notice.firstDoneStats", { files: first.files.toLocaleString(), dur: durationText(first.durationMs) }) : "";
      actionNotice(t("notice.firstDone"), joinSentences(stats, t(autoOn ? "notice.firstDoneAutoOn" : "notice.firstDoneAutoOff")), [
        { text: t(autoOn ? "notice.changeAuto" : "notice.turnOnAuto"), cta: !autoOn, onClick: () => dest && this.editDestination(dest.id) },
        { text: t("notice.close") },
      ]);
    }
    this.wasBacked = backed;
  }

  editDestination(id: string): void {
    const original = this.settings.destinations.find((d) => d.id === id);
    if (!original) return;
    new DestinationModal(this.app, this.sync, original, false, async (d) => {
      this.settings.destinations = this.settings.destinations.map((x) => (x.id === id ? d : x));
      await this.saveSettings();
      this.settingTab.refresh();
    }).open();
  }

  private async ensureHistoryTab(): Promise<void> {
    if (this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE).length) return;
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: HISTORY_VIEW_TYPE, active: false });
  }

  async openHistory(destId?: string): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) return;
      await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (destId && leaf.view instanceof HistoryView) leaf.view.setDestination(destId);
  }

  async openConflicts(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(CONFLICTS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) return;
      await leaf.setViewState({ type: CONFLICTS_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  /** 从备份恢复；destId 指定时先选中这个目的地 */
  openRestore(destId?: string): void {
    new RestoreModal(this.app, this.sync, destId).open();
  }

  async exportConfig(): Promise<void> {
    try {
      const path = await this.sync.exportConfig();
      new Notice(t("notice.configExported", { path }));
    } catch (e) {
      this.logger.error("config export failed", e);
      new Notice(t("notice.unexpected"));
    }
  }

  openImportConfig(): void {
    new ImportConfigModal(this.app, this.sync, () => this.settingTab.reload()).open();
  }

  openFileHistory(path: string): void {
    new FileHistoryModal(this.app, this.sync, path).open();
  }

  openSettings(): void {
    const setting = (this.app as App & { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }
}

class DestinationSuggest extends FuzzySuggestModal<DestinationConfig> {
  constructor(
    app: App,
    private readonly dests: DestinationConfig[],
    private readonly pick: (d: DestinationConfig) => void,
  ) {
    super(app);
    this.setPlaceholder(t("suggest.placeholder"));
  }
  getItems(): DestinationConfig[] {
    return this.dests;
  }
  getItemText(d: DestinationConfig): string {
    return destDisplayName(d);
  }
  onChooseItem(d: DestinationConfig): void {
    this.pick(d);
  }
}
