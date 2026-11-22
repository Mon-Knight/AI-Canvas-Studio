@echo off
setlocal EnableExtensions DisableDelayedExpansion

if not exist "%~dp0agent\.venv\Scripts\python.exe" goto missing_python
where node.exe >nul 2>&1
if errorlevel 1 goto missing_node

wscript.exe //NoLogo "%~dp0launch-silent.vbs" --desktop %*
exit /b 0

:missing_python
echo [ERROR] Agent Python venv not found: %~dp0agent\.venv\Scripts\python.exe
pause
exit /b 1

:missing_node
echo [ERROR] Node.js not found on PATH. Please install Node.js first.
pause
exit /b 1
