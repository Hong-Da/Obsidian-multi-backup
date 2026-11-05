import { describe, expect, it } from "vitest";
import { GITHUB_TOKEN_URL, gitHostTokenUrl, nextcloudSecurityUrl, s3Policy } from "../../src/core/key-guide";

describe("创建密钥的指导：页面地址", () => {
  it("GitHub 预填名称、不过期和 Contents 读写", () => {
    const u = new URL(GITHUB_TOKEN_URL);
    expect(u.origin + u.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(u.searchParams.get("expires_in")).toBe("none");
    expect(u.searchParams.get("contents")).toBe("write");
    expect(u.searchParams.get("name")).toBe("Obsidian Multi Backup");
  });

  it("其他 Git：GitLab 用个人令牌页并预填 write_repository，其余按 Gitea / Forgejo", () => {
    const gl = new URL(gitHostTokenUrl("https://gitlab.com/me/notes.git")!);
    expect(gl.origin + gl.pathname).toBe("https://gitlab.com/-/user_settings/personal_access_tokens");
    expect(gl.searchParams.get("scopes")).toBe("write_repository");
    expect(gitHostTokenUrl("https://gitlab.example.org/me/notes.git")).toMatch(/^https:\/\/gitlab\.example\.org\/-\/user_settings\//);
    expect(gitHostTokenUrl("https://git.example.com:3000/me/notes.git")).toBe("https://git.example.com:3000/user/settings/applications");
    expect(gitHostTokenUrl("")).toBeNull();
    expect(gitHostTokenUrl("git@host:me/notes.git")).toBeNull();
  });

  it("Nextcloud：取 /remote.php 之前的部分作为根，带子路径也行", () => {
    expect(nextcloudSecurityUrl("https://cloud.example.com/remote.php/dav/files/me/")).toBe("https://cloud.example.com/index.php/settings/user/security");
    expect(nextcloudSecurityUrl("https://example.com/nextcloud/remote.php/dav/files/me/")).toBe("https://example.com/nextcloud/index.php/settings/user/security");
    expect(nextcloudSecurityUrl("https://cloud.example.com")).toBe("https://cloud.example.com/index.php/settings/user/security");
    expect(nextcloudSecurityUrl("not a url")).toBeNull();
  });
});

interface Statement { Effect?: string; Action?: string[]; Resource?: string[]; resource?: string[] }
interface Policy { Version?: string; Statement: Statement[]; statement: Statement[] }
const parse = (r: ReturnType<typeof s3Policy>): Policy => {
  if (!("policy" in r)) throw new Error("没有生成策略");
  return JSON.parse(r.policy) as Policy;
};

describe("创建密钥的指导：只允许一个桶的权限策略", () => {
  it("AWS / MinIO：列出桶，读写删除桶里的对象", () => {
    const doc = parse(s3Policy("aws", " notes-backup "));
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Statement[0]).toEqual({ Effect: "Allow", Action: ["s3:ListBucket"], Resource: ["arn:aws:s3:::notes-backup"] });
    expect(doc.Statement[1]?.Resource).toEqual(["arn:aws:s3:::notes-backup/*"]);
    expect(doc.Statement[1]?.Action).toEqual(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);
  });

  it("阿里云 OSS 用 acs:oss 资源", () => {
    const doc = parse(s3Policy("oss", "notes"));
    expect(doc.Version).toBe("1");
    expect(doc.Statement[0]?.Resource).toEqual(["acs:oss:*:*:notes"]);
    expect(doc.Statement[1]?.Resource).toEqual(["acs:oss:*:*:notes/*"]);
  });

  it("腾讯云 COS：从桶名取 APPID，带地域", () => {
    const doc = parse(s3Policy("cos", "notes-1250000000", "ap-guangzhou"));
    expect(doc.statement[0]?.resource).toEqual([
      "qcs::cos:ap-guangzhou:uid/1250000000:notes-1250000000/",
      "qcs::cos:ap-guangzhou:uid/1250000000:notes-1250000000/*",
    ]);
    expect(s3Policy("cos", "notes")).toEqual({ missing: "appid" });
  });

  it("没填桶名时提示先填", () => {
    expect(s3Policy("aws", "  ")).toEqual({ missing: "bucket" });
  });
});
