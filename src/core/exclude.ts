// 排除规则：每行一条，类似 .gitignore 的简化版。
// - 不含 / 的规则匹配任意层级的文件名或文件夹名，例如 *.tmp、.DS_Store
// - 开头或中间含 / 的规则从 Vault 根目录开始匹配，例如 Attachments/Videos/**、/Archive/
// - 以 / 结尾表示文件夹及其中全部内容；只有结尾的 / 不算锚定（与 .gitignore 相同），例如 Archive/ 匹配任意层级的 Archive 文件夹
// - * 匹配一层中的任意字符，** 匹配任意多层，? 匹配一个字符
// - 以 # 开头的行和空行忽略；匹配不区分大小写（Vault 常在不同系统之间迁移）

export interface ExcludeOptions {
  /** Obsidian 配置文件夹名，通常是 .obsidian */
  configDir: string;
  /** 插件自己的数据文件夹（Vault 内路径），总是排除 */
  pluginDir: string;
  /** 是否备份配置文件夹 */
  includeConfigDir: boolean;
}

/** 内置规则，用户不能关闭 */
export function builtinRules(o: ExcludeOptions): string[] {
  const rules = [
    ".trash/",
    "/.git/",
    `/${o.pluginDir}/`,
    `/${o.configDir}/workspace.json`,
    `/${o.configDir}/workspace-mobile.json`,
    `/${o.configDir}/workspaces.json`,
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
  ];
  if (!o.includeConfigDir) rules.push(`/${o.configDir}/`);
  return rules;
}

interface Rule {
  re: RegExp;
  /** 规则只匹配文件夹（以 / 结尾） */
  dirOnly: boolean;
}

export class ExcludeMatcher {
  private readonly rules: Rule[];

  constructor(patterns: string[]) {
    this.rules = patterns.map(parseLine).filter((r): r is Rule => r !== null);
  }

  /** 文件是否被排除：文件本身匹配，或任一上级文件夹匹配 */
  isExcludedFile(path: string): boolean {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (this.matchDir(parts.slice(0, i).join("/"))) return true;
    return this.rules.some((r) => !r.dirOnly && r.re.test(path));
  }

  /** 文件夹是否被排除（排除后不再进入） */
  isExcludedDir(path: string): boolean {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) if (this.matchDir(parts.slice(0, i).join("/"))) return true;
    return false;
  }

  private matchDir(dir: string): boolean {
    return this.rules.some((r) => r.re.test(dir));
  }
}

function parseLine(line: string): Rule | null {
  let p = line.trim();
  if (!p || p.startsWith("#")) return null;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  const anchored = p.includes("/");
  p = p.replace(/^\/+/, "");
  if (!p) return null;
  // 以 /** 结尾：等同于文件夹规则（匹配文件夹本身即可排除其下全部内容）
  if (p.endsWith("/**")) return { re: toRegExp(p.slice(0, -3), true), dirOnly: true };
  return { re: toRegExp(p, anchored), dirOnly };
}

function toRegExp(glob: string, anchored: boolean): RegExp {
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        i++;
        if (glob.charAt(i + 1) === "/") {
          i++;
          src += "(?:.*/)?"; // **/ 匹配零层或多层
        } else src += ".*";
      } else src += "[^/]*";
    } else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${src}$` : `(?:^|/)${src}$`, "i");
}
