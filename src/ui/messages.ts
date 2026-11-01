// 把状态与错误转成界面文字
import type { DestinationErrorCode } from "../core/errors";
import { secondsLabel, whenLabel } from "../core/format";
import type { DestState } from "../core/overview";
import { currentLocale, t, tn } from "../i18n";
import { CLOUD_NAMES, type DestinationConfig } from "../settings";

export function errorText(code: DestinationErrorCode | undefined, path = ""): string {
  return t(`error.${code ?? "io"}`, { path });
}

/** 目的地列表中显示的位置：本机路径、仓库地址、WebDAV 地址加文件夹、桶加前缀 */
export function destWhere(d: DestinationConfig): string {
  if (d.type === "git-remote") return d.url;
  if (d.type === "webdav") return d.url ? d.url.replace(/\/+$/, "") + "/" + d.folder.replace(/^\/+/, "") : "";
  if (d.type === "s3") return d.bucket ? `${d.bucket}/${d.prefix.replace(/^\/+/, "")}` : "";
  if (d.type === "cloud") return `${CLOUD_NAMES[d.kind]}${d.folder ? " · " + d.folder : ""}`;
  return d.path;
}

export function destDisplayName(d: DestinationConfig): string {
  return d.name.trim() || (d.type === "cloud" ? CLOUD_NAMES[d.kind] : typeLabel(d.type));
}

export function typeLabel(type: string): string {
  if (type === "git-remote") return t("type.gitRemoteShort");
  if (type === "webdav") return t("type.webdav");
  if (type === "s3") return t("type.s3");
  if (type === "cloud") return t("type.cloud");
  return t(type === "zip" ? "type.zip" : type === "git" ? "type.git" : "type.mirror");
}

/** 目的地列表中的状态说明 */
export function destStatusText(s: DestState, progress: { done: number; total: number } | null, now = Date.now()): string {
  if (s.ring === "busy") return progress ? t("dest.status.syncing", { done: progress.done, total: progress.total }) : t("status.busyStart");
  if (s.ring === "paused") return t("dest.status.paused");
  if (!s.last) return t("dest.status.never");
  const d = s.last.dest;
  const when = whenLabel(s.last.entry.finishedAt, now, currentLocale());
  switch (d.status) {
    case "failed":
      return t("dest.status.failed", { when, reason: errorText(d.errorCode, d.errorPath) });
    case "partial":
      return t("dest.status.partial", { when, count: d.failedCount, reason: errorText(d.errorCode, d.errorPath) });
    case "unchanged":
      return t("dest.status.unchanged", { when });
    default:
      if (d.primary)
        return (
          t("dest.status.okPrimary", { when, down: d.primary.downloaded, up: d.uploaded }) +
          (d.primary.conflicts ? sentenceGap() + tn("dest.status.conflicts", d.primary.conflicts) : "")
        );
      if (d.type === "git" || d.type === "git-remote")
        return d.commit
          ? tn("dest.status.okGit", d.uploaded + d.moved + d.deleted, { when, commit: d.commit, n: d.uploaded + d.moved + d.deleted })
          : t("dest.status.noCommit", { when });
      if (d.snapshot) return t("dest.status.okZip", { when, name: d.snapshot });
      // 成功但什么都没改（如镜像重新连上后核对一致）：和“没有变化”说法一致
      if (d.uploaded + d.moved + d.deleted === 0) return t("dest.status.unchanged", { when });
      return tn("dest.status.ok", d.uploaded, { when, n: d.uploaded });
  }
}

/** 耗时：不到 1 秒时直接说“不到 1 秒”，避免“0.0 秒” */
export function durationText(ms: number): string {
  return ms < 1000 ? t("time.underSecond") : t("time.seconds", { sec: secondsLabel(ms) });
}

/** 句间间隔：英文加空格，中文不加 */
export function sentenceGap(): string {
  return currentLocale() === "zh-CN" ? "" : " ";
}

/** 把几句话连起来 */
export function joinSentences(...parts: string[]): string {
  return parts.filter(Boolean).join(sentenceGap());
}
