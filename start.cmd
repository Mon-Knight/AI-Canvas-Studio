@echo off
setlocal EnableExtensions DisableDelayedExpansion

if /i "%~1"=="" goto desktop_mode
if /i "%~1"=="--desktop" goto desktop_mode
if /i "%~1"=="--web" goto web_mode
if /i "%~1"=="--agent" goto agent
if /i "%~1"=="--frontend" goto frontend
if /i "%~1"=="--check" goto check
echo Usage: start.cmd [--desktop ^| --web ^| --check]
exit /b 2

:desktop_mode
call :prerequisites
if errorlevel 1 goto launch_error
wscript.exe //NoLogo "%~dp0launch-silent.vbs" --desktop %2 %3 %4 %5
exit /b 0

:web_mode
call :prerequisites
if errorlevel 1 goto launch_error
wscript.exe //NoLogo "%~dp0launch-silent.vbs" --web %2 %3 %4 %5
exit /b 0

:check
call :prerequisites
exit /b %errorlevel%

:prerequisites
if not exist "%~dp0agent\.venv\Scripts\python.exe" (
    echo [ERROR] Agent virtual environment is missing: %~dp0agent\.venv\Scripts\python.exe
    exit /b 1
)
"%~dp0agent\.venv\Scripts\python.exe" -c "import uvicorn, fastapi, sqlmodel, websockets, httpx" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Agent dependencies are missing. Run: agent\.venv\Scripts\python.exe -m pip install -e agent
    exit /b 1
)
where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH.
    exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found on PATH.
    exit /b 1
)
exit /b 0

:agent
title Flowboard Agent :8434
pushd "%~dp0agent"
if errorlevel 1 goto launch_error
".venv\Scripts\python.exe" -m uvicorn flowboard.main:app --reload --host 127.0.0.1 --port 8434 --timeout-graceful-shutdown 2
if errorlevel 1 goto launch_error
exit /b 0

:frontend
title Flowboard Frontend :5173
pushd "%~dp0frontend"
if errorlevel 1 goto launch_error
call npm run dev -- --strictPort
if errorlevel 1 goto launch_error
exit /b 0

:launch_error
echo [ERROR] Flowboard could not start. Check the details above.
pause
exit /b 1
