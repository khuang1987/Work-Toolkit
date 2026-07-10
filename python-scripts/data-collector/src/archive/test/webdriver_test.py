from selenium import webdriver
from selenium.webdriver.edge.service import Service
import time

def test_webdriver():
    driver = None
    try:
        # 硬编码配置（请确认驱动路径正确）
        DRIVER_PATH = r"C:\Apps\webdriverEDGE\msedgedriver.exe"
        TARGET_URL = "https://www.baidu.com"  # 百度主页
        
        # 初始化基础配置
        options = webdriver.EdgeOptions()
        options.add_argument("--log-level=3")  # 禁用日志
        options.add_experimental_option("excludeSwitches", ["enable-logging"])
        
        # 核心测试流程
        print("[1/3] 正在初始化驱动...")
        driver = webdriver.Edge(service=Service(DRIVER_PATH), options=options)
        
        print("[2/3] 正在打开测试页...")
        driver.get(TARGET_URL)
        
        # 等待10秒
        print("等待10秒...")
        time.sleep(10)
        
        print("[3/3] 测试成功！标题:", driver.title)
        
    except Exception as e:
        print(f"测试失败: {str(e)}")
    finally:
        if driver:
            driver.quit()

if __name__ == "__main__":
    test_webdriver()