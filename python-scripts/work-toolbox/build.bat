@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=%~dp0..\..\.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" (
    echo Python was not found:
    echo %PYTHON_EXE%
    pause
    exit /b 1
)

"%PYTHON_EXE%" make_icon.py
if errorlevel 1 (
    echo Could not generate work-toolbox.ico.
    pause
    exit /b 1
)

if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist WorkToolbox.spec del /f /q WorkToolbox.spec

"%PYTHON_EXE%" -m PyInstaller --clean --noconfirm --onefile --windowed --name WorkToolbox --icon "work-toolbox.ico" --add-data "tools.json;." --add-data "work-toolbox.ico;." --exclude-module numpy --exclude-module scipy --exclude-module pandas main.py
if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
)

copy /y tools.json dist\tools.json >nul
if errorlevel 1 (
    echo Could not copy tools.json to the release folder.
    pause
    exit /b 1
)
copy /y sfc_integration.py dist\sfc_integration.py >nul
if errorlevel 1 (
    echo Could not copy sfc_integration.py to the release folder.
    pause
    exit /b 1
)
copy /y README.md dist\README.md >nul
if errorlevel 1 (
    echo Could not copy README.md to the release folder.
    pause
    exit /b 1
)

echo.
echo Build completed:
echo %~dp0dist\WorkToolbox.exe
pause
exit /b 0
