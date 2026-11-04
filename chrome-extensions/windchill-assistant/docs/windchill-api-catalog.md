# Windchill API 与页面结构目录

> 用途：为 Windchill 助手后续增加常用功能提供可复用的接口、字段和页面定位参考。
>
> 采集范围：当前登录的 Windchill 页面、原生高级搜索结果 DOM，以及扩展已经实际调用的同源 OData 请求。当前目录只记录只读检索，不保存 Cookie、Token、账号或密码。

## 1. 结论摘要

当前扩展使用两条互补路径：

1. 通过同源 OData 获取结构化数据，用于数量汇总、分类和格式判断。
2. 通过 Windchill 自带的高级搜索和结果列表展示数据，避免在浮层中复制一套结果页面。

当前页面实测确认的检索逻辑：

- 图纸：名称包含关键词、主文件格式为 PDF、编号和名称开头不带业务前缀；Windchill 图纸/CAD 图标作为辅助证据，不作为硬性排除条件。
- 工程文件：编号或名称带 `MG` / `PS` 前缀。
- 质量文件：编号或名称带 `PII` 前缀。
- 文件格式支持多选：PDF、DWG、Word、Excel、PPT、压缩包。
- 原生结果列表可以使用“在表格中搜索”输入框继续缩小结果；当前页面的稳定 ID 是 `wt.doc.WTDocument.defaultSearchView.searchInListTextBox`。

## 2. 同源 OData 接口表

### 2.1 基础约定

| 项目 | 当前确认值 | 说明 |
|---|---|---|
| 服务根路径 | `/Windchill/servlet/odata/` | 必须拼接当前 Windchill 页面 origin，不能写死协议或端口 |
| 请求方式 | `GET` | 当前扩展只读查询 |
| 登录态 | `credentials: include` | 复用当前浏览器登录态，不自行读取 Cookie |
| 请求头 | `Accept: application/json` | 返回 JSON 时使用 |
| 常见返回数组 | `value` | 扩展同时兼容 `value`、`items`、`data` 和直接数组 |
| 分页控制 | `$top` | 当前搜索使用 100，审批摘要使用 100；超过上限时需要补 `$skip` 或服务端分页 |
| 请求容错 | `AbortController` + `Promise.allSettled` | 单个分类接口 12 秒超时；关键词或筛选条件变化时取消上一轮查询；部分接口成功时保留可取得结果并提示不完整，全部失败才清空本轮结果 |
| 字符串转义 | 单引号替换为两个单引号 | 用于 OData `$filter`，避免关键词破坏查询表达式 |

### 2.2 已实际用于插件的接口

| 功能 | Endpoint | Method | 当前参数 | 关键返回对象 | 当前状态 |
|---|---|---:|---|---|---|
| Windchill 文档关键词检索 | `DocMgmt/Documents` | GET | `$filter=contains(Name,'关键词') or contains(Number,'关键词')`；`$expand=PrimaryContent,Attachments`；`$top=100` | 文档编号、名称、版本、状态、描述、上下文、主内容、附件 | 已用于数量汇总和业务分类 |
| 图纸名称包含检索 | `DocMgmt/Documents` | GET | `$filter=contains(Name,'关键词')`；`$expand=PrimaryContent,Attachments`；`$top=100` | 文档名称、编号、主文件信息 | 已用于图纸快捷筛选；原生结果行再按名称包含、主文件 PDF 和业务前缀复核 |
| CAD / DWG 检索 | `CADDocumentMgmt/CADDocuments` | GET | `$filter=contains(FileName,'关键词')`；`$expand=AllPrimaryContents`；`$top=100` | CAD 文件名、编号、名称、主内容 | 已用于 DWG 格式筛选 |
| 当前用户待审批任务 | `Workflow/WorkItems` | GET | `$filter=Status/Display eq 'Potential'`；`$expand=Activity,Subject,Owner,OriginalOwner`；`$top=100` | 活动、主题对象、状态、所有者、创建时间、截止时间、角色 | 已用于审批摘要数量 |

### 2.3 文档对象的可复用字段映射

Windchill 不同版本、对象类型和站点配置的字段可能不同。下表是当前扩展的兼容读取顺序，开发新功能时应沿用“多个候选字段 + 空值兜底”，不要只依赖一个字段名。

| 统一字段 | 当前候选字段 | 用途 |
|---|---|---|
| `identifier` | `Number` → `DocumentNumber` → `FileName` → `Name` | 结果去重、和原生结果行回配 |
| `number` | `Number` → `DocumentNumber` → `FileName` → `Name` | 文件号、前缀分类 |
| `title` | `Name` → `Title` → `FileName` → `name` → `title` | 名称包含匹配、显示标题 |
| `version` | `Version` → `VersionID` → `Revision` → `Iteration` | 版本、迭代和历史追踪 |
| `status` | `State` → `LifeCycleState` → `Status` → `ChangeStatus` | 生命周期和审批前置判断 |
| `description` | `Description` → `description` | 详情摘要、辅助关键词检索 |
| `context` | `Context` → `Folder` → `Organization` | 产品、文件夹和组织范围 |
| `format` | 主内容对象 + `Name` / `Title` / `FileName` / `Format` / `MimeType` / `ContentType` | PDF、DWG、Office 等格式过滤；不再从 `Attachments` 推断主文件格式 |
| `primaryContent` | `PrimaryContent` → `primaryContent` → `PrimaryContentInfo` → `primaryContentInfo` → `Content` → `content` | 获取文件格式、内容链接和后续单文件打开能力 |
| `attachments` | `Attachments` | 附件数量、附件列表和关联文件功能 |

推荐的内部统一对象：

```js
{
  identifier,
  number,
  title,
  version,
  status,
  description,
  context,
  category: 'drawing' | 'engineering' | 'quality' | 'other',
  format: 'pdf' | 'dwg' | 'word' | 'excel' | 'ppt' | 'archive' | 'other',
  isPdf,
  sourceEndpoint,
  raw
}
```

`raw` 只应保存在当前内存请求中，不要写入扩展存储，防止把页面对象或敏感上下文长期落盘。

### 2.4 审批任务字段映射

| 统一字段 | 当前候选字段 | 关联对象 |
|---|---|---|
| `title` | `Activity.Name` → `Activity.Title` → `WorkItem.Name` → `WorkItem.Subject` | 当前审批活动 |
| `number` | `Subject.Number` → `Subject.Name` → `Subject.Title` → `WorkItem.Number` | 被审批对象 |
| `version` | `Subject.Version` → `Subject.VersionID` → `Subject.Revision` | 被审批对象版本 |
| `status` | `Status` → `State` → `StatusDisplay` | 任务状态 |
| `owner` | `OriginalOwner` → `Owner` | 责任人 |
| `initiator` | `CreatedBy` → `Initiator` → `OriginalOwner` | 发起人 |
| `deadline` | `Deadline` → `DueDate` → `DeadlineDate` | 截止日期 |
| `created` | `CreatedOn` → `CreateTimestamp` → `StartTime` | 创建或开始时间 |
| `role` | `Role` → `RoleDisplay` | 当前任务角色 |

## 3. Windchill 原生高级搜索结构表

这些不是 REST Endpoint，而是当前页面中可以稳定复用的原生表单入口。优先通过页面自身的搜索逻辑提交，让 Windchill 处理权限、上下文和结果分页。

| 区域 | 定位方式 | 当前确认用途 |
|---|---|---|
| 高级搜索容器 | `#advancedSearchCompDiv` | 判断高级搜索表单是否已经加载 |
| 关键字 | `#keywordkeywordField_SearchTextBox` | 提交文件号、文件名或关键词 |
| 所有类型 | `#wt.fc.Persistable` | 无业务/格式筛选时使用 |
| 文档类型 | `#wt.doc.WTDocument` | 图纸、工程文件、质量文件和 Office 文档 |
| CAD 类型 | `#WCTYPE\|wt.epm.EPMDocument\|com.libeier.DefaultEPMDocument` | DWG / CAD 结果 |
| 上下文 | `#all_contexts` | 当前验证页面的“所有上下文”选项 |
| 编号条件行 | `#qBAttributeTD-2` 的父行 | 可读取属性条件；当前扩展主动留空，避免“=”造成图纸漏检 |
| 名称条件行 | `#qBAttributeTD-1` | 可作为后续“名称包含”原生条件入口 |
| 搜索按钮 | `#searchButtonDiv button` | 提交高级搜索 |
| 结果容器 | `#searchResultTableDiv` | 判断结果区是否出现 |
| 结果数据行 | `.x-grid3-body > .x-grid3-row` | 当前 Windchill Ext 网格的真实结果行 |
| 结果列表内搜索 | `#wt.doc.WTDocument.defaultSearchView.searchInListTextBox` | 对原生结果列表做第二次快速缩小 |
| 结果汇总 | 结果区文本中的 `共 xx 个对象` | Windchill 原生总数 |

结果表通常是异步创建的，且业务类型/文件格式图标可能晚于数据行插入。扩展在结果容器出现后绑定局部 `MutationObserver`，先补写“在表格中搜索”，再按编号、名称、类型图标和主文件格式做行级回配；关键词或筛选条件变化时会取消上一轮仍在进行的 OData 请求，避免旧响应覆盖新结果。

### 3.1 当前结果表字段

| 结果字段 | 当前页面线索 | 用途 |
|---|---|---|
| 编号 | `td` class 中包含 `-td-number`，通常有详情链接 | 与 OData 统一对象按编号回配 |
| 名称 | `td` class 中包含 `-td-name` 或 `data-column="name"` | 图纸名称包含关键词判断 |
| 格式 | `td` class 中包含 `-td-formatIcon`，或单元格内图片/提示信息 | 判断 PDF、DWG、Office 等格式 |
| 详情链接 | 结果行中的 `a[href]` | 打开文档详情页 |
| 主内容下载/打开线索 | `/Windchill/servlet/AttachmentsDownloadDirectionServlet/primary?oid=...` | 后续单文件打开或详情操作；当前未实现批量下载 |

当前页面见到的格式识别线索包括：`file_pdf.gif`、`file_dwg.gif`、`file_msword.gif`、`file_excel.gif`、`file_generic.gif`，以及链接地址或提示文本中的 `.pdf`、`.dwg`、`.xlsb`、Word、Excel 等信息。不同站点可能更换图标文件名，因此新功能应同时读取文本、`src`、`alt`、`title`、`data-qtip` 和链接地址。

## 4. 文档详情页结构表

| 功能 | 当前页面线索 | 可做的功能 |
|---|---|---|
| 对象身份 | `#infoPageIdentityDisplayText` | 展示编号、名称、版本和对象类型 |
| 格式名称 | 当前页面标签“格式名称:”对应的动态 ID 字段 | 可靠确认主文件是不是 PDF |
| 可视化链接 | ID 以 `viewVizPV:IconLink:External_Drawing_` 开头 | 打开 Windchill 可视化预览或外部图纸 |
| 名称 | ID 以 `name` 开头的字段 | 详情名称、关联名称检索 |
| 上下文 | ID 以 `containerReference` 开头的字段 | 所属产品/上下文 |
| 文件夹 | ID 以 `folder.id` 开头的字段 | 文件夹导航、范围过滤 |
| 内容页签 | 页面中的“内容”页签 | 主文件、附件和格式详情 |
| 结构/关联页签 | “结构”“相关对象”等页签 | 结构、关联文件、变更和追溯能力 |

当前审批详情页还可以直接读取 WorkItem 模板表格中的以下字段：`指示`、`进程`、`进程启动者`、`工作负责人`、`角色`、`优先级`、`最后期限`、`主题`。其中“主题”链接可以跳转到被审批的 ECN/文档对象。

当前实测的 ECN 主题对象详情页可以读取：`说明`、`格式名称`、`状态`、`状况`、`上下文`、`位置`、`名称`、`修改者`、`上次修改时间`、`创建者`、`创建时间`、`记录类型`。因此审批摘要可以给出页面级重点说明；如果具体改动只存在于 Excel、Word 或其他主文件内部，仍应通过主题对象页的内容入口查看原文件，不能仅凭审批任务字段臆测文件差异。

审批增强卡片插入位置：WorkItem 页面稳定容器 `#infoPageinfoPanelID` 的顶部，并与 ID 包含 `workitemtaskFormTemplate` 的原生任务表单组成左右布局。左侧保留 Windchill 的审批、账号密码和附加验证控件，右侧用蓝色只读容器展示主题信息，并保留“主题”原生链接；不覆盖 Windchill 的“批准”“驳回”“保存”“完成任务”或附加验证字段。

审批数据流：优先在首页/任务列表页读取原生任务表并写入当前会话缓存；通过任务链接进入 WorkItem 详情页时只复用缓存，不再次请求待审批列表，也不依赖详情页是否存在任务表格。这样可以避免详情页的 OData 导航对象缺少标题时覆盖首页已补齐的主题信息。

详情页的部分 ID 会随对象和页面加载变化，后续实现应优先按可见标签、`aria-label`、ID 前缀和当前对象链接定位，不要把动态后缀写死。

## 5. 安全和兼容边界

| 项目 | 约束 |
|---|---|
| 认证 | 只复用当前页面登录态；不读取、不导出 Cookie、Authorization 或密码 |
| 权限 | OData 和原生页面都必须服从当前用户权限；数量与结果不应绕过 Windchill 权限 |
| 数据范围 | 当前查询默认受 Windchill 原生上下文控制；后续增加产品/文件夹范围时要显式显示范围 |
| 分页 | `$top=50/100` 不是全量保证；需要全量统计时应支持服务端分页和“结果是否完整”标记 |
| 版本差异 | Windchill 版本、语言包和站点定制可能改变字段、图标和 DOM；新功能先做页面探测再启用 |
| 写操作 | 审批、改状态、下载、签出/签入、修改属性等均应单独确认，不与只读查询混合执行 |
| 当前限制 | 当前环境可读取页面 DOM 和扩展请求定义；原始网络响应字段仍需在允许的页面调试/网络观测环境中逐项验证 |

## 6. 后续插件功能建议

按“收益高、风险低、复用当前结构”的顺序建议如下：

| 优先级 | 功能 | 复用的数据/页面 | 说明 |
|---|---|---|---|
| P0 | 文档详情摘要 | `DocMgmt/Documents` + 详情页 | 编号、名称、版本、状态、上下文、主文件格式一键查看 |
| P0 | 主文件与附件清单 | `PrimaryContent`、`Attachments` + 内容页签 | 显示 PDF/DWG/Office 附件数量，提供逐个打开入口 |
| P0 | 保存搜索条件 | 当前关键词、业务标签、格式、上下文 | 保存“某类图纸”“PII PDF”等常用查询，避免重复设置 |
| P1 | 版本/状态对比 | 文档版本字段、历史/相关对象页签 | 提醒当前版本、最新版本和生命周期状态差异 |
| P1 | 结构与关联对象导航 | “结构”“相关对象”页签 | 从图纸跳到工程文件、质量文件、变更对象和父子结构 |
| P1 | 待审批任务列表 | `Workflow/WorkItems` | 在保留数量汇总的基础上，按截止日期、对象号和活动筛选 |
| P1 | 当前上下文快捷检索 | `Context`、`containerReference`、`folder.id` | 从当前产品/文件夹自动带入搜索范围 |
| P2 | Where-used / 反查 | 结构和相关对象接口/页面 | 查询某个零件、图纸或文档被哪些对象引用 |
| P2 | 变更追踪 | 变更对象、版本、状态、时间字段 | 按对象号查看最近变更和受影响文件 |
| P2 | 单文件打开助手 | 主内容链接、可视化链接 | 只提供单文件打开/预览，保持当前已删除批量下载的范围 |
| P2 | 搜索诊断 | 请求状态、原生结果数、筛选后数量 | 解释“原生结果 xx 条、当前格式筛选 xx 条”，便于排查权限和分页差异 |
| P3 | 受控写操作 | 审批、签出/签入、属性修改 | 需要逐项确认、权限检查和操作审计，不建议直接默认开启 |

## 7. 建议的后续开发顺序

1. 先补齐 OData 原始响应的字段探测和分页标记，建立版本兼容日志。
2. 增加“搜索条件保存”和“当前上下文”两个只读/本地功能。
3. 增加详情摘要、主文件/附件清单和可视化打开。
4. 再接入版本、结构、相关对象和 Where-used。
5. 最后单独设计审批、签出/签入等写操作，并为每个动作增加明确确认。

这份目录应作为新增 Windchill 功能的入口文档；每接入一个接口，都补充真实请求参数、返回样例字段、分页行为、权限表现和 Windchill 版本信息。
