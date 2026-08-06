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
:: `start /B` shares this same console window's stdout with whatever it launches — so without
:: redirecting it, the background server's own startup logs (dotenvx env injection, NLP training,
:: semanticMatcher's embedding-model loading, etc.) print directly into this window, interleaved
:: with the interactive CLI chat itself (confirmed live 2026-07-29 — very confusing to read).
:: Redirected to a log file instead; check server.log if something needs debugging (stderr goes
:: to server.err.log — Start-Process cannot redirect both streams to the same file).
:: The server is launched through PowerShell so its wrapper PID can be captured; on failure we
:: kill only that process tree (npm -> node server). The old `taskkill /f /im node.exe` killed
:: every Node process on the machine, including unrelated dev servers and this console's own
:: tooling (confirmed live 2026-08-06 audit) — never do that.
echo Starting server in the background (log: server.log)...
IF EXIST "dist\server.js" (
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.err.log' -WindowStyle Hidden -PassThru; $p.Id"`) do set SERVER_PID=%%P
) ELSE (
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.err.log' -WindowStyle Hidden -PassThru; $p.Id"`) do set SERVER_PID=%%P
)

:: Previously waited here for `netstat` to show port 3000 as listening before starting the CLI
:: client — but that only confirms *something* is bound to that exact port, not that this app's
:: server is actually the one there or that it's finished starting (route registration / Vite
:: middleware setup / semanticMatcher's embedding model load all take real time), and it had no
:: way to notice the server falling back to a different port. cli-client.js now handles both
:: concerns itself (retries for up to 20s, checks ports 3000-3009), so just hand off to it
:: directly instead of duplicating a weaker version of that logic here.
node server/cli-client.js
if errorlevel 1 (
    echo CLI chat exited. Stopping server...
    if defined SERVER_PID (
        taskkill /f /t /pid !SERVER_PID! >nul 2>&1
    )
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
