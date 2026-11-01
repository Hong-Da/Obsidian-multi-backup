// 上架前检查：manifest、versions.json、package.json 是否一致，是否符合 Obsidian 社区插件的提交规则。
// 用法：node scripts/release-check.mjs [标签]；带标签时（如 v0.6.0）还检查标签与版本号一致。发现问题时退出码为 1。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** 返回发现的问题列表（空列表表示通过） */
export function checkRelease(root, tag) {
  const problems = [];
  const read = (f) => JSON.parse(readFileSync(path.join(root, f), "utf8"));
  const manifest = read("manifest.json");
  const versions = read("versions.json");
  const pkg = read("package.json");

  for (const key of ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"]) {
    if (manifest[key] === undefined || manifest[key] === "") problems.push(`manifest.json 缺少 ${key}`);
  }
  const { id = "", name = "", version = "", minAppVersion = "", description = "" } = manifest;

  if (!/^[a-z0-9-]+$/.test(id)) problems.push("id 只能用小写字母、数字和连字符");
  if (/obsidian/i.test(id) || /obsidian/i.test(name)) problems.push("id 和名称不能包含 Obsidian");
  if (/plugin$/i.test(id) || /plugin$/i.test(name)) problems.push("id 和名称不能以 plugin 结尾");
  if (!SEMVER.test(version)) problems.push(`版本号 ${version} 不是 x.y.z 格式`);
  if (!SEMVER.test(minAppVersion)) problems.push(`minAppVersion ${minAppVersion} 不是 x.y.z 格式`);

  if (description.length > 250) problems.push(`简介 ${description.length} 个字符，超过 250`);
  if (!/[.?!)]$/.test(description)) problems.push("简介要以句号结尾");
  if (/obsidian/i.test(description)) problems.push("简介不要包含 Obsidian");
  if (/^this (is a )?plugin/i.test(description)) problems.push("简介不要以 This plugin 开头");

  if (pkg.version !== version) problems.push(`package.json 版本 ${pkg.version} 与 manifest ${version} 不一致`);
  if (versions[version] !== minAppVersion) problems.push(`versions.json 缺少 ${version}: ${minAppVersion}`);

  for (const f of ["README.md", "LICENSE", "styles.css"]) {
    if (!existsSync(path.join(root, f))) problems.push(`缺少 ${f}`);
  }
  if (tag !== undefined && tag.replace(/^v/, "") !== version) problems.push(`标签 ${tag} 与版本号 ${version} 不一致`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkRelease(root, process.argv[2]);
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log("上架检查通过");
}
