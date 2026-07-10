@echo off
chcp 65001 >nul
echo ========================================
echo   Medtronic Work Assistant 部署脚本
echo ========================================
echo.

REM 设置源目录和目标目录
set SOURCE_DIR=%~dp0
set TARGET_DIR=C:\Apps\Surfari_Extension

echo 源目录: %SOURCE_DIR%
echo 目标目录: %TARGET_DIR%
echo.

REM 检查源目录是否存在
if not exist "%SOURCE_DIR%" (
    echo [错误] 源目录不存在: %SOURCE_DIR%
    pause
    exit /b 1
)

REM 创建目标目录（如果不存在）
if not exist "%TARGET_DIR%" (
    echo [信息] 创建目标目录: %TARGET_DIR%
    mkdir "%TARGET_DIR%"
)

REM 复制文件
echo [信息] 正在复制文件...
xcopy "%SOURCE_DIR%\*.*" "%TARGET_DIR%\" /E /I /Y /Q

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo   ✅ 部署成功！
    echo ========================================
    echo.
    echo 扩展已复制到: %TARGET_DIR%
    echo.
    echo 下一步操作：
    echo 1. 打开 Chrome 浏览器
    echo 2. 访问 chrome://extensions/
    echo 3. 开启"开发者模式"
    echo 4. 点击"加载已解压的扩展程序"
    echo 5. 选择目录: %TARGET_DIR%
    echo.
) else (
    echo.
    echo [错误] 复制失败，错误代码: %ERRORLEVEL%
    echo.
)

pause
