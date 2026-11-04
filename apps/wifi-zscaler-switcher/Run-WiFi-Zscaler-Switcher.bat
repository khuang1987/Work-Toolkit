@echo off
setlocal

set "SCRIPT=%~dp0Switch-ZscalerWiFi.ps1"
where pwsh.exe >nul 2>&1
if not errorlevel 1 (
    pwsh.exe -NoLogo -NoProfile -File "%SCRIPT%" -NonInteractive
) else (
    powershell.exe -NoLogo -NoProfile -File "%SCRIPT%" -NonInteractive
)
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" echo Completed. The computer is on the bypass Wi-Fi.
if not "%EXITCODE%"=="0" echo The switcher exited with code %EXITCODE%. Review the messages above.
pause
exit /b %EXITCODE%
