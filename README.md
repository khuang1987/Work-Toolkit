# Work-Toolkit (工作工具箱)

这是一个 Monorepo (单体仓库)，用于集中管理所有的工作辅助工具、自动化脚本和浏览器插件。本项目结构遵循 `AI_GUIDE.md` 规范。

## 📁 目录结构

```text
Work-Toolkit/
├── chrome-extensions/       # Chrome 浏览器插件
│   └── password-autofill/   # 密码自动填充与验证码辅助插件
├── python-scripts/          # Python 自动化脚本
│   ├── data-collector/      # 数据采集与处理工具 (原 toolkit_dataCollect)
│   └── line-tour-transfer/  # 巡线记录转移工具 (ETL 自动化)
├── web-tools/               # Web 前端工具 (预留)
├── _archive/                # 归档的旧项目
└── AI_GUIDE.md              # AI 助手开发规范文档
```

## 🚀 快速导航

### [Chrome 插件: Password Autofill](chrome-extensions/password-autofill/)
帮助自动化填充内部系统的登录凭证，并优化验证码输入体验。

### [Python: Data Collector](python-scripts/data-collector/)
核心数据采集工具，集成了 Planner 数据导出、交易日志处理和 PowerBI 自动刷新功能。
- **运行**: `python src/main.py`

### [Python: Line Tour Transfer](python-scripts/line-tour-transfer/)
自动化提取和转移主管巡线记录的 ETL 工具。
- **运行**: `python src/line_tour_transfer.py`

## 🛠️ 开发指南

本仓库禁止在子目录中创建独立的 `.git` 仓库。所有提交必须在根目录进行。

### 初始化环境
建议为每个 Python 项目创建独立的虚拟环境：

```bash
# 数据采集工具
cd python-scripts/data-collector
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt

# 巡线记录工具
cd ../line-tour-transfer
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

### Git 规范
提交信息请遵循以下格式：
- `feat: ...` 新增功能
- `fix: ...` 修复 Bug
- `refactor: ...` 代码重构
- `docs: ...` 文档更新
