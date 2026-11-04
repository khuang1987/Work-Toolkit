@echo off
REM 以远程调试模式启动 Chrome 并直接加载本目录扩展（端口 9333，供 chrome-devtools MCP / CDP 连接）
set EXT_DIR=%~dp0
set PROFILE=%LOCALAPPDATA%\MWA-DevProfile
set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
REM Chrome 137+ 忽略 --load-extension，改用 dev-load.js 通过 CDP 加载；加载后需刷新目标页面
start "" "%CHROME%" --remote-debugging-port=9333 --remote-allow-origins=* --enable-unsafe-extension-debugging --user-data-dir="%PROFILE%" https://medtronic.fabriq.tech/team/28728/task-plan
timeout /t 6 >nul
node "%EXT_DIR%dev-load.js" 9333
echo 调试地址: http://127.0.0.1:9333/json/version
echo 启动后在插件弹窗中开启"开发者模式"，页面控制台可用 await window.__mwaDev.diagnose()
