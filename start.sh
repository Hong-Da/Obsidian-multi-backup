#!/usr/bin/env bash
# 一键开发：准备项目内 Node 与 pnpm、安装依赖、构建并部署到 dev-vault/，进入 watch
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/scripts/env.sh"
cd "$ROOT"

bash scripts/ensure-node.sh
corepack enable
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi

echo
echo "测试 Vault：$ROOT/dev-vault"
echo "首次使用：在 Obsidian 中选择“打开文件夹作为仓库”，打开上面的目录，并在“第三方插件”中信任并启用 Multi Backup。"
echo "按 Ctrl+C 结束 watch。"
echo
pnpm dev
