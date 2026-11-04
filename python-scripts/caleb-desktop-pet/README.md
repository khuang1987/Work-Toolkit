# Caleb Desktop Pet

桌面宠物项目，版本 1.8.1。从 `C:\Users\huangk14\Documents\Codex\2026-09-12\hatch-pet-c-users-huangk14-codex` 复制过来，保留原始源码和最新安装包。Work Toolbox 的悬浮 AI 助手复用了这里的 AI 对话逻辑（`app/ai_service.py`）。

## 目录

- `app/`：宠物主程序和 AI 客户端源码。
- `tools/`：构建、打包、预览脚本。
- `runtime` 资源：`spritesheet.png`、`lean.png`、`tray.ico`、`tray.png`、`pet.json`、`personality.json`。
- `CalebDesktopPet.spec`：PyInstaller 配置。
- `package-docs/`：安装包附带的说明、版本信息和第三方许可证。
- `release/Caleb-Desktop-Pet-1.8.1-win-x64.zip`：最新安装包。zip 已加入 `.gitignore`，只保留本地副本；`.sha256` 文件用于校验。
- `BEHAVIOR-NOTES.md`、`DEVELOPMENT-LOG.md`：原项目的行为说明和开发记录。

## 运行

- 安装包：解压 `release` 中的 zip，运行里面的 exe。
- 开发预览：运行 `Start-Preview.cmd`（需要原项目的 Python 环境 / `.venv`）。

## 数据

用户数据在 `%APPDATA%\CalebDesktopPet\`：`ai-config.json`、`ai-key.bin`（DPAPI 加密的 API Key）、`ai-history.jsonl` 等。Work Toolbox 会读取这里的配置作为初始值，并共用密钥文件，但不会修改这里的文件。

## 已知情况

2026-09-12 检查时，宠物配置的模型 `gpt-5.6-luna` 在当前网关上返回 503。Work Toolbox 改用 `gpt-5.6-terra`；宠物本身的配置没有改动。
