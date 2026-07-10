@echo off
setlocal

title Line Tour Transfer Tool

echo ============================================================
echo Line Tour Transfer Tool
echo ============================================================
echo.
echo Starting, please wait...
echo.

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"

if not exist "%PYTHON_EXE%" (
    echo Project venv not found. Creating...
    py -3 -m venv "%~dp0.venv"
    if errorlevel 1 (
        echo Failed to create venv. Please check Python 3 installation.
        goto :end
    )

    echo Installing dependencies...
    "%PYTHON_EXE%" -m pip install -r "%~dp0requirements.txt"
    if errorlevel 1 (
        echo Failed to install dependencies. Please check network and requirements.txt.
        goto :end
    )
)

"%PYTHON_EXE%" "src\line_tour_transfer.py"

echo.
echo ============================================================
echo Press any key to close this window...
echo ============================================================

:end
pause > nul
endlocal
