import sys
import time
import os
import glob
import logging
import shutil
import pandas as pd
from datetime import datetime
from pathlib import Path
from utils.playwright_manager import PlaywrightManager
from utils.task_lock_manager import (
    acquire_task_lock, release_task_lock, is_task_locked,
    is_interrupted, InterruptedError
)



def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        current_dir = os.path.dirname(__file__)  # core目录
        src_dir = os.path.dirname(current_dir)   # src目录
        return os.path.dirname(src_dir)         # 项目根目录



def get_path_from_config(path_name):
    base_path = get_base_path()
    config_path = os.path.join(base_path, 'config', 'path_config.csv')
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"配置文件不存在: {config_path}")
    df = pd.read_csv(config_path)
    path_value = df[df['path_name'] == path_name]['path_value'].values[0]
    return path_value.replace('{username}', os.getlogin()).replace('{app_dir}', base_path)

# 已移除 setup_browser_options 和 process_planner_url，使用 Playwright 实现

def _try_auto_login(page, log_callback) -> bool:
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
        
        if log_callback:
            log_callback("探测到 Microsoft 登录/验证页面...")
        
        # 1. 优先尝试“选取账户”页面的账号磁贴
        pick_account_selector = "div[aria-label*='@medtronic.com'], div[role='button']:has-text('@medtronic.com')"
        
        try:
            element = page.wait_for_selector(pick_account_selector, timeout=2000)
            if element:
                if log_callback:
                    log_callback("🔥 发现已保存的公司账号磁贴，立即点击...")
                element.click()
                return True
        except:
            pass
        
        # 2. 交互元素选择器 (Next/Sign-in)
        login_selectors = [
            "input#idSIButton9",                   # 微软通用按钮 ID
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
                    if log_callback:
                        log_callback(f"发现登录交互元素 ({selector})，点击...")
                    element.click()
                    time.sleep(1)
                    return True
            except:
                continue
        
        return False
    except Exception as e:
        if log_callback:
            log_callback(f"自动登录检测失败: {e}")
        return False

def _wait_for_planner_load(page, log_callback) -> bool:
    """循环检查页面加载，处理重定向和自动登录"""
    max_attempts = 6
    dropdown_selector = '//button[contains(@aria-label, "计划选项") and contains(@class, "linkedBadgeDropdown")]'
    
    for attempt in range(max_attempts):
        try:
            # 1. 检查是否在登录页面，如果是则触发自动登录
            if _try_auto_login(page, log_callback):
                log_callback("✅ 自动登录成功，等待跳转...")
                time.sleep(5)
                continue
            
            # 2. 检查是否已经加载到 Planner 主页面 (通过检测 计划选项 按钮)
            try:
                # 缩短单词等待时间，以便更快进入下一次循环检测登录页
                element = page.wait_for_selector(f"xpath={dropdown_selector}", state="visible", timeout=8000)
                if element:
                    log_callback("✅ Planner 页面加载完成")
                    return True
            except:
                pass
            
            # 3. 检查当前 URL 状态
            current_url = page.url.lower()
            is_login_page = any(domain in current_url for domain in [
                'login.microsoftonline.com', 'login.live.com', 'login.windows.net', 'microsoftonline.com'
            ])
            
            if is_login_page:
                log_callback(f"仍在登录页面/等待重定向 ({attempt + 1}/{max_attempts})...")
                time.sleep(3)
            else:
                log_callback(f"等待 Planner 内容加载 ({attempt + 1}/{max_attempts})...")
                time.sleep(3)
                
        except Exception as e:
            log_callback(f"⚠️ 加载检测异常: {str(e)}")
            time.sleep(2)
            
    return False

def wait_for_download(downloads_path, before_files, callback=None, stop_flag=None, timeout=60):
    start_time = time.time()
    while (time.time() - start_time) < timeout:
        # 检查是否收到终止信号
        if stop_flag and stop_flag.is_set():
            if callback:
                callback("收到终止信号，停止等待下载")
            return False

        time.sleep(1)
        current_files = set(glob.glob(os.path.join(downloads_path, "*.xlsx")))
        if current_files - before_files:
            if callback:
                callback("检测到新下载的文件")
            return True
    return False

def move_downloaded_file(downloads_path, index, total_urls, callback, logger):
    recent_files = sorted(glob.glob(os.path.join(downloads_path, "*.xlsx")), key=os.path.getmtime)
    if not recent_files:
        raise Exception("未找到下载的文件")
        
    source_path = recent_files[-1]
    file_name = os.path.basename(source_path)
    # 使用path_config.csv中的路径
    save_path = get_path_from_config('planner_folder')
    destination_path = os.path.join(save_path, file_name)
    
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    if os.path.exists(destination_path):
        os.remove(destination_path)
    
    shutil.move(source_path, destination_path)
    
    # 如果有回调函数，输出日志（用于兼容旧代码）
    if callback:
        message = f"文件已保存[{index+1}/{total_urls}]: {file_name}"
        callback(message)
    
    # 返回文件名供调用者使用
    return file_name

def export_planner_data(callback=None, headless=True, browser_type="chrome"):
    """导出Planner数据（使用 Playwright）"""
    # 检查任务锁
    task_name = "Planner数据导出"
    if is_task_locked(task_name):
        if callback:
            callback(f"⚠️ {task_name}任务正在执行中，请等待当前任务完成")
        return False
    
    if not acquire_task_lock(task_name):
        if callback:
            callback(f"❌ 无法获取{task_name}任务锁，任务可能正在执行中")
        return False
    
    # 创建日志回调函数
    def log_callback(message):
        print(message)  # 输出到控制台
        if callback:
            callback(message)  # 输出到GUI
        else:
            # 如果没有回调函数，尝试获取全局日志函数
            try:
                from main import log_with_timestamp
                log_with_timestamp(message)
            except:
                pass
    
    log_callback("开始导出Planner数据...")
    
    manager = None
    
    try:
        # 创建 Playwright 管理器
        manager = PlaywrightManager(
            headless=headless,
            use_user_profile=True,
            callback=log_callback,
            browser_type=browser_type
        )
        manager.start()
        
        # 创建页面
        page = manager.new_page()
            
        base_path = get_base_path()

        # 读取配置文件
        config_file = os.path.join(base_path, "config", "planner_config.csv")
        
        df = pd.read_csv(config_file, encoding='utf-8')
        if df.empty:
            raise ValueError("配置文件为空")
        
        urls = df['URL'].dropna().tolist() if 'URL' in df.columns else []
        areas = df['区域'].dropna().tolist() if '区域' in df.columns else []
        
        if not urls:
            raise ValueError("未找到有效的URL配置")
            
        log_callback(f"开始处理 {len(urls)} 个Planner URL...")
        
        # 处理所有URL
        for index, url in enumerate(urls):
            # 检查中断标志
            if is_interrupted():
                log_callback("⚠️ 检测到中断请求，停止任务...")
                raise InterruptedError("任务已被用户中断")
            
            try:
                area = areas[index] if index < len(areas) else f"区域{index+1}"
                log_callback(f"开始处理 {area} [{index+1}/{len(urls)}]...")
                
                # 访问URL - 使用 domcontentloaded 而不是 networkidle，更快且更可靠
                try:
                    page.goto(url, timeout=60000, wait_until="domcontentloaded")
                except Exception as e:
                    log_callback(f"⚠️ 页面初次加载超时，尝试继续检测: {str(e)}")
                
                # 使用 robust 循环等待加载和处理登录
                if not _wait_for_planner_load(page, log_callback):
                    log_callback(f"❌ {area} 页面加载超时，跳过此区域")
                    continue
                
                # 重新定位计划选项按钮 (之前 wait_for_planner_load 已经确认它可见)
                dropdown_selector = '//button[contains(@aria-label, "计划选项") and contains(@class, "linkedBadgeDropdown")]'
                
                # 使用更智能的等待：等待按钮可见且可点击
                try:
                    page.wait_for_selector(f"xpath={dropdown_selector}", state="visible", timeout=30000)
                    # 确保按钮可点击（没有被遮挡）
                    page.locator(f"xpath={dropdown_selector}").wait_for(state="visible", timeout=5000)
                except Exception as e:
                    log_callback(f"⚠️ 等待计划选项按钮超时: {str(e)}")
                    raise
                
                # 点击计划选项下拉按钮
                page.click(f"xpath={dropdown_selector}")
                
                # 等待导出按钮出现（下拉菜单展开后）
                export_selector = "//button[@aria-label='将计划导出到 Excel']"
                page.wait_for_selector(f"xpath={export_selector}", state="visible", timeout=10000)
                
                # 等待下载完成
                downloads_path = os.path.expanduser("~/Downloads")
                before_download_files = set(glob.glob(os.path.join(downloads_path, "*.xlsx")))
                
                # 使用 Playwright 的下载处理
                with page.expect_download(timeout=60000) as download_info:
                    page.click(f"xpath={export_selector}")
                
                download = download_info.value
                # 等待下载完成并获取文件
                download_path = Path(downloads_path) / download.suggested_filename
                download.save_as(str(download_path))
                
                # 移动文件并获取文件名
                file_name = move_downloaded_file(downloads_path, index, len(urls), None, None)
                # 导出成功信息（不显示文件名）
                log_callback(f"✅ {area} 导出成功 - 文件已保存[{index+1}/{len(urls)}]")
                # 添加空行分隔
                print()  # 输出纯空行到控制台
                
            except Exception as e:
                error_message = f"处理{area}时出错: {str(e)}"
                log_callback(error_message)
                continue
        
        log_callback(f"🎉 Planner导出完成: {len(urls)} 个区域")
        return True
    
    except InterruptedError as e:
        log_callback(f"⚠️ Planner数据导出已中断: {e}")
        return False
    except Exception as e:
        error_msg = f"处理过程中出错: {str(e)}"
        log_callback(error_msg)
        return False
    finally:
        if manager:
            try:
                manager.close()
            except Exception as e:
                log_callback(f"关闭浏览器时出错: {str(e)}")
        # 释放任务锁
        release_task_lock(task_name)
