<#
.SYNOPSIS
Stops the Project Console daemon by reading the port from logs/daemon.port
and killing whatever process(es) are listening on it.
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
$PortFile = Join-Path $LogDir 'daemon.port'
$PidFile = Join-Path $LogDir 'daemon.pid'

if (-not (Test-Path $PortFile)) {
    Write-Host 'No daemon port file found. The server may already be stopped.' -ForegroundColor Yellow
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $PortFile -Force -ErrorAction SilentlyContinue
    exit 0
}

$port = Get-Content $PortFile -Raw -ErrorAction SilentlyContinue
if (-not $port) {
    Write-Host 'Port file is empty. Removing stale files.' -ForegroundColor Yellow
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $PortFile -Force -ErrorAction SilentlyContinue
    exit 0
}

$port = $port.Trim()
Write-Host ('Looking for process on port ' + $port + '...')

# Find ALL PIDs listening on the console's port
$listeners = netstat -ano | Select-String (':' + $port + ' ') | Select-String 'LISTENING'
if (-not $listeners) {
    Write-Host ('No process found listening on port ' + $port + '. The server may already be stopped.') -ForegroundColor Yellow
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $PortFile -Force -ErrorAction SilentlyContinue
    exit 0
}

# Parse all PIDs from netstat output and kill each one
$pidsToKill = @()
foreach ($line in $listeners) {
    $parts = $line.ToString().Trim() -split '\s+'
    $p = $parts[-1]
    if ($p -and ($pidsToKill -notcontains $p)) { $pidsToKill += $p }
}

$pidList = $pidsToKill -join ', '
Write-Host ('Found ' + $pidsToKill.Count + ' process(es) on port ' + $port + ': ' + $pidList) -ForegroundColor Cyan

foreach ($daemonPid in $pidsToKill) {
    try {
        Write-Host ('Stopping PID ' + $daemonPid + '...')
        Stop-Process -Id $daemonPid -Force -ErrorAction Stop
        Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ParentProcessId -eq $daemonPid } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Host ('Could not stop PID ' + $daemonPid + ': ' + $_.Exception.Message) -ForegroundColor Yellow
    }
}

# Final check -- use taskkill fallback if anything remains
Start-Sleep -Milliseconds 500
$remaining = netstat -ano | Select-String (':' + $port + ' ') | Select-String 'LISTENING'
if ($remaining) {
    Write-Host ('Some processes still holding port ' + $port + ' -- using taskkill fallback...') -ForegroundColor Yellow
    foreach ($line in $remaining) {
        $parts = $line.ToString().Trim() -split '\s+'
        $p = $parts[-1]
        & 'taskkill.exe' /f /pid $p 2>$null
    }
    Start-Sleep -Seconds 1
}

Write-Host ('Port ' + $port + ' is now free.') -ForegroundColor Green
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Remove-Item $PortFile -Force -ErrorAction SilentlyContinue
