# Opens the JobHuntAssist dashboard in the default browser.
# If the backend isn't running, starts it first (minimized console window,
# titled "JobHuntAssist backend", so it stays visible and closable).
$port = 8787
$url  = "http://localhost:$port"
$backendDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'backend'

function Test-Backend {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-Backend)) {
    Start-Process cmd.exe -ArgumentList '/k', 'title JobHuntAssist backend && npm start' `
        -WorkingDirectory $backendDir -WindowStyle Minimized
    $deadline = (Get-Date).AddSeconds(45)
    while (-not (Test-Backend) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
}

if (Test-Backend) {
    Start-Process $url
} else {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
        "The backend didn't come up on port $port within 45s.`nCheck the minimized 'JobHuntAssist backend' window in the taskbar for errors.",
        'JobHuntAssist dashboard')
}
