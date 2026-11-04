# Work Toolbox

本地 Windows 工作工具箱，将常用的 `.bat`、PowerShell、SSH、Wi-Fi/Zscaler 和现有工作工具集中到一个窗口中。桌面只需要保留一个 `工作工具箱.lnk`。图标资源为 `work-toolbox.ico`，由构建脚本自动嵌入 EXE。

工具箱统一使用 `Wt`（Work Toolbox）品牌徽标：窗口标题、任务栏和 `work-toolbox.ico` 为同一图形；图标由 `python make_icon.py` 用同一套徽标渲染生成，包含 16 到 256 像素多尺寸版本。所有工具入口使用 Adobe 风格徽标：深色圆角方块 + 同色系细边框 + 两位字母缩写（如 `Wf`、`Wc`、`Oc`、`Sf`），缩写取 `tools.json` 中的 `abbr`，未配置时自动取名称的两个首字母；徽标由 Pillow 渲染，没有 Pillow 时退回简化绘制。

启动后会在主显示器工作区左下角显示一个同进程悬浮工具栏：只显示徽标、不显示文字，底板默认取任务栏颜色（`app.floating_dock.background` 为 `taskbar` 或 `#RRGGBB`），无边框线，Windows 11 下使用系统圆角。始终置顶：监听前台窗口切换，点击任务栏后会立即把悬浮栏重新提到任务栏之上；可拖动到整块屏幕（包括任务栏区域），悬停放大、按下回弹，鼠标悬停时在悬浮栏上方显示按钮名称和功能说明。Codex 运行、刚完成或异常时显示对应状态点，空闲时自动隐藏；在悬浮栏空白处右击可刷新状态、锁定/解锁位置、恢复默认位置、打开完整工具箱、隐藏悬浮框或退出。

悬浮栏按钮可自行更换：在主窗口工作台里右击任意工具卡片，选择“添加到悬浮栏”，已在悬浮栏的工具可“从悬浮栏移除”或“在悬浮栏中左移/右移”。修改立即生效，并写回 `tools.json` 的 `app.floating_tools`（按顺序排列）。

点击窗口右上角关闭按钮只会隐藏主窗口（不退出、不占任务栏），悬浮栏继续工作；右键悬浮栏选“打开完整工具箱”或再次运行 `WorkToolbox.exe`/快捷方式会重新显示主窗口。彻底退出请右键悬浮栏选择“退出工具箱”。

主窗口为竖向紧凑的扁平化界面（默认 282×620，小字号；字体默认 Microsoft YaHei UI（TrueType 带屏幕微调，在 Tk/GDI + ClearType 下中文边缘最清晰；Noto Sans SC 为 OTF 字体，GDI 小字号渲染发虚有毛刺），也可用 `app.font` 指定），顶部一行只保留“工作台 / 运行记录”标签和刷新/配置图标（窗口标题栏已显示名称，不再重复大标题）；底部状态栏平时只显示当前 Wi-Fi 名称（点击可刷新），Wi-Fi 切换、SFC 等操作提示临时出现约 8 秒后自动隐藏，不再显示 Codex 状态，底部不再放目录/悬浮框按钮（启动时是否显示悬浮框由 `app.show_floating_toolbox` 控制）。卡片、抽屉标题和按钮均为大圆角，界面更柔和；圆角、圆点和待办勾选圈由 `aa_draw.py` 用 Pillow 4 倍超采样渲染成抗锯齿图片（Tk Canvas 原生图形无抗锯齿，边缘会有毛刺）。工作台按 网络与远程、AI Agent、公司系统、办公效率、工具箱 5 个抽屉分组（由 `app.drawers` 把工具的 `group` 映射到抽屉，可自行调整），点击分组标题展开，一次只展开一个（再次点击可收起），上次展开的分组保存在 `%LOCALAPPDATA%\WorkToolbox\main-window.json`。网络与远程每行一个，右侧用 `SSH`（绿）/`RDP`（蓝）标签区分，并显示 `用户@地址`。个性化：`app.theme` 可选 `dark`（默认）或 `light`，`app.accent` 设置强调色（如 `#31A8FF`、`#FF5A1F`），修改后重启工具箱生效。

## 当前按钮

- `待办角标与汇总`：悬浮栏不再放 `Wt` 按钮，新增 `Hr`（EHR）按钮。Chrome 插件 `chrome-extensions/password-autofill`（2.3.0+）后台每 10 分钟（以及打开 Windchill / EHR 页面时）用浏览器现有登录读取 Windchill 待审批任务、EHR 待办和 Fabriq 未读通知（2.4.0+，打开 Fabriq 页面时也会触发），POST 到工具箱本机接口 `http://127.0.0.1:47821/pending`（只监听本机、只接受扩展来源）。`Wc`、`Hr`、`Fq` 图标右上角显示红色数字角标，`Ai` 有待办时显示红点；右键 `Ai` 只弹出“待处理汇总”（命令菜单只在悬浮栏空白处右击出现），按来源列出数量和前 5 条摘要，点击条目或标题打开对应页面，Esc 或点击外部关闭。最近一次结果保存在 `%LOCALAPPDATA%\WorkToolbox\pending.json`，会话过期时保留上次数量并提示。逻辑在 `pending_inbox.py`。
- `Fabriq`：打开 https://medtronic.fabriq.tech/tasks（“公司系统”抽屉；悬浮栏第一个按钮，替换原 Wi-Fi 切换）。
- `Wi-Fi / VPN`：切换到 `Guest Wi-Fi 2302`，测试 Windchill，成功或最多等待 180 秒后回到 `FBI Surveillance Van #4`。
- `SSH` 区域：自动读取 `%USERPROFILE%\.ssh\config`，并加载本机专用的 `%USERPROFILE%\Work-Toolkit-Local\remote-hosts.json`，为每个 Host 显示名称和地址，点击后直接启动 `ssh.exe`。
- `RDP` 区域：自动扫描本机 `.rdp` 文件，为每个连接显示名称和地址，点击后启动 `mstsc.exe`。
  - 每个 RDP 按钮右侧有钥匙按钮，可设置显示名称和连接密码。密码用 Windows DPAPI 加密保存在 `%LOCALAPPDATA%\WorkToolbox\rdp-profiles.json`（不进仓库）。点击 RDP 按钮时自动把密码复制到剪贴板，方便在登录框粘贴；60 秒后如果剪贴板内容没变会自动清空。
- `管理员密码`（工具箱抽屉，`secret-copy` 类型）：点右侧钥匙图标手动录入管理员密码（DPAPI 加密，存于 `rdp-profiles.json` 的 `secret:uac-password` 项），之后点卡片即复制，在 UAC 窗口按 Ctrl+V 粘贴；30 秒后自动清空。密码类复制带有排除标记，不进入 Win+V 剪贴板历史和云剪贴板。程序无法直接向 UAC 安全桌面输入，只能手动粘贴。
- `Wi-Fi / VPN`：调用 `apps/wifi-zscaler-switcher/Switch-ZscalerWiFi.ps1 -NonInteractive`，后台运行不弹窗：切到 `Guest Wi-Fi 2302` 建立 Zscaler、验证 Windchill（最多 180 秒），再回到 `FBI Surveillance Van #4`。进度实时显示在底部状态栏，完整输出在“运行记录”，结束后按退出码提示结果并刷新 Wi-Fi 名称；运行中重复点击不会再次启动。SSID 和测试地址在同目录 `wifi-switcher.config.psd1` 中修改。
- `图标右键详情`：右键悬浮栏其他图标（`Ai` 仍为待处理汇总、`Td` 仍为待办面板）在图标正上方弹出该工具的详情页，宽 340、最高 460 像素，超出部分在框内滚动。内容按工具区分：`Fq`/`Wc`/`Hr` 显示未读数量、最近刷新时间、失败或过期提示及最多 30 条通知；`Ob` 显示 Vault 路径、待办数量和今日 Daily 自动记录；`Qm` 显示会议日志末尾；其余工具显示目标路径/网址、参数、可用状态和最近操作。底部按钮：打开、所在文件夹/设置，以及 ◀ ▶ 调整顺序、✕ 从悬浮栏移除。再次右键同一图标、Esc 或点击外部关闭。逻辑在 `tool_detail.py` 与 `main.py` 的 `build_tool_detail`。
- `AI 助手`：点击悬浮窗 `Ai` 图标（或“办公效率”抽屉中的按钮），在悬浮栏正上方弹出一个无边框输入框（悬浮栏靠近屏幕顶部时改为下方弹出，不会被悬浮栏遮挡）；收到回答时再向远离悬浮栏的方向展开对话区。对话用类似 WhatsApp 的圆角气泡显示：自己的消息靠右（绿色），助手回答靠左，带时间；双击或右键气泡复制。点输入框左侧 `Ai` 徽标可展开/收起历史，Esc 收起。快捷键与宠物一致：单独点按左 Ctrl 第一次弹出输入框并获得焦点，第二次触发微信语音输入：先把焦点切回并选中输入框（确认 AI 面板确实是前台窗口），再模拟右 Alt，麦克风按钮变为绿色，语音转写的文字直接进入输入框，也可点击麦克风切换，第三次关闭；由 `tools.json` 的 `ai.hotkey_enabled`、`ai.hotkey_keys`（默认 `[162]` 左 Ctrl）、`ai.voice_alt`、`ai.voice_key`（默认 `165` 右 Alt）配置。若同时运行 Caleb 宠物，两者都会响应 Ctrl，建议只保留一个。中性工作助手人设，流式回复，Enter 发送，Shift+Enter 换行。对话逻辑复用 `../caleb-desktop-pet`：`ai_service.py` 从宠物项目复制，首次启动时从 `%APPDATA%\CalebDesktopPet\ai-config.json` 复制一份配置到 `%LOCALAPPDATA%\WorkToolbox\ai-config.json`，并共用宠物的 DPAPI 密钥文件 `ai-key.bin`。模型由 `tools.json` 的 `ai.model` 覆盖（当前 `gpt-5.6-terra`），可在面板 ⚙ 里修改并测试连接。对话历史保存在 `%LOCALAPPDATA%\WorkToolbox\ai-history.jsonl`。
- `Windchill`：打开公司 Windchill 地址。
- `AI Agent`：一键启动本机已安装的 Codex（Microsoft Store 版，按 AppID 启动）、WorkBuddy、GitHub Copilot、OpenCode 桌面版和 Cursor。工具类型为 `app`：`target` 为 exe 路径（支持 `{LOCALAPPDATA}`），找不到时回退到 `app_id`（`shell:AppsFolder`）。原 OpenCode Web 启停脚本 `_maintenance\Start-OpenCode-Web.ps1` 已不存在，相关按钮已移除。
- `深浅色`：调用 Work-Toolkit 中已有入口。
- `一键开会`：后台运行 `quick-meeting\quick_meeting.py`，不打开界面，直接加入本年度固定会议「快捷会议纪要YYYY」（首次自动查找或创建）并开始转录，全年会议聊天和转录集中在同一对话，进度显示在右下角提示。
- `待办`：点击悬浮栏 `Td` 打开每日待办面板，输入一句话回车由 AI 整理成标题、日期、优先级和步骤（无 Key 时原样添加）；右击条目可改日期、优先级、AI 拆解、删除；“✦ 规划今天”给出建议顺序。`Td` 角标显示今天到期和逾期数，`Ai` 右击汇总中也显示“今日待办”。数据存放在 Obsidian 库的 `00-Inbox/Todo.md`（自动识别 Obsidian 最近打开的库，Obsidian Tasks 语法：`- [ ] 标题 ⏫ 📅 日期 🆔 编号`），工具箱只是快捷入口：在 Obsidian 中勾选、编辑或新增任务，3 秒内同步到面板和角标；工具箱中完成的任务移到“已完成”分区。可在 `tools.json` 加 `"todo": {"obsidian_vault": "库路径", "file": "00-Inbox/Todo.md"}` 指定位置；没有 Obsidian 时退回 `%LOCALAPPDATA%\WorkToolbox\Todo.md`。旧版 `todos.json` 首次启动自动迁移。完整功能在 Obsidian：库中已安装 Tasks 插件，`00-Inbox/待办看板.md` 按逾期/今天/高优先级/未来 7 天/未安排/今天完成分组（子步骤折叠在父任务下），日记模板也嵌入了当日待办；面板右上角“Obsidian ↗”直接打开看板。AI 整理会把待办文字发送给已配置的 AI 服务。
- `今日日志`：任务只存在 `Todo.md`，Obsidian 日记（`01-Daily/YYYY-MM-DD.md`，按库的日记设置和模板）只做工作日志，通过 Tasks 查询显示当日待办和完成。工具箱启动时及每天 6:00 后自动按模板创建当天日记；待办面板输入框按 `Shift+回车` 把文字以 `- HH:MM 内容` 记入日记“工作记录”节，“今日 ↗”打开当天日记；一键开会成功后也会自动记一行。日记里手写的 `- [ ]` 不会同步到工具箱。
- `AI 记录`：在 Ai 聊天里说“提醒我周四前…”“记一下：…”，AI 会在回复末尾输出 ```` ```toolbox {"todo":[...],"daily":[...]} ``` ```` 代码块，工具箱解析后直接写入 `Todo.md` 或今日日记，并把代码块替换为 `✓ 待办：…` / `✓ 今日日志：…` 回执；普通问答不触发。右击任意聊天气泡可选“复制 / ✦ AI 整理为待办 / 记入今日日志”。
- `SFC 登录`：已并入工作工具箱，SFC 设置整合为登录卡片右侧的齿轮图标，不再启动独立的 Office Assistant；SFC 自动化模块仅在点击时按需加载，密码继续使用原有 Windows DPAPI 配置。

## 运行

源码运行：

```bat
run.bat
```

打包（首次需在仓库根目录创建 `.venv` 并安装依赖：`python -m venv .venv` 后 `.venv\Scripts\python -m pip install pyinstaller pillow pywinauto pywin32`；打包版 SFC 登录会从该 `.venv` 加载 pywinauto/pywin32）：

```bat
build.bat
```

打包产物：

```text
dist\WorkToolbox.exe
```

打包目录同时包含内部 SFC 模块 `dist\sfc_integration.py`。它不是独立软件，只由 `WorkToolbox.exe` 在点击 SFC 操作时加载；日常启动工具箱不会加载 UI Automation/COM 组件。

## 配置按钮

按钮定义在 `tools.json`。支持的类型：

- `batch`：在独立命令窗口中调用 `.bat`。
- `powershell`：后台调用 PowerShell，并把输出显示在工具箱运行记录中；输出摘要同时显示在窗口底部通知条。
- `exe`：启动 Windows 程序。
- `url`：用默认浏览器打开 URL。
- `folder`：打开文件夹。
- `ssh-list`：读取本机 SSH 配置，为每个服务器生成一个连接按钮；同一 `Host` 行的多个别名，或主机名/用户/端口相同的多个 Host，合并为一个按钮，悬停提示列出全部别名。
- `rdp-list`：扫描配置路径中的 `.rdp` 文件，为每个远程桌面连接生成一个按钮。

SSH 和 RDP 列表在工具箱启动时读取一次。修改 SSH 配置或新增 `.rdp` 文件后，关闭并重新打开工具箱即可刷新列表。同一 RDP 地址存在多个副本时，工具箱只保留一个按钮，并优先使用文件名明确的配置，而不是 `Default.rdp`。

当前 SSH 列表保留：腾讯云 Windows `175.24.139.233`、腾讯云 Linux `111.231.22.87`、飞牛 NAS `ssh@192.168.3.222:22`（登记在本机 `%USERPROFILE%\Work-Toolkit-Local\remote-hosts.json`） 和 `Volcengine_Client`。错误的 `khuang.chn`、`MDDAP_Client` 已删除。连接元数据保存在用户目录，不进入仓库；密码和私钥正文不会写入工具箱。

路径支持以下占位符：

- `{CODESPACE}`：`C:\CodeSpeace`
- `{WORK_TOOLKIT}`：`C:\CodeSpeace\Work-Toolkit`
- `{DESKTOP}`：当前用户实际桌面，包括 OneDrive 桌面路径
- `{LOCAL_TOOLKIT}`：`%USERPROFILE%\Work-Toolkit-Local`，存放本机专属脚本，不进入仓库
- `{USERPROFILE}`：当前 Windows 用户目录

配置中没有保存 SSH 密码、Wi-Fi 密码、API Key 或登录令牌。

## 桌面入口

任务栏图标：程序启动时设置 AppUserModelID `Medtronic.WorkToolbox`，并为窗口设置 `Wt` 多尺寸图标，任务栏按钮显示 `Wt` 图标（源码运行时也不会归到 Python 图标下）。桌面和开始菜单的“工作工具箱.lnk”写入了同一 AppUserModelID，右键“固定到任务栏”后，固定图标与运行中的窗口合并为同一个按钮。

打包完成后，桌面快捷方式应指向：

```text
python-scripts\work-toolbox\dist\WorkToolbox.exe
```

SSH 服务器列表直接读取 `%USERPROFILE%\.ssh\config` 和 `%USERPROFILE%\Work-Toolkit-Local\remote-hosts.json`，不复制私钥和密码；旧的 `%USERPROFILE%\Work-Toolkit-Local\SSH.bat` 仍保留为本机备份。旧桌面 `.bat` 和 `.lnk` 已移入本机备份目录，不建议直接删除。

### 待办角标颜色

- 红色：数据最新。
- 灰色：最近一次同步失败，或超过 30 分钟未收到扩展上报（通常是 Chrome 未运行或登录过期）；汇总面板会显示失败原因和上次更新时间。
- Fabriq 只统计个人未读通知（与网页铃铛一致），团队通知未读仅在汇总里提示。
