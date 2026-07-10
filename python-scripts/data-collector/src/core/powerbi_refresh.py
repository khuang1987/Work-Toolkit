import os
import sys
import time
import csv
from datetime import datetime
from utils.playwright_manager import PlaywrightManager, check_playwright_installed
from utils.task_lock_manager import (
    acquire_task_lock, release_task_lock, is_task_locked,
    is_interrupted, InterruptedError
)

def check_network_connection(callback=None):
    """检查网络连接状态 - 直接返回True，跳过网络检查"""
    return True

def get_powerbi_url(name):
    """从配置文件中获取PowerBI URL"""
    try:
        if getattr(sys, 'frozen', False):
            base_path = os.path.dirname(sys.executable)
        else:
            base_path = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            
        config_path = os.path.join(base_path, 'config', 'powerbi_config.csv')
        with open(config_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row['name'] == name:
                    return row['url']
        raise ValueError(f"未找到名称为 {name} 的PowerBI配置")
    except Exception as e:
        raise Exception(f"读取PowerBI配置失败: {str(e)}")

def refresh_powerbi(page, powerbi_name, callback=None):
    """刷新单个PowerBI报表（复用已打开的页面）"""
    try:
        if callback:
            callback(f"开始处理 {powerbi_name}...")
        
        # 获取PowerBI URL
        powerbi_url = get_powerbi_url(powerbi_name)
        
        # 导航到PowerBI页面 - 使用 domcontentloaded 策略
        try:
            page.goto(powerbi_url, timeout=60000, wait_until="domcontentloaded")
        except Exception as e:
            if callback:
                callback(f"⚠️ 页面加载超时，尝试继续: {str(e)}")
        
        # 等待刷新按钮出现并点击
        refresh_selector = 'button.mat-mdc-menu-trigger[title="刷新"]'
        page.wait_for_selector(refresh_selector, timeout=60000)
        page.click(refresh_selector)
        
        # 等待下拉菜单中的'立即刷新'按钮出现并点击
        refresh_now_selector = 'button.mat-mdc-menu-item[title="立即刷新"]'
        page.wait_for_selector(refresh_now_selector, timeout=60000)
        page.click(refresh_now_selector)
        
        # 等待刷新请求发送
        time.sleep(3)
        
        if callback:
            callback(f"✅ {powerbi_name} 刷新请求已发送")
            callback("")  # 添加空行分隔
        return True
        
    except Exception as e:
        error_message = f"处理{powerbi_name}时出错: {str(e)}"
        if callback:
            callback(f"❌ {error_message}")
        return False

def list_powerbi_reports(callback=None):
    """列出所有可用的PowerBI报表配置信息"""
    try:
        if getattr(sys, 'frozen', False):
            base_path = os.path.dirname(sys.executable)
        else:
            base_path = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            
        config_path = os.path.join(base_path, 'config', 'powerbi_config.csv')
        with open(config_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            reports = list(reader)
        return reports
    except Exception as e:
        if callback:
            callback(f"获取PowerBI报表列表失败: {str(e)}")
        else:
            print(f"获取PowerBI报表列表失败: {str(e)}")
        return []

def refresh_all_powerbi_data(callback=None, headless=False, browser_type="chrome"):
    """刷新所有PowerBI报表数据（复用浏览器实例）"""
    # 检查任务锁
    task_name = "PowerBI数据刷新"
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
    
    manager = None
    try:
        log_callback("开始刷新PowerBI数据...")
        
        reports = list_powerbi_reports()
        if not reports:
            log_callback("未找到可用的PowerBI报表配置")
            return False
        
        log_callback(f"开始处理 {len(reports)} 个PowerBI报表...")
        
        # 创建 Playwright 管理器（只创建一次）
        manager = PlaywrightManager(
            headless=headless,
            use_user_profile=True,
            callback=log_callback,
            browser_type=browser_type
        )
        manager.start()
        
        # 创建页面（复用同一个页面）
        page = manager.new_page()
        
        success_count = 0
        failed_reports = []
        
        for index, report in enumerate(reports):
            # 检查中断标志
            if is_interrupted():
                log_callback("⚠️ 检测到中断请求，停止任务...")
                raise InterruptedError("任务已被用户中断")
            
            try:
                if refresh_powerbi(page, report['name'], log_callback):
                    success_count += 1
                else:
                    failed_reports.append((report['name'], "刷新失败"))
            except InterruptedError:
                raise
            except Exception as e:
                failed_reports.append((report['name'], str(e)))
                continue
        
        # 输出总体刷新结果
        if success_count == len(reports):
            log_callback(f"🎉 PowerBI刷新完成: 成功 {success_count}/{len(reports)}")
        elif success_count > 0:
            log_callback(f"⚠️ PowerBI刷新完成: 成功 {success_count}/{len(reports)}")
            for name, error in failed_reports:
                log_callback(f"  ❌ {name}: {error[:50]}")
        else:
            log_callback(f"💥 PowerBI刷新失败: 0/{len(reports)}")
        return True
    
    except InterruptedError as e:
        log_callback(f"⚠️ PowerBI数据刷新已中断: {e}")
        return False
    except Exception as e:
        log_callback(f"PowerBI数据刷新过程中出错: {str(e)}")
        return False
    finally:
        # 关闭浏览器（所有报表处理完成后才关闭）
        if manager:
            try:
                manager.close()
            except Exception as e:
                log_callback(f"关闭浏览器时出错: {str(e)}")
        # 释放任务锁
        release_task_lock(task_name)

def main():
    """主函数"""
    try:
        refresh_all_powerbi_data(headless=False)
    except Exception as e:
        print(f"批量刷新失败: {str(e)}")
        sys.exit(1)

if __name__ == '__main__':
    main()