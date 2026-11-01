// 推送前检查：要推送的内容里不能有内部文件、令牌、私钥、内部决策编号。
// 用法：
//   node scripts/check-public.mjs              检查当前提交（HEAD）的所有文件（CI 用）
//   node scripts/check-public.mjs --pre-push   由 .githooks/pre-push 调用：检查这次要推送的每个提交
//   node scripts/check-public.mjs --all        检查所有提交（改写历史后核对用）
// 本机另有内部规则时（如测试机地址），写在 InternalDocs/public-check.json：{ "patterns": ["正则", ...] }。
// 发现问题时退出码为 1，并列出文件和行号。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 不推送的路径（与 .gitignore 一致） */
export const PRIVATE_PATHS = ["DevelopDocs/", "InternalDocs/", "CLAUDE.md", "CLAUDE.local.md", ".claude/", "scripts/version-status.sh"];

export const PATTERNS = [
  { label: "GitHub 令牌", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { label: "GitLab 令牌", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { label: "AWS 访问密钥", re: /\bAKIA[0-9A-Z]{16}\b/, allow: /AKIAIOSFODNN7EXAMPLE/ },
  { label: "私钥", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "内部决策编号", re: /\bD-\d{4}\b/ },
];

export function isPrivatePath(file) {
  return PRIVATE_PATHS.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/** 逐行检查一段文本，返回 [{ line, label, text }] */
export function scanText(text, patterns) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const p of patterns) {
      if (p.re.test(line) && !(p.allow && p.allow.test(line))) hits.push({ line: i + 1, label: p.label, text: line.trim().slice(0, 120) });
    }
  });
  return hits;
}

function git(args, cwd, input) {
  return execFileSync("git", args, { cwd, input, maxBuffer: 1024 * 1024 * 1024 });
}

function loadPatterns(root) {
  const extra = path.join(root, "InternalDocs", "public-check.json");
  if (!existsSync(extra)) return PATTERNS;
  const { patterns = [] } = JSON.parse(readFileSync(extra, "utf8"));
  return [...PATTERNS, ...patterns.map((s) => ({ label: "内部信息", re: new RegExp(s) }))];
}

const SELF = "scripts/check-public.mjs";

/** 检查若干提交的完整文件树；相同内容的文件只读一次 */
function checkCommits(root, commits, patterns) {
  const problems = new Set();
  const blobs = new Map(); // 内容哈希 → [{ commit, file }]
  for (const c of commits) {
    for (const row of git(["ls-tree", "-r", c], root).toString("utf8").split("\n").filter(Boolean)) {
      const [meta, file] = row.split("\t");
      const [, type, sha] = meta.split(" ");
      if (type !== "blob") continue;
      if (isPrivatePath(file)) problems.add(`${file}：不该推送的文件`);
      else if (file !== SELF) {
        if (!blobs.has(sha)) blobs.set(sha, []);
        blobs.get(sha).push(file);
      }
    }
  }
  if (blobs.size === 0) return [...problems];
  // 一次读出所有内容：每段为“<sha> blob <长度>\n<内容>\n”
  const out = git(["cat-file", "--batch"], root, [...blobs.keys()].join("\n") + "\n");
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(10, pos);
    const [sha, , size] = out.subarray(pos, nl).toString("utf8").split(" ");
    const body = out.subarray(nl + 1, nl + 1 + Number(size));
    pos = nl + 1 + Number(size) + 1;
    if (body.includes(0)) continue; // 二进制文件
    const hits = scanText(body.toString("utf8"), patterns);
    for (const file of new Set(blobs.get(sha))) for (const h of hits) problems.add(`${file}:${h.line}：${h.label}：${h.text}`);
  }
  return [...problems];
}

/** pre-push：标准输入每行“本地引用 本地提交 远程引用 远程提交”，检查新推送的每个提交 */
function pushedCommits(root, input) {
  const zero = /^0+$/;
  const commits = new Set();
  for (const line of input.split("\n").filter(Boolean)) {
    const [, local, , remote] = line.split(" ");
    if (zero.test(local)) continue; // 删除远程分支
    const range = zero.test(remote) ? [local] : [local, `^${remote}`];
    for (const c of git(["rev-list", ...range], root).toString("utf8").split("\n").filter(Boolean)) commits.add(c);
  }
  return [...commits];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const patterns = loadPatterns(root);
  const commits = process.argv.includes("--pre-push")
    ? pushedCommits(root, readFileSync(0, "utf8"))
    : process.argv.includes("--all")
      ? git(["rev-list", "--all"], root).toString("utf8").split("\n").filter(Boolean)
      : ["HEAD"];
  const problems = checkCommits(root, commits, patterns);
  if (problems.length > 0) {
    console.error(`发现 ${problems.length} 处不该公开的内容，已停止：`);
    for (const p of problems.slice(0, 50)) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log("公开内容检查通过");
}
