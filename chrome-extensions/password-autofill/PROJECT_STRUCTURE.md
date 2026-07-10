# 项目结构说明

## 文件结构

```
password-autofill/
├── manifest.json           # 插件配置文件
├── background.js          # 后台服务脚本
├── content.js            # 内容脚本（注入到网页）
├── popup.html            # 弹出窗口界面
├── popup.js              # 弹出窗口逻辑
├── icon.png              # 插件图标（PNG格式）
├── icon.svg              # 插件图标（SVG格式）
├── README.md             # 项目说明文档
├── CHANGELOG.md          # 更新日志
├── USAGE_GUIDE.md        # 使用指南
├── INSTALL.md            # 安装指南
├── PROJECT_STRUCTURE.md  # 项目结构说明（本文件）
└── AI_GUIDE.md           # AI 开发指南
```

## 核心文件说明

### manifest.json
Chrome 扩展的配置文件，定义了：
- 插件基本信息（名称、版本、描述）
- 权限声明
- 后台脚本
- 内容脚本
- 弹出窗口
- 图标资源

**关键配置：**
```json
{
  "manifest_version": 3,
  "name": "Medtronic Smart Assistant",
  "version": "1.3",
  "permissions": [
    "storage", "tabs", "contextMenus", 
    "webRequest", "alarms", "notifications"
  ]
}
```

### background.js
后台服务脚本，持续运行，负责：
- 监听新标签页创建和更新
- 处理 HTTP Basic Authentication
- 管理右键菜单
- 处理定时任务（每日自动打开）
- 缓存用户凭据
- 接收和处理来自其他脚本的消息

**主要功能：**
- `updateContextMenu()`: 更新右键菜单
- `updateCachedCredentials()`: 更新缓存的凭据
- `updateDailyAlarm()`: 更新定时任务
- `chrome.webRequest.onAuthRequired`: 处理 Basic Auth

### content.js
内容脚本，注入到目标网页，负责：
- 自动填充账号密码
- 检测登录成功/失败
- 显示登录重试对话框
- Cornerstone 自动点击功能
- 创建悬浮按钮
- 监听 DOM 变化
- 弹窗自动关闭

**主要功能：**
- `autoFillCredentials()`: 自动填充凭据
- `checkLoginSuccess()`: 检查登录是否成功
- `showLoginRetryDialog()`: 显示重试对话框
- `findAndClickMarkComplete()`: 查找并点击按钮
- `createFloatingButton()`: 创建悬浮按钮
- `startPopupMonitoring()`: 启动弹窗监控

**支持的网站：**
- `https://khplm.medtronic.com.cn/*` (Windchill)
- `https://medtronic.csod.com/*` (Cornerstone)
- `http://ehr.medtronic.com.cn/*` (EHR)

### popup.html
弹出窗口的 HTML 结构，包含：
- 标题栏（带版本号）
- 系统卡片（Windchill、Cornerstone、EHR）
- 定时启动卡片
- 使用提示
- 状态提示区域

**设计特点：**
- 渐变色背景
- 卡片式布局
- 可展开/收起的设置区域
- 响应式设计
- 动画效果

### popup.js
弹出窗口的交互逻辑，负责：
- 系统卡片点击事件处理
- 展开/收起设置区域
- 表单数据加载和保存
- 开关状态管理
- 键盘快捷键
- 状态提示显示

**主要功能：**
- 卡片点击：打开网页或展开设置
- 数据持久化：使用 Chrome Storage API
- 键盘快捷键：Ctrl/Cmd + S 保存，Enter 快速保存
- 状态反馈：成功/错误提示

## 数据存储

使用 Chrome Storage API 存储配置：

```javascript
chrome.storage.local.set({
  username: 'xxx',           // Windchill 用户名
  password: 'xxx',           // Windchill 密码
  Login1: 'xxx',             // EHR 用户名
  Password1: 'xxx',          // EHR 密码
  clickCount: 30,            // 自动点击次数
  autoClickEnabled: true,    // 自动点击开关
  autoClosePopup: false,     // 自动关闭弹窗开关
  dailyOpenEnabled: false,   // 定时启动开关
  dailyOpenTime: '09:00',    // 启动时间
  loginAttempts: 0,          // 登录尝试次数
  isAutoClickRunning: false, // 自动点击运行状态
  currentClickCount: 0,      // 当前点击次数
  targetClickCount: 0,       // 目标点击次数
  clickedLaunchHrefs: [],    // 已点击的链接
  noButtonRefreshAttempts: 0 // 刷新尝试次数
});
```

## 通信机制

### 1. Content Script → Background
```javascript
chrome.runtime.sendMessage({
  action: 'monitorNewTab',
  url: 'xxx'
});
```

### 2. Background → Content Script
```javascript
chrome.tabs.sendMessage(tabId, {
  action: 'stopAllActions'
});
```

### 3. Storage 变化监听
```javascript
chrome.storage.onChanged.addListener((changes, area) => {
  // 处理存储变化
});
```

## 权限说明

| 权限 | 用途 |
|------|------|
| storage | 保存配置信息 |
| tabs | 打开和管理标签页 |
| activeTab | 访问当前标签页 |
| contextMenus | 创建右键菜单 |
| webRequest | 拦截 HTTP 请求 |
| webRequestAuthProvider | 处理 Basic Auth |
| alarms | 定时任务 |
| notifications | 桌面通知 |
| scripting | 注入脚本 |

## 开发指南

### 本地开发
1. 修改代码
2. 在 `chrome://extensions/` 点击"重新加载"
3. 测试功能
4. 查看控制台错误

### 调试技巧
- **Popup 调试**: 右键点击插件图标 → 检查弹出内容
- **Background 调试**: 在扩展程序页面点击"Service Worker"
- **Content Script 调试**: 在目标网页按 F12 打开控制台
- **Storage 查看**: 在控制台使用 `chrome.storage.local.get()`

### 代码规范
- 使用 ES6+ 语法
- 添加详细注释
- 函数命名使用驼峰命名法
- 常量使用大写字母
- 保持代码简洁清晰

## 安全考虑

1. **密码存储**: 使用 Chrome Storage API，数据加密存储
2. **CSP 合规**: 避免使用 inline script 和 eval
3. **权限最小化**: 只申请必要的权限
4. **域名限制**: 只在指定域名下运行
5. **输入验证**: 验证用户输入，防止注入攻击

## 性能优化

1. **懒加载**: 设置区域按需展开
2. **事件委托**: 减少事件监听器数量
3. **防抖节流**: 避免频繁操作
4. **缓存机制**: 缓存常用数据
5. **异步操作**: 使用 Promise 和 async/await

## 兼容性

- **Chrome**: 版本 88+
- **Edge**: 版本 88+（基于 Chromium）
- **Manifest**: V3

## 未来规划

- [ ] 支持更多浏览器（Firefox、Safari）
- [ ] 云同步配置
- [ ] 多账号管理
- [ ] 自定义主题
- [ ] 插件市场发布

---

**版本**: v1.3  
**最后更新**: 2024-03-03
