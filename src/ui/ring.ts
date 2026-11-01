// 同步环：取自 Logo 的状态图标（成功、同步中、失败、未同步、已暂停）
import type { RingState } from "../core/overview";

const ARC = "M5 12 A7 7 0 0 1 16.9 7.1";
const HEAD = "18.7,8.8 17.6,4.9 14.8,7.4";

export function renderRing(parent: HTMLElement, state: RingState, label?: string): SVGSVGElement {
  return parent.createSvg("svg", { cls: ["mb-ring", `is-${state}`], attr: { viewBox: "0 0 24 24", role: "img", "aria-label": label ?? state } }, (svg) => {
    for (const rotate of [null, "rotate(180 12 12)"]) {
      svg.createSvg("g", rotate ? { attr: { transform: rotate } } : undefined, (g) => {
        g.createSvg("path", { attr: { d: ARC } });
        g.createSvg("polygon", { attr: { points: HEAD } });
      });
    }
    if (state === "error") svg.createSvg("circle", { cls: "mb-ring-dot", attr: { cx: 12, cy: 12, r: 2.2 } });
    if (state === "paused") svg.createSvg("path", { cls: "mb-ring-pause", attr: { d: "M10 9.5v5M14 9.5v5" } });
  });
}

/** 功能区按钮用的图标（Obsidian 图标坐标为 100×100） */
export const RIBBON_ICON_ID = "multi-backup-ring";
const ARC100 =
  '<path d="M20 50 A30 30 0 0 1 71.2 28.8" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><polygon points="78.3,35.9 74,20.3 62.7,31.7" fill="currentColor"/>';
export const RIBBON_ICON_SVG = `${ARC100}<g transform="rotate(180 50 50)">${ARC100}</g>`;
