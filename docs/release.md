# 发布与上架

## 发布一个版本

1. 确认 `test.bat`（或 `./test.sh`）全部通过，`node scripts/release-check.mjs` 与 `node scripts/check-public.mjs` 通过。
2. `pnpm version <x.y.z>`：同步 `package.json`、`manifest.json`、`versions.json`；新版本需要更高的 Obsidian 时，先改 `manifest.json` 的 `minAppVersion`。
3. 提交，打标签 `v<x.y.z>`，推送分支和标签。
4. GitHub Actions 的 Release 流程会：上架检查（标签与版本号一致）→ 代码检查 → 单元测试 → 构建 → 建草稿 Release，标签为 `<x.y.z>`（不带 v），附件为 `main.js`、`manifest.json`、`styles.css`。
5. 在 GitHub 的 Releases 页检查草稿和自动生成的说明，点 **Publish release**。

为什么有两个标签：项目的 git 标签统一带 v（`v0.6.0`）；Obsidian 按 `manifest.json` 里的版本号下载 Release 附件，所以 Release 的标签必须是 `0.6.0`。两个标签指向同一个提交。

## 哪些文件推送

- 推送：插件源码、构建与发布配置、测试、用户和发布者文档、更新记录。
- 不推送（在 `.gitignore` 中）：`DevelopDocs/`、`InternalDocs/`（内部文档，单独的本地仓库）、`CLAUDE.md`、`.claude/`、`scripts/version-status.sh`。
- 推送前检查：`.githooks/pre-push` 对要推送的每个提交运行 `scripts/check-public.mjs`，发现不该推送的文件、令牌、私钥、内部编号就停止推送；CI 对当前提交再查一遍。新克隆的仓库先运行 `git config core.hooksPath .githooks` 启用。

## 提交社区插件审核（只做一次）

Obsidian 现在通过社区目录提交（2026-11 核对官方文档《Submit your plugin》），不再向 obsidian-releases 提合并请求。

1. 仓库设为公开，并发布一个 Release（见上）：标签与 `manifest.json` 的版本号一致，附件为 `main.js`、`manifest.json`、`styles.css`。
2. 打开 [community.obsidian.md](https://community.obsidian.md)，用 Obsidian 账号登录。
3. 在个人资料里关联 GitHub 账号，用来证明仓库是你的。
4. 添加插件，选择仓库 `Hong-Da/Obsidian-multi-backup`。目录读取默认分支最新提交里的 `manifest.json`，提交前确认它已推送。
5. 提交后会自动审核，目录页面会列出要修改的地方。修改后发一个更高版本号的 Release。
6. 审核通过、发布后，就能在 Obsidian 里搜索安装。可以在论坛 Share & showcase 和 Discord #updates 频道发布消息。

## 审核清单（验收标准 9）

检查日期：2026-11-01，版本 0.5.2。

| 项目                                                | 状态 | 说明                                                                                                                           |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| ESLint（含 eslint-plugin-obsidianmd）无错误         | 通过 | 0 错误；3 条警告是 Obsidian 1.13 的新接口建议（`setDestructive`、声明式设置页），插件最低支持 1.11.4，旧版没有这些接口，暂不改 |
| `manifest.json` 字段齐全、格式正确                  | 通过 | `scripts/release-check.mjs` 自动检查，CI 和发布流程都会跑                                                                      |
| id 和名称不含 Obsidian、不以 plugin 结尾            | 通过 | `multi-backup` / `Multi Backup`，社区列表中没有重名（2026-11-01 查 9757 个）                                                   |
| 简介 250 字符以内、以句号结尾                       | 通过 |                                                                                                                                |
| `versions.json` 与版本号对应                        | 通过 |                                                                                                                                |
| 有 LICENSE                                          | 通过 | MIT                                                                                                                            |
| README 说明网络用途、需要的账号、Vault 外的文件访问 | 通过 | README 的“Privacy, network use and accounts”                                                                                   |
| 不收集使用数据、没有广告                            | 通过 |                                                                                                                                |
| 网络请求走 `requestUrl`                             | 通过 | WebDAV、S3、Git、网盘都经 `obsidian-request.ts` / `obsidian-http.ts`                                                           |
| 不用 `innerHTML` 等拼 HTML                          | 通过 |                                                                                                                                |
| 控制台默认只有错误和警告                            | 通过 | 打开调试日志后才输出其余日志（v0.5.3 起）                                                                                      |
| 命令 id 不带插件 id，没有默认快捷键                 | 通过 |                                                                                                                                |
| 不用全局 `app`，`onunload` 不 detach 视图           | 通过 |                                                                                                                                |
| 移动端不加载 Node 模块                              | 通过 | Node 模块只在桌面端按需加载（`platform/desktop.ts`）；Android 模拟器验收通过                                                   |
| 样式写在 `styles.css`，不内联固定样式               | 通过 | 只有一处设置 CSS 变量（恢复对话框的缩进层级）                                                                                  |
| 凭据只存密钥存储                                    | 通过 | 验收标准 7，模拟器上验证                                                                                                       |
| 发布产物不入库                                      | 通过 | `main.js`、`dist/` 在 `.gitignore` 中                                                                                          |

## 上架前还要处理的

- **Dropbox 应用**：现在是开发模式，最多 500 个用户。用户多了要在 [App Console](https://www.dropbox.com/developers/apps) 的 Settings 页申请 Production。
- **OneDrive、Google Drive**：应用 ID 还没注册，界面上会提示“这个版本还不能登录”。注册方法见 [cloud-apps.md](cloud-apps.md)。
- **仓库公开**：开发期仓库私有，提交审核前改为公开。
