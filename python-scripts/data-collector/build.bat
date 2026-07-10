@echo off
chcp 936

echo ========================================
echo Building Data Collection Tool (Optimized)...
echo ========================================

REM Create virtual environment
if not exist venv (
    echo [1/5] Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
call venv\Scripts\activate.bat

REM Install dependencies
echo [2/5] Installing dependencies...
pip install -r requirements.txt
pip install pyinstaller==6.4.0

REM Create resource directories
echo [3/5] Creating resource directories...
if not exist resources\cache mkdir resources\cache

REM Clean old build files
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
del /f /q *.spec 2>nul

REM Build with PyInstaller (Optimized)
echo [5/5] Building application (optimized)...
pyinstaller --clean --noconfirm --onedir --windowed ^
    --icon=assets\app_icon.ico ^
    --add-data "config;config" ^
    --add-data "assets;assets" ^
    --add-data "docs;docs" ^
    --add-data "readme.md;." ^
    --add-data "src\core;src\core" ^
    --add-data "src\gui;src\gui" ^
    --add-data "src\utils;src\utils" ^
    --paths "src" ^
    --hidden-import core ^
    --hidden-import core.planner_exporter ^
    --hidden-import core.transaction_log_exporter ^
    --hidden-import core.labor_hour_formatter ^
    --hidden-import core.product_quantity_formatter ^
    --hidden-import core.team_shift_manager ^
    --hidden-import core.powerbi_refresh ^
    --hidden-import core.cmes_data_collector ^
    --hidden-import gui ^
    --hidden-import gui.gui ^
    --hidden-import gui.system_tray ^
    --hidden-import utils ^
    --hidden-import utils.scheduler ^
    --hidden-import utils.schedule_logger ^
    --hidden-import utils.path_manager ^
    --hidden-import utils.config_manager ^
    --hidden-import utils.log_manager ^
    --hidden-import utils.task_lock_manager ^
    --hidden-import utils.playwright_manager ^
    --hidden-import pystray ^
    --hidden-import ttkbootstrap ^
    --hidden-import playwright ^
    --hidden-import PIL ^
    --hidden-import PIL.Image ^
    --hidden-import PIL.ImageTk ^
    --hidden-import pandas ^
    --hidden-import psutil ^
    --exclude-module matplotlib ^
    --exclude-module scipy ^
    --exclude-module numpy.tests ^
    --exclude-module numpy.random._examples ^
    --exclude-module pandas.tests ^
    --exclude-module PIL.tests ^
    --exclude-module psutil.tests ^
    --exclude-module pystray.tests ^
    --exclude-module IPython ^
    --exclude-module jupyter ^
    --exclude-module pytest ^
    --exclude-module tkinter.test ^
    --exclude-module selenium ^
    --exclude-module babel ^
    --exclude-module Pythonwin ^
    --exclude-module pythonwin ^
    --exclude-module win32com.demos ^
    --exclude-module win32com.test ^
    --hidden-import pytz ^
    --collect-data "ttkbootstrap" ^
    --collect-submodules "ttkbootstrap" ^
    --name "DataCollector" ^
    src\main.py

if errorlevel 1 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo Build completed successfully!
echo ========================================

REM Create release package
echo Creating release package...
if not exist "dist\DataCollector_v1.4.1" mkdir "dist\DataCollector_v1.4.1"
xcopy /E /I /Y "dist\DataCollector" "dist\DataCollector_v1.4.1\"

REM Copy necessary files
echo Copying files...
xcopy /E /I /Y "config" "dist\DataCollector_v1.4.1\config"
xcopy /E /I /Y "assets" "dist\DataCollector_v1.4.1\assets"
xcopy /E /I /Y "docs" "dist\DataCollector_v1.4.1\docs"
copy "readme.md" "dist\DataCollector_v1.4.1\" 2>nul

echo.
echo ========================================
echo Release package created successfully!
echo Location: dist\DataCollector_v1.4.1\
echo ========================================

pause
