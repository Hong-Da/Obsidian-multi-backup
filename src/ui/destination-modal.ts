// 目的地添加 / 编辑弹窗（按 M1 预览页 destination-modal.html、M2 预览页 git-modal.html 与 git-remote-modal.html、M4 预览页 storage-modal.html 实现）
import { Modal, Platform, Setting, setIcon, type App } from "obsidian";
import { DestinationError } from "../core/errors";
import { sizeLabel, whenLabel } from "../core/format";
import { commitMessage, conflictsWithVault, snapshotFileName } from "../core/paths";
import { currentLocale, t } from "../i18n";
import { canPickFolder, pickFolder, vaultBasePath } from "../platform/desktop";
import {
  CLOUD_NAMES,
  cloudFolder,
  cloudSecretName,
  isRemote,
  newDestination,
  type CloudConfig,
  S3_PRESETS,
  WEBDAV_PRESETS,
  type DestinationConfig,
  type DestinationType,
  type GitConfig,
  type GitProvider,
  type GitRemoteConfig,
  type MirrorConfig,
  type S3Config,
  type S3Preset,
  type WebDavConfig,
  type WebDavPreset,
  type ZipConfig,
} from "../settings";
import type { SyncService } from "../sync-service";
import { destWhere, errorText } from "./messages";
import { cloudConfigured } from "../destinations/cloud-providers";
import type { DeviceCode } from "../core/oauth";
import { addSecretSetting } from "./secret-field";

/** 各类型弹窗的文案键 */
const TEXT = {
  mirror: { add: "modal.addMirror", desc: "modal.mirror.desc", ph: "modal.name.phMirror", folder: "modal.folder.mirror", folderDesc: "modal.folder.desc" },
  zip: { add: "modal.addZip", desc: "modal.zip.desc", ph: "modal.name.phZip", folder: "modal.folder.zip", folderDesc: "modal.folder.desc" },
  git: { add: "modal.addGit", desc: "modal.git.desc", ph: "modal.name.phGit", folder: "modal.folder.git", folderDesc: "modal.folder.gitDesc" },
  "git-remote": { add: "modal.addGitRemote", desc: "modal.gitRemote.desc", ph: "modal.name.phGitRemote", folder: "modal.url.name", folderDesc: "modal.url.desc" },
  webdav: { add: "modal.addWebdav", desc: "modal.webdav.desc", ph: "modal.name.phWebdav", folder: "modal.dav.folder.name", folderDesc: "modal.dav.folder.desc" },
  s3: { add: "modal.addS3", desc: "modal.s3.desc", ph: "modal.name.phS3", folder: "modal.s3.prefix.name", folderDesc: "modal.s3.prefix.desc" },
  cloud: { add: "modal.addCloud", desc: "modal.cloud.desc", ph: "modal.name.phCloud", folder: "modal.dav.folder.name", folderDesc: "modal.dav.folder.desc" },
} as const satisfies Record<DestinationType, Record<string, string>>;

const ALIST_GUIDE = "https://github.com/Hong-Da/Obsidian-multi-backup/blob/main/docs/alist.md";

export class DestinationModal extends Modal {
  private draft: DestinationConfig;
  private resultEl!: HTMLElement;
  private folderError!: HTMLElement;
  private saveBtn: HTMLButtonElement | null = null;
  private guideOpen = false;
  /** 网盘：正在浏览器里登录；Google 的设备代码 */
  private signing = false;
  private device: DeviceCode | null = null;
  private signError = "";
  private saved = false;

  constructor(
    app: App,
    private readonly sync: SyncService,
    original: DestinationConfig,
    private readonly isNew: boolean,
    private readonly onSave: (d: DestinationConfig) => Promise<void>,
  ) {
    super(app);
    this.draft = structuredClone(original);
  }

  override onOpen(): void {
    const { contentEl } = this;
    const text = TEXT[this.draft.type];
    this.modalEl.addClass("mb-dest-modal");
    const cloudName = this.draft.type === "cloud" ? CLOUD_NAMES[this.draft.kind] : "";
    this.setTitle(this.isNew ? t(text.add, { name: cloudName }) : t("modal.edit"));
    contentEl.createEl("p", { text: t(text.desc, { name: cloudName }), cls: "mb-modal-sub" });

    new Setting(contentEl)
      .setName(t("modal.name.name"))
      .setDesc(t("modal.name.desc"))
      .addText((c) =>
        c
          .setPlaceholder(t(text.ph, { name: cloudName }))
          .setValue(this.draft.name)
          .onChange((v) => (this.draft.name = v)),
      );

    if (this.draft.type === "git-remote") {
      this.folderError = createDiv();
      this.remoteFields(contentEl, this.draft);
      this.gitFields(contentEl, this.draft);
    } else if (this.draft.type === "webdav") {
      this.folderError = createDiv();
      this.davFields(contentEl, this.draft);
      this.mirrorFields(contentEl, this.draft);
    } else if (this.draft.type === "s3") {
      this.folderError = createDiv();
      this.s3Fields(contentEl, this.draft);
      this.mirrorFields(contentEl, this.draft);
    } else if (this.draft.type === "cloud") {
      this.folderError = createDiv();
      this.cloudFields(contentEl, this.draft);
      this.mirrorFields(contentEl, this.draft);
    } else this.folderFields(contentEl, text);

    const extra = new Setting(contentEl)
      .setName(t("modal.extra.name"))
      .setDesc(t("modal.extra.desc"))
      .addTextArea((c) => {
        c.setPlaceholder(t("modal.extra.ph"))
          .setValue(this.draft.extraExcludes)
          .onChange((v) => (this.draft.extraExcludes = v));
        c.inputEl.rows = 2;
        c.inputEl.addClass("mb-mono");
      });
    // 手机上说明文字占满一行，输入框放到下面整行显示
    if (Platform.isMobile) extra.settingEl.addClass("mb-stacked");

    this.autoFields(contentEl);

    new Setting(contentEl)
      .setName(t("modal.uploadConfig.name"))
      .setDesc(t("modal.uploadConfig.desc"))
      .addToggle((c) => c.setValue(this.draft.uploadConfig).onChange((v) => (this.draft.uploadConfig = v)));

    this.resultEl = contentEl.createDiv({ cls: "mb-test-result" });
    this.resultEl.hide();

    const footer = new Setting(contentEl);
    footer.settingEl.addClass("mb-modal-footer");
    footer.addButton((b) => {
      // setIcon 会替换掉按钮文字，所以图标单独放在文字前面
      b.onClick(() => void this.runTest(b.buttonEl));
      setIcon(b.buttonEl.createSpan({ cls: "mb-btn-icon" }), "check");
      b.buttonEl.createSpan({ text: t("modal.test") });
    });
    footer.controlEl.createDiv({ cls: "mb-spacer" });
    footer.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()));
    footer.addButton((b) => {
      b.setButtonText(t(this.isNew ? "modal.add" : "modal.save"))
        .setCta()
        .onClick(() => void this.save());
      this.saveBtn = b.buttonEl;
    });
    this.validateFolder();
    // 手机上弹窗会自动聚焦第一个输入框并弹出键盘，挡住大半屏；等用户自己点输入框
    if (Platform.isMobile) {
      window.setTimeout(() => {
        const el = activeDocument.activeElement;
        if (el instanceof HTMLElement && this.contentEl.contains(el)) el.blur();
      }, 50);
    }
  }

  /** 自动同步（按 M3 预览页 auto-sync.html 实现）：总开关 + 定时、修改后、启动时、每天固定时间 */
  private autoFields(el: HTMLElement): void {
    const a = this.draft.auto;
    const box = el.createDiv({ cls: "mb-auto" });
    const triggers = el.createDiv({ cls: "mb-auto-triggers" });
    new Setting(box)
      .setName(t("modal.auto.name"))
      .setDesc(t("modal.auto.desc"))
      .addToggle((c) =>
        c.setValue(a.enabled).onChange((v) => {
          a.enabled = v;
          triggers.toggle(v);
        }),
      );
    triggers.toggle(a.enabled);
    const num = (input: HTMLInputElement, value: number, min: number, max: number, set: (n: number) => void) => numberInput(input, value, min, max, set);

    const interval = new Setting(triggers).setName(t("modal.auto.interval"));
    interval.settingEl.addClass("mb-trigger", "mb-trigger-input");
    interval.controlEl.createSpan({ text: t("modal.auto.every"), cls: "mb-unit" });
    interval.addText((c) => num(c.inputEl, a.interval.minutes, 1, 1440, (n) => (a.interval.minutes = n)));
    interval.controlEl.createSpan({ text: t("modal.auto.minutes"), cls: "mb-unit" });
    interval.addToggle((c) => c.setValue(a.interval.on).onChange((v) => (a.interval.on = v)));

    const edit = new Setting(triggers).setName(t("modal.auto.afterEdit")).setDesc(t("modal.auto.afterEditDesc"));
    edit.settingEl.addClass("mb-trigger", "mb-trigger-input");
    edit.controlEl.createSpan({ text: t("modal.auto.idleFor"), cls: "mb-unit" });
    edit.addText((c) => num(c.inputEl, a.afterEdit.seconds, 5, 3600, (n) => (a.afterEdit.seconds = n)));
    edit.controlEl.createSpan({ text: t("modal.auto.seconds"), cls: "mb-unit" });
    edit.addToggle((c) => c.setValue(a.afterEdit.on).onChange((v) => (a.afterEdit.on = v)));

    const startup = new Setting(triggers).setName(t("modal.auto.onStartup"));
    startup.settingEl.addClass("mb-trigger");
    startup.addToggle((c) => c.setValue(a.onStartup).onChange((v) => (a.onStartup = v)));

    const daily = new Setting(triggers).setName(t("modal.auto.daily"));
    daily.settingEl.addClass("mb-trigger", "mb-trigger-input");
    daily.addText((c) => {
      c.inputEl.type = "time";
      c.setValue(a.daily.time).onChange((v) => {
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) a.daily.time = v;
      });
    });
    daily.addToggle((c) => c.setValue(a.daily.on).onChange((v) => (a.daily.on = v)));
  }

  /** 本地类目的地：目标文件夹（整行输入框 + “选择…”按钮）与各类型字段 */
  private folderFields(el: HTMLElement, text: (typeof TEXT)[DestinationType]): void {
    const folder = new Setting(el).setName(t(text.folder)).setDesc(t(text.folderDesc));
    folder.settingEl.addClass("mb-stacked");
    const row = folder.controlEl.createDiv({ cls: "mb-field-row" });
    const input = row.createEl("input", { type: "text", cls: "mb-mono", attr: { placeholder: t("modal.folder.ph"), spellcheck: "false" } });
    input.value = this.draft.path;
    input.addEventListener("input", () => {
      this.draft.path = input.value;
      this.validateFolder();
    });
    if (canPickFolder()) {
      const btn = row.createEl("button", { text: t("modal.browse") });
      setIcon(btn.createSpan({ cls: "mb-btn-icon" }), "folder");
      btn.prepend(btn.lastChild as Node);
      btn.addEventListener("click", () => {
        void pickFolder(this.draft.path).then((p) => {
          if (!p) return;
          input.value = p;
          this.draft.path = p;
          this.validateFolder();
        });
      });
    }
    this.folderError = folder.controlEl.createDiv({ cls: "mb-error-text" });

    if (this.draft.type === "zip") this.zipFields(el, this.draft);
    else if (this.draft.type === "git") this.gitFields(el, this.draft);
    else if (this.draft.type === "mirror") this.mirrorFields(el, this.draft);
  }

  /** 远程 Git：平台、地址、分支、用户名、令牌 */
  private remoteFields(el: HTMLElement, d: GitRemoteConfig): void {
    const defaults: Record<GitProvider, string> = { github: "main", gitee: "master", other: "main" };
    const placeholders: Record<GitProvider, string> = {
      github: "https://github.com/owner/repo.git",
      gitee: "https://gitee.com/owner/repo.git",
      other: "https://git.example.com/owner/repo.git",
    };
    new Setting(el)
      .setName(t("modal.platform.name"))
      .setDesc(t("modal.platform.desc"))
      .addDropdown((c) =>
        c
          .addOptions({ github: "GitHub", gitee: "Gitee", other: t("modal.platform.other") })
          .setValue(d.provider)
          .onChange((v) => {
            const next = v as GitProvider;
            if (d.branch === defaults[d.provider]) d.branch = defaults[next];
            d.provider = next;
            this.rerender();
          }),
      );
    const url = new Setting(el).setName(t("modal.url.name")).setDesc(t("modal.url.desc"));
    url.settingEl.addClass("mb-wide");
    url.addText((c) => {
      c.setPlaceholder(placeholders[d.provider]).setValue(d.url).onChange((v) => (d.url = v));
      c.inputEl.addClass("mb-mono");
      c.inputEl.spellcheck = false;
    });
    new Setting(el)
      .setName(t("modal.branch.name"))
      .setDesc(t("modal.branch.desc"))
      .addText((c) => {
        c.setValue(d.branch).onChange((v) => (d.branch = v));
        c.inputEl.addClass("mb-mono");
      });
    if (d.provider !== "github") {
      new Setting(el)
        .setName(t("modal.user.name"))
        .setDesc(t("modal.user.desc"))
        .addText((c) => {
          c.setValue(d.username).onChange((v) => (d.username = v));
          c.inputEl.addClass("mb-mono");
        });
    }
    const token = addSecretSetting(el, this.app, {
      name: t("modal.token.name"),
      desc: t("modal.token.desc"),
      value: d.tokenSecret,
      onChange: (v) => (d.tokenSecret = v),
    });
    const steps = { github: 4, gitee: 3, other: 3 }[d.provider];
    const guide = el.createDiv({ cls: "mb-token-guide" });
    const ol = guide.createEl("ol");
    for (let i = 1; i <= steps; i++) ol.createEl("li", { text: t(`modal.token.${d.provider}.${i}` as "modal.token.github.1") });
    guide.toggle(this.guideOpen);
    token.descEl.appendText(" ");
    const link = token.descEl.createEl("a", { text: t(this.guideOpen ? "modal.token.hide" : "modal.token.howto"), href: "#" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      this.guideOpen = !this.guideOpen;
      guide.toggle(this.guideOpen);
      link.setText(t(this.guideOpen ? "modal.token.hide" : "modal.token.howto"));
    });
  }

  /** 选了别的服务或服务商后重画弹窗 */
  private rerender(): void {
    this.contentEl.empty();
    this.onOpen();
  }

  /** WebDAV：服务、说明、地址、用户名、密码、文件夹 */
  private davFields(el: HTMLElement, d: WebDavConfig): void {
    new Setting(el)
      .setName(t("modal.dav.preset.name"))
      .setDesc(t("modal.dav.preset.desc"))
      .addDropdown((c) =>
        c
          .addOptions({ jianguo: t("modal.dav.preset.jianguo"), nextcloud: "Nextcloud", alist: t("modal.dav.preset.alist"), other: t("modal.dav.preset.other") })
          .setValue(d.preset)
          .onChange((v) => {
            const next = v as WebDavPreset;
            if (!d.url || d.url === WEBDAV_PRESETS[d.preset].url) d.url = WEBDAV_PRESETS[next].url;
            d.preset = next;
            this.rerender();
          }),
      );
    if (d.preset !== "other") {
      const ol = el.createDiv({ cls: "mb-token-guide" }).createEl("ol");
      for (const i of [1, 2]) ol.createEl("li", { text: t(`modal.dav.help.${d.preset}.${i}` as "modal.dav.help.jianguo.1") });
      if (d.preset === "alist") ol.createEl("li").createEl("a", { text: t("modal.dav.help.alistGuide"), href: ALIST_GUIDE });
    }
    const placeholders: Record<WebDavPreset, string> = {
      jianguo: "https://dav.jianguoyun.com/dav/",
      nextcloud: "https://cloud.example.com/remote.php/dav/files/USER/",
      alist: "http://192.168.1.10:5244/dav/",
      other: "https://nas.local:5006/",
    };
    const url = new Setting(el).setName(t("modal.dav.url.name"));
    url.settingEl.addClass("mb-wide");
    url.addText((c) => {
      c.setPlaceholder(placeholders[d.preset]).setValue(d.url).onChange((v) => (d.url = v));
      c.inputEl.addClass("mb-mono");
      c.inputEl.spellcheck = false;
    });
    new Setting(el).setName(t("modal.user.name")).addText((c) => {
      c.setPlaceholder(d.preset === "jianguo" ? "me@example.com" : "").setValue(d.username).onChange((v) => (d.username = v));
      c.inputEl.addClass("mb-mono");
    });
    addSecretSetting(el, this.app, { name: t("modal.password.name"), desc: t("modal.password.desc"), value: d.passwordSecret, onChange: (v) => (d.passwordSecret = v) });
    new Setting(el)
      .setName(t("modal.dav.folder.name"))
      .setDesc(t("modal.dav.folder.desc"))
      .addText((c) => {
        c.setPlaceholder("/Obsidian").setValue(d.folder).onChange((v) => (d.folder = v));
        c.inputEl.addClass("mb-mono");
      });
  }

  /** S3：服务商、地址、地域、桶、前缀、访问密钥、路径风格 */
  private s3Fields(el: HTMLElement, d: S3Config): void {
    new Setting(el)
      .setName(t("modal.s3.provider.name"))
      .setDesc(t("modal.s3.provider.desc"))
      .addDropdown((c) =>
        c
          .addOptions({ aws: "AWS S3", oss: t("modal.s3.provider.oss"), cos: t("modal.s3.provider.cos"), r2: "Cloudflare R2", minio: "MinIO" })
          .setValue(d.preset)
          .onChange((v) => {
            const old = S3_PRESETS[d.preset];
            const next = S3_PRESETS[v as S3Preset];
            if (!d.endpoint || d.endpoint === old.endpoint) d.endpoint = next.endpoint;
            if (!d.region || d.region === old.region) d.region = next.region;
            d.pathStyle = next.pathStyle;
            d.preset = v as S3Preset;
            this.rerender();
          }),
      );
    const placeholders: Partial<Record<S3Preset, string>> = { r2: "https://<account>.r2.cloudflarestorage.com", minio: "http://192.168.1.10:9000" };
    const text = (s: Setting, value: string, set: (v: string) => void, ph = "") =>
      s.addText((c) => {
        c.setPlaceholder(ph).setValue(value).onChange(set);
        c.inputEl.addClass("mb-mono");
        c.inputEl.spellcheck = false;
      });
    const endpoint = new Setting(el).setName(t("modal.s3.endpoint.name"));
    endpoint.settingEl.addClass("mb-wide");
    text(endpoint, d.endpoint, (v) => (d.endpoint = v), placeholders[d.preset] ?? S3_PRESETS[d.preset].endpoint);
    text(new Setting(el).setName(t("modal.s3.region.name")), d.region, (v) => (d.region = v), S3_PRESETS[d.preset].region);
    text(new Setting(el).setName(t("modal.s3.bucket.name")), d.bucket, (v) => (d.bucket = v), "notes-backup");
    text(new Setting(el).setName(t("modal.s3.prefix.name")).setDesc(t("modal.s3.prefix.desc")), d.prefix, (v) => (d.prefix = v), "obsidian");
    text(new Setting(el).setName(t("modal.s3.keyId.name")), d.accessKeyId, (v) => (d.accessKeyId = v));
    addSecretSetting(el, this.app, { name: t("modal.s3.secret.name"), desc: t("modal.s3.secret.desc"), value: d.secretKeySecret, onChange: (v) => (d.secretKeySecret = v) });
    new Setting(el)
      .setName(t("modal.s3.pathStyle.name"))
      .setDesc(t("modal.s3.pathStyle.desc"))
      .addToggle((c) => c.setValue(d.pathStyle).onChange((v) => (d.pathStyle = v)));
  }

  /** 网盘（按 M5 预览页 cloud.html）：账号（登录 / 退出登录）、文件夹 */
  private cloudFields(el: HTMLElement, d: CloudConfig): void {
    const name = CLOUD_NAMES[d.kind];
    const secret = cloudSecretName(d.id);
    const auth = this.sync.cloudAuth;
    const tokens = auth.load(secret);
    const account = new Setting(el).setName(t("modal.cloud.account")).setDesc(t("modal.cloud.accountDesc"));
    if (!cloudConfigured(d.kind)) {
      account.descEl.createDiv({ text: t("modal.cloud.notConfigured", { name }), cls: "mb-error-text" });
    } else if (tokens) {
      const who = account.controlEl.createSpan({ cls: "mb-cloud-account" });
      setIcon(who.createSpan({ cls: "mb-btn-icon" }), "check");
      who.createSpan({ text: tokens.account || t("modal.cloud.signedIn") });
      account.addButton((b) =>
        b.setButtonText(t("modal.cloud.signOut")).onClick(() => {
          auth.signOut(secret);
          this.rerender();
        }),
      );
    } else if (this.signing) {
      account.addButton((b) => b.setButtonText(t("modal.cloud.waiting")).setDisabled(true));
      account.addButton((b) =>
        b.setButtonText(t("common.cancel")).onClick(() => {
          this.signing = false;
          this.device = null;
          auth.cancel();
          this.rerender();
        }),
      );
      const box = el.createDiv({ cls: "mb-token-guide mb-cloud-wait" });
      if (this.device) {
        box.createDiv({ text: t("modal.cloud.deviceStep", { url: this.device.verifyUrl }) });
        const code = box.createDiv({ cls: "mb-cloud-code" });
        code.createEl("code", { text: this.device.userCode });
        const copy = code.createEl("button", { text: t("modal.cloud.copy") });
        copy.addEventListener("click", () => void navigator.clipboard.writeText(this.device?.userCode ?? ""));
        const open = code.createEl("button", { text: t("modal.cloud.openPage"), cls: "mod-cta" });
        open.addEventListener("click", () => window.open(this.device?.verifyUrl));
      } else box.createDiv({ text: t("modal.cloud.browserStep", { name }) });
    } else {
      account.addButton((b) =>
        b
          .setButtonText(t("modal.cloud.signIn", { name }))
          .setCta()
          .onClick(() => void this.signIn(d)),
      );
    }
    if (this.signError) account.descEl.createDiv({ text: this.signError, cls: "mb-error-text" });

    new Setting(el)
      .setName(t("modal.dav.folder.name"))
      .setDesc(t("modal.dav.folder.desc"))
      .addText((c) => {
        c.setPlaceholder(cloudFolder({ ...d, folder: "" }, this.app.vault.getName())).setValue(d.folder).onChange((v) => (d.folder = v));
        c.inputEl.addClass("mb-mono");
      });
  }

  private async signIn(d: CloudConfig): Promise<void> {
    const auth = this.sync.cloudAuth;
    const secret = cloudSecretName(d.id);
    this.signing = true;
    this.signError = "";
    this.device = null;
    this.rerender();
    try {
      if (d.kind === "gdrive") {
        this.device = await auth.deviceCode(d.kind);
        this.rerender();
        window.open(this.device.verifyUrl);
        await auth.waitDevice(d.kind, secret, this.device, () => !this.signing);
      } else await auth.signIn(d.kind, secret);
    } catch (e) {
      if (this.signing) this.signError = e instanceof DestinationError ? errorText(e.code, CLOUD_NAMES[d.kind]) : errorText("io", CLOUD_NAMES[d.kind]);
    }
    this.signing = false;
    this.device = null;
    if (this.contentEl.isConnected) this.rerender();
  }

  private mirrorFields(el: HTMLElement, d: MirrorConfig | WebDavConfig | S3Config | CloudConfig): void {
    new Setting(el)
      .setName(t("modal.delete.name"))
      .setDesc(t("modal.delete.desc"))
      .addDropdown((c) =>
        c
          .addOptions({ trash30: t("modal.delete.trash30"), delete: t("modal.delete.delete"), keep: t("modal.delete.keep") })
          .setValue(d.deletePolicy)
          .onChange((v) => (d.deletePolicy = v as MirrorConfig["deletePolicy"])),
      );
    const versions = new Setting(el).setName(t("modal.versions.name")).setDesc(t("modal.versions.desc"));
    versions.controlEl.createSpan({ text: t("modal.versions.prefix") });
    versions.addText((c) => numberInput(c.inputEl, d.keepVersions, 0, 1000, (n) => (d.keepVersions = n)));
    versions.controlEl.createSpan({ text: t("modal.versions.suffix") });
  }

  private zipFields(el: HTMLElement, d: ZipConfig): void {
    const name = new Setting(el).setName(t("modal.fileName.name"));
    const example = () => snapshotFileName(d.fileName, this.app.vault.getName(), new Date());
    const desc = name.descEl;
    const renderDesc = () => {
      desc.empty();
      desc.appendText(t("modal.fileName.desc") + " ");
      for (const p of ["{vault}", "{date}", "{time}"]) {
        desc.createEl("code", { text: p });
        desc.appendText(" ");
      }
      desc.createEl("br");
      desc.appendText(t("modal.fileName.example") + " ");
      desc.createEl("code", { text: example() });
    };
    renderDesc();
    name.addText((c) => {
      c.setValue(d.fileName).onChange((v) => {
        d.fileName = v;
        renderDesc();
      });
      c.inputEl.addClass("mb-mono");
    });

    const keep = new Setting(el).setName(t("modal.keep.name")).setDesc(t("modal.keep.desc"));
    keep.controlEl.createSpan({ text: t("modal.keep.latest") });
    keep.addText((c) => numberInput(c.inputEl, d.keepCount, 0, 100000, (n) => (d.keepCount = n)));
    keep.controlEl.createSpan({ text: t("modal.keep.within") });
    keep.addText((c) => numberInput(c.inputEl, d.keepDays, 0, 100000, (n) => (d.keepDays = n)));
    keep.controlEl.createSpan({ text: t("modal.keep.days") });
  }

  private gitFields(el: HTMLElement, d: GitConfig | GitRemoteConfig): void {
    const msg = new Setting(el).setName(t("modal.commit.name"));
    const renderDesc = () => {
      const desc = msg.descEl;
      desc.empty();
      desc.appendText(t("modal.commit.desc") + " ");
      for (const p of ["{vault}", "{date}", "{time}"]) {
        desc.createEl("code", { text: p });
        desc.appendText(" ");
      }
      desc.createEl("br");
      desc.appendText(t("modal.fileName.example") + " ");
      desc.createEl("code", { text: commitMessage(d.commitMessage, this.app.vault.getName(), new Date()) });
    };
    renderDesc();
    msg.addText((c) => {
      c.setValue(d.commitMessage).onChange((v) => {
        d.commitMessage = v;
        renderDesc();
      });
      c.inputEl.addClass("mb-mono");
    });

    const author = new Setting(el).setName(t("modal.author.name")).setDesc(t("modal.author.desc"));
    author.controlEl.addClass("mb-author");
    author.addText((c) => c.setPlaceholder(t("modal.author.namePh")).setValue(d.authorName).onChange((v) => (d.authorName = v)));
    author.addText((c) => {
      c.setPlaceholder(t("modal.author.emailPh")).setValue(d.authorEmail).onChange((v) => (d.authorEmail = v));
      c.inputEl.addClass("mb-mono", "mb-email");
    });
  }

  /** 路径在 Vault 里面（或包含 Vault）时提示并禁止保存 */
  private validateFolder(): boolean {
    const notSigned = this.draft.type === "cloud" && !this.sync.cloudAuth.load(cloudSecretName(this.draft.id));
    if (this.saveBtn && notSigned) this.saveBtn.disabled = true;
    if (notSigned) return false;
    const bad = !isRemote(this.draft) && conflictsWithVault(this.draft.path, vaultBasePath(this.app.vault.adapter));
    this.folderError.setText(bad ? errorText("inside-vault") : "");
    this.folderError.toggle(bad);
    if (this.saveBtn) this.saveBtn.disabled = bad;
    return !bad;
  }

  private async runTest(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    this.showResult("pending", t("modal.testing"));
    try {
      const info = await this.sync.testDestination(this.draft);
      if (this.draft.type === "git-remote") {
        const branch = this.draft.branch.trim() || "main";
        const state =
          info.remote === "empty" ? t("modal.test.remoteEmpty") : info.remote === "branch" ? t("modal.test.remoteBranch", { branch }) : t("modal.test.remoteNoBranch", { branch });
        this.showResult("ok", t("modal.test.connected") + " " + state);
        return;
      }
      const parts = [t(isRemote(this.draft) ? "modal.test.remoteOk" : "modal.test.ok")];
      if (info.freeBytes !== null) parts.push(t("modal.test.free", { free: sizeLabel(info.freeBytes) }));
      if (this.draft.type === "mirror" || this.draft.type === "webdav" || this.draft.type === "s3") parts.push(t("modal.test.files", { count: info.existing.toLocaleString() }));
      else if (this.draft.type === "git") {
        if (!info.isRepo) parts.push(t("modal.test.notRepo"));
        else if (info.existing && info.newest)
          parts.push(t("modal.test.commits", { count: info.existing.toLocaleString(), when: whenLabel(info.newest, Date.now(), currentLocale()) }));
        else parts.push(t("modal.test.noCommits"));
      }
      else if (info.existing && info.newest)
        parts.push(t("modal.test.snapshots", { count: info.existing, when: whenLabel(info.newest, Date.now(), currentLocale()) }));
      else parts.push(t("modal.test.noSnapshots"));
      this.showResult("ok", parts.join(" "));
    } catch (e) {
      const err = e instanceof DestinationError ? e : new DestinationError("io", destWhere(this.draft));
      this.showResult("fail", errorText(err.code, err.path || destWhere(this.draft)));
    } finally {
      btn.disabled = false;
    }
  }

  private showResult(kind: "ok" | "fail" | "pending", text: string): void {
    this.resultEl.empty();
    this.resultEl.show();
    this.resultEl.className = `mb-test-result is-${kind}`;
    if (kind !== "pending") setIcon(this.resultEl.createSpan({ cls: "mb-test-icon" }), kind === "ok" ? "check" : "alert-triangle");
    this.resultEl.createSpan({ text });
  }

  private async save(): Promise<void> {
    if (!this.validateFolder()) return;
    this.draft.path = this.draft.path.trim();
    this.draft.name = this.draft.name.trim();
    if (this.draft.type === "git-remote") {
      this.draft.url = this.draft.url.trim();
      this.draft.branch = this.draft.branch.trim() || "main";
      this.draft.username = this.draft.username.trim();
    }
    if (this.draft.type === "webdav") {
      this.draft.url = this.draft.url.trim();
      this.draft.username = this.draft.username.trim();
      this.draft.folder = this.draft.folder.trim() || "/Obsidian";
    }
    if (this.draft.type === "cloud") this.draft.folder = this.draft.folder.trim();
    if (this.draft.type === "s3") {
      const d = this.draft;
      d.endpoint = d.endpoint.trim().replace(/\/+$/, "");
      d.region = d.region.trim() || S3_PRESETS[d.preset].region;
      d.bucket = d.bucket.trim();
      d.prefix = d.prefix.trim().replace(/^\/+|\/+$/g, "");
      d.accessKeyId = d.accessKeyId.trim();
    }
    if (this.draft.type === "git" || this.draft.type === "git-remote") {
      const d = newDestination("git") as GitConfig;
      this.draft.commitMessage = this.draft.commitMessage.trim() || d.commitMessage;
      this.draft.authorName = this.draft.authorName.trim() || d.authorName;
      this.draft.authorEmail = this.draft.authorEmail.trim() || d.authorEmail;
    }
    await this.onSave(this.draft);
    this.saved = true;
    this.close();
  }

  override onClose(): void {
    this.signing = false;
    this.sync.cloudAuth.cancel();
    // 新加的网盘登录了却没保存：删掉刚存的凭据
    if (this.isNew && !this.saved && this.draft.type === "cloud") this.sync.cloudAuth.signOut(cloudSecretName(this.draft.id));
    this.contentEl.empty();
  }
}

function numberInput(el: HTMLInputElement, value: number, min: number, max: number, set: (n: number) => void): void {
  el.type = "number";
  el.min = String(min);
  el.max = String(max);
  el.value = String(value);
  el.addClass("mb-number");
  el.addEventListener("change", () => {
    const n = Math.floor(Number(el.value));
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    el.value = String(v);
    set(v);
  });
}
