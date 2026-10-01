# Opens a real Chrome window for the profile that hosts the JobHuntAssist
# extension. chrome.alarms only fire reliably while a browser window exists —
# Chrome's own "--no-startup-window" background mode (started at logon when
# "continue running background apps" is on) keeps a chrome.exe alive with NO
# window, and the extension's alarms stayed silent in that state (2026-09-09).
# So: always ask Chrome for a window. If Chrome is already running, this just
# opens one more window in the existing instance (harmless); if not, it starts.
param(
    [string]$Profile = "Default"
)

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { Write-Error "chrome.exe not found"; exit 1 }

# No "already running" check: a window title cannot tell profiles apart, and an
# extra window in an existing Chrome is harmless. Always ask for one.

Start-Process $chrome -ArgumentList "--profile-directory=`"$Profile`"", "--new-window", "http://localhost:8787/"
