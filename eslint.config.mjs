import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["dist/", "dev-vault/", "tmp/", ".toolchain/", "node_modules/", "DevelopDocs/", "InternalDocs/", "coverage/", "**/*.mjs", "vitest.config.ts", "vitest.accept.config.ts", "vitest.integration.config.ts", "vitest.perf.config.ts", "vitest.e2e.config.ts"] },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
  },
  ...obsidianmd.configs.recommended,
  // 测试用 .obsidian 作为示例数据，并在 Node 中运行（没有 window）；插件代码中必须用 vault.configDir、不能静态引入 Node 模块
  {
    files: ["tests/**/*.ts"],
    rules: {
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-window-timers": "off",
    },
  },
);
