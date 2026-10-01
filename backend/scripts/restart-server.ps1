# Restarts the JobHuntAssist backend via its scheduled task, with visible feedback.
# Invoked by restart-server.cmd (double-click / Desktop shortcut "Restart JobHunt Server").
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$taskName = 'JobHuntAssist Backend'
$port = 8787
$check = [char]0x2713
$pgBin = 'C:\Program Files\PostgreSQL\17\bin'
$pgData = Join-Path $PSScriptRoot '..\data\pg'
$pgLog = Join-Path $PSScriptRoot '..\logs\postgres.log'

# Start pg_ctl without inheriting our stdout/stderr: postgres outlives pg_ctl and
# would otherwise hold the inherited pipe/log handles forever (hanging `&` calls
# that wait for output EOF, or locking log files). Waits for pg_ctl only.
function Start-JobhuntPostgres {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $pgBin 'pg_ctl.exe'
    $psi.Arguments = "start -D `"$pgData`" -l `"$pgLog`" -w -t 60"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    if (-not $p.WaitForExit(90000)) { return $false }
    return ($p.ExitCode -eq 0)
}

Write-Host ''
Write-Host 'Restarting JobHuntAssist server...' -ForegroundColor Cyan

# 1. Stop the scheduled task (ignore errors if it isn't running).
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

# 2. Kill whatever still owns port 8787 (by port ownership only, never by name).
$owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($ownerPid in $owners) {
    Write-Host "  stopping process $ownerPid still listening on port $port"
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
}

# 3. Wait for the port to free (up to 15 s).
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "FAILED - port $port is still in use; check Task Manager." -ForegroundColor Red
    Start-Sleep -Seconds 15
    exit 1
}

# 4. Make sure the jobhunt Postgres (5434) is up before starting the backend.
& "$pgBin\pg_isready.exe" -h 127.0.0.1 -p 5434 *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host '  Postgres already running'
} else {
    Write-Host '  Starting Postgres...'
    if (-not (Start-JobhuntPostgres)) {
        Write-Host 'FAILED - Postgres did not start. Check backend\logs\postgres.log' -ForegroundColor Red
        Start-Sleep -Seconds 15
        exit 1
    }
}

# 5. Start the scheduled task again.
Write-Host '  starting scheduled task...'
Start-ScheduledTask -TaskName $taskName

# 6. Poll /health until it answers (up to 60 s).
$deadline = (Get-Date).AddSeconds(60)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
}

if ($healthy) {
    Write-Host "Server is up $check" -ForegroundColor Green
    Start-Sleep -Seconds 3
    exit 0
} else {
    Write-Host 'FAILED - server did not come back. Check backend\logs\server.log' -ForegroundColor Red
    Start-Sleep -Seconds 15
    exit 1
}
