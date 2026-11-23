@echo off
setlocal EnableExtensions DisableDelayedExpansion

if /i "%~1"=="" goto desktop_mode
if /i "%~1"=="--desktop" goto desktop_mode
if /i "%~1"=="--web" goto web_mode
if /i "%~1"=="--agent" goto agent
if /i "%~1"=="--frontend" goto frontend
if /i "%~1"=="--check" goto check
echo Usage: start.cmd [--desktop ^| --web ^| --agent ^| --frontend ^| --check]
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
pushd "%~dp0agent"
if errorlevel 1 goto launch_error
set "FB_HTTP_PORT=8434"
set "FB_WS_PORT=8355"
for /f "usebackq tokens=1,2 delims==" %%A in (`".venv\Scripts\python.exe" -m flowboard.port_probe --mode agent`) do (
    if /i "%%A"=="HTTP_PORT" set "FB_HTTP_PORT=%%B"
    if /i "%%A"=="WS_PORT" set "FB_WS_PORT=%%B"
)
set "FLOWBOARD_HTTP_PORT=%FB_HTTP_PORT%"
set "FLOWBOARD_EXT_WS_PORT=%FB_WS_PORT%"
if not "%FB_HTTP_PORT%"=="8434" (
    echo [INFO] Port 8434 is occupied or reserved by Windows; auto-switched Agent HTTP to 127.0.0.1:%FB_HTTP_PORT% ^(WS :%FB_WS_PORT%^)
)
title Flowboard Agent :%FB_HTTP_PORT%
".venv\Scripts\python.exe" -m uvicorn flowboard.main:app --reload --host 127.0.0.1 --port %FB_HTTP_PORT% --timeout-graceful-shutdown 2
if errorlevel 1 goto launch_error
exit /b 0

:frontend
set "FB_FE_PORT=5173"
set "FB_HTTP_PORT=8434"
for /f "usebackq tokens=1,2 delims==" %%A in (`"%~dp0agent\.venv\Scripts\python.exe" -m flowboard.port_probe --mode frontend`) do (
    if /i "%%A"=="FRONTEND_PORT" set "FB_FE_PORT=%%B"
    if /i "%%A"=="HTTP_PORT" set "FB_HTTP_PORT=%%B"
)
set "FLOWBOARD_HTTP_PORT=%FB_HTTP_PORT%"
set "FLOWBOARD_FRONTEND_PORT=%FB_FE_PORT%"
title Flowboard Frontend :%FB_FE_PORT% ^(Proxy -^> :%FB_HTTP_PORT%^)
pushd "%~dp0frontend"
if errorlevel 1 goto launch_error
call npm run dev -- --port %FB_FE_PORT%
if errorlevel 1 goto launch_error
exit /b 0

:launch_error
echo [ERROR] Flowboard could not start. Check the details above.
pause
exit /b 1
