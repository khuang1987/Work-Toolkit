# Work-Toolkit (工作工具箱)

集中管理工作辅助工具、自动化脚本和浏览器插件的单体仓库。项目入口和维护状态见 [PROJECTS.md](PROJECTS.md)，协作约定见 [AGENTS.md](AGENTS.md)，结构规范见 [AI_GUIDE.md](AI_GUIDE.md)。

## ▶ 启动工作工具箱

双击仓库根目录的 **`工作工具箱.lnk`**（本机快捷方式，不提交），或直接运行：

```text
python-scripts\work-toolbox\dist\WorkToolbox.exe
```

桌面和开始菜单也有同名快捷方式，右键可“固定到任务栏”。源码运行用 `python-scripts\work-toolbox\run.bat`，打包用同目录 `build.bat`。其他工具（一键开会、深浅色切换等）都可以从工具箱里一键启动。

## 📁 目录结构

```text
Work-Toolkit/
├── 工作工具箱.lnk              # ▶ 工具箱启动快捷方式（本机生成）
├── python-scripts/
│   ├── work-toolbox/          # ★ 统一工作工具箱（主入口，dist\WorkToolbox.exe）
│   ├── caleb-desktop-pet/     # 桌面宠物（工具箱 AI 对话的源头，源码归档）
│   ├── data-collector/        # Planner 导出、交易日志处理、PowerBI 刷新
│   ├── line-tour-transfer/    # 巡线记录转移 ETL
│   └── quick-meeting/         # 一键开 Teams 会议并开始转录
├── chrome-extensions/
│   ├── password-autofill/     # EHR、Cornerstone、Planner 等登录辅助
│   ├── windchill-assistant/   # Windchill 自动填充与查询助手
│   ├── windchill-assistant-share/ # Windchill 助手分发包（仅保留最新版）
│   └── planner-assistant/     # Planner 辅助
├── apps/
│   ├── toggle-light-dark/     # 深浅色模式切换（ToggleTheme.exe）
│   └── wifi-zscaler-switcher/ # Wi-Fi / Zscaler 一键切换（工具箱按钮调用）
├── _archive/                  # 历史项目和旧文件（不提交、不作为入口）
├── .venv/                     # 打包用 Python 环境（PyInstaller、Pillow、pywinauto、pywin32）
├── PROJECTS.md  AGENTS.md  AI_GUIDE.md
```

## 🛠️ 开发

- 禁止在子目录中创建独立的 `.git` 仓库，提交在根目录进行。
- Python 项目建议各自使用虚拟环境；工具箱打包使用根目录 `.venv`（首次：`python -m venv .venv`，再 `.venv\Scripts\python -m pip install pyinstaller pillow pywinauto pywin32`）。
- 提交信息格式：`feat:` / `fix:` / `refactor:` / `docs:`。
