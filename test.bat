@echo off
chcp 65001 >nul
setlocal
rem 一键测试：类型检查 → 代码检查（含 Obsidian 审核规则）→ 单元测试
call "%~dp0scripts\env.bat"
cd /d "%ROOT%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\ensure-node.ps1" -Root "%ROOT%"
if errorlevel 1 goto :fail
call corepack enable
if errorlevel 1 goto :fail
if exist pnpm-lock.yaml (call pnpm install --frozen-lockfile) else (call pnpm install)
if errorlevel 1 goto :fail

echo [1/3] 类型检查
call pnpm typecheck
if errorlevel 1 goto :fail
echo [2/3] 代码检查
call pnpm lint
if errorlevel 1 goto :fail
echo [3/3] 单元测试
call pnpm test
if errorlevel 1 goto :fail

echo 全部通过。
exit /b 0

:fail
echo 测试未通过。
exit /b 1
