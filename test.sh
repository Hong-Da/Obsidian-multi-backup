#!/usr/bin/env bash
# 一键测试：类型检查 → 代码检查（含 Obsidian 审核规则）→ 单元测试
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/scripts/env.sh"
cd "$ROOT"

bash scripts/ensure-node.sh
corepack enable
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi

echo "[1/3] 类型检查"; pnpm typecheck
echo "[2/3] 代码检查"; pnpm lint
echo "[3/3] 单元测试"; pnpm test
echo "全部通过。"
