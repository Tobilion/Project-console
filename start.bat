@echo off
TITLE Local Project Console Launcher
setlocal enabledelayedexpansion

cd /d "%~dp0"

IF NOT EXIST "node_modules\" (
    echo Installing dependencies...
    call npm install
)

:: Mode selection
echo.
echo ====================================
echo    Local Project Console Launcher
echo ====================================
echo.
echo Choose mode:
echo   [W] Web UI (opens browser)
echo   [C] CLI Chat (terminal chat mode)
echo.
:MODE_SELECT
set /p MODE="Mode (w/c): "
if /i "!MODE!"=="c" goto :CLI_MODE
if /i "!MODE!"=="w" goto :WEB_MODE
goto :MODE_SELECT

:CLI_MODE
set PORT=3000
echo Starting server on port !PORT! (port fallback handled by server)...
set PORT=!PORT!

IF EXIST "dist\server.js" (
    start /B "" npm start
) ELSE (
    start /B "" npm run dev
)

echo Waiting for server...
:WAIT_SERVER
timeout /t 1 /nobreak >nul
netstat -an 2>nul | find ":!PORT! " >nul
if !errorlevel! neq 0 goto :WAIT_SERVER

echo Server is ready. Starting CLI chat...
node server/cli-client.js
if errorlevel 1 (
    echo CLI chat exited. Stopping server...
    taskkill /f /im node.exe >nul 2>&1
)
pause
exit /b 0

:WEB_MODE
echo Starting on port 3000 (port fallback handled by server)...
start http://localhost:3000
IF EXIST "dist\server.js" (
    call npm start
) ELSE (
    call npm run dev
)
