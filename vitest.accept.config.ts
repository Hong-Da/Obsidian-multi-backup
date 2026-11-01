import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 里程碑验收测试：数据量大、耗时长，不放进一键测试。运行：pnpm test:accept
export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/acceptance/**/*.test.ts"],
    cacheDir: ".toolchain/cache/vitest",
    setupFiles: ["tests/support/setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
