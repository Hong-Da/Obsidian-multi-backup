# 测试说明

| 目录 | 内容 | 运行 |
|---|---|---|
| `unit/` | Vitest 单元测试；`obsidian` 包由 `mocks/obsidian.ts` 代替；`release-check.test.ts` 检查 manifest 与社区插件提交规则（验收标准 9）；`check-public.test.ts` 检查推送前的公开内容规则 | `test.bat` / `./test.sh`，或 `pnpm test` |
| `integration/` | 对 Docker 测试服务的集成测试（Gitea、rclone WebDAV、rclone S3）；没有设置服务地址时整组跳过 | `scripts/test-services.sh`（用测试机的 Docker：先设 `MB_DOCKER_SSH=root@<地址>`） |
| `perf/` | 性能测试（验收标准第 4、5 条）：生成 5000 篇笔记 + 1 GB 附件的 Vault（留在 `tmp/` 复用），测 Gitea、WebDAV 的首次、无变化、改 1 个文件的耗时，以及同步时主线程最长被占用多久；另测本机 zip 快照。规模用 `MB_PERF_NOTES`、`MB_PERF_MB` 调整，WebDAV 并发数用 `MB_PERF_PARALLEL` | `MB_TEST_CMD="pnpm test:perf" bash scripts/test-services.sh` |
| `acceptance/` | 里程碑验收：1000 篇笔记的本地镜像、zip、本地 git、远程 Git | `pnpm test:accept` |
| `support/` | 测试工具：临时目录、样例 Vault、本机 HTTP Git 服务（系统 `git http-backend`）、内存 DataAdapter | — |
| `e2e/` | 端到端验收：经远程调试接口驱动 Android 模拟器里真实的 Obsidian，逐条核对验收标准 1–5、7、8；测试数据只放 `E2E/`，结束后恢复设置并清理 | 先 `adb forward tcp:9222 localabstract:webview_devtools_remote_<Obsidian 的 pid>`，再 `MB_TEST_CMD="pnpm test:e2e" bash scripts/test-services.sh` |
| `fixtures/` | 测试 Vault 与样例数据 | — |

规则：

- 每完成一项功能就补测试；`src/core/` 的逻辑必须有单元测试。
- 测试名称用中文描述行为，例如“保留最近 N 天（含今天），删除更早的”。
- 测试产生的文件写到项目内 `tmp/`，测试结束后清理；不写入用户目录或系统临时目录。
- 一键测试依次运行：类型检查（tsc）→ 代码检查（ESLint，含 Obsidian 审核规则）→ 单元测试。
- 集成测试的账号密码和令牌都在运行时生成，只放在环境变量和内存里，不写入文件。
