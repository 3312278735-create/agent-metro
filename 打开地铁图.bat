@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要先安装 Node.js： https://nodejs.org
  pause
  exit /b 1
)
start "看板服务 - 关掉这个窗口就停止" /min node "%~dp0tools\board-server.js"
