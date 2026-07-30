<#
.SYNOPSIS
Starts the Project Console server as a background daemon (hidden window).
Logs to logs/daemon.log, writes the bound port to logs/daemon.port.
Scans ports 3000-3009 to discover which port the server actually bound to.
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
$PortFile = Join-Path $LogDir 'daemon.port'
$LogFile = Join-Path $LogDir 'daemon.log'

# Ensure log directory exists
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# Kill any existing daemon first (by port, robust against stale PIDs)
if (Test-Path $PortFile) {
    $oldPort = Get-Content $PortFile -Raw -ErrorAction SilentlyContinue
    if ($oldPort) {
        $oldPort = $oldPort.Trim()
        $listener = netstat -ano | Select-String ":$oldPort " | Select-String "LISTENING"
        if ($listener) {
            $parts = $listener.ToString().Trim() -split '\s+'
            $oldDaemonPid = $parts[-1]
            Write-Host "Stopping existing daemon on port $oldPort (PID $oldDaemonPid)..."
            Stop-Process -Id $oldDaemonPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
    }
    Remove-Item $PortFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Starting Project Console daemon..."

# Start npm run dev in a hidden window. "npm" is npm.cmd on Windows — Start-Process
# can't launch .cmd files directly, so we use cmd.exe as the wrapper.
# Redirect both stdout and stderr to the same log file via cmd's own 2>&1 syntax.
$process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run dev >> `"$LogFile`" 2>&1" -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru

# Track the cmd.exe PID as a best-effort reference
$PidFile = Join-Path $LogDir 'daemon.pid'
$process.Id | Out-File -FilePath $PidFile -Encoding ASCII
Write-Host "Daemon started (PID $($process.Id)). Waiting for server to become ready..." -ForegroundColor Cyan

# Scan ports 3000-3009 to find the actual bound port.
# Keep trying for up to 45 seconds — first boot can be slow (NLP training + embedding
# model download + project indexing all run before the server starts listening).
$found = $false
$basePort = 3000
$maxRounds = 15
for ($round = 0; $round -lt $maxRounds -and -not $found; $round++) {
    for ($i = 0; $i -lt 10 -and -not $found; $i++) {
        $port = $basePort + $i
        $url = "http://localhost:$port"
        try {
            # curl.exe is available on Windows 10/11 by default — more reliable than
            # Invoke-WebRequest for simple health checks (PS 5.1's cmdlet can time out
            # even on a responsive server serving HTML).
            $exitCode = & 'curl.exe' -s -o nul -w '%{http_code}' $url --max-time 2
            if ($LASTEXITCODE -eq 0 -and $exitCode -eq '200') {
                Write-Host "Console ready at $url" -ForegroundColor Green
                Write-Host "Log file: $LogFile" -ForegroundColor Gray
                $port | Out-File -FilePath $PortFile -Encoding ASCII
                $found = $true
            }
        } catch {
            # Port not ready yet
        }
    }
    if (-not $found) {
        Start-Sleep -Seconds 3
    }
}

if (-not $found) {
    Write-Host "Server did not become ready within 45 seconds." -ForegroundColor Yellow
    Write-Host "Check the log file for details: $LogFile" -ForegroundColor Yellow
    Write-Host "The server may have started on an unexpected port or encountered an error." -ForegroundColor Yellow
}

Write-Host "Use scripts/stop-daemon.ps1 to stop the server." -ForegroundColor Gray
