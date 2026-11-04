# 项目清单

> 维护规则：新增、归档或改变入口时，更新本文件的对应行和“最后确认”日期。不要把密码、令牌或完整连接字符串写入清单。

最后确认：2026-11-04

| 项目 | 位置 | 类型 | 入口 / 运行方式 | 状态 |
|---|---|---|---|---|
| Password Autofill | `chrome-extensions/password-autofill` | Chrome 扩展 | 在 Chrome 扩展页加载目录；更新后重新加载；`dev-chrome.bat` 启动独立调试 Chrome（9333），Fabriq AI 配置见 README | 维护中 |
| Windchill Work Assistant | `chrome-extensions/windchill-assistant` | Chrome 扩展 | 在 Chrome 扩展页加载目录；更新后重新加载 | 维护中 |
| Planner Assistant | `chrome-extensions/planner-assistant` | Chrome 扩展 | 在 Chrome 扩展页加载目录 | 维护中 |
| Data Collector | `python-scripts/data-collector` | Python / Tkinter | `python src/main.py` 或运行打包程序 | 维护中 |
| Line Tour Transfer | `python-scripts/line-tour-transfer` | Python ETL | `python src/line_tour_transfer.py` | 维护中 |
| Office Assistant | `_archive/office-assistant` | 已迁移到 Work Toolbox | 由 `WorkToolbox.exe` 内置 SFC 登录与设置 | 归档 |
| Tray App | `_archive/tray-app` | .NET Windows tray app（Codex 红绿灯，已由工具箱悬浮栏状态替代） | `publish.ps1` | 归档 |
| Docker WSL Lab | `_archive/docker-wsl-lab` | Docker / Python demo | `docker compose up --build` | 归档 |
| Quick Meeting | `python-scripts/quick-meeting` | Python / UI Automation | 工具箱“一键开会”或 `run.bat` | 维护中 |
| Toggle Light Dark | `apps/toggle-light-dark` | Windows 量产工具 | 运行 `ToggleTheme.exe` | 维护中 |
| Wi-Fi Zscaler Switcher | `apps/wifi-zscaler-switcher` | PowerShell：切直连 Wi-Fi 建立 Zscaler、验证 Windchill、再回旁路由 | 工具箱“Wi-Fi / VPN”按钮（后台运行）；手动 `Run-WiFi-Zscaler-Switcher.bat` | 维护中 |
| **Work Toolbox（主入口）** | `python-scripts/work-toolbox` | Python / Tkinter Windows 工具箱（含悬浮 AI 助手、AI 每日待办、审批角标汇总、AI Agent 启动器、RDP 密码复制） | 根目录 `工作工具箱.lnk` → `dist\WorkToolbox.exe`；源码 `run.bat`；打包 `build.bat`（使用根目录 `.venv`） | 维护中 |
| Caleb Desktop Pet | `python-scripts/caleb-desktop-pet` | Python / Tkinter 桌面宠物（AI 对话源头） | 解压 `release\Caleb-Desktop-Pet-1.8.1-win-x64.zip` 或 `Start-Preview.cmd` | 源码归档 |
| Archive | `_archive` | 历史项目、旧分发包和根目录旧文件（已 gitignore） | 不作为当前实现入口 | 归档 |

