// 右下角状态栏：显示整体同步状态，点击打开菜单
import { Menu, setIcon, setTooltip } from "obsidian";
import { agoLabel, whenLabel } from "../core/format";
import { destState, overview } from "../core/overview";
import { currentLocale, t, tn } from "../i18n";
import type { MultiBackupSettings } from "../settings";
import type { SyncService } from "../sync-service";
import { destDisplayName } from "./messages";
import { renderRing } from "./ring";

export interface StatusBarActions {
  openHistory(): void;
  openConflicts(): void;
  openSettings(): void;
  openRestore(): void;
}

export class StatusBar {
  constructor(
    private readonly el: HTMLElement,
    private readonly sync: SyncService,
    private readonly settings: () => MultiBackupSettings,
    private readonly actions: StatusBarActions,
  ) {
    el.addClass("mod-clickable", "mb-status");
    el.setAttr("role", "button");
    el.setAttr("tabindex", "0");
    el.addEventListener("click", (e) => this.openMenu(e));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        this.showMenuAt(r.left, r.top);
      }
    });
    this.render();
  }

  render(): void {
    const s = this.settings();
    const running = this.sync.running;
    const ov = overview(s.destinations, this.sync.history, running?.progress?.destId ?? null, !!running);
    const lang = currentLocale();
    this.el.empty();
    this.el.toggleClass("is-error", ov.state === "error");
    let text: string;
    let tip: string;
    if (ov.state === "busy") {
      const p = running?.progress;
      const name = p ? destDisplayName(s.destinations.find((d) => d.id === p.destId) ?? s.destinations[0]!) : "";
      text = p ? t("status.busy", { done: p.done, total: p.total }) : t("status.busyStart");
      tip = p ? t("tip.busy", { name, done: p.done, total: p.total }) : t("status.busyStart");
    } else if (ov.state === "none") {
      text = t("status.none");
      tip = t("tip.none");
    } else if (ov.state === "error") {
      text = tn("status.failed", ov.failedIds.length);
      const first = s.destinations.find((d) => d.id === ov.failedIds[0]);
      tip = t("tip.failed", { name: first ? destDisplayName(first) : "" });
    } else if (ov.state === "ok" && ov.lastAt) {
      text = agoLabel(ov.lastAt, Date.now(), lang);
      tip = t("tip.ok", { when: whenLabel(ov.lastAt, Date.now(), lang) });
    } else {
      text = t("status.idle");
      tip = t("tip.idle");
    }
    // 有未处理的冲突时，在前面显示冲突数（M3 预览页 conflicts.html）
    const conflicts = this.sync.conflicts.length;
    if (conflicts) {
      const c = this.el.createSpan({ cls: "mb-status-conflicts" });
      setIcon(c.createSpan({ cls: "mb-status-conflicts-icon" }), "git-compare");
      c.createSpan({ text: tn("status.conflicts", conflicts) });
      tip = tn("status.conflicts", conflicts) + " · " + tip;
    }
    renderRing(this.el, ov.state === "none" ? "idle" : ov.state === "idle" ? "idle" : ov.state);
    this.el.createSpan({ text });
    setTooltip(this.el, tip, { placement: "top" });
    this.el.setAttr("aria-label", tip);
  }

  private openMenu(e: MouseEvent): void {
    this.showMenuAt(e.clientX, e.clientY);
  }

  private showMenuAt(x: number, y: number): void {
    const s = this.settings();
    const menu = new Menu();
    if (!s.destinations.length) {
      menu.addItem((i) => i.setTitle(t("menu.addDestination")).setIcon("plus").onClick(() => this.actions.openSettings()));
      if (this.sync.conflicts.length) menu.addItem((i) => i.setTitle(tn("status.conflicts", this.sync.conflicts.length)).setIcon("git-compare").onClick(() => this.actions.openConflicts()));
      menu.addItem((i) => i.setTitle(t("menu.openHistory")).setIcon("history").onClick(() => this.actions.openHistory()));
      menu.addItem((i) => i.setTitle(t("menu.openSettings")).setIcon("settings").onClick(() => this.actions.openSettings()));
      menu.showAtPosition({ x, y });
      return;
    }
    menu.addItem((i) => i.setTitle(t("menu.syncAll")).setIcon("refresh-cw").onClick(() => void this.sync.syncAll("status-bar")));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(t("menu.syncOne")).setIsLabel(true));
    const runningId = this.sync.running?.progress?.destId ?? null;
    for (const d of s.destinations) {
      const st = destState(d, this.sync.history, runningId);
      const aside =
        st.ring === "busy"
          ? t("menu.status.syncing")
          : st.ring === "paused"
            ? t("menu.status.paused")
            : st.ring === "error"
              ? t("menu.status.failed")
              : st.last
                ? agoLabel(st.last.entry.finishedAt, Date.now(), currentLocale())
                : t("menu.status.never");
      // 与预览页一致：左侧同步环，右侧状态
      const title = createFragment((f) => {
        const row = f.createSpan({ cls: "mb-menu-dest" });
        renderRing(row, st.ring);
        row.createSpan({ text: destDisplayName(d), cls: "mb-menu-name" });
        row.createSpan({ text: aside, cls: "mb-menu-aside" });
      });
      menu.addItem((i) => i.setTitle(title).setDisabled(!d.enabled).onClick(() => void this.sync.syncOne(d.id, "status-bar")));
    }
    menu.addSeparator();
    if (this.sync.conflicts.length) menu.addItem((i) => i.setTitle(tn("status.conflicts", this.sync.conflicts.length)).setIcon("git-compare").onClick(() => this.actions.openConflicts()));
    menu.addItem((i) => i.setTitle(t("menu.openHistory")).setIcon("history").onClick(() => this.actions.openHistory()));
    menu.addItem((i) => i.setTitle(t("menu.restore")).setIcon("undo-2").onClick(() => this.actions.openRestore()));
    menu.addItem((i) => i.setTitle(t("menu.openSettings")).setIcon("settings").onClick(() => this.actions.openSettings()));
    menu.showAtPosition({ x, y });
  }
}
