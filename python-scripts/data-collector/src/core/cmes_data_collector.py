"""
CMES 数据采集器

从 Power BI 报表导出 CMES MES 产出数据。
支持从 CSV 配置文件读取多个 URL，逐个下载并保存到指定位置。

功能：
1. 从 CSV 配置文件读取报表 URL 列表
2. 打开 Power BI 报表页面
3. 设置日期筛选器（当月范围）
4. 导出数据表为 Excel
5. 重命名并移动到目标目录

使用方法：
    from core.cmes_data_collector import collect_cmes_data
    collect_cmes_data(callback=print)
"""

import os
import sys
import shutil
import logging
import time
import csv
from datetime import datetime, timedelta
from calendar import monthrange
from pathlib import Path
from typing import Optional, Callable, List, Dict
import pandas as pd

from utils.playwright_manager import PlaywrightManager
from utils.task_lock_manager import (
    acquire_task_lock, release_task_lock, is_task_locked,
    is_interrupted, check_interrupt, InterruptedError
)


# ============================================================
# 配置
# ============================================================

# 默认超时设置（秒）
PAGE_LOAD_TIMEOUT = 60
ELEMENT_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 600  # 10分钟，年度数据量大需要更长时间
EXPORT_CHECK_INTERVAL = 5  # 检查导出状态的间隔（秒）
MAX_EXPORT_WAIT = 600  # 最大等待导出完成时间（秒）

# 元素选择器
SELECTORS = {
    # 日期筛选器 - 开始日期
    "date_start_input": "input[aria-label^='开始日期']",
    # 日期筛选器 - 结束日期
    "date_end_input": "input[aria-label^='结束日期']",
    # 数据表容器
    "table_visual": ".visual-tableEx",
    # 更多选项按钮
    "table_menu_button": "button[data-testid='visual-more-options-btn']",
    # 导出数据菜单项
    "export_data_menu": "button[data-testid='pbimenu-item.导出数据']",
    # 导出确认按钮
    "export_confirm_button": "button[data-testid='export-btn']",
    # 页面加载完成标志 - 使用通用选择器，兼容不同页面
    "page_loaded_indicator": ".visual-tableEx, text=CMES Product Output, text=WIP",
}


# ============================================================
# 工具函数
# ============================================================

def get_base_path() -> str:
    """获取项目根目录路径"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        current_dir = os.path.dirname(__file__)  # core目录
        src_dir = os.path.dirname(current_dir)   # src目录
        return os.path.dirname(src_dir)          # 项目根目录


def get_path_from_config(path_name: str) -> str:
    """从配置文件中获取路径"""
    base_path = get_base_path()
    config_path = os.path.join(base_path, 'config', 'path_config.csv')
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"配置文件不存在: {config_path}")
    df = pd.read_csv(config_path)
    path_value = df[df['path_name'] == path_name]['path_value'].values[0]
    resolved = path_value.replace('{username}', os.getlogin()).replace('{app_dir}', base_path)
    return os.path.normpath(resolved)


def get_cmes_config() -> List[Dict]:
    """
    从配置文件读取 CMES 报表配置
    
    Returns:
        List[Dict]: 报表配置列表
    """
    base_path = get_base_path()
    config_path = os.path.join(base_path, 'config', 'cmes_config.csv')
    
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"CMES 配置文件不存在: {config_path}")
    
    # 获取用户名用于变量替换
    try:
        username = os.getlogin()
    except Exception:
        username = os.environ.get('USERNAME', os.environ.get('USER', 'default'))
    
    # 获取默认目标文件夹
    try:
        default_folder = get_path_from_config('cmes_folder')
    except:
        default_folder = os.path.join(base_path, 'data', 'cmes')
    
    configs = []
    with open(config_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            report_name = row.get('name', '')
            filename_format = row.get('filename_format', 'CMES_{name}_{month}.xlsx')
            
            skip_date = row.get('skip_date_filter', 'false').lower() == 'true'

            # 区分报表类型：产出报表 vs WIP 报表
            is_output_report = (
                (report_name in ["CZM", "CKH"]) and
                ("CMES_Product_Output" in filename_format)
            )
            is_wip_report = (
                ("WIP" in report_name.upper()) or
                ("CMES_WIP" in filename_format.upper())
            )

            # 确定最终保存目录
            if is_output_report:
                # 1. 产出报表：优先从 path_config 获取 cmes_product_folder，没有则使用默认
                try:
                    resolved_target_folder = get_path_from_config('cmes_product_folder')
                except:
                    resolved_target_folder = str(Path(default_folder) / "CMES_Product_Output" / report_name)
                
                # 如果是基于全局配置的，还需要追加报表名作为子目录 (保持原有逻辑)
                if resolved_target_folder.lower().endswith("cmes_product_output"):
                    resolved_target_folder = str(Path(resolved_target_folder) / report_name)
                    
            elif is_wip_report:
                # 2. WIP 报表：优先从 path_config 获取 cmes_wip_folder
                try:
                    resolved_target_folder = get_path_from_config('cmes_wip_folder')
                except:
                    resolved_target_folder = str(Path(default_folder) / "CMES_WIP")
            else:
                # 3. 其他报表保存到默认 cmes 目录
                resolved_target_folder = default_folder

            configs.append({
                'name': report_name,
                'url': row.get('url', ''),
                'filename_format': filename_format,
                'description': row.get('description', ''),
                'target_folder': resolved_target_folder,
                'skip_date_filter': skip_date
            })
    
    return configs


def get_current_month_range() -> tuple[str, str]:
    """
    获取当前月的日期范围
    范围：当月1日 ~ 当月最后一天
    """
    today = datetime.now()
    first_day = today.replace(day=1)
    last_day = today.replace(day=monthrange(today.year, today.month)[1])
    return first_day.strftime("%Y/%m/%d"), last_day.strftime("%Y/%m/%d")


def get_month_range(year: int, month: int) -> tuple[str, str]:
    first_day = datetime(year, month, 1)
    last_day = datetime(year, month, monthrange(year, month)[1])
    return first_day.strftime("%Y/%m/%d"), last_day.strftime("%Y/%m/%d")


def get_quarter_period(dt: Optional[datetime] = None) -> str:
    if dt is None:
        dt = datetime.now()
    quarter = (dt.month - 1) // 3 + 1
    return f"{dt.year}Q{quarter}"


def get_quarter_range(year: int, quarter: int) -> tuple[str, str]:
    if quarter < 1 or quarter > 4:
        raise ValueError("quarter must be 1-4")
    start_month = (quarter - 1) * 3 + 1
    end_month = start_month + 2
    start_day = datetime(year, start_month, 1)
    end_day = datetime(year, end_month, monthrange(year, end_month)[1])
    return start_day.strftime("%Y/%m/%d"), end_day.strftime("%Y/%m/%d")


def get_previous_quarter_period(dt: Optional[datetime] = None) -> str:
    if dt is None:
        dt = datetime.now()
    quarter = (dt.month - 1) // 3 + 1
    if quarter == 1:
        return f"{dt.year - 1}Q4"
    return f"{dt.year}Q{quarter - 1}"


def get_recent_quarters(quarters: int, base_date: Optional[datetime] = None) -> List[str]:
    if quarters <= 0:
        raise ValueError("quarters must be > 0")
    if base_date is None:
        base_date = datetime.now()
    current_q = (base_date.month - 1) // 3 + 1
    current_idx = base_date.year * 4 + (current_q - 1)

    result: List[str] = []
    for i in range(quarters - 1, -1, -1):
        idx = current_idx - i
        y = idx // 4
        q = (idx % 4) + 1
        result.append(f"{y}Q{q}")
    return result


def get_recent_months(months: int, base_date: Optional[datetime] = None) -> List[str]:
    if months <= 0:
        raise ValueError("months must be > 0")
    if base_date is None:
        base_date = datetime.now()

    start_year = base_date.year
    start_month = base_date.month

    result: List[str] = []
    for i in range(months - 1, -1, -1):
        total_month = (start_year * 12 + (start_month - 1)) - i
        y = total_month // 12
        m = (total_month % 12) + 1
        result.append(f"{y}{m:02d}")
    return result





def get_existing_months(target_folder: str, filename_prefix: str) -> set[str]:
    existing: set[str] = set()
    target_path = Path(target_folder)
    if not target_path.exists():
        return existing

    import re
    pattern = re.compile(rf"^{re.escape(filename_prefix)}(\d{{6}})\.xlsx$", re.IGNORECASE)
    for fp in target_path.glob("*.xlsx"):
        m = pattern.match(fp.name)
        if m:
            existing.add(m.group(1))
    return existing


def get_existing_quarters(target_folder: str, filename_prefix: str) -> set[str]:
    existing: set[str] = set()
    target_path = Path(target_folder)
    if not target_path.exists():
        return existing

    import re
    pattern = re.compile(rf"^{re.escape(filename_prefix)}(\d{{4}}Q[1-4])\.xlsx$", re.IGNORECASE)
    for fp in target_path.glob("*.xlsx"):
        m = pattern.match(fp.name)
        if m:
            existing.add(m.group(1))
    return existing


def get_missing_months(target_folder: str, filename_prefix: str, months: int) -> List[str]:
    required = get_recent_months(months)
    existing = get_existing_months(target_folder, filename_prefix)
    return [m for m in required if m not in existing]


def get_missing_quarters(target_folder: str, filename_prefix: str, quarters: int) -> List[str]:
    required = get_recent_quarters(quarters)
    existing = get_existing_quarters(target_folder, filename_prefix)
    return [q for q in required if q not in existing]


def get_current_year_ytd_range() -> tuple[str, str]:
    """
    获取当前年累计的日期范围（年初到上月底）
    范围：1月1日 ~ 上月最后一天
    """
    today = datetime.now()
    first_day = today.replace(month=1, day=1)
    
    # 上月最后一天
    first_of_current_month = today.replace(day=1)
    last_of_prev_month = first_of_current_month - timedelta(days=1)
    
    return first_day.strftime("%Y/%m/%d"), last_of_prev_month.strftime("%Y/%m/%d")


def get_year_range(year: int) -> tuple[str, str]:
    """
    获取指定年份的完整日期范围
    范围：该年1月1日 ~ 次年1月1日
    """
    start_date = datetime(year, 1, 1)
    end_date = datetime(year + 1, 1, 1)
    return start_date.strftime("%Y/%m/%d"), end_date.strftime("%Y/%m/%d")


def get_output_filename(filename_format: str, name: str, period: str = None) -> str:
    """
    获取输出文件名
    
    Args:
        filename_format: 文件名格式模板
        name: 报表名称
        period: 时间周期标识（如 "202512" 或 "2024"）
    """
    if period is None:
        period = datetime.now().strftime("%Y%m")
    return filename_format.format(month=period, name=name)


def get_history_years(years_back: int = 3) -> List[int]:
    """获取需要检查的历史年份列表"""
    current_year = datetime.now().year
    return [current_year - i for i in range(1, years_back + 1)]


def get_previous_month_str() -> str:
    """获取上个月的 YYYYMM 字符串"""
    today = datetime.now()
    first_of_current_month = today.replace(day=1)
    last_of_prev_month = first_of_current_month - timedelta(days=1)
    return last_of_prev_month.strftime("%Y%m")


def cleanup_old_monthly_files(target_folder: str, name: str, filename_format: str, log_callback=None) -> List[str]:
    """
    清理旧的月度文件（跨月时删除上个月的文件）
    
    只保留当前月的文件，删除之前月份的 YYYYMM 格式文件
    
    Returns:
        List[str]: 被删除的文件列表
    """
    deleted_files = []
    today = datetime.now()
    current_month = today.strftime("%Y%m")
    current_year = str(today.year)
    
    target_path = Path(target_folder)
    if not target_path.exists():
        return deleted_files
    
    # 获取文件名模式（用于匹配）
    # 假设格式为 CMES_Product_Output_{name}_{month}.xlsx
    # 需要匹配 YYYYMM 格式的文件，但不匹配 YYYY 格式（年度文件）
    
    for filepath in target_path.glob("*.xlsx"):
        filename = filepath.name
        
        # 检查是否是该报表的文件
        if name not in filename:
            continue
        
        # 提取文件名中的时间标识
        # 尝试匹配 YYYYMM 格式（6位数字）
        import re
        match = re.search(r'_(\d{6})\.xlsx$', filename)
        if match:
            file_month = match.group(1)
            # 如果不是当前月，且是同一年或去年的月度文件，删除
            if file_month != current_month:
                try:
                    filepath.unlink()
                    deleted_files.append(filename)
                    if log_callback:
                        log_callback(f"🗑️ 已删除旧月度文件: {filename}")
                except Exception as e:
                    if log_callback:
                        log_callback(f"⚠️ 删除文件失败 {filename}: {e}")
    
    return deleted_files


def check_missing_files(target_folder: str, name: str, filename_format: str, years_back: int = 3) -> Dict:
    """
    检查缺失的文件
    
    Returns:
        Dict: {
            'missing_years': [2022, 2023, ...],  # 缺失的历史年份
            'need_ytd_update': bool,  # 是否需要更新当前年累计
            'current_month': str  # 当前月标识
        }
    """
    today = datetime.now()
    current_year = today.year
    current_month = today.strftime("%Y%m")
    
    missing_years = []
    
    # 检查历史年份文件
    for year in get_history_years(years_back):
        filename = get_output_filename(filename_format, name, str(year))
        filepath = Path(target_folder) / filename
        if not filepath.exists():
            missing_years.append(year)
    
    # 检查当前年累计文件是否需要更新
    # 规则：跨月时需要更新（通过检查文件修改时间判断）
    ytd_filename = get_output_filename(filename_format, name, str(current_year))
    ytd_filepath = Path(target_folder) / ytd_filename
    need_ytd_update = False
    
    if not ytd_filepath.exists():
        need_ytd_update = True
    else:
        # 检查文件修改时间是否在本月
        mtime = datetime.fromtimestamp(ytd_filepath.stat().st_mtime)
        if mtime.month != today.month or mtime.year != today.year:
            need_ytd_update = True
    
    return {
        'missing_years': sorted(missing_years),
        'need_ytd_update': need_ytd_update,
        'current_month': current_month
    }


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
# CMES 数据采集器
# ============================================================

class CMESDataCollector:
    """CMES 数据采集器"""
    
    def __init__(
        self,
        config: Dict,
        headless: bool = False,
        debug: bool = False,
        log_callback: Optional[Callable[[str], None]] = None,
        browser_type: str = "chrome"
    ):
        """
        初始化采集器
        
        Args:
            config: 报表配置字典
            headless: 是否使用无头模式
            debug: 是否启用调试模式
            log_callback: 日志回调函数
            browser_type: 浏览器类型 ("chrome" 或 "edge")
        """
        self.config = config
        self.headless = headless
        self.debug = debug
        self.log_callback = log_callback
        self.browser_type = browser_type
        self.download_dir = Path(get_base_path()) / "data" / "downloads"
        
    def _log(self, message: str, to_gui: bool = False):
        """输出日志
        
        Args:
            message: 日志消息
            to_gui: 是否输出到 GUI（默认只输出到控制台）
        """
        print(message)  # 始终输出到控制台
        if to_gui and self.log_callback:
            self.log_callback(message)
    
    def collect(self, start_date: str = None, end_date: str = None, output_period: str = None) -> bool:
        """
        执行数据采集
        
        Args:
            start_date: 开始日期（格式：YYYY/MM/DD），None 则使用当前月
            end_date: 结束日期（格式：YYYY/MM/DD），None 则使用当前月
            output_period: 输出文件的时间标识（如 "202512" 或 "2024"），None 则使用当前月
        
        Returns:
            bool: 采集成功返回 True，失败返回 False
        """
        # 检查是否跳过日期筛选
        skip_date_filter = self.config.get('skip_date_filter', False)
        
        # 如果未指定日期范围且不跳过日期筛选，使用当前月
        if not skip_date_filter and (start_date is None or end_date is None):
            start_date, end_date = get_current_month_range()
        
        if output_period is None:
            output_period = datetime.now().strftime("%Y%m")
        
        self._log(f"开始采集: {self.config['name']}", to_gui=False)
        if not skip_date_filter:
            self._log(f"日期范围: {start_date} ~ {end_date}", to_gui=False)
        
        # 确保下载目录存在
        self.download_dir.mkdir(parents=True, exist_ok=True)
        
        manager = None
        try:
            # 创建 Playwright 管理器
            manager = PlaywrightManager(
                headless=self.headless,
                slow_mo=500 if self.debug else 0,
                use_user_profile=True,
                callback=self.log_callback,
                browser_type=self.browser_type
            )
            manager.start()
            
            # 创建页面
            page = manager.new_page()
            page.set_default_timeout(ELEMENT_TIMEOUT * 1000)
            
            # 打开页面 - 使用 domcontentloaded 策略，更快且更可靠
            report_url = self.config['url']
            try:
                page.goto(report_url, timeout=PAGE_LOAD_TIMEOUT * 1000, wait_until="domcontentloaded")
            except Exception as e:
                self._log(f"⚠️ 页面加载超时，尝试继续: {str(e)}")
                # 即使超时也继续，可能页面已经部分加载
            
            # 检测页面是否成功加载
            if not self._check_page_loaded(page):
                self._log("❌ 页面加载失败或需要登录", to_gui=True)
                return False
            
            # 设置日期筛选器（如果不跳过）
            if not skip_date_filter:
                
                if not self._set_date_filter(page, start_date, end_date):
                    self._log("❌ 设置日期筛选器失败", to_gui=True)
                    return False
                
                # 等待数据刷新 - 等待加载指示器消失或数据表格更新
                # 等待数据刷新 - 不使用 networkidle (可能导致无谓等待)，直接短时间等待
                # Power BI 响应日期变化通常很快
                time.sleep(2)
            
            # 导出数据
            downloaded_file = self._export_data(page)
            
            if not downloaded_file:
                self._log("❌ 导出数据失败", to_gui=True)
                return False
            
            
            # 移动并重命名文件
            new_filename = get_output_filename(
                self.config['filename_format'],
                self.config['name'],
                output_period
            )
            target_dir = self.config['target_folder']
            if not target_dir:
                target_dir = str(self.download_dir)
            
            final_path = move_and_rename_file(downloaded_file, target_dir, new_filename)
            self._log(f"✅ 导出成功: {new_filename}", to_gui=True)
            
            return True
            
        except Exception as e:
            self._log(f"❌ 采集过程中发生错误: {e}", to_gui=True)
            return False
        finally:
            if manager:
                manager.close()
    
    def _check_page_loaded(self, page) -> bool:
        """检查页面是否成功加载，如果需要登录则自动登录"""
        max_attempts = 5
        login_attempted = False
        
        for attempt in range(max_attempts):
            try:
                # 先检查是否需要登录
                login_result = self._try_auto_login(page)
                if login_result:
                    self._log("✅ 自动登录成功，等待页面跳转...")
                    login_attempted = True
                    # 登录后等待页面跳转和加载
                    time.sleep(5)
                
                # 如果检测到还在登录页面（且自动登录未生效或未尝试），不要等待报表加载
                current_url = page.url.lower()
                is_login_page_now = any(domain in current_url for domain in [
                    'login.microsoftonline.com', 'login.live.com', 'login.windows.net', 'microsoftonline.com'
                ])
                if is_login_page_now:
                    self._log(f"仍在登录页面 (尝试 {attempt + 1}/{max_attempts})，跳过报表加载检查...")
                    time.sleep(2)
                    continue

                # 检查页面是否加载完成 - 使用多个选择器
                page_loaded = False
                load_indicators = [
                    ".visual-tableEx",  # 数据表格
                    "div[class*='visualContainer']",  # Power BI 可视化容器
                    "div[class*='report']",  # 报表容器
                ]
                
                for indicator in load_indicators:
                    try:
                        self._log(f"等待页面加载... {indicator}")
                        page.wait_for_selector(indicator, timeout=10000)
                        self._log(f"✅ 页面加载完成 (检测到: {indicator})")
                        page_loaded = True
                        break
                    except:
                        continue
                
                if page_loaded:
                    # 额外等待确保数据加载
                    time.sleep(2)
                    return True
                
                # 如果没有检测到，继续重试
                if attempt < max_attempts - 1:
                    self._log(f"页面加载检测中... ({attempt + 1}/{max_attempts})")
                    time.sleep(3)
                    
            except Exception as e:
                if attempt < max_attempts - 1:
                    self._log(f"页面加载检测失败，重试 ({attempt + 1}/{max_attempts}): {e}")
                    time.sleep(3)
                else:
                    self._log(f"页面加载失败: {e}")
                    return False
        
        self._log("❌ 页面加载超时", to_gui=True)
        return False
    
    def _try_auto_login(self, page) -> bool:
        """尝试自动登录（如果检测到登录页面）"""
        try:
            # 首先检查当前 URL 是否是 Microsoft 登录页面
            current_url = page.url.lower()
            is_login_page = any(domain in current_url for domain in [
                'login.microsoftonline.com',
                'login.live.com',
                'login.windows.net',
                'microsoftonline.com'
            ])
            
            if not is_login_page:
                return False
            
            self._log("探测到 Microsoft 登录/验证页面...")
            
            # 1. 优先尝试“选取账户”页面的账号磁贴
            # 使用更稳健的 aria-label 选择器 (包含 @medtronic.com)
            pick_account_selector = "div[aria-label*='@medtronic.com'], div[role='button']:has-text('@medtronic.com')"
            
            try:
                # 稍微等待磁贴出现
                element = page.wait_for_selector(pick_account_selector, timeout=2000)
                if element:
                    self._log("🔥 发现已保存的公司账号磁贴，立即点击...")
                    element.click()
                    return True
            except:
                pass
            
            # 2. 尝试输入框页面 (Email/Password) 或 “下一步/登录” 按钮
            # 使用诊断中发现的 ID (idSIButton9 是微软通用的下一步/登录按钮 ID)
            login_selectors = [
                "input#idSIButton9",                   # 微软通用“下一步”或“登录”按钮
                "input[type='submit'][value='登录']",
                "input[type='submit'][value='Sign in']",
                "input[type='submit'][id='idSIButton9']",
                "div.table-row:has-text('@medtronic.com')",
                "input[type='submit'][value='Next']",
                "input[type='submit'][value='下一步']",
            ]
            
            for selector in login_selectors:
                try:
                    element = page.locator(selector).first
                    if element.is_visible(timeout=500):
                        self._log(f"发现登录交互元素 ({selector})，点击...")
                        element.click()
                        time.sleep(1)
                        return True
                except:
                    continue
            
            return False
        except Exception as e:
            self._log(f"自动登录检测失败: {e}")
            return False
    
    def _set_date_filter(self, page, start_date: str, end_date: str) -> bool:
        """设置日期筛选器"""
        try:
            def _apply_dates(sd: str, ed: str) -> bool:
                start_input = page.locator(SELECTORS["date_start_input"])
                end_input = page.locator(SELECTORS["date_end_input"])

                def _digits(s: str) -> str:
                    return "".join(ch for ch in s if ch.isdigit())

                def _set_one(locator, value: str) -> None:
                    # 快速路径：JS 直接写入，不做 click/选中动作（避免触发日期选择器）
                    try:
                        locator.evaluate(
                            """(el, v) => {
                                el.value = v;
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                if (typeof el.blur === 'function') el.blur();
                            }"""
                            ,
                            value,
                        )
                        time.sleep(0.15)
                        return
                    except Exception:
                        pass

                    # 备用：fill（可能会 focus，但比手动 click/选中更少动作）
                    locator.fill(value)
                    time.sleep(0.15)

                expected_sd = _digits(sd)
                expected_ed = _digits(ed)

                _set_one(start_input, sd)
                _set_one(end_input, ed)

                try:
                    current_sd = start_input.input_value().strip()
                    current_ed = end_input.input_value().strip()
                    if expected_sd and expected_sd in _digits(current_sd) and expected_ed and expected_ed in _digits(current_ed):
                        return True
                except Exception:
                    return True

                return False

            if _apply_dates(start_date, end_date):
                return True

            start_date_alt = start_date.replace("/", "-")
            end_date_alt = end_date.replace("/", "-")
            if _apply_dates(start_date_alt, end_date_alt):
                return True

            self._log(f"⚠️ 日期筛选器未确认生效: {start_date} ~ {end_date}")
            return False
        except Exception as e:
            self._log(f"设置日期筛选器失败: {e}")
            return False
    
    def _export_data(self, page) -> Optional[Path]:
        """导出数据表"""
        try:
            # 等待页面数据加载完成
            time.sleep(1)
            
            # hover 到表格上触发工具栏显示
            table_visual = page.locator(SELECTORS["table_visual"]).first
            table_visual.hover()
            time.sleep(1)
            
            # 通过 JavaScript 定位并点击更多选项按钮
            result = page.evaluate("""
                () => {
                    const tableEx = document.querySelector('.visual-tableEx');
                    if (!tableEx) return 'tableEx not found';
                    
                    let vc = tableEx.closest('visual-container');
                    if (!vc) return 'visual-container not found';
                    
                    let btn = vc.querySelector('button[data-testid="visual-more-options-btn"]');
                    if (btn) {
                        btn.click();
                        return 'clicked';
                    }
                    
                    return 'button not found';
                }
            """)
            
            if result != 'clicked':
                self._log(f"点击更多选项按钮失败: {result}")
                return None
            
            time.sleep(1)
            
            # 点击导出数据菜单
            page.click(SELECTORS["export_data_menu"])
            time.sleep(1)
            
            # 选择导出类型
            page.locator("text=具有当前布局的数据").click()
            time.sleep(0.5)
            
            # 点击导出按钮并等待下载
            with page.expect_download(timeout=DOWNLOAD_TIMEOUT * 1000) as download_info:
                page.click(SELECTORS["export_confirm_button"])
                
                # 等待导出完成，检测"正在导出数据"提示
                self._wait_for_export_complete(page)
            
            download = download_info.value
            
            # 保存到下载目录
            download_path = self.download_dir / download.suggested_filename
            download.save_as(str(download_path))
            
            return download_path
            
        except Exception as e:
            self._log(f"导出数据失败: {e}")
            return None
    
    def _wait_for_export_complete(self, page):
        """等待导出完成，检测"正在导出数据"提示消失"""
        start_time = time.time()
        exporting_detected = False
        
        while time.time() - start_time < MAX_EXPORT_WAIT:
            try:
                # 检查是否存在"正在导出数据"提示
                exporting_toast = page.locator('h2.toastTitle:has-text("正在导出数据")')
                if exporting_toast.count() > 0:
                    if not exporting_detected:
                        self._log("检测到导出进行中，等待完成...")
                        exporting_detected = True
                    time.sleep(EXPORT_CHECK_INTERVAL)
                else:
                    if exporting_detected:
                        self._log("导出提示已消失，继续处理...")
                    break
            except:
                # 如果检测失败，继续等待
                time.sleep(EXPORT_CHECK_INTERVAL)
        
        elapsed = time.time() - start_time
        if elapsed > 10:
            self._log(f"导出等待时间: {elapsed:.1f} 秒")


# ============================================================
# 主函数
# ============================================================

def collect_cmes_data(
    callback: Optional[Callable[[str], None]] = None,
    headless: bool = False,
    report_names: Optional[List[str]] = None,
    years_back: int = 3,
    browser_type: str = "chrome"
) -> bool:
    """
    采集 CMES 数据（支持历史数据批量导出）
    
    导出逻辑：
    1. 检查历史年份文件是否缺失 → 缺失则补导
    2. 检查当前年累计文件是否需要更新（跨月更新）
    3. 每次都更新当前月文件
    
    Args:
        callback: 日志回调函数
        headless: 是否使用无头模式
        report_names: 要采集的报表名称列表，None 表示采集所有
        years_back: 检查历史数据的年数，默认3年
        
    Returns:
        bool: 全部成功返回 True
    """
    # 检查任务锁
    task_name = "CMES数据采集"
    if is_task_locked(task_name):
        if callback:
            callback(f"⚠️ {task_name}任务正在执行中，请等待当前任务完成")
        return False
    
    if not acquire_task_lock(task_name):
        if callback:
            callback(f"❌ 无法获取{task_name}任务锁")
        return False
    
    # 创建日志回调函数
    def log_callback(message: str):
        print(message)  # 输出到控制台
        if callback:
            callback(message)  # 输出到GUI
        else:
            try:
                from main import log_with_timestamp
                log_with_timestamp(message)
            except:
                pass
    
    try:
        log_callback("CMES 数据采集开始...")
        
        # 读取配置
        configs = get_cmes_config()
        
        if not configs:
            log_callback("❌ 未找到 CMES 配置")
            return False
        
        # 过滤要采集的报表
        if report_names:
            configs = [c for c in configs if c['name'] in report_names]
        
        if not configs:
            log_callback("❌ 未找到匹配的报表配置")
            return False
        
        log_callback(f"找到 {len(configs)} 个报表配置")
        
        # 统计
        total_success = 0
        total_failed = 0
        failed_items = []
        
        for config_index, config in enumerate(configs):
            report_name = config['name']
            target_folder = config['target_folder']
            filename_format = config['filename_format']
            
            log_callback(f"[{config_index + 1}/{len(configs)}] 处理报表: {report_name}")
            log_callback(f"保存目录: {target_folder}")
            
            # 检查是否跳过日期筛选
            skip_date_filter = config.get('skip_date_filter', False)
            
            # 构建采集任务列表
            tasks = []
            
            if skip_date_filter:
                # 跳过日期筛选的报表：只导出一次，无需历史数据
                # 使用当天日期 YYYYMMDD 作为文件名标识
                today_str = datetime.now().strftime("%Y%m%d")
                tasks.append({
                    'type': 'direct',
                    'period': today_str,  # 使用当天日期
                    'start_date': None,
                    'end_date': None,
                    'description': f"直接导出 {report_name}"
                })
            else:
                is_output_report = (
                    (report_name in ["CZM", "CKH"]) and
                    ("CMES_Product_Output" in filename_format)
                )

                if is_output_report:

                    filename_prefix = filename_format.format(month="").replace(".xlsx", "")
                    missing_quarters = get_missing_quarters(target_folder, filename_prefix, 12)

                    now = datetime.now()
                    current_quarter = get_quarter_period(now)
                    current_filename = get_output_filename(filename_format, report_name, current_quarter)
                    first_run_current_quarter = not (Path(target_folder) / current_filename).exists()

                    if current_quarter not in missing_quarters:
                        missing_quarters.append(current_quarter)

                    if first_run_current_quarter:
                        prev_quarter = get_previous_quarter_period(now)
                        missing_quarters.append(prev_quarter)

                    quarters_to_export = sorted(set(missing_quarters), reverse=True)
                    log_callback(f"📌 {report_name} 最近12个季度待导出(最新->最旧): {', '.join(quarters_to_export)}")

                    for quarter_str in quarters_to_export:
                        y = int(quarter_str[:4])
                        q = int(quarter_str[-1])
                        start_date, end_date = get_quarter_range(y, q)
                        tasks.append({
                            'type': 'quarter',
                            'period': quarter_str,
                            'start_date': start_date,
                            'end_date': end_date,
                            'description': f"季度 {quarter_str}"
                        })
                else:
                    # 需要日期筛选的报表：清理旧文件，检查缺失，构建任务
                    # 清理旧的月度文件（跨月时删除上个月的文件）
                    cleanup_old_monthly_files(target_folder, report_name, filename_format, log_callback)

                    # 检查缺失的文件
                    missing_info = check_missing_files(target_folder, report_name, filename_format, years_back)
                    missing_years = missing_info['missing_years']
                    need_ytd_update = missing_info['need_ytd_update']
                    current_month = missing_info['current_month']

                    # 1. 缺失的历史年份
                    for year in missing_years:
                        start_date, end_date = get_year_range(year)
                        tasks.append({
                            'type': 'history',
                            'period': str(year),
                            'start_date': start_date,
                            'end_date': end_date,
                            'description': f"历史年份 {year}"
                        })

                    # 2. 当前年累计（如果需要更新）
                    if need_ytd_update:
                        current_year = datetime.now().year
                        # 只有当不是1月份时才导出YTD（1月份没有上月数据）
                        if datetime.now().month > 1:
                            start_date, end_date = get_current_year_ytd_range()
                            tasks.append({
                                'type': 'ytd',
                                'period': str(current_year),
                                'start_date': start_date,
                                'end_date': end_date,
                                'description': f"当前年累计 {current_year}"
                            })

                    # 3. 当前月（每次都更新）
                    start_date, end_date = get_current_month_range()
                    tasks.append({
                        'type': 'current',
                        'period': current_month,
                        'start_date': start_date,
                        'end_date': end_date,
                        'description': f"当前月 {current_month}"
                    })
            
            # 显示任务计划（仅在控制台输出）
            print(f"需要导出 {len(tasks)} 个文件")
            
            # 执行采集任务
            collector = CMESDataCollector(
                config=config,
                headless=headless,
                log_callback=log_callback,
                browser_type=browser_type
            )
            
            for task_index, task in enumerate(tasks):
                # 检查中断标志
                if is_interrupted():
                    log_callback("⚠️ 检测到中断请求，停止任务...")
                    raise InterruptedError("任务已被用户中断")
                
                print(f"[{task_index + 1}/{len(tasks)}] 导出: {task['description']}")
                
                success = collector.collect(
                    start_date=task['start_date'],
                    end_date=task['end_date'],
                    output_period=task['period']
                )
                
                if success:
                    total_success += 1
                    log_callback(f"✅ {task['description']} 导出成功")
                else:
                    total_failed += 1
                    failed_items.append(f"{report_name}-{task['description']}")
                    log_callback(f"❌ {task['description']} 导出失败")
                
                # 任务间等待（分段等待以便快速响应中断）
                if task_index < len(tasks) - 1:
                    for _ in range(3):
                        if is_interrupted():
                            raise InterruptedError("任务已被用户中断")
                        time.sleep(1)
            
            # 报表间等待（分段等待以便快速响应中断）
            if config_index < len(configs) - 1:
                for _ in range(5):
                    if is_interrupted():
                        raise InterruptedError("任务已被用户中断")
                    time.sleep(1)
        
        # 输出结果
        log_callback(f"CMES 采集完成: 成功 {total_success} 个, 失败 {total_failed} 个")
        
        if failed_items:
            log_callback(f"失败项目: {', '.join(failed_items)}")
        
        return total_failed == 0
    
    except InterruptedError as e:
        log_callback(f"⚠️ CMES 数据采集已中断: {e}")
        return False
    except Exception as e:
        log_callback(f"❌ CMES 数据采集出错: {e}")
        return False
    finally:
        release_task_lock(task_name)


def list_cmes_reports() -> List[Dict]:
    """
    列出所有可用的 CMES 报表配置
    
    Returns:
        List[Dict]: 报表配置列表
    """
    try:
        return get_cmes_config()
    except Exception as e:
        print(f"获取 CMES 报表列表失败: {e}")
        return []


# ============================================================
# 命令行入口
# ============================================================

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="CMES 数据采集器")
    parser.add_argument("--headless", action="store_true", help="无头模式运行")
    parser.add_argument("--report", "-r", type=str, help="指定报表名称")
    parser.add_argument("--list", "-l", action="store_true", help="列出所有报表")
    args = parser.parse_args()
    
    if args.list:
        reports = list_cmes_reports()
        print("\n可用的 CMES 报表:")
        for r in reports:
            print(f"  - {r['name']}: {r['description']}")
        sys.exit(0)
    
    report_names = [args.report] if args.report else None
    success = collect_cmes_data(headless=args.headless, report_names=report_names)
    sys.exit(0 if success else 1)
