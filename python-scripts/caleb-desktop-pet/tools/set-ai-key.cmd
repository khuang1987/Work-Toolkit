@echo off
cd /d "%~dp0.."
chcp 65001 >nul
if not exist ".venv\Scripts\python.exe" (
  echo Development runtime is missing. This launcher is not a standalone package.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" "tools\set_ai_key.py"
echo.
pause
