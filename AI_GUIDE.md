# AI 助手操作指南 (Work-Toolkit)

本文档定义了本代码仓库的结构规范、开发原则和安全要求。所有 AI 助手在处理本仓库任务时，**必须**遵循以下规则。

## 1. 仓库结构规范

本仓库采用 Monorepo 结构管理所有工作相关的工具和脚本。

```text
Work-Toolkit/
├── chrome-extensions/   # 所有 Chrome 浏览器插件
│   └── [插件名称]/      # 例如: password_autofill
├── python-scripts/      # Python 自动化脚本
│   └── [脚本名称]/      # 例如: daily_report
├── web-tools/           # 简单的网页工具 (HTML/JS)
├── _archive/            # 归档/废弃的项目 (只读，不建议修改)
├── AI_GUIDE.md          # 本规则文件
└── README.md            # 项目总索引
```

## 2. 新项目创建规则

当用户要求创建一个新工具时：
1.  **分类**：根据工具类型（插件、脚本、网页）选择正确的父目录。
2.  **命名**：项目文件夹使用 `小写-短横线` 命名法 (kebab-case)，例如 `excel-merger`，不要使用空格或中文。
3.  **自包含**：每个项目必须是独立的文件夹，**必须包含**一个独立的 `README.md` 说明该工具的用途和用法。

## 3. 安全红线 (Critical)

**绝对禁止**将敏感信息硬编码提交到 Git。

*   ❌ **禁止**：直接在代码中写死密码、API Key、Webhook URL、内网 IP、Token。
*   ✅ **要求**：使用配置文件（如 `config.json`、`.env`）加载敏感信息。
*   ✅ **操作**：
    1. 创建 `config.json` (存真实数据)。
    2. 创建 `config.example.json` (存脱敏的模板数据，如 `{"password": "YOUR_PASSWORD"}`)。
    3. 确保根目录或项目目录的 `.gitignore` 包含 `config.json` 和 `.env`。

## 4. 编码与提交习惯

*   **注释**：关键逻辑必须添加简洁的中文注释。
*   **Git 提交**：不要为每个小工具建立单独的 `.git` 目录。你是通过根目录的 Git 管理所有内容。
*   **修改现有代码**：在修改 `_archive` 目录下的代码前，必须先询问用户是否需要将其移回活跃目录。

## 5. 常用技术栈偏好

*   **Chrome 插件**：Manifest V3, Vanilla JS (除非用户指定 React/Vue)。
*   **脚本**：Python (优先) 或 Node.js。
*   **UI**：简洁实用为主，无需过度设计，但交互必须流畅。

---
*请在开始任务前读取本文件，并在执行过程中严格遵守上述规范。*
