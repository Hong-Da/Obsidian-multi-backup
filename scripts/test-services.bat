@echo off
chcp 65001 >nul
rem 集成测试（Gitea）。用法见 scripts/test-services.sh；需要 Git Bash。
bash "%~dp0test-services.sh" %*
