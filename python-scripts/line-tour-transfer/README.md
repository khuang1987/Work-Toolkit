# 巡线记录转移工具 (Line Tour Transfer Tool)

此工具用于自动从源 Excel 文件中提取巡线记录，并按规则转移到目标 Excel 文件中。

## 历史与迁移
- **原项目位置**: `_archive/20251124-巡线记录转移`
- **迁移日期**: 2026-01-27
- **核心脚本**: `src/line_tour_transfer.py` (原 `01_主程序/上周数据提取.py`)

## 快速开始

### 1. 环境配置
```bash
# 进入项目目录
cd python-scripts/line-tour-transfer

# 创建虚拟环境 (可选但推荐)
python -m venv .venv
.\.venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

### 2. 运行工具
```bash
python src/line_tour_transfer.py
```

## 配置说明
脚本目前使用硬编码路径（继承自原版本）：
- **源文件**: `FY26 Q4 各区域巡线记录（01.24-04.24）.xlsx`
- **目标文件**: `FY26 主管巡线记录.xlsx`

请确保你有脚本中引用的 OneDrive 文件夹访问权限。

## 注意事项
- 此工具需要本机安装 Excel，因为它使用 `win32com` 进行自动化操作。
- 运行脚本前请确保所有相关 Excel 文件已关闭，以避免冲突。

## 技术架构

### 执行流程
工具遵循三步流程：**提取 (Extract) -> 转换 (Transform) -> 加载 (Load)**。

```mermaid
graph TD
    Start([开始]) --> Extract[1. 数据提取]
    Extract -->|读取源Excel| SrcDB[("FY26 Q4 巡线记录")]
    Extract --> Filter{筛选逻辑}
    
    Filter -->|日期范围| LastWeek["锁定上周工作日(一-五)"]
    Filter -->|优先级| Select[筛选10条记录]
    Select -->|优先选5条| UserA["登记人: 纪磊"]
    Select -->|补足剩余| UserB["登记人: 其他"]
    
    Select --> Transform[2. 数据转换]
    Transform --> Format[字段标准化]
    Format -->|业务规则| StatusCheck{"检查正常?"}
    StatusCheck -->|正常| SetEmpty["P/D/C/A列 = N/A"]
    StatusCheck -->|异常| SetAction[自动填充整改措施]
    
    Format --> CSV[保存中间态 CSV]
    
    Format --> Load[3. 数据加载]
    Load --> TryCOM{"尝试 COM 自动化?"}
    
    TryCOM -->|是| Connect[连接 Excel 进程]
    Connect -->|成功| Append[追加到目标文件]
    Append --> TargetDB[("目标: 主管巡线记录")]
    
    Connect -->|失败| Fallback["降级方案: OpenPyXL"]
    Fallback --> CreateNew[创建全新 Excel 文件]
    
    Append --> End([结束])
    CreateNew --> End
```

### 逻辑详情

1.  **数据提取 (`获取上周工作日记录`)**:
    *   读取源文件的 "加工中心" 工作表。
    *   自动计算上一个工作周（周一至周五）的日期范围。
    *   筛选有效记录并应用选择策略：优先选择 "纪磊" 的记录（最多5条），然后从其他人员记录中补充，直到总数达到10条。

2.  **数据转换 (`保存待粘贴CSV`)**:
    *   标准化字段（日期格式、空值处理）。
    *   应用业务规则：如果 "检查正常" 列不是 "正常"，则自动在 P/D/C/A 列填充标准整改措辞。
    *   保存一份备份 CSV 到 `publish/待粘贴信息.csv`。

3.  **数据加载 (`写入Excel记录`)**:
    *   **首选方案 (COM)**：使用 `win32com` 控制真实的 Excel 实例。这可以完美保留目标文件中的现有逻辑、公式和格式，直接将数据追加到第一个空行。
    *   **备用方案 (OpenPyXL)**：如果 COM 失败（例如 Excel 崩溃或无响应），它会创建一个*新的*独立 Excel 文件包含数据，以防止数据丢失。
