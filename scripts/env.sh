# 项目内工具链与缓存的环境变量。用法：. scripts/env.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
export NODE_HOME="$ROOT/.toolchain/runtime/node"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) export PATH="$NODE_HOME:$PATH" ;;  # Windows 版 Node 没有 bin/ 子目录
  *) export PATH="$NODE_HOME/bin:$PATH" ;;
esac
export npm_config_cache="$ROOT/.toolchain/cache/npm"
export COREPACK_HOME="$ROOT/.toolchain/cache/corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export XDG_STATE_HOME="$ROOT/.toolchain/cache/state"
export PNPM_HOME="$ROOT/.toolchain/cache/pnpm-home"
