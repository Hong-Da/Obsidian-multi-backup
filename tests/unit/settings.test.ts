import { describe, expect, it } from "vitest";
import { canBePrimary, DEFAULT_SETTINGS, isRemote, mergeSettings, newDestination, splitRules, type S3Config, type WebDavConfig } from "../../src/settings";
import { destWhere } from "../../src/ui/messages";

describe("设置", () => {
  it("没有保存过时用默认值", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("保留合法的已保存值", () => {
    const s = mergeSettings({ debugLog: true, logKeepDays: 30, includeConfigDir: false, excludes: "*.tmp", maxFileSizeMB: 100 });
    expect(s).toMatchObject({ debugLog: true, logKeepDays: 30, includeConfigDir: false, excludes: "*.tmp", maxFileSizeMB: 100 });
  });

  it("类型错误或超出范围的字段回到默认值", () => {
    expect(mergeSettings({ debugLog: "yes", logKeepDays: 0, maxFileSizeMB: -1, destinations: "x" })).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ logKeepDays: 999 }).logKeepDays).toBe(DEFAULT_SETTINGS.logKeepDays);
  });

  it("忽略未知字段", () => {
    expect(mergeSettings({ foo: 1 })).toEqual(DEFAULT_SETTINGS);
  });
});

describe("目的地设置", () => {
  it("新建目的地带默认值", () => {
    expect(newDestination("mirror")).toMatchObject({ type: "mirror", enabled: true, deletePolicy: "trash30", keepVersions: 10 });
    expect(newDestination("zip")).toMatchObject({ type: "zip", fileName: "{vault}_{date}_{time}.zip", keepCount: 30, keepDays: 90 });
    expect(newDestination("mirror").id).not.toBe(newDestination("mirror").id);
  });

  it("保存后读回一致", () => {
    const m = { ...newDestination("mirror"), name: "移动硬盘", path: "E:\\Backup", deletePolicy: "keep" as const, keepVersions: 3 };
    const z = { ...newDestination("zip"), path: "D:\\Snaps", keepCount: 0 };
    const s = mergeSettings(JSON.parse(JSON.stringify({ destinations: [m, z] })));
    expect(s.destinations).toEqual([m, z]);
  });

  it("认不出的目的地丢弃，字段不合法时用默认值", () => {
    const s = mergeSettings({
      destinations: [
        { type: "ftp", path: "x" },
        null,
        { type: "mirror", id: "a", deletePolicy: "burn", keepVersions: -3, enabled: "no" },
      ],
    });
    expect(s.destinations).toHaveLength(1);
    expect(s.destinations[0]).toMatchObject({ id: "a", deletePolicy: "trash30", keepVersions: 10, enabled: true });
  });

  it("本地 git：默认提交说明与作者，空值回到默认", () => {
    const g = newDestination("git");
    expect(g).toMatchObject({ type: "git", commitMessage: "Backup {date} {time}", authorName: "Multi Backup", authorEmail: "multi-backup@localhost" });
    const saved = { destinations: [{ ...g, commitMessage: "{vault} 备份", authorName: "  ", authorEmail: 5 }] };
    expect(mergeSettings(saved).destinations[0]).toMatchObject({ commitMessage: "{vault} 备份", authorName: "Multi Backup", authorEmail: "multi-backup@localhost" });
  });

  it("WebDAV、S3：默认值、合并与主同步端", () => {
    const w = newDestination("webdav") as WebDavConfig;
    expect(w).toMatchObject({ type: "webdav", preset: "jianguo", url: "https://dav.jianguoyun.com/dav/", folder: "/Obsidian", passwordSecret: "", deletePolicy: "trash30" });
    const s3 = newDestination("s3") as S3Config;
    expect(s3).toMatchObject({ type: "s3", preset: "aws", region: "us-east-1", pathStyle: false, prefix: "obsidian" });
    const saved = {
      primaryId: s3.id,
      destinations: [
        { ...w, preset: "nope", folder: "  ", keepVersions: -1, passwordSecret: "dav-pw" },
        { ...s3, preset: "minio", bucket: " notes ", pathStyle: "yes", secretKeySecret: "s3-secret" },
      ],
    };
    const m = mergeSettings(saved);
    expect(m.destinations[0]).toMatchObject({ preset: "jianguo", folder: "/Obsidian", keepVersions: 10, passwordSecret: "dav-pw" });
    expect(m.destinations[1]).toMatchObject({ preset: "minio", bucket: "notes", pathStyle: false, secretKeySecret: "s3-secret" });
    expect(m.primaryId).toBe(s3.id);
    expect([w, s3].every((d) => canBePrimary(d) && isRemote(d))).toBe(true);
    expect(canBePrimary(newDestination("git")) || isRemote(newDestination("mirror"))).toBe(false);
    // 设置里只有密钥名，没有密码本身
    expect(JSON.stringify(m)).not.toMatch(/password"|secretAccessKey/);
    expect(destWhere({ ...w, folder: "/Obsidian/笔记" })).toBe("https://dav.jianguoyun.com/dav/Obsidian/笔记");
    expect(destWhere({ ...s3, bucket: "notes" })).toBe("notes/obsidian");
  });

  it("规则文本按行拆分，去掉空行与注释", () => {
    expect(splitRules("a/**\n\n  # 注释\r\n*.tmp  ")).toEqual(["a/**", "*.tmp"]);
  });
});
