// 凭据规则：令牌、密码只放在 Obsidian 的本机密钥存储（app.secretStorage）。
// 设置（data.json）里只保存密钥名，也就是凭据的引用，不保存凭据本身。

/** Obsidian 要求的密钥名格式：小写字母、数字，中间可以有连字符 */
const SECRET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** 读取凭据的接口；插件中由 app.secretStorage 实现，测试中用内存实现 */
export interface SecretReader {
  /** 密钥名不合法或不存在时返回 null */
  get(name: string): string | null;
}
