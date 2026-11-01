@echo off
chcp 65001 >nul
setlocal
rem 一键开发：准备项目内 Node 与 pnpm、安装依赖、构建并部署到 dev-vault\，进入 watch
call "%~dp0scripts\env.bat"
cd /d "%ROOT%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\ensure-node.ps1" -Root "%ROOT%"
if errorlevel 1 goto :fail
call corepack enable
if errorlevel 1 goto :fail

if exist pnpm-lock.yaml (call pnpm install --frozen-lockfile) else (call pnpm install)
if errorlevel 1 goto :fail

echo.
echo 测试 Vault：%ROOT%\dev-vault
echo 首次使用：在 Obsidian 中选择“打开文件夹作为仓库”，打开上面的目录，并在“第三方插件”中信任并启用 Multi Backup。
echo 按 Ctrl+C 结束 watch。
echo.
call pnpm dev
exit /b %errorlevel%

:fail
echo 启动失败，请查看上面的错误信息。
exit /b 1
