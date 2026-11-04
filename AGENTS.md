# Work-Toolkit Agent Instructions

## 范围

本文件适用于 `C:\CodeSpeace\Work-Toolkit` 及其子目录。项目导航和入口见 [PROJECTS.md](PROJECTS.md)。

## 工作约定

- 先读取 `PROJECTS.md` 和目标项目的 README，再定位最小改动范围。
- 这是一个多项目目录；不要把一个项目的依赖、配置或生成物复制到另一个项目。
- 保留用户已有的未提交修改，修改前先检查状态，不做重置、覆盖或大范围清理。
- 使用 UTF-8 和补丁方式编辑文件；涉及中文路径、批处理或 Excel 的改动要做 Windows 本机验证。
- 不提交 `.env`、`config.local.json`、连接字符串、密码、令牌、登录缓存、日志、虚拟环境、`node_modules` 和生成目录。
- 优先复用项目现有依赖和脚本，避免为小修复引入新依赖。

## WorkshopTracker 例外说明

WorkshopTracker 不在本仓库内，源码位于 `C:\CodeSpeace\WorkshopTracker`。每天 11:00 的同步任务是 Windows 计划任务 `WorkshopTracker Weekly Xlsx Sync`，入口为：

```text
C:\CodeSpeace\WorkshopTracker\tools\reporting-sync\run_weekly_inspections_to_xlsx.bat
```

更新该任务时：

1. 先查看 `tools/reporting-sync/logs/weekly-xlsx-sync-YYYYMMDD.log` 和计划任务的 Last Result。
2. 检查 OneDrive 当前季度工作簿是否存在；不要凭旧季度文件名推断路径。
3. 使用 `--no-popup` 做验证，避免计划任务在交互式弹窗处挂起。
4. 验证 Python 语法、配置 JSON、工作簿选择逻辑，再决定是否执行真实同步。
5. 不直接修改数据库结构或删除历史数据，除非用户明确授权。

## 交付前检查

- `git diff` 只包含本次任务所需的文件。
- 运行与改动相称的最小验证，并记录未能验证的外部条件。
- 若更新了项目入口、运行方式、定时任务或故障排查路径，同步更新 `PROJECTS.md`。
