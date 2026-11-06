# Windchill 签名文件批量下载：分析与假设

> 范围：综合包 `chrome-extensions/password-autofill` 内的 Windchill 助手。本文记录第一轮分析的结论、实现方式，以及必须用真实数据验证的假设。

## 1. 需求拆解

| 需求 | 实现 |
|---|---|
| 批量下载，通常只下载签名文件 | 检索结果面板「下载签名文件」：先分析、再勾选、后下载 |
| 图纸 / 工程文件 / 质量文件匹配规则可调 | 规则库（`windchillRules`），插件后台「Windchill 规则库」编辑 |
| 必要时加入 AI | 规则无法确定时的签名文件判断；根据检索样本建议规则 |
| Key 全插件共享，设置收纳 | 弹窗「⚙ 设置」：AI 接口 / Key / 开发者模式 / 插件后台入口 |

## 2. 「签名文件」的判定（规则可调）

Windchill 文档的内容有三类来源：主文件（`PrimaryContent`）、附件（`Attachments`）、CAD 主内容（`AllPrimaryContents`）。从 OData 返回里统一提取为 `{ role, id, fileName, mime, size, urls, format }`。

判定顺序（`wc_rules.js: planSigned`）：

1. **文件名命中签名关键词**（默认：签名 / 签字 / 会签 / signed / sign）且格式在允许范围（默认 PDF）→ 高可信，优先主文件。
2. 否则按兜底策略：`primary`（默认）= 主文件格式符合即可；`any` = 主文件或附件中第一个符合格式的；`none` = 只认文件名命中。
3. 接口没带内容明细但检索记录的主文件格式已知符合 → 低可信，按主文件尝试，下载时再验证。
4. 仍无结果 → 标记「无签名文件」，不勾选；开启 AI 辅助后可交给 AI 判断（AI 只能在已有文件清单里选，序号越界会被拒绝并自动纠正重试）。

默认勾选高 / 中可信项，低可信项需手动勾选。

## 3. 下载链路与风险

1. 候选地址（按顺序验证，首个通过即用）：接口给出的 `ContentURL` 等字段 → 由内容 ID + 文档 OID 构造的 `WindchillAuthGW/wt.content.ContentHttp/viewContent` → 主文件入口 `AttachmentsDownloadDirectionServlet/primary?oid=`。
2. 验证：content script 用当前登录态 `fetch`（`Range: bytes=0-1023`），读首块后立即中止；PDF 必须含 `%PDF`，其他格式拒绝 HTML 响应（登录页 / 报错页）。
3. 落盘：后台 `chrome.downloads.download`，`conflictAction: uniquify`，文件名 `Windchill/<日期_关键词>/<编号>_<名称>_V<版本>.<扩展名>`；后台只接受 Windchill 页面发起、同源地址、相对路径文件名。

## 4. 未验证假设（需要真实环境数据）

本轮没有 Windchill 登录态，以下按已知接口行为编写，需要用面板里的「导出分析」在真实页面确认：

| 假设 | 影响 | 验证方法 |
|---|---|---|
| `PrimaryContent` / `Attachments` 的元素包含 `FileName`、`ID`（`OR:wt.content.ApplicationData:…`） | 无文件名则无法按名称识别签名文件，会退回「按主文件格式」 | 导出分析 JSON，看 `candidates` 是否有 `fileName` |
| 内容对象可能带 `ContentURL` 等地址字段 | 有则优先使用；无则用构造地址 | 导出分析 JSON 的 `urlCandidates` |
| `viewContent` / `AttachmentsDownloadDirectionServlet` 入口可用 | 都不可用则全部显示「下载地址均不可用」 | 点开始下载后看逐条失败原因；可把验证关掉对比 |
| 签名文件是 PDF 且以文件名或「主文件为 PDF」体现 | 若签名体现在版本 / 状态 / 另一个对象上，需要新增规则维度 | 对比真实样本，在规则库里调整关键词和兜底策略 |

遇到失败时的调整顺序：导出分析 → 看 `candidates` 与 `urlCandidates` → 调规则库关键词 / 兜底 → 仍不行再按导出的地址格式补充候选构造。

## 5. 安全边界

- 只读 + 下载：不修改 Windchill 数据；认证只复用当前页面登录态。
- AI 请求只含编号、名称、文件名和格式，不含 Cookie、地址或账号；经过输入清洗（隐藏疑似密钥），每次调用写入插件后台 AI 对话记录。
- 规则库内容是普通字符串匹配（不执行用户输入的正则）。
