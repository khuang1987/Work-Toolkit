@echo off
setlocal
set "VENV_PYW=%~dp0..\..\.venv\Scripts\pythonw.exe"
if exist "%VENV_PYW%" (
    start "" "%VENV_PYW%" "%~dp0quick_meeting.py"
) else (
    start "" pythonw "%~dp0quick_meeting.py"
)
