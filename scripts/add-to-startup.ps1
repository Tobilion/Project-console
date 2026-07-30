<#
.SYNOPSIS
Adds the Project Console daemon to Windows startup (CurrentUser only).
Creates a .lnk shortcut in the shell:startup folder pointing to start-daemon.ps1.
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StartupFolder = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupFolder 'Project Console Daemon.lnk'
$DaemonScript = Join-Path (Join-Path $ProjectRoot 'scripts') 'start-daemon.ps1'

if (-not (Test-Path $DaemonScript)) {
    Write-Host "ERROR: start-daemon.ps1 not found at $DaemonScript" -ForegroundColor Red
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$DaemonScript`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.Description = 'Project Console background daemon'
$shortcut.WindowStyle = 7  # Minimized
$shortcut.Save()

Write-Host "Startup shortcut created at:" -ForegroundColor Green
Write-Host "  $ShortcutPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "The Project Console will now start automatically when you log in." -ForegroundColor Green
Write-Host "It runs in the background (hidden) — open http://localhost:3000 to access it." -ForegroundColor Gray
Write-Host ""
Write-Host "To remove from startup later, delete the shortcut from:" -ForegroundColor Gray
Write-Host "  shell:startup" -ForegroundColor Gray
