' Invisible launcher for watchdog.ps1, used by the "JobHuntAssist Watchdog"
' scheduled task so the 5-minute health check never flashes a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
psPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "watchdog.ps1")
Set sh = CreateObject("WScript.Shell")
code = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & psPath & """", 0, True)
WScript.Quit code
