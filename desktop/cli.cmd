@echo off
rem Project Console CLI launcher (2026-08-26).
rem Runs the terminal chat client from the desktop install with the BUNDLED Electron
rem runtime as plain Node (ELECTRON_RUN_AS_NODE=1) - no separate Node.js install needed.
rem Lives at <install>\resources\cli.cmd; extra arguments (e.g. --project "Name") pass
rem through to the client. ASCII-only on purpose (cmd.exe parser rules).
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Project Console.exe" "%~dp0server\cli-client.js" %*
if errorlevel 1 pause