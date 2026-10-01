' Invisible launcher for start-server.cmd, so the scheduled task shows no console window.
' Waits for the server to exit and propagates its exit code so Task Scheduler's
' restart-on-failure (max 3 retries) can see EADDRINUSE crashes as failures.
Set fso = CreateObject("Scripting.FileSystemObject")
cmdPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-server.cmd")
Set sh = CreateObject("WScript.Shell")
code = sh.Run("""" & cmdPath & """", 0, True)
WScript.Quit code
