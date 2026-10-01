@echo off
rem Visible restart of the JobHuntAssist backend. Double-click me (or the
rem "Restart JobHunt Server" Desktop shortcut). Logic lives in restart-server.ps1.
title Restart JobHunt Server
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-server.ps1"
exit /b %ERRORLEVEL%
