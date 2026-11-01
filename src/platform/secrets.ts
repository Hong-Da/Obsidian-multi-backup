// 从 Obsidian 的本机密钥存储读取凭据。读到的值会登记到日志脱敏，之后不会出现在日志里。

import type { App } from "obsidian";
import type { Logger } from "../core/logger";
import { isSecretName, type SecretReader } from "../core/secrets";

export class ObsidianSecrets implements SecretReader {
  constructor(
    private readonly app: App,
    private readonly logger: Logger,
  ) {}

  get(name: string): string | null {
    if (!isSecretName(name)) return null;
    const value = this.app.secretStorage.getSecret(name);
    this.logger.addSecret(value);
    return value;
  }
}
