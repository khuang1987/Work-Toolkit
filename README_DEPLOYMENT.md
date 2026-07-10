# Medtronic Work Assistant 部署指南

## 📦 快速部署

### 方法一：使用部署脚本（推荐）

1. 双击运行 `deploy-extension.bat`
2. 脚本会自动将扩展复制到 `C:\Apps\Surfari_Extension`
3. 按照提示在 Chrome 中加载扩展

### 方法二：手动部署

1. 复制 `chrome-extensions/password-autofill` 文件夹到目标位置
2. 在 Chrome 中加载扩展（见下方说明）

## 🔧 在 Chrome 中加载扩展

1. 打开 Chrome 浏览器
2. 访问 `chrome://extensions/`
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择目录：`C:\Apps\Surfari_Extension`

## 📝 关于文件名拼写

原文件名 `Sufiri_Extention` 存在拼写错误：
- ❌ `Sufiri` → ✅ `Surfari`（如果是指 Safari 的变体）
- ❌ `Extention` → ✅ `Extension`

已在脚本中修正为：`C:\Apps\Surfari_Extension`

## 🚀 Chrome 扩展自动加载说明

**重要提示**：Chrome 浏览器出于安全考虑，**不支持**通过脚本自动加载未打包的扩展程序。

### 可用的自动化方案：

#### 方案 1：使用 Chrome 企业策略（需要管理员权限）
```powershell
# 创建注册表项（需要管理员权限）
reg add "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "扩展ID;file:///C:/Apps/Surfari_Extension" /f
```

#### 方案 2：打包扩展为 .crx 文件
1. 在 `chrome://extensions/` 点击"打包扩展程序"
2. 选择扩展目录
3. 生成 .crx 文件
4. 分发 .crx 文件给其他用户

#### 方案 3：发布到 Chrome Web Store（推荐用于团队部署）
- 发布为私有扩展，仅限组织内部使用
- 用户可以直接从 Web Store 安装

### 当前最佳实践：

对于团队内部部署，推荐流程：
1. 使用 `deploy-extension.bat` 统一部署到固定路径
2. 首次手动在 Chrome 中加载扩展
3. 后续更新时，只需运行脚本覆盖文件，Chrome 会自动重新加载

## 📂 标准部署路径

```
C:\Apps\Surfari_Extension\
├── manifest.json
├── background.js
├── content.js
├── content_planner.js
├── popup.html
├── popup.js
├── styles_planner.css
└── ...
```

## 🔄 更新扩展

1. 运行 `deploy-extension.bat` 覆盖文件
2. 在 Chrome 扩展页面点击"重新加载"按钮
3. 或者使用快捷键：`Ctrl+R`（在扩展页面）

## ⚠️ 注意事项

- 确保目标路径 `C:\Apps\` 存在且有写入权限
- 首次部署后需要手动在 Chrome 中加载一次
- 开发者模式必须保持开启状态
- 扩展更新后需要手动重新加载

## 📞 技术支持

如有问题，请检查：
1. Chrome 版本是否为最新
2. 开发者模式是否已开启
3. 扩展文件是否完整
4. manifest.json 是否有语法错误
