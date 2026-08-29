@echo off
:: ASCII-only by design (no box-drawing / emoji). cmd.exe's batch parser desyncs on multi-byte
:: characters (confirmed live 2026-08-10 with a UTF-8 file: echo lines randomly executed as
:: commands and the menu broke; an OEM-encoded file with box-drawing survived cmd but any
:: editor save converted it back to UTF-8 and corrupted it again). Colors + layout carry the
:: style instead. Also: never put parentheses inside an echo line inside an IF block - cmd
:: misparses the block (confirmed live 2026-08-10: "X was unexpected at this time").
title Local Project Console Launcher
setlocal enabledelayedexpansion

:: ANSI escape detection - yields the ESC character used by the colored output below.
for /F "tokens=1,2 delims=#" %%a in ('"prompt #$H#$E# & echo on & for %%b in (1) do rem"') do set "ESC=%%b"

cd /d "%~dp0"

IF NOT EXIST "node_modules\" (
    echo Installing dependencies...
    call npm install
)

:MENU
cls
echo %ESC%[36m  ================================================================
echo  %ESC%[0m%ESC%[1m%ESC%[37m              LOCAL PROJECT CONSOLE ENGINE V4%ESC%[36m
echo  ================================================================%ESC%[0m
echo.
echo %ESC%[90m  Select execution interface:%ESC%[0m
echo.
echo %ESC%[32m    [W]%ESC%[1m Web UI %ESC%[0m%ESC%[90m   (Opens browser canvas @ localhost:3000)%ESC%[0m
echo %ESC%[33m    [C]%ESC%[1m CLI Chat %ESC%[0m%ESC%[90m   (Interactive terminal agent mode)%ESC%[0m
echo %ESC%[31m    [Q]%ESC%[1m Quit %ESC%[0m%ESC%[90m   (Exit launcher)%ESC%[0m
echo.
echo %ESC%[36m  ----------------------------------------------------------------%ESC%[0m
echo.
set /p MODE=%ESC%[35m  Enter choice (W/C/Q): %ESC%[0m

if /i "!MODE!"=="W" goto WEB_MODE
if /i "!MODE!"=="C" goto CLI_MODE
if /i "!MODE!"=="Q" goto QUIT
goto MENU

:CLI_MODE
echo.
echo %ESC%[33m  [+] Checking for a running server on ports 3000-3019...%ESC%[0m
REM Already-running probe - deliberately pipe-free (no `for /f`): the probe result is written
REM to server.pid (gitignored via *.pid) and read back with `set /p`. If a console server
REM already responds, skip starting a second instance (it would only land on a fallback port)
REM and hand straight to the CLI client, which waits out cold boot itself (up to 90s, ports
REM 3000-3019). Proxy detection is disabled and the per-port timeout is 5s because PowerShell
REM 5.1's first WebRequest can stall on proxy auto-detection - measured live: a 1s timeout
REM missed a running server while 2s was borderline (this machine's /api/projects takes ~1.7s).
powershell -NoProfile -Command "[Net.WebRequest]::DefaultWebProxy=$null; $f=$null; foreach($i in 3000..3019){ try { $r=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$i+'/api/projects') -TimeoutSec 5; if($r.projects){$f=$i;break} } catch {} }; if($null -ne $f){ 'UP '+$f | Set-Content server.pid } else { 'DOWN' | Set-Content server.pid }"
set /p PROBE_RESULT=<server.pid
if /i "!PROBE_RESULT:~0,2!"=="UP" (
    echo %ESC%[32m  [+] Server already running on port !PROBE_RESULT:~3! - skipping start.%ESC%[0m
) ELSE (
    REM `start /B` would share this console window's stdout with the server, printing its
    REM startup logs (NLP training, embedding model loading, etc.) right into the interactive
    REM CLI - very confusing (confirmed live 2026-07-29). So the server is launched hidden
    REM through PowerShell with both streams redirected to log files (server.log and
    REM server.err.log - Start-Process cannot redirect both streams to the same file). On
    REM failure we kill only that process tree (npm -> node server), captured via a PID file;
    REM the old `taskkill /f /im node.exe` killed every Node process on the machine, including
    REM unrelated dev servers and this console's own tooling (confirmed live 2026-08-06 audit)
    REM - never do that.
    REM PID capture uses Set-Content + `set /p` instead of a `for /f` pipe because the pipe
    REM variant hung forever (confirmed 2026-08-10): the detached server process tree kept the
    REM capture pipe's write end open, so the batch never reached the cli-client handoff and
    REM the window sat idle at "Starting server..." with no child process and no error. A file
    REM has no handles, so nothing can hold it open.
    echo %ESC%[33m  [+] Starting server in the background - logs: server.log, server.err.log...%ESC%[0m
    IF EXIST "dist\server.js" (
        powershell -NoProfile -Command "$p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.err.log' -WindowStyle Hidden -PassThru; $p.Id | Set-Content server.pid"
    ) ELSE (
        powershell -NoProfile -Command "$p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.err.log' -WindowStyle Hidden -PassThru; $p.Id | Set-Content server.pid"
    )
    set /p SERVER_PID=<server.pid
)

REM Previously waited here for `netstat` to show port 3000 as listening before starting the
REM CLI client - but that only confirms *something* is bound to that exact port, not that this
REM app's server is actually the one there or that it's finished starting (route registration /
REM Vite middleware setup / semanticMatcher's embedding model load all take real time), and it
REM had no way to notice the server falling back to a different port. cli-client.js now handles
REM both concerns itself (retries for up to 90s, checks ports 3000-3019), so just hand off to it
REM directly instead of duplicating a weaker version of that logic here.
node server/cli-client.js
if errorlevel 1 (
    echo %ESC%[31m  CLI chat exited with an error - code !ERRORLEVEL!. Stopping server...%ESC%[0m
    if defined SERVER_PID (
        taskkill /f /t /pid !SERVER_PID! >nul 2>&1
    )
) else (
    echo %ESC%[90m  [cli chat exited cleanly]%ESC%[0m
)
pause
exit /b 0

:WEB_MODE
echo.
echo %ESC%[32m  [+] Checking for a running server on ports 3000-3019...%ESC%[0m
REM Same already-running probe as CLI mode - opening the browser against an existing server is
REM all that's needed; starting a second foreground instance would land on a fallback port and
REM leave a duplicate process behind.
powershell -NoProfile -Command "[Net.WebRequest]::DefaultWebProxy=$null; $f=$null; foreach($i in 3000..3019){ try { $r=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$i+'/api/projects') -TimeoutSec 5; if($r.projects){$f=$i;break} } catch {} }; if($null -ne $f){ 'UP '+$f | Set-Content server.pid } else { 'DOWN' | Set-Content server.pid }"
set /p PROBE_RESULT=<server.pid
if /i "!PROBE_RESULT:~0,2!"=="UP" (
    echo %ESC%[32m  [+] Server already running on port !PROBE_RESULT:~3! - opening browser.%ESC%[0m
    start http://localhost:!PROBE_RESULT:~3!
) ELSE (
    echo %ESC%[32m  [+] Starting server and opening the browser...%ESC%[0m
    REM The server binds 3000-3019 via its own fallback loop, so the browser must open on the
    REM ACTUALLY-bound port, not a hardcoded 3000 (audit 2026-08-24: with 3000 occupied the old
    REM line opened localhost:3000 - the wrong service - every time). A background watcher
    REM (start /B, same console, dies with this window) probes the port range the same way the
    REM already-running probe above does - proxy disabled, 5s per-port timeout, up to ~95s for
    REM a cold boot - then opens the browser on whatever port the server landed on.
    start "" /B powershell -NoProfile -Command "[Net.WebRequest]::DefaultWebProxy=$null; $deadline=(Get-Date).AddSeconds(95); $f=$null; while((Get-Date) -lt $deadline -and $null -eq $f){ foreach($i in 3000..3019){ try { $r=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$i+'/api/projects') -TimeoutSec 5; if($r.projects){$f=$i;break} } catch {} }; if($null -eq $f){ Start-Sleep -Seconds 3 } }; if($null -ne $f){ Start-Process ('http://localhost:'+$f) } else { Write-Host 'Console did not become ready - open the printed URL manually' }"
    IF EXIST "dist\server.js" (
        call npm start
    ) ELSE (
        call npm run dev
    )
    if errorlevel 1 (
        echo.
        echo %ESC%[31m  Server exited with code %ERRORLEVEL%. Check the error above.%ESC%[0m
        echo %ESC%[90m  If this was a missing dependency, try: npm install%ESC%[0m
        echo %ESC%[90m  For a full diagnostic, run: npm run doctor%ESC%[0m
        pause
        exit /b %ERRORLEVEL%
    )
)
exit /b 0

:QUIT
echo.
echo %ESC%[90m  Exiting launcher...%ESC%[0m
exit /b 0
