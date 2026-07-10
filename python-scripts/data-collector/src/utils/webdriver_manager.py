import os
import sys
import logging
from selenium import webdriver
from selenium.webdriver.edge.service import Service
import winreg

class WebDriverManager:
    def __init__(self, headless=False):
        self.headless = headless
        self.is_headless = headless
        self.driver = None
        self.base_path = self._get_base_path()
        self.webdriver_dir = os.path.join(self.base_path, 'resources', 'webdriver')
        logging.info(f"WebDriver目录: {self.webdriver_dir}")
        
    def _get_base_path(self):
        """获取基础路径"""
        if getattr(sys, 'frozen', False):
            # 如果是打包后的exe
            return os.path.dirname(sys.executable)
        else:
            # 如果是开发环境
            current_dir = os.path.dirname(os.path.abspath(__file__))  # utils目录
            return os.path.dirname(os.path.dirname(current_dir))      # 项目根目录
            
    def check_webdriver(self):
        """检查WebDriver状态"""
        try:
            if not self.driver:
                return False, "WebDriver未初始化"
                
            # 尝试执行一个简单的操作来检查WebDriver是否正常工作
            self.driver.current_url
            return True, "WebDriver运行正常"
            
        except Exception as e:
            return False, f"检查WebDriver时出错: {str(e)}"
            
    @staticmethod
    def get_edge_version():
        """获取Edge浏览器版本"""
        try:
            # 从注册表获取Edge版本
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, 
                               r"Software\Microsoft\Edge\BLBeacon")
            version, _ = winreg.QueryValueEx(key, "version")
            # 只返回主版本号
            return version.split('.')[0]
        except Exception as e:
            logging.error(f"获取Edge版本失败: {str(e)}")
            return None

    def create_edge_driver(self, headless=None):
        """只使用指定目录下的 msedgedriver.exe，不做自动下载和版本校验"""
        try:
            driver_path = os.path.join(self.webdriver_dir, 'msedgedriver.exe')
            if not os.path.exists(driver_path):
                raise FileNotFoundError(f"未找到 WebDriver: {driver_path}")

            options = webdriver.EdgeOptions()
            use_headless = headless if headless is not None else self.is_headless
            if use_headless:
                options.add_argument('--headless')
            options.add_argument('--disable-gpu')
            options.add_argument('--no-sandbox')
            options.add_argument('--disable-dev-shm-usage')
            options.add_argument('--log-level=3')
            options.add_experimental_option('excludeSwitches', ['enable-logging'])

            service = Service(executable_path=driver_path)
            driver = webdriver.Edge(service=service, options=options)
            logging.info("WebDriver创建成功")
            return driver
        except Exception as e:
            logging.error(f"创建Edge WebDriver失败: {str(e)}")
            return None
            
    def close_driver(self):
        """关闭WebDriver"""
        if self.driver:
            try:
                self.driver.quit()
            except Exception as e:
                logging.error(f"关闭WebDriver时出错: {str(e)}")
            finally:
                self.driver = None