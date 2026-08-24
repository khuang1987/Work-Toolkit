@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在安装 PyInstaller(如已安装可跳过)...
pip install -q pyinstaller mss pywin32 pillow
if %errorlevel% neq 0 (
    echo PyInstaller 安装失败,请检查网络后重试。
    pause
    exit /b 1
)

echo 正在打包,请等待 1-3 分钟...
set "BUILD_ROOT=%TEMP%\MeetingNotes-build"
set "SPEC_ROOT=%TEMP%\MeetingNotes-spec"
python -m PyInstaller --noconfirm --clean --onefile --windowed --workpath "%BUILD_ROOT%" --specpath "%SPEC_ROOT%" --add-data "%~dp0ocr.ps1;." --name "会议纪要助手" app.py
if %errorlevel% neq 0 (
    echo 打包失败。请将上方错误信息反馈。
    pause
    exit /b 1
)

echo.
echo 打包完成: dist\会议纪要助手.exe
echo 复制该 exe 到任意位置即可双击使用,无需安装 Python。
pause
