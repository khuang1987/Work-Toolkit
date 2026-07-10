import sys
import time
import os
import glob
import logging
import shutil
import pandas as pd
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.edge.service import Service
from selenium.webdriver.edge.options import Options
from concurrent.futures import ThreadPoolExecutor

def setup_logging(base_path):
    # 构建日志文件路径
    # 1. 在base_path下创建config/logs目录结构
    # 2. 日志文件名格式：planner_exporter_YYYYMMDD_HHMMSS.log
    log_dir = os.path.join(base_path, 'config', 'logs')
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, f'planner_exporter_{time.strftime("%Y%m%d_%H%M%S")}.log')
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s\n',
        handlers=[
            logging.FileHandler(log_file, encoding='utf-8'),
            logging.StreamHandler(sys.stdout)
        ]
    )
    return logging.getLogger(__name__)

def get_base_path():
    # 获取应用程序的基础路径
    # 1. 如果是打包后的exe环境，返回exe所在目录
    # 2. 如果是开发环境，返回项目根目录（src的上一级目录）
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.dirname(__file__))

def setup_browser_options():
    options = Options()
    options.add_argument("--log-level=3")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-extensions")
    options.add_argument("--ignore-certificate-errors")
    options.add_argument("--window-size=800,800")
    options.add_argument("about:blank")
    options.add_experimental_option("excludeSwitches", ["enable-logging"])
    return options

def process_planner_url(url, area, index, driver_path, user_data_dir, total_urls, callback=None, logger=None, stop_flag=None):
    driver = None
    max_retries = 3
    retry_count = 0
    
    while retry_count < max_retries:
        try:
            logger.info(f"处理 {area} - 尝试 {retry_count + 1}/{max_retries}")
            unique_user_data_dir = os.path.join(user_data_dir, f"Profile_{index}")
            os.makedirs(unique_user_data_dir, exist_ok=True)
            
            options = setup_browser_options()
            options.add_argument(f"user-data-dir={unique_user_data_dir}")
            
            driver = webdriver.Edge(service=Service(driver_path), options=options)
            driver.get(url)
            
            # 检查是否收到终止信号
            if stop_flag and stop_flag.is_set():
                logger.info(f"收到终止信号，停止处理 {area}")
                if callback:
                    callback(f"已终止处理 {area}")
                return

            # 点击导出按钮
            dropdown_button = WebDriverWait(driver, 30).until(
                EC.element_to_be_clickable((By.XPATH, '//button[contains(@aria-label, "计划选项") and contains(@class, "linkedBadgeDropdown")]'))
            )
            dropdown_button.click()
            time.sleep(2)

            export_button = WebDriverWait(driver, 20).until(
                EC.element_to_be_clickable((By.XPATH, "//button[@aria-label='将计划导出到 Excel']")),
            )
            export_button.click()
            
            downloads_path = os.path.expanduser("~/Downloads")
            before_download_files = set(glob.glob(os.path.join(downloads_path, "*.xlsx")))
            
            if not wait_for_download(downloads_path, before_download_files, logger, stop_flag):
                raise TimeoutException("下载超时")
            
            # 检查是否收到终止信号
            if stop_flag and stop_flag.is_set():
                logger.info(f"收到终止信号，停止处理 {area}")
                if callback:
                    callback(f"已终止处理 {area}")
                return

            move_downloaded_file(downloads_path, index, total_urls, callback, logger)
            break
            
        except Exception as e:
            error_message = f"处理{area}时出错 (尝试 {retry_count + 1}/{max_retries}): {str(e)}"
            logger.error(error_message)
            if callback and retry_count == max_retries - 1:
                callback(error_message)
            retry_count += 1
            time.sleep(5)
        finally:
            if driver:
                try:
                    driver.quit()
                except Exception as e:
                    logger.error(f"关闭浏览器时出错: {str(e)}")

def wait_for_download(downloads_path, before_files, logger, stop_flag=None, timeout=60):
    start_time = time.time()
    while (time.time() - start_time) < timeout:
        # 检查是否收到终止信号
        if stop_flag and stop_flag.is_set():
            logger.info("收到终止信号，停止等待下载")
            return False

        time.sleep(1)
        current_files = set(glob.glob(os.path.join(downloads_path, "*.xlsx")))
        if current_files - before_files:
            logger.info("检测到新下载的文件")
            return True
    return False

def move_downloaded_file(downloads_path, index, total_urls, callback, logger):
    # 移动下载的文件到目标位置
    # 1. 获取下载目录中最新的xlsx文件
    # 2. 构建目标路径：OneDrive - Medtronic PLC/General - CZ Production/POWER BI 数据源 V2/B1_Planner 导出数据/
    # 3. 如果目标文件已存在则先删除
    recent_files = sorted(glob.glob(os.path.join(downloads_path, "*.xlsx")), key=os.path.getmtime)
    if not recent_files:
        raise Exception("未找到下载的文件")
        
    source_path = recent_files[-1]
    file_name = os.path.basename(source_path)
    destination_path = os.path.join(
        fr'C:\Users\{os.getlogin()}\OneDrive - Medtronic PLC\General - CZ Production\POWER BI 数据源 V2\B1_Planner 导出数据', 
        file_name
    )
    
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    if os.path.exists(destination_path):
        os.remove(destination_path)
    
    shutil.move(source_path, destination_path)
    message = f"文件已保存[{index+1}/{total_urls}]: {file_name}"
    logger.info(message)
    if callback:
        callback(message)

def main(callback=None, stop_flag=None):
    base_path = get_base_path()
    logger = setup_logging(base_path)
    logger.info("开始执行Planner数据导出任务")

    driver_path = fr"C:\Apps\webdriverEDGE\msedgedriver.exe"
    user_data_dir = fr"C:\Users\{os.getlogin()}\AppData\Local\Microsoft\Edge\User Data\Automation"

    try:
        # 读取配置文件
        # 配置文件路径：base_path/config/planner_config.csv
        config_file = os.path.join(base_path, "config", "planner_config.csv")
        logger.info(f"读取配置文件: {config_file}")
        
        if not os.path.exists(config_file):
            error_msg = f"配置文件不存在: {config_file}"
            logger.error(error_msg)
            if callback:
                callback(error_msg)
            return
        
        df = pd.read_csv(config_file, encoding='utf-8')
        if df.empty:
            raise ValueError("配置文件为空")
        
        urls = df['URL'].dropna().tolist() if 'URL' in df.columns else []
        areas = df['区域'].dropna().tolist() if '区域' in df.columns else []
        
        if not urls:
            raise ValueError("未找到有效的URL配置")
            
        logger.info(f"开始处理 {len(urls)} 个Planner URL...")
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.map(lambda x: process_planner_url(
                urls[x], 
                areas[x] if areas else f"区域{x+1}", 
                x, 
                driver_path, 
                user_data_dir, 
                len(urls),
                callback, 
                logger,
                stop_flag
            ), range(len(urls)))
            
        logger.info("所有Planner导出任务已完成")
            
    except Exception as e:
        error_msg = f"配置文件读取失败: {str(e)}"
        logger.error(error_msg)
        if callback:
            callback(error_msg)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger = setup_logging(get_base_path())
        logger.error(f"程序执行过程中发生未处理的异常: {str(e)}")
        sys.exit(1)
