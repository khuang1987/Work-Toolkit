Tray Light — Windows 系统托盘插件

目标：在 Windows 任务栏右下角显示一个托盘图标（红/黄/绿），检测 Codex/Co-pilot 相关任务运行状态：
- 绿灯：任务正在运行
- 黄灯：任务已完成
- 红灯：任务异常或遇到问题

交互：右击图标弹出菜单，可切换/选择要检测的任务和打开设置。

技术选型（已决定）：C#（WinForms/WPF），理由：原生 Windows 集成最好，NotifyIcon 支持，易打包为单文件可执行。

实现计划（初期）：
1. 创建 WPF/WinForms 项目，使用 NotifyIcon + ContextMenuStrip。
2. 在后台定时检查可配置的进程名列表（默认检测进程名："copilot", "codex", "Copilot"）。
3. 根据检测结果切换托盘图标（红/黄/绿）。
4. 添加设置窗口来配置进程名和行为。

下一步：创建项目骨架、示例检测逻辑和图标资源。
