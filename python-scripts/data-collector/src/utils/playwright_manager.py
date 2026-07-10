"""
Playwright 浏览器管理器

使用 Playwright 替代 Selenium WebDriver，提供更稳定的浏览器自动化能力。
支持复用 Edge 用户配置，无需重复登录。

使用方法:
    from utils.playwright_manager import PlaywrightManager
    
    with PlaywrightManager() as manager:
        page = manager.new_page()
        page.goto("https://example.com")
        # ... 执行操作
"""

import os
import sys
import logging
import time
from pathlib import Path
from typing import Optional, Callable
from contextlib import contextmanager

try:
    from playwright.sync_api import sync_playwright, Page, Browser, BrowserContext
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    PlaywrightTimeout = Exception


class PlaywrightManager:
    """
    Playwright 浏览器管理器
    
    特性:
    - 支持复用 Edge 用户配置（已登录状态）
    - 支持无头模式
    - 自动处理文件下载
    - 统一的超时和错误处理
    """
    
    # 浏览器用户配置文件路径
    DEFAULT_EDGE_USER_DATA_DIR = r"C:\Users\{username}\AppData\Local\Microsoft\Edge\User Data"
    DEFAULT_CHROME_USER_DATA_DIR = r"C:\Users\{username}\AppData\Local\Google\Chrome\User Data"
    # Playwright 专用配置目录（避免与正在运行的浏览器冲突）
    PLAYWRIGHT_CHROME_USER_DATA_DIR = r"C:\Users\{username}\AppData\Local\Google\Chrome\User Data - Playwright"
    PLAYWRIGHT_EDGE_USER_DATA_DIR = r"C:\Users\{username}\AppData\Local\Microsoft\Edge\User Data - Playwright"
    DEFAULT_PROFILE = "Default"
    
    # 默认超时设置（秒）
    DEFAULT_PAGE_TIMEOUT = 60
    DEFAULT_ELEMENT_TIMEOUT = 30
    DEFAULT_DOWNLOAD_TIMEOUT = 120
    
    def __init__(
        self,
        headless: bool = False,
        slow_mo: int = 0,
        download_dir: Optional[str] = None,
        use_user_profile: bool = True,
        callback: Optional[Callable[[str], None]] = None,
        browser_type: str = "edge"  # "edge" 或 "chrome"
    ):
        """
        初始化 Playwright 管理器
        
        Args:
            headless: 是否使用无头模式
            slow_mo: 操作延迟（毫秒），用于调试
            download_dir: 下载目录，默认为系统下载目录
            use_user_profile: 是否使用浏览器用户配置（复用登录状态）
            callback: 日志回调函数
            browser_type: 浏览器类型，"edge" 或 "chrome"
        """
        if not PLAYWRIGHT_AVAILABLE:
            raise ImportError(
                "Playwright 未安装。请运行: pip install playwright && playwright install msedge"
            )
        
        self.headless = headless
        self.slow_mo = slow_mo
        self.download_dir = download_dir or os.path.expanduser("~/Downloads")
        self.use_user_profile = use_user_profile
        self.callback = callback
        self.browser_type = browser_type.lower()  # "edge" 或 "chrome"
        
        self._playwright = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        
        # 获取用户名
        try:
            username = os.getlogin()
        except Exception:
            username = os.environ.get('USERNAME', os.environ.get('USER', 'default'))
        
        # 统一使用 Chrome 的配置目录，确保登录状态一致
        # 无论选择 Chrome 还是 Edge，都使用同一个配置目录保存登录状态
        self.user_data_dir = self.PLAYWRIGHT_CHROME_USER_DATA_DIR.format(username=username)
        self.profile = self.DEFAULT_PROFILE
        
        # 创建配置目录（如果不存在）
        if self.use_user_profile:
            os.makedirs(self.user_data_dir, exist_ok=True)
        
    def _log(self, message: str, level: str = "INFO"):
        """输出日志"""
        formatted_msg = f"[{level}] {message}"
        logging.info(formatted_msg) if level == "INFO" else logging.error(formatted_msg)
        if self.callback:
            self.callback(message)
        else:
            print(formatted_msg)
    
    def __enter__(self):
        """上下文管理器入口"""
        self.start()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """上下文管理器退出"""
        self.close()
        return False
    
    def start(self):
        """启动 Playwright 和浏览器"""
        self._playwright = sync_playwright().start()
        
        # 打包环境 + Edge + headless：强制禁用 headless（Edge 的 persistent_context + headless 不稳定）
        # Chrome 的 headless 模式更稳定，不需要禁用
        if getattr(sys, 'frozen', False) and self.headless and self.use_user_profile and self.browser_type == "edge":
            self._log("⚠️ 打包环境 Edge 不支持 headless 模式，已自动切换为显示浏览器")
            self.headless = False
        
        if self.use_user_profile:
            self._start_with_user_profile()
        else:
            self._start_fresh_browser()
    
    def _start_with_user_profile(self):
        """使用浏览器用户配置启动（复用登录状态）"""
        # 查找浏览器可执行文件
        browser_exe = self._find_browser_executable()
        channel = "chrome" if self.browser_type == "chrome" else "msedge"
        browser_name = "Chrome" if self.browser_type == "chrome" else "Edge"
        
        # 配置目录信息仅输出到日志文件，不显示在GUI
        logging.info(f"🔧 使用配置目录: {self.user_data_dir}")
        
        try:
            # 启动参数 - 移除 --profile-directory，因为 user_data_dir 已经指定了配置目录
            launch_args = [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-software-rasterizer",
                "--disable-extensions",
                "--disable-background-networking",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-default-apps",
                "--disable-popup-blocking",
                "--disable-features=WebRtcLocalNetworkPermissionCheck",  # 禁用本地网络权限检查弹窗
                "--disable-features=PrivateNetworkAccessPermissionPrompt",  # 禁用私有网络访问权限提示
                "--disable-session-crashed-bubble",  # 禁用"恢复页面"提示
                "--disable-infobars",  # 禁用信息栏
                "--hide-crash-restore-bubble"  # 隐藏崩溃恢复气泡
            ]
            
            if browser_exe:
                # 使用可执行文件路径启动
                self._context = self._playwright.chromium.launch_persistent_context(
                    user_data_dir=self.user_data_dir,
                    executable_path=browser_exe,
                    headless=self.headless,
                    slow_mo=self.slow_mo,
                    accept_downloads=True,
                    args=launch_args,
                    timeout=60000,
                    ignore_default_args=["--enable-automation"]  # 隐藏自动化标识
                )
            else:
                # 使用 channel 启动
                self._context = self._playwright.chromium.launch_persistent_context(
                    user_data_dir=self.user_data_dir,
                    channel=channel,
                    headless=self.headless,
                    slow_mo=self.slow_mo,
                    accept_downloads=True,
                    args=launch_args,
                    timeout=60000,
                    ignore_default_args=["--enable-automation"]  # 隐藏自动化标识
                )
            self._log(f"✅ {browser_name} 浏览器启动成功（使用持久化配置）")
        except Exception as e:
            error_msg = str(e)
            self._log(f"使用用户配置启动失败: {error_msg}", "ERROR")
            
            if "user data directory is already in use" in error_msg.lower():
                self._log(f"可能是 {browser_name} 浏览器正在运行，尝试使用独立配置", "ERROR")
            
            self._start_fresh_browser()
    
    def _find_browser_executable(self) -> Optional[str]:
        """查找浏览器可执行文件"""
        if self.browser_type == "chrome":
            paths = [
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            ]
        else:  # edge
            paths = [
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            ]
        
        for path in paths:
            if os.path.exists(path):
                return path
        return None
    
    def _start_fresh_browser(self):
        """启动全新的浏览器实例（不使用用户配置）"""
        browser_exe = self._find_browser_executable()
        channel = "chrome" if self.browser_type == "chrome" else "msedge"
        browser_name = "Chrome" if self.browser_type == "chrome" else "Edge"
        
        launch_args = [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--disable-extensions",
            "--disable-background-networking",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-default-apps",
            "--disable-popup-blocking"
        ]
        
        # 优先使用可执行文件路径
        if browser_exe:
            try:
                browser = self._playwright.chromium.launch(
                    executable_path=browser_exe,
                    headless=self.headless,
                    slow_mo=self.slow_mo,
                    args=launch_args,
                    timeout=60000
                )
                
                self._context = browser.new_context(
                    accept_downloads=True
                )
                self._log(f"✅ {browser_name} 浏览器启动成功")
                return
            except Exception as e:
                self._log(f"使用可执行文件启动失败: {e}", "ERROR")
        
        # 备用：使用 channel 模式
        try:
            browser = self._playwright.chromium.launch(
                channel=channel,
                headless=self.headless,
                slow_mo=self.slow_mo,
                args=launch_args,
                timeout=60000
            )
            
            self._context = browser.new_context(
                accept_downloads=True
            )
            self._log(f"✅ {browser_name} 浏览器启动成功")
        except Exception as e:
            self._log(f"所有启动方式均失败: {e}", "ERROR")
            raise RuntimeError(f"无法启动 {browser_name} 浏览器: {e}")
    
    def new_page(self) -> Page:
        """
        创建新页面
        
        Returns:
            Page: Playwright 页面对象
        """
        if not self._context:
            raise RuntimeError("浏览器未启动，请先调用 start() 或使用 with 语句")
        
        self._page = self._context.new_page()
        self._page.set_default_timeout(self.DEFAULT_ELEMENT_TIMEOUT * 1000)
        return self._page
    
    def get_page(self) -> Optional[Page]:
        """获取当前页面"""
        return self._page
    
    def goto(self, url: str, timeout: int = None) -> bool:
        """
        导航到指定 URL
        
        Args:
            url: 目标 URL
            timeout: 超时时间（秒）
            
        Returns:
            bool: 是否成功
        """
        if not self._page:
            self._page = self.new_page()
        
        timeout_ms = (timeout or self.DEFAULT_PAGE_TIMEOUT) * 1000
        
        try:
            self._log(f"导航到: {url}")
            self._page.goto(url, timeout=timeout_ms)
            return True
        except PlaywrightTimeout:
            self._log(f"页面加载超时: {url}", "ERROR")
            return False
        except Exception as e:
            self._log(f"页面加载失败: {e}", "ERROR")
            return False
    
    def wait_for_selector(self, selector: str, timeout: int = None) -> bool:
        """
        等待元素出现
        
        Args:
            selector: CSS 选择器
            timeout: 超时时间（秒）
            
        Returns:
            bool: 元素是否出现
        """
        if not self._page:
            return False
        
        timeout_ms = (timeout or self.DEFAULT_ELEMENT_TIMEOUT) * 1000
        
        try:
            self._page.wait_for_selector(selector, timeout=timeout_ms)
            return True
        except PlaywrightTimeout:
            return False
    
    def click(self, selector: str, timeout: int = None) -> bool:
        """
        点击元素
        
        Args:
            selector: CSS 选择器
            timeout: 超时时间（秒）
            
        Returns:
            bool: 是否成功
        """
        if not self._page:
            return False
        
        timeout_ms = (timeout or self.DEFAULT_ELEMENT_TIMEOUT) * 1000
        
        try:
            self._page.click(selector, timeout=timeout_ms)
            return True
        except Exception as e:
            self._log(f"点击元素失败 [{selector}]: {e}", "ERROR")
            return False
    
    def fill(self, selector: str, value: str, timeout: int = None) -> bool:
        """
        填充输入框
        
        Args:
            selector: CSS 选择器
            value: 要填充的值
            timeout: 超时时间（秒）
            
        Returns:
            bool: 是否成功
        """
        if not self._page:
            return False
        
        timeout_ms = (timeout or self.DEFAULT_ELEMENT_TIMEOUT) * 1000
        
        try:
            self._page.fill(selector, value, timeout=timeout_ms)
            return True
        except Exception as e:
            self._log(f"填充输入框失败 [{selector}]: {e}", "ERROR")
            return False
    
    def download_file(
        self,
        trigger_selector: str,
        save_path: Optional[str] = None,
        timeout: int = None
    ) -> Optional[Path]:
        """
        触发下载并保存文件
        
        Args:
            trigger_selector: 触发下载的元素选择器
            save_path: 保存路径，默认使用下载目录
            timeout: 下载超时时间（秒）
            
        Returns:
            Path: 下载文件的路径，失败返回 None
        """
        if not self._page:
            return None
        
        timeout_ms = (timeout or self.DEFAULT_DOWNLOAD_TIMEOUT) * 1000
        
        try:
            with self._page.expect_download(timeout=timeout_ms) as download_info:
                self._page.click(trigger_selector)
            
            download = download_info.value
            
            if save_path:
                download_path = Path(save_path)
            else:
                download_path = Path(self.download_dir) / download.suggested_filename
            
            # 确保目录存在
            download_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 保存文件
            download.save_as(str(download_path))
            self._log(f"文件下载成功: {download_path}")
            
            return download_path
            
        except PlaywrightTimeout:
            self._log("下载超时", "ERROR")
            return None
        except Exception as e:
            self._log(f"下载失败: {e}", "ERROR")
            return None
    
    def screenshot(self, path: str = None) -> Optional[bytes]:
        """
        截图
        
        Args:
            path: 保存路径，不指定则返回字节数据
            
        Returns:
            bytes: 截图数据（如果未指定路径）
        """
        if not self._page:
            return None
        
        try:
            if path:
                self._page.screenshot(path=path)
                self._log(f"截图已保存: {path}")
                return None
            else:
                return self._page.screenshot()
        except Exception as e:
            self._log(f"截图失败: {e}", "ERROR")
            return None
    
    def evaluate(self, expression: str):
        """
        执行 JavaScript
        
        Args:
            expression: JavaScript 表达式
            
        Returns:
            执行结果
        """
        if not self._page:
            return None
        
        try:
            return self._page.evaluate(expression)
        except Exception as e:
            self._log(f"执行 JavaScript 失败: {e}", "ERROR")
            return None
    
    def close(self):
        """关闭浏览器和 Playwright"""
        import time
        
        # 先关闭 context
        if self._context:
            try:
                time.sleep(0.5)  # 给浏览器一点时间保存数据
                self._context.close()
            except Exception as e:
                logging.warning(f"关闭浏览器上下文时出错: {e}")
            finally:
                self._context = None
        
        # 再停止 playwright
        if self._playwright:
            try:
                self._playwright.stop()
            except Exception as e:
                logging.warning(f"停止 Playwright 时出错: {e}")
            finally:
                self._playwright = None
        
        # 等待资源完全释放
        time.sleep(1)
        self._log("浏览器已关闭")


# ============================================================
# 便捷函数
# ============================================================

def check_playwright_installed() -> tuple[bool, str]:
    """
    检查 Playwright 是否已安装
    
    Returns:
        tuple: (是否安装, 状态消息)
    """
    if not PLAYWRIGHT_AVAILABLE:
        return False, "Playwright 未安装。请运行: pip install playwright"
    
    try:
        with sync_playwright() as p:
            # 尝试获取 Edge 浏览器路径
            browser = p.chromium.launch(channel="msedge", headless=True)
            browser.close()
        return True, "Playwright 和 Edge 浏览器已就绪"
    except Exception as e:
        if "msedge" in str(e).lower():
            return False, "Edge 浏览器未安装或未配置。请运行: playwright install msedge"
        return False, f"Playwright 检查失败: {e}"


@contextmanager
def create_browser(
    headless: bool = False,
    use_user_profile: bool = True,
    callback: Optional[Callable[[str], None]] = None
):
    """
    创建浏览器上下文管理器（便捷函数）
    
    Args:
        headless: 是否使用无头模式
        use_user_profile: 是否使用用户配置
        callback: 日志回调函数
        
    Yields:
        PlaywrightManager: 浏览器管理器实例
        
    Example:
        with create_browser(headless=True) as manager:
            page = manager.new_page()
            page.goto("https://example.com")
    """
    manager = PlaywrightManager(
        headless=headless,
        use_user_profile=use_user_profile,
        callback=callback
    )
    try:
        manager.start()
        yield manager
    finally:
        manager.close()


# ============================================================
# 测试代码
# ============================================================

if __name__ == "__main__":
    # 测试 Playwright 安装状态
    installed, message = check_playwright_installed()
    print(f"Playwright 状态: {message}")
    
    if installed:
        # 简单测试
        print("\n测试浏览器启动...")
        with create_browser(headless=True, use_user_profile=False) as manager:
            page = manager.new_page()
            manager.goto("https://www.bing.com")
            print(f"页面标题: {page.title()}")
        print("测试完成!")
