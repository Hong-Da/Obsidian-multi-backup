import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // 单元测试中用模拟模块代替 obsidian 包（它只有类型，没有运行时代码）
    alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    cacheDir: ".toolchain/cache/vitest",
    setupFiles: ["tests/support/setup.ts"],
  },
});
