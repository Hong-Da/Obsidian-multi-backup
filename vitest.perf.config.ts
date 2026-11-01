import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 性能测试：需要 Docker 里的测试服务，由 MB_TEST_CMD="pnpm test:perf" bash scripts/test-services.sh 启动后运行
export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/perf/**/*.test.ts"],
    cacheDir: ".toolchain/cache/vitest",
    setupFiles: ["tests/support/setup.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
});
