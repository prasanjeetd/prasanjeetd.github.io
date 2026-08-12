@echo off
REM ===========================================================================
REM  logs.bat - build an HTML activity report from the R2 log bucket and open
REM  it in your browser.
REM
REM  Double-click it, or from a terminal:
REM
REM     logs.bat                    every site, every date
REM     logs.bat --date 2026-08-12  one date
REM     logs.bat --console          plain text in this window instead
REM     logs.bat --console --errors only sessions that hit a problem
REM
REM  Reports are written to logging\reports\ with the generation time in the
REM  filename, so each run is kept rather than overwriting the last. That folder
REM  is gitignored: the reports contain visitor data and this repo is public.
REM
REM  Credentials come from ..\secret\.r2.secret, also gitignored.
REM ===========================================================================

chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not on PATH. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "..\secret\.r2.secret" (
  echo.
  echo   Missing ..\secret\.r2.secret - that file holds the R2 credentials.
  echo   It is gitignored, so it will not be present on a fresh clone.
  echo.
  pause
  exit /b 1
)

REM --console switches to the terminal report. Everything else is passed through.
set MODE=html
set ARGS=
for %%A in (%*) do (
  if /i "%%A"=="--console" (set MODE=console) else (set ARGS=!ARGS! %%A)
)

if "%MODE%"=="console" (
  node "tools\report.mjs" %ARGS%
  set EXITCODE=!ERRORLEVEL!
  goto :done
)

echo.
echo   Reading logs from R2...

REM html.mjs prints the path it wrote, which is captured here so the report can
REM be opened without guessing the timestamped filename.
set REPORT=
for /f "usebackq delims=" %%P in (`node "tools\html.mjs" %ARGS%`) do set REPORT=%%P
set EXITCODE=%ERRORLEVEL%

if not defined REPORT (
  echo   Report was not generated.
  set EXITCODE=1
  goto :done
)

echo   Written: !REPORT!
echo   Opening in your browser...
start "" "!REPORT!"

:done
echo.
if not "%EXITCODE%"=="0" echo   Finished with exit code %EXITCODE%.

REM Only pause when double-clicked. Explorer adds /c to CMDCMDLINE; a run from
REM an existing console does not have it, so scripted use is not blocked.
echo %CMDCMDLINE% | find /i "/c" >nul
if not errorlevel 1 pause

exit /b %EXITCODE%
