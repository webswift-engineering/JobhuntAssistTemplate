# Registers a daily 7:00 task that wakes the PC (if asleep) and launches the
# keep-awake tray app, which holds the system awake until 17:00 and shows a
# green/grey status dot in the system tray.
$launcher = Join-Path $PSScriptRoot 'keep-awake-launch.vbs'

$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`""
$trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
$settings = New-ScheduledTaskSettingsSet -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName 'JobHuntAssist KeepAwake' `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Wakes PC at 7am and starts the JobHuntAssist keep-awake tray (auto-releases at 5pm)' -Force

Write-Host "Task registered: PC wakes at 7:00 and the keep-awake tray starts (green dot, auto-pause at 17:00)."
