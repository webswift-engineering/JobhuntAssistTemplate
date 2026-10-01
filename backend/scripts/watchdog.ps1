# Watchdog for the JobHuntAssist backend. Run every 5 min by the
# "JobHuntAssist Watchdog" scheduled task (hidden, via watchdog-hidden.vbs).
# Healthy (/health answers 200, even from a dev server) -> exit silently.
# Dead or hung -> log one line to backend\logs\watchdog.log and restart the task.
$ErrorActionPreference = 'SilentlyContinue'
$taskName = 'JobHuntAssist Backend'
$port = 8787
$logDir = Join-Path $PSScriptRoot '..\logs'
$logFile = Join-Path $logDir 'watchdog.log'
$pgBin = 'C:\Program Files\PostgreSQL\17\bin'
$pgData = Join-Path $PSScriptRoot '..\data\pg'
$pgLog = Join-Path $PSScriptRoot '..\logs\postgres.log'

function Write-WatchdogLog([string]$msg) {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
}

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

# 1. Health check — any 200 counts (managed task OR a manual `npm run dev` server).
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200) { exit 0 }
} catch { }

# 2. Unhealthy. If something is listening but not answering, it's hung: kill by port owner.
$owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
if ($owners) {
    Write-WatchdogLog "health failed but port $port busy (pid $($owners -join ',')) - killing and restarting task"
    foreach ($ownerPid in $owners) { Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
} else {
    Write-WatchdogLog "health failed, nothing on port $port - starting task"
}

# 3. Make sure the jobhunt Postgres (5434) is up before (re)starting the backend.
& "$pgBin\pg_isready.exe" -h 127.0.0.1 -p 5434 *> $null
if ($LASTEXITCODE -ne 0) {
    Write-WatchdogLog "postgres 5434 down - pg_ctl start"
    if (-not (Start-JobhuntPostgres)) { Write-WatchdogLog 'pg_ctl start FAILED - see logs\postgres.log' }
}

# 4. Start the backend task (no-op if the task engine already has it running).
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
exit 0
