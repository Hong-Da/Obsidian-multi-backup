// 首次运行指导（M6 预览页 onboarding.html）：欢迎窗口、选目的地窗口
import { Modal, Platform, setIcon, type App } from "obsidian";
import type { CloudKind } from "../core/oauth";
import { t } from "../i18n";
import { newDestination, type DestinationConfig, type DestinationType } from "../settings";
import { renderRing } from "./ring";

export interface WelcomeActions {
  /** 打开目的地编辑弹窗；保存后调用 afterSave */
  addDestination(draft: DestinationConfig, afterSave?: () => void): void;
  openImportConfig(): void;
  /** 欢迎窗口关闭（无论选了什么）后记下“已出现过” */
  markWelcomeDone(): void;
}

export class WelcomeModal extends Modal {
  constructor(
    app: App,
    private readonly actions: WelcomeActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("mb-welcome");
    titleEl.empty();
    renderRing(titleEl, "ok");
    titleEl.createSpan({ text: t("welcome.title") });
    contentEl.createEl("p", { text: t("welcome.lead"), cls: "mb-welcome-lead" });
    const paths = contentEl.createDiv({ cls: "mb-welcome-paths" });
    this.path(paths, "plus", t("welcome.fresh"), t("welcome.freshDesc"), () => {
      this.close();
      new ChooseDestinationModal(this.app, this.actions, false).open();
    });
    this.path(paths, "download", t("welcome.other"), t("welcome.otherDesc"), () => {
      this.close();
      new ChooseDestinationModal(this.app, this.actions, true).open();
    });
    const footer = contentEl.createDiv({ cls: "mb-welcome-footer" });
    footer.createSpan({ text: t("welcome.later.help"), cls: "mb-welcome-help" });
    const later = footer.createEl("button", { text: t("welcome.later") });
    later.addEventListener("click", () => this.close());
  }

  private path(parent: HTMLElement, icon: string, title: string, desc: string, onClick: () => void): void {
    const b = parent.createEl("button", { cls: "mb-welcome-path" });
    setIcon(b.createSpan({ cls: "mb-welcome-path-icon" }), icon);
    const text = b.createSpan({ cls: "mb-welcome-path-text" });
    text.createEl("b", { text: title });
    text.createEl("small", { text: desc });
    b.addEventListener("click", onClick);
  }

  override onClose(): void {
    this.actions.markWelcomeDone();
    this.contentEl.empty();
  }
}

interface TypeChoice {
  type: DestinationType;
  kind?: CloudKind;
  icon: string;
  name: string;
  desc: string;
  local: boolean;
}

/** 选目的地类型。fromOther：在别的设备上用过，保存后接着导入配置 */
export class ChooseDestinationModal extends Modal {
  constructor(
    app: App,
    private readonly actions: WelcomeActions,
    private readonly fromOther: boolean,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("mb-welcome");
    titleEl.setText(this.fromOther ? t("choose.otherTitle") : t("choose.title"));

    const steps = contentEl.createDiv({ cls: "mb-welcome-steps" });
    const labels = this.fromOther ? [t("choose.step.connect"), t("choose.step.import"), t("choose.step.primary")] : [t("choose.step.pick"), t("choose.step.fill"), t("choose.step.backup")];
    labels.forEach((l, i) => steps.createSpan({ text: `${i + 1} ${l}`, cls: i === 0 ? "is-current" : "" }));
    if (this.fromOther) contentEl.createEl("p", { text: t("choose.otherLead"), cls: "mb-welcome-lead" });

    const desktop = Platform.isDesktopApp;
    const local: TypeChoice[] = [
      { type: "mirror", icon: "folder", name: t("type.mirror.add"), desc: t("choose.mirrorDesc"), local: true },
      { type: "zip", icon: "archive", name: t("type.zip"), desc: t("choose.zipDesc"), local: true },
    ];
    const online: TypeChoice[] = [
      { type: "git-remote", icon: "git-branch", name: t("type.gitRemote"), desc: t("choose.gitDesc"), local: false },
      { type: "webdav", icon: "server", name: t("type.webdav"), desc: t("choose.webdavDesc"), local: false },
      { type: "s3", icon: "database", name: t("type.s3"), desc: t("choose.s3Desc"), local: false },
      { type: "cloud", kind: "dropbox", icon: "cloud", name: "Dropbox", desc: t("choose.dropboxDesc"), local: false },
    ];
    if (!this.fromOther) this.group(contentEl, t("choose.groupLocal"), local, desktop);
    this.group(contentEl, t("choose.groupOnline"), online, desktop);
    if (!desktop && !this.fromOther) {
      const tip = contentEl.createDiv({ cls: "mb-welcome-tip" });
      setIcon(tip.createSpan(), "smartphone");
      tip.createSpan({ text: t("choose.phoneTip") });
    }

    const footer = contentEl.createDiv({ cls: "mb-welcome-footer" });
    footer.createSpan({ text: t("choose.help"), cls: "mb-welcome-help" });
    const back = footer.createEl("button", { text: t("choose.back") });
    back.addEventListener("click", () => {
      this.close();
      new WelcomeModal(this.app, this.actions).open();
    });
  }

  private group(parent: HTMLElement, label: string, list: TypeChoice[], desktop: boolean): void {
    parent.createDiv({ text: label, cls: "mb-welcome-group" });
    const box = parent.createDiv({ cls: "mb-welcome-types" });
    for (const c of list) {
      const off = c.local && !desktop;
      const b = box.createEl("button", { cls: ["mb-welcome-type", off ? "is-disabled" : ""].filter(Boolean) });
      b.disabled = off;
      setIcon(b.createSpan({ cls: "mb-welcome-type-icon" }), c.icon);
      b.createSpan({ text: c.name, cls: "mb-welcome-type-name" });
      b.createEl("small", { text: off ? t("choose.notOnPhone") : c.desc });
      b.addEventListener("click", () => {
        this.close();
        const after = this.fromOther ? () => this.actions.openImportConfig() : undefined;
        this.actions.addDestination(newDestination(c.type, c.kind), after);
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
