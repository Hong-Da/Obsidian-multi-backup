import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { Logger, type LogSink } from "../../src/core/logger";
import { isSecretName } from "../../src/core/secrets";
import { ObsidianSecrets } from "../../src/platform/secrets";
import { mergeSettings } from "../../src/settings";

function fakeApp(store: Record<string, string>): App {
  return { secretStorage: { getSecret: (id: string) => store[id] ?? null } } as unknown as App;
}

describe("密钥名", () => {
  it.each([
    ["github-token", true],
    ["a1", true],
    ["multi-backup-d-k3x9", true],
    ["GitHub", false],
    ["has space", false],
    ["-lead", false],
    ["trail-", false],
    ["double--dash", false],
    ["", false],
  ])("%s → %s", (name, ok) => expect(isSecretName(name)).toBe(ok));
});

describe("ObsidianSecrets", () => {
  it("读取凭据，并让它之后不出现在日志里", () => {
    const lines: string[] = [];
    const sink: LogSink = { write: (_l, line) => lines.push(line) };
    const logger = new Logger([sink]);
    const secrets = new ObsidianSecrets(fakeApp({ "github-token": "ghp_abcdefghijklmnop" }), logger);

    expect(secrets.get("github-token")).toBe("ghp_abcdefghijklmnop");
    logger.info("push failed for ghp_abcdefghijklmnop");
    expect(lines.join("\n")).not.toContain("ghp_abcdefghijklmnop");
  });

  it("密钥名不合法或不存在时返回 null", () => {
    const secrets = new ObsidianSecrets(fakeApp({}), new Logger([]));
    expect(secrets.get("missing")).toBeNull();
    expect(secrets.get("Bad Name")).toBeNull();
    expect(secrets.get("")).toBeNull();
  });
});

describe("凭据不进 data.json", () => {
  it("设置里混进的凭据字段在读取时被丢弃", () => {
    const saved = {
      token: "ghp_top_level_secret",
      destinations: [
        { id: "d-1", type: "mirror", name: "A", path: "E:\\Backup", token: "ghp_dest_secret", password: "p@ss-word-1" },
      ],
    };
    const json = JSON.stringify(mergeSettings(saved));
    expect(json).not.toContain("ghp_top_level_secret");
    expect(json).not.toContain("ghp_dest_secret");
    expect(json).not.toContain("p@ss-word-1");
  });
});
