# Registers a weekday 06:58 task that launches Chrome (JobHuntAssist extension
# profile) so the extension's auto-scan alarms can fire from 07:00.
$launcher = Join-Path $PSScriptRoot 'launch-chrome.ps1'

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 6:58am
# Also at logon: an overnight reboot (Windows Update) leaves the PC at the lock
# screen, where a "run only when user is logged on" task can't fire — so the
# 06:58 run is missed until someone signs in. Start Chrome at that moment instead.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName 'JobHuntAssist Chrome' `
    -Action $action -Trigger @($trigger, $logon) -Settings $settings `
    -Description 'Weekdays 06:58 + at logon: start Chrome (extension profile) so LinkedIn auto-scan alarms run 07:00-17:00' -Force

Write-Host "Task registered: Chrome launches weekdays at 06:58 and at every logon, if not already running."
