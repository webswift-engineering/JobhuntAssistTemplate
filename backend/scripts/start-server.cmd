@echo off
rem Auto-start wrapper for the JobHuntAssist backend.
rem Used by the "JobHuntAssist Backend" scheduled task (see README, "Auto-start on Windows").
rem Ensures the jobhunt Postgres (127.0.0.1:5434, data dir backend\data\pg) is up, then runs
rem npm start. Appends stdout/stderr to backend\logs\server.log with a date header per start.
setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo.>> "logs\server.log"
echo ===== JobHuntAssist backend starting %DATE% %TIME% =====>> "logs\server.log"

rem IMPORTANT: pg_ctl's output must go to nul, NOT server.log. postgres and its
rem launcher inherit the redirect handle and cmd opens >> targets without write
rem sharing, so redirecting pg_ctl to server.log locks the log for as long as
rem Postgres lives (breaking the npm redirect below and all future appends).
set "PGBIN=C:\Program Files\PostgreSQL\17\bin"
"%PGBIN%\pg_isready.exe" -h 127.0.0.1 -p 5434 >nul 2>&1
if errorlevel 1 (
  echo [start-server] Postgres 5434 not ready - starting via pg_ctl>> "logs\server.log"
  "%PGBIN%\pg_ctl.exe" start -D "%CD%\data\pg" -l "%CD%\logs\postgres.log" -w -t 60 <nul >nul 2>&1
  if errorlevel 1 (
    echo [start-server] WARNING: pg_ctl start failed - backend will likely crash with ECONNREFUSED>> "logs\server.log"
  ) else (
    echo [start-server] Postgres started>> "logs\server.log"
  )
) else (
  echo [start-server] Postgres 5434 already accepting connections>> "logs\server.log"
)

call "C:\Program Files\nodejs\npm.cmd" run start >> "logs\server.log" 2>&1
exit /b %ERRORLEVEL%
