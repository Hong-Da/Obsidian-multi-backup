@echo off
rem Project-local toolchain and cache variables. Usage: call scripts\env.bat
rem Keep this file ASCII-only: cmd may misparse UTF-8 text before chcp 65001.
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "NODE_HOME=%ROOT%\.toolchain\runtime\node"
set "PATH=%NODE_HOME%;%PATH%"
set "npm_config_cache=%ROOT%\.toolchain\cache\npm"
set "COREPACK_HOME=%ROOT%\.toolchain\cache\corepack"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
set "XDG_STATE_HOME=%ROOT%\.toolchain\cache\state"
set "PNPM_HOME=%ROOT%\.toolchain\cache\pnpm-home"
