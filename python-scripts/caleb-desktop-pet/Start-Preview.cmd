@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo Development runtime is missing. This launcher is not a standalone package.
  pause
  exit /b 1
)
start "Caleb Preview" ".venv\Scripts\pythonw.exe" "app\main.py"
