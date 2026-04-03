@echo off
chcp 65001 > nul
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   今彩539 智能分析系統  正在啟動...       ║
echo  ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [錯誤] 找不到 Node.js，請先安裝 Node.js
    echo 下載: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo 首次執行，正在安裝套件...
    npm install
    echo.
)

echo 啟動伺服器中...
echo 請稍候，首次啟動需要 2-3 分鐘下載歷史資料
echo.

start "" "http://localhost:3000"

node server.js

pause
