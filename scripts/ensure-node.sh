#!/usr/bin/env bash
# 按 .nvmrc 把 Node 下载到 .toolchain/runtime/node/，核对官方 SHA256。用法：scripts/ensure-node.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)  # Git Bash：交给 Windows 版脚本
    exec powershell -NoProfile -ExecutionPolicy Bypass -File "$ROOT/scripts/ensure-node.ps1" -Root "$(cygpath -w "$ROOT")" ;;
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "不支持的系统：$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

ver="$(tr -d ' \r\nv' < "$ROOT/.nvmrc")"
runtime="$ROOT/.toolchain/runtime"
dir="$runtime/node"
if [ -x "$dir/bin/node" ]; then
  [ "$("$dir/bin/node" -v)" = "v$ver" ] && exit 0
  echo "Node 版本与 .nvmrc 不一致，重新下载 v$ver"
  rm -rf "$dir"
fi

name="node-v$ver-$os-$arch"
base="https://nodejs.org/dist/v$ver"
tmp="$ROOT/.toolchain/tmp"
mkdir -p "$tmp" "$runtime"
echo "下载 Node v$ver（$os-$arch）..."
curl -fsSL "$base/$name.tar.xz" -o "$tmp/$name.tar.xz"
expected="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$name.tar.xz" '$2==f {print $1}')"
[ -n "$expected" ] || { echo "SHASUMS256.txt 中找不到 $name.tar.xz" >&2; exit 1; }
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$tmp/$name.tar.xz" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$tmp/$name.tar.xz" | cut -d' ' -f1)"; fi
[ "$actual" = "$expected" ] || { rm -f "$tmp/$name.tar.xz"; echo "SHA256 校验失败" >&2; exit 1; }

tar -xJf "$tmp/$name.tar.xz" -C "$runtime"
mv "$runtime/$name" "$dir"
rm -f "$tmp/$name.tar.xz"
echo "Node v$ver 已就绪：$dir"
