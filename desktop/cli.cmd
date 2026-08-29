@echo off
rem Project Console CLI launcher (2026-08-26, patched 2026-08-29 for picker crash).
rem Runs the terminal chat client from the desktop install with the BUNDLED Electron
rem runtime as plain Node (ELECTRON_RUN_AS_NODE=1) - no separate Node.js install needed.
rem Lives at <install>\resources\cli.cmd; extra arguments (e.g. --project "Name") pass
rem through to the client. ASCII-only on purpose (cmd.exe parser rules).
rem
rem CONSOLE_DATA_DIR: the desktop server (main.cjs) persists state in %APPDATA%\Project Console
rem (app.getPath('userData')), not in <install>\resources\data. The CLI must read the SAME
rem dir for the mascot name and any future dataPath reads — without this the mascot always
rem said "there" and a future shared read would diverge. Falls back to resources\data when
rem APPDATA is unavailable (portable installs).
set "ELECTRON_RUN_AS_NODE=1"
if not defined CONSOLE_DATA_DIR (
  if defined APPDATA set "CONSOLE_DATA_DIR=%APPDATA%\Project Console"
)
rem Always run from the resources dir so relative data/ resolves consistently
pushd "%~dp0" >nul 2>&1
"%~dp0..\Project Console.exe" "%~dp0server\cli-client.js" %*
set "CLI_EXIT=%ERRORLEVEL%"
popd >nul 2>&1
if not "%CLI_EXIT%"=="0" (
  echo.
  echo [Project Console CLI exited with code %CLI_EXIT%]
  echo If this was unexpected, re-run from PowerShell to see the full stack:
  echo   ^& "$env:LOCALAPPDATA\Programs\Project Console\resources\cli.cmd" --project "General"
  pause
)
exit /b %CLI_EXIT%