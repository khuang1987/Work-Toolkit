@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
    python app.py
) else (
    py -3 app.py
)
pause
