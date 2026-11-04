@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=%~dp0..\..\.venv\Scripts\pythonw.exe"
if exist "%PYTHON_EXE%" (
    start "Work Toolbox" /b "%PYTHON_EXE%" "%~dp0main.py"
    exit /b 0
)

where pythonw.exe >nul 2>&1
if not errorlevel 1 (
    start "Work Toolbox" /b pythonw.exe "%~dp0main.py"
    exit /b 0
)

echo Python 3 was not found.
pause
exit /b 1
