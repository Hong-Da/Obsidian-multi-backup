// 构建插件：开发模式 watch 并部署到测试 Vault；production 只输出到 dist/
// 用法：node esbuild.config.mjs [production] [--deploy]
import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes("production");
const deploy = !prod || process.argv.includes("--deploy");
const distDir = path.join(root, "dist");
const vaultDir = process.env.DEV_VAULT || path.join(root, "dev-vault");
const pluginId = "multi-backup";
const assets = ["manifest.json", "styles.css"];

async function ensureDevVault() {
  const obsidianDir = path.join(vaultDir, ".obsidian");
  await mkdir(path.join(obsidianDir, "plugins", pluginId), { recursive: true });
  const enabled = path.join(obsidianDir, "community-plugins.json");
  if (!existsSync(enabled)) await writeFile(enabled, JSON.stringify([pluginId]) + "\n");
  const welcome = path.join(vaultDir, "Welcome.md");
  if (!existsSync(welcome)) {
    await writeFile(welcome, "# 测试 Vault\n\n由 start 脚本创建，用于开发时加载 Multi Backup 插件。\n");
  }
}

const copyAssets = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      for (const f of assets) await copyFile(path.join(root, f), path.join(distDir, f));
      if (!deploy) return;
      const target = path.join(vaultDir, ".obsidian", "plugins", pluginId);
      await ensureDevVault();
      for (const f of ["main.js", ...assets]) await copyFile(path.join(distDir, f), path.join(target, f));
      // 配合 Hot Reload 插件自动重新加载
      await writeFile(path.join(target, ".hotreload"), "");
      console.log(`[build] 已部署到 ${target}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: [path.join(root, "src", "main.ts")],
  bundle: true,
  // buffer 不当作 Node 内置模块：移动端没有 Node，用打包进来的 buffer 包（isomorphic-git 的依赖要用）
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules.filter((m) => m !== "buffer"), ...builtinModules.map((m) => `node:${m}`)],
  inject: [path.join(root, "scripts", "buffer-shim.mjs")],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(distDir, "main.js"),
  plugins: [copyAssets],
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
