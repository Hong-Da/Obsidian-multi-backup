import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 集成测试：需要 Docker 里的测试服务，由 scripts/test-services.sh 启动后运行
export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    cacheDir: ".toolchain/cache/vitest",
    setupFiles: ["tests/support/setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
