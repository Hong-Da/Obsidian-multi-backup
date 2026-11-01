import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 端到端验收：驱动 Android 模拟器里的 Obsidian；由 MB_TEST_CMD="pnpm test:e2e" bash scripts/test-services.sh 启动测试服务后运行
export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    cacheDir: ".toolchain/cache/vitest",
    setupFiles: ["tests/support/setup.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
});
