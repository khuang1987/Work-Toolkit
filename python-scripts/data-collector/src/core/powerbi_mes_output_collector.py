"""
Power BI MES产出数据采集器
从 CMES_Product_Output_CZM_AWS Power BI 报表导出数据

功能：
1. 打开 Power BI 报表页面
2. 设置日期筛选器（当月第一天到最后一天）
3. 导出数据表为 Excel
4. 重命名并移动到目标目录

使用方法：
    python powerbi_mes_output_collector.py
    python powerbi_mes_output_collector.py --headless  # 无头模式
    python powerbi_mes_output_collector.py --debug     # 调试模式（暂停等待）
"""

import os
import sys
import shutil
import logging
from datetime import datetime, timedelta
from calendar import monthrange
from pathlib import Path
from typing import Optional
import time

from playwright.sync_api import sync_playwright, Page, TimeoutError as PlaywrightTimeout

# ============================================================
# 配置区域 - 根据实际情况修改
# ============================================================

# 报表配置 - 支持多个报表
REPORT_CONFIGS = {
    "CZM": {
        "url": "https://app.powerbi.com/groups/me/apps/82847a01-d062-4b7d-b20a-ae7c0bca81f9/reports/b2d4200e-3dfe-4943-b5c5-407ede537a74/ReportSection?experience=power-bi",
        "filename_format": "CMES_Product_Output_CZM_{month}.xlsx",
        "description": "CZM MES产出数据"
    },
    "CKH": {
        "url": "https://app.powerbi.com/groups/me/apps/a21ef31d-d5ae-44a9-954e-bd8c4a75922f/reports/3cc14cf6-4701-4a48-a180-082c36ae82f8/ReportSection?experience=power-bi",
        "filename_format": "CMES_Product_Output_CKH_{month}.xlsx",
        "description": "CKH MES产出数据"
    }
}

# 默认报表
DEFAULT_REPORT = "CZM"

# 目标目录
TARGET_DIR = r"C:\Users\huangk14\OneDrive - Medtronic PLC\CZ Production - 文档\General\POWER BI 数据源 V2\30-MES导出数据\CMES_Product_Output"

# 下载目录（临时）
SCRIPT_DIR = Path(__file__).parent
DOWNLOAD_DIR = SCRIPT_DIR / "downloads"

# 超时设置（秒）
PAGE_LOAD_TIMEOUT = 60
ELEMENT_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 120

# Edge 用户配置文件路径（使用已登录的配置，需要先关闭所有Edge窗口）
EDGE_USER_DATA_DIR = r"C:\Users\huangk14\AppData\Local\Microsoft\Edge\User Data"
EDGE_PROFILE = "Default"

# ============================================================
# 元素选择器
# ============================================================

SELECTORS = {
    # 日期筛选器 - 开始日期（左边框）- 使用 aria-label 定位
    "date_start_input": "input[aria-label^='开始日期']",
    
    # 日期筛选器 - 结束日期（右边框）- 使用 aria-label 定位
    "date_end_input": "input[aria-label^='结束日期']",
    
    # 数据表容器（用于hover触发工具栏显示）
    "table_container": "xpath=//visual-container-repeat/visual-container[5]//div[contains(@class,'visualContent')]",
    
    # 数据表右上角的 ... 按钮（更多选项）
    "table_menu_button": "button[data-testid='visual-more-options-btn']",
    
    # 导出数据 菜单项
    "export_data_menu": "button[data-testid='pbimenu-item.导出数据']",
    
    # 导出弹窗中的 导出 按钮
    "export_confirm_button": "button[data-testid='export-btn']",
    
    # 页面加载完成的标志元素 - 使用数据表的标题或内容
    "page_loaded_indicator": "text=CMES Product Output",
}

# ============================================================
# 日志配置
# ============================================================

def setup_logging(debug: bool = False):
    """配置日志"""
    level = logging.DEBUG if debug else logging.INFO
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(
                SCRIPT_DIR / f"collector_{datetime.now().strftime('%Y%m%d')}.log",
                encoding='utf-8'
            )
        ]
    )

# ============================================================
# 工具函数
# ============================================================

def get_current_month_range() -> tuple[str, str]:
    """
    获取数据抓取的日期范围
    为确保月末数据完整，抓取范围为：上月倒数第2天 ~ 本月最后一天
    后续ETL脚本中按DateEnteredStep去重即可
    """
    today = datetime.now()
    
    # 本月最后一天
    last_day = today.replace(day=monthrange(today.year, today.month)[1])
    
    # 上月倒数第2天（即上月的倒数第二天）
    first_of_current_month = today.replace(day=1)
    last_of_prev_month = first_of_current_month - timedelta(days=1)
    # 上月倒数第2天
    start_day = last_of_prev_month.replace(day=max(1, last_of_prev_month.day - 1))
    
    # 格式化为 yyyy/M/d（Power BI 要求的格式）
    return start_day.strftime("%Y/%m/%d"), last_day.strftime("%Y/%m/%d")


def get_recent_month_tasks(months: int, base_date: Optional[datetime] = None) -> list[tuple[int, int]]:
    if months <= 0:
        raise ValueError("months must be > 0")
    if base_date is None:
        base_date = datetime.now()

    start_year = base_date.year
    start_month = base_date.month

    tasks: list[tuple[int, int]] = []
    # 生成最近 months 个自然月（包含当前月），按从旧到新顺序导出
    for i in range(months - 1, -1, -1):
        total_month = (start_year * 12 + (start_month - 1)) - i
        y = total_month // 12
        m = (total_month % 12) + 1
        tasks.append((y, m))
    return tasks


def get_month_range(year: int, month: int) -> tuple[str, str]:
    if month < 1 or month > 12:
        raise ValueError(f"month must be 1..12, got {month}")

    last_day = datetime(year, month, monthrange(year, month)[1])

    if month == 1:
        prev_year, prev_month = year - 1, 12
    else:
        prev_year, prev_month = year, month - 1
    last_of_prev_month = datetime(prev_year, prev_month, monthrange(prev_year, prev_month)[1])
    start_day = last_of_prev_month.replace(day=max(1, last_of_prev_month.day - 1))

    return start_day.strftime("%Y/%m/%d"), last_day.strftime("%Y/%m/%d")


def get_output_filename(report_key: str, month_str: Optional[str] = None) -> str:
    """获取输出文件名（按月份命名）"""
    if month_str is None:
        month_str = datetime.now().strftime("%Y%m")
    filename_format = REPORT_CONFIGS[report_key]["filename_format"]
    return filename_format.format(month=month_str)


def get_output_target_dir(base_dir: str, report_key: str) -> str:
    return str(Path(base_dir) / report_key)


def wait_for_download(download_dir: Path, timeout: int = DOWNLOAD_TIMEOUT) -> Optional[Path]:
    """等待下载完成，返回下载的文件路径"""
    start_time = time.time()
    
    # 记录开始时的文件列表
    existing_files = set(download_dir.glob("*.xlsx"))
    
    while time.time() - start_time < timeout:
        current_files = set(download_dir.glob("*.xlsx"))
        new_files = current_files - existing_files
        
        if new_files:
            # 检查文件是否下载完成（没有 .crdownload 等临时文件）
            for f in new_files:
                if f.exists() and f.stat().st_size > 0:
                    # 等待一小段时间确保文件写入完成
                    time.sleep(1)
                    return f
        
        time.sleep(0.5)
    
    return None


def move_and_rename_file(source: Path, target_dir: str, new_name: str) -> Path:
    """移动并重命名文件"""
    target_path = Path(target_dir) / new_name
    
    # 确保目标目录存在
    target_path.parent.mkdir(parents=True, exist_ok=True)
    
    # 如果目标文件已存在，先删除
    if target_path.exists():
        target_path.unlink()
    
    shutil.move(str(source), str(target_path))
    return target_path

# ============================================================
# 主采集逻辑
# ============================================================

class PowerBIMESCollector:
    """Power BI MES 数据采集器"""
    
    def __init__(self, report_key: str = DEFAULT_REPORT, headless: bool = False, debug: bool = False):
        if report_key not in REPORT_CONFIGS:
            raise ValueError(f"无效的报表类型: {report_key}，可用选项: {list(REPORT_CONFIGS.keys())}")
        self.report_key = report_key
        self.report_config = REPORT_CONFIGS[report_key]
        self.headless = headless
        self.debug = debug
        self.page: Optional[Page] = None
        
    def collect(self, year: Optional[int] = None, month: Optional[int] = None, recent_months: Optional[int] = None) -> bool:
        """
        执行数据采集
        
        Returns:
            bool: 采集成功返回 True，失败返回 False
        """
        logging.info("=" * 60)
        logging.info("Power BI MES 数据采集开始")
        logging.info("=" * 60)
        
        # 确保下载目录存在
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        
        # 生成要导出的月份任务
        if recent_months is not None:
            tasks = get_recent_month_tasks(recent_months)
        elif year is None and month is None:
            today = datetime.now()
            tasks = [(today.year, today.month)]
        elif year is not None and month is None:
            tasks = [(year, m) for m in range(1, 13)]
        elif year is not None and month is not None:
            tasks = [(year, month)]
        else:
            raise ValueError("month is provided but year is None")

        with sync_playwright() as p:
            context = None
            try:
                # 1. 启动浏览器（使用已登录的用户配置）
                logging.info("启动 Edge 浏览器（使用已登录的用户配置）...")

                # 使用 launch_persistent_context 来复用已登录的会话
                context = p.chromium.launch_persistent_context(
                    user_data_dir=EDGE_USER_DATA_DIR,
                    channel="msedge",
                    headless=self.headless,
                    slow_mo=500 if self.debug else 0,
                    accept_downloads=True,
                    args=[f"--profile-directory={EDGE_PROFILE}"]
                )

                self.page = context.new_page()
                self.page.set_default_timeout(ELEMENT_TIMEOUT * 1000)

                # 2. 打开页面
                report_url = self.report_config["url"]
                logging.info(f"打开页面 [{self.report_key}]: {report_url}")
                self.page.goto(report_url, timeout=PAGE_LOAD_TIMEOUT * 1000)

                # 3. 检测页面是否成功加载
                if not self._check_page_loaded():
                    logging.error("页面加载失败或需要登录，请检查网络和权限")
                    if self.debug:
                        input("按 Enter 键继续...")
                    return False

                logging.info("页面加载成功")

                all_success = True
                for idx, (y, m) in enumerate(tasks):
                    month_str = f"{y}{m:02d}"
                    if len(tasks) > 1:
                        logging.info(f"[{idx + 1}/{len(tasks)}] 开始导出月份: {month_str}")

                    start_date, end_date = get_month_range(y, m)
                    logging.info(f"设置日期范围: {start_date} 至 {end_date}")

                    if not self._set_date_filter(start_date, end_date):
                        logging.error(f"设置日期筛选器失败: {month_str}")
                        all_success = False
                        continue

                    # 等待数据刷新
                    logging.info("等待数据刷新...")
                    time.sleep(3)

                    # 导出数据
                    logging.info("开始导出数据...")
                    downloaded_file = self._export_data()
                    if not downloaded_file:
                        logging.error(f"导出数据失败: {month_str}")
                        all_success = False
                        continue

                    logging.info(f"文件下载成功: {downloaded_file}")

                    new_filename = get_output_filename(self.report_key, month_str=month_str)
                    target_dir = get_output_target_dir(TARGET_DIR, self.report_key)
                    final_path = move_and_rename_file(downloaded_file, target_dir, new_filename)
                    logging.info(f"文件已移动到: {final_path}")

                    # 多月导出时，给页面一点缓冲避免 UI 状态残留
                    if len(tasks) > 1 and idx < len(tasks) - 1:
                        time.sleep(1)

                logging.info("=" * 60)
                logging.info("数据采集完成!")
                logging.info("=" * 60)
                return all_success

            except PlaywrightTimeout as e:
                logging.error(f"操作超时: {e}")
                return False
            except Exception as e:
                logging.exception(f"采集过程中发生错误: {e}")
                return False
            finally:
                if self.debug:
                    input("按 Enter 键关闭浏览器...")
                if context is not None:
                    context.close()
    
    def _check_page_loaded(self) -> bool:
        """检查页面是否成功加载"""
        try:
            # 等待页面加载指示器出现
            self.page.wait_for_selector(
                SELECTORS["page_loaded_indicator"],
                timeout=PAGE_LOAD_TIMEOUT * 1000
            )
            return True
        except PlaywrightTimeout:
            return False
    
    def _set_date_filter(self, start_date: str, end_date: str) -> bool:
        """设置日期筛选器"""
        try:
            # 先设置开始日期（左边框）
            logging.debug(f"设置开始日期: {start_date}")
            start_input = self.page.locator(SELECTORS["date_start_input"])
            start_input.click()
            start_input.fill("")  # 先清空
            start_input.fill(start_date)
            start_input.press("Escape")  # 关闭日历弹窗
            time.sleep(0.5)
            
            # 再设置结束日期（右边框）
            logging.debug(f"设置结束日期: {end_date}")
            end_input = self.page.locator(SELECTORS["date_end_input"])
            end_input.click()
            end_input.fill("")  # 先清空
            end_input.fill(end_date)
            end_input.press("Escape")  # 关闭日历弹窗
            time.sleep(0.5)
            
            # 点击页面空白处确保日历关闭
            self.page.click("body", position={"x": 10, "y": 10})
            time.sleep(1)
            
            return True
        except Exception as e:
            logging.error(f"设置日期筛选器失败: {e}")
            return False
    
    def _export_data(self) -> Optional[Path]:
        """导出数据表"""
        try:
            # 等待页面数据加载完成
            logging.debug("等待数据加载...")
            time.sleep(3)
            
            # 先用Playwright hover到表格上触发工具栏显示
            logging.debug("hover到数据表上触发工具栏显示...")
            table_visual = self.page.locator(".visual-tableEx").first
            table_visual.hover()
            time.sleep(1)
            
            # 使用JavaScript找到包含tableEx的表格，然后向上查找并点击更多选项按钮
            logging.debug("通过JavaScript定位数据表并点击更多选项按钮...")
            result = self.page.evaluate("""
                () => {
                    // 找到tableEx表格
                    const tableEx = document.querySelector('.visual-tableEx');
                    if (!tableEx) return 'tableEx not found';
                    
                    // 向上查找到visual-container标签
                    let vc = tableEx.closest('visual-container');
                    if (!vc) return 'visual-container not found';
                    
                    // 在visual-container中查找更多选项按钮
                    let btn = vc.querySelector('button[data-testid="visual-more-options-btn"]');
                    if (btn) {
                        btn.click();
                        return 'clicked in vc';
                    }
                    
                    // 如果没找到，向上查找父级visual-container-repeat
                    let vcRepeat = vc.closest('visual-container-repeat');
                    if (vcRepeat) {
                        // 找到包含当前vc的直接子visual-container
                        for (const child of vcRepeat.children) {
                            if (child.tagName === 'VISUAL-CONTAINER' && child.contains(tableEx)) {
                                btn = child.querySelector('button[data-testid="visual-more-options-btn"]');
                                if (btn) {
                                    btn.click();
                                    return 'clicked in vcRepeat child';
                                }
                            }
                        }
                    }
                    
                    // 最后尝试：在整个页面中找到所有更多选项按钮，点击离tableEx最近的那个
                    const allBtns = document.querySelectorAll('button[data-testid="visual-more-options-btn"]');
                    return 'button not found, total buttons: ' + allBtns.length;
                }
            """)
            logging.info(f"JavaScript执行结果: {result}")
            time.sleep(1)
            
            # 点击 导出数据 菜单项
            logging.debug("点击导出数据菜单...")
            self.page.click(SELECTORS["export_data_menu"])
            time.sleep(1)
            
            # 在弹出的导出选项页面，选择"具有当前布局的数据"
            logging.debug("选择导出类型: 具有当前布局的数据...")
            self.page.locator("text=具有当前布局的数据").click()
            time.sleep(0.5)
            
            # 点击导出按钮
            logging.debug("点击导出按钮...")
            
            # 设置下载监听
            with self.page.expect_download(timeout=DOWNLOAD_TIMEOUT * 1000) as download_info:
                self.page.click(SELECTORS["export_confirm_button"])
            
            download = download_info.value
            
            # 保存到下载目录
            download_path = DOWNLOAD_DIR / download.suggested_filename
            if download_path.exists():
                try:
                    download_path.unlink()
                except Exception:
                    pass
            download.save_as(str(download_path))
            
            return download_path
            
        except Exception as e:
            logging.error(f"导出数据失败: {e}")
            return None


# ============================================================
# 命令行入口
# ============================================================

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Power BI MES 数据采集器")
    parser.add_argument("--report", "-r", choices=list(REPORT_CONFIGS.keys()), default=DEFAULT_REPORT,
                        help=f"报表类型，可选: {list(REPORT_CONFIGS.keys())}，默认: {DEFAULT_REPORT}")
    parser.add_argument("--all", "-a", action="store_true", help="采集所有报表")
    parser.add_argument("--year", type=int, help="按年导出（会自动按月拆分导出该年的12个月）")
    parser.add_argument("--month", type=int, help="配合 --year 使用，仅导出指定月份（1-12）")
    parser.add_argument("--recent-months", type=int, help="导出最近N个月（包含当前月），例如 36")
    parser.add_argument("--headless", action="store_true", help="无头模式运行（不显示浏览器窗口）")
    parser.add_argument("--debug", action="store_true", help="调试模式（放慢操作，暂停等待）")
    args = parser.parse_args()

    if args.recent_months is not None:
        if args.recent_months <= 0:
            parser.error("--recent-months 必须大于 0")
        if args.year is not None or args.month is not None:
            parser.error("--recent-months 不能与 --year/--month 同时使用")

    if args.month is not None:
        if args.year is None:
            parser.error("--month 必须与 --year 一起使用")
        if args.month < 1 or args.month > 12:
            parser.error("--month 范围必须是 1-12")
    
    setup_logging(debug=args.debug)
    
    # 确定要采集的报表列表
    if args.all:
        reports_to_collect = list(REPORT_CONFIGS.keys())
    else:
        reports_to_collect = [args.report]
    
    all_success = True
    for report_key in reports_to_collect:
        logging.info(f"\n{'='*60}")
        logging.info(f"开始采集报表: {report_key} - {REPORT_CONFIGS[report_key]['description']}")
        logging.info(f"{'='*60}")
        
        collector = PowerBIMESCollector(report_key=report_key, headless=args.headless, debug=args.debug)
        success = collector.collect(year=args.year, month=args.month, recent_months=args.recent_months)
        
        if not success:
            all_success = False
            logging.error(f"报表 {report_key} 采集失败")
        
        # 如果还有其他报表要采集，等待一下
        if len(reports_to_collect) > 1 and report_key != reports_to_collect[-1]:
            logging.info("等待5秒后采集下一个报表...")
            time.sleep(5)
    
    sys.exit(0 if all_success else 1)


if __name__ == "__main__":
    main()
