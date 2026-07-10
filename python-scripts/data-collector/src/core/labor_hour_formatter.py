import os
import zipfile
import shutil
import sys
from datetime import datetime
import time
import psutil  # 用于进程管理
import re  # 用于路径处理
from utils.task_lock_manager import (
    acquire_task_lock, release_task_lock, is_task_locked,
    is_interrupted, InterruptedError
)
import pandas as pd

def get_base_path():
    """获取项目根目录路径"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        current_dir = os.path.dirname(__file__)  # core目录
        src_dir = os.path.dirname(current_dir)   # src目录
        return os.path.dirname(src_dir)         # 项目根目录

def get_path_from_config(path_name):
    """从配置文件中获取路径"""
    base_path = get_base_path()
    config_path = os.path.join(base_path, 'config', 'path_config.csv')
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"配置文件不存在: {config_path}")
    df = pd.read_csv(config_path)
    path_value = df[df['path_name'] == path_name]['path_value'].values[0]
    return path_value.replace('{username}', os.getlogin()).replace('{app_dir}', base_path)

def get_labor_hour_config():
    """获取工时相关的配置"""
    base_path = get_base_path()
    config_path = os.path.join(base_path, 'config', 'labor_hour_config.csv')
    
    # 如果配置文件不存在，创建默认配置
    if not os.path.exists(config_path):
        default_config = {
            'zip_filename': ['YPP_M03_Q5003.ZIP'],
            'extracted_filename': ['YPP_M03_Q5003_00000.xls'],
            'output_filename': ['YPP_M03_Q5003_00000.xlsx']
        }
        df = pd.DataFrame(default_config)
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        df.to_csv(config_path, index=False)
        return default_config
    
    df = pd.read_csv(config_path)
    return {
        'zip_filename': df['zip_filename'].iloc[0] if 'zip_filename' in df.columns else 'YPP_M03_Q5003.ZIP',
        'extracted_filename': df['extracted_filename'].iloc[0] if 'extracted_filename' in df.columns else 'YPP_M03_Q5003_00000.xls',
        'output_filename': df['output_filename'].iloc[0] if 'output_filename' in df.columns else 'YPP_M03_Q5003_00000.xlsx'
    }

def extract_filename(path):
    """从路径中提取文件名"""
    if not path:
        return path
    # 检查是否是路径格式
    if os.path.sep in path or '/' in path:
        return os.path.basename(path)
    return path

def simplify_log_message(message):
    """简化日志消息，将路径替换为文件名"""
    if not message:
        return message
    
    # 替换常见的路径模式
    # 匹配形如 C:\path\to\file.ext 的Windows路径
    message = re.sub(r'[A-Za-z]:\\(?:[^\\:*?"<>|\r\n]+\\)*([^\\:*?"<>|\r\n]+)', r'\1', message)
    # 匹配形如 /path/to/file.ext 的Unix路径
    message = re.sub(r'/(?:[^/]+/)*([^/]+)', r'\1', message)
    
    return message

def format_labor_hour(callback=None):
    """格式化工时数据"""
    # 检查任务锁
    task_name = "工时数据格式化"
    if is_task_locked(task_name):
        if callback:
            callback(f"⚠️ {task_name}任务正在执行中，请等待当前任务完成")
        return False
    
    if not acquire_task_lock(task_name):
        if callback:
            callback(f"❌ 无法获取{task_name}任务锁，任务可能正在执行中")
        return False
    
    try:
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
        # 从配置文件获取路径和文件名
        try:
            data_folder = get_path_from_config('laborhour_folder')
            labor_config = get_labor_hour_config()
            attachment_name = labor_config['zip_filename']
            target_zip_path = os.path.join(data_folder, attachment_name)
        except Exception as e:
            log_callback(f"[ERROR] 读取配置文件失败: {e}")
            return False


        # 检查ZIP文件是否存在
        if os.path.exists(target_zip_path):
            # 检测ZIP文件日期与当前日期比较
            try:
                # 获取ZIP文件的修改时间
                zip_mtime = os.path.getmtime(target_zip_path)
                zip_date = datetime.fromtimestamp(zip_mtime)
                zip_date_str = zip_date.strftime("%Y-%m-%d")
                
                # 获取当前日期
                current_date_obj = datetime.now()
                current_date_str = current_date_obj.strftime("%Y-%m-%d")
                
                # 比较日期
                if zip_date_str != current_date_str:
                    log_callback(f"[WARN] 日期不匹配！ZIP文件日期({zip_date_str})与当前日期({current_date_str})不一致，跳过处理")
                    return
                    
            except Exception as e:
                log_callback(f"[ERROR] 检测文件日期时出错: {e}")
                return
            
            try:
                # 清理所有YPP开头的xls文件
                try:
                    for file in os.listdir(data_folder):
                        if file.startswith('YPP') and file.endswith('.xls'):
                            file_path = os.path.join(data_folder, file)
                            try:
                                # 检查是否有进程占用文件
                                for proc in psutil.process_iter(['pid', 'name', 'open_files']):
                                    try:
                                        for open_file in proc.info['open_files'] or []:
                                            if open_file.path.lower() == file_path.lower():
                                                proc.terminate()
                                                proc.wait(timeout=3)
                                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired):
                                        pass
                                
                                # 删除文件
                                os.remove(file_path)
                                log_callback(f"[INFO] 删除旧文件: {file}")
                            except Exception as e:
                                log_callback(f"[WARN] 删除文件 {file} 时出错: {e}")
                except Exception as e:
                    log_callback(f"[WARN] 清理文件时出错: {e}")

                # 解压文件到目标文件夹
                with zipfile.ZipFile(target_zip_path, 'r') as zip_ref:
                    zip_ref.extractall(data_folder)
                    log_callback(f"[INFO] 解压完成，检查文件列表...")
                    # 列出解压后的文件
                    for file in os.listdir(data_folder):
                        if file.startswith('YPP'):
                            log_callback(f"[INFO] 找到文件: {file}")

                log_callback("[INFO] 开始转换文件，请不要关闭程序和窗口...")

                # Convert xls to xlsx
                def convert_xls_to_xlsx(input_file, output_file, retries=3):
                    excel = None
                    workbook = None
                    attempt = 0
                    
                    # 清理 win32com 缓存（解决 CLSIDToPackageMap 错误）
                    def clear_win32com_cache():
                        try:
                            import win32com
                            gen_py_path = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Temp', 'gen_py')
                            if os.path.exists(gen_py_path):
                                shutil.rmtree(gen_py_path, ignore_errors=True)
                                log_callback("[INFO] 已清理 win32com 缓存")
                            # 也尝试清理 win32com 模块内的缓存路径
                            if hasattr(win32com, '__gen_path__'):
                                cache_path = win32com.__gen_path__
                                if os.path.exists(cache_path):
                                    shutil.rmtree(cache_path, ignore_errors=True)
                        except Exception as e:
                            log_callback(f"[WARN] 清理缓存时出错: {e}")
                    
                    # 强制关闭所有 Excel 进程
                    def kill_excel_processes():
                        killed = False
                        for proc in psutil.process_iter(['pid', 'name']):
                            try:
                                if proc.info['name'] and 'excel' in proc.info['name'].lower():
                                    proc.terminate()
                                    proc.wait(timeout=5)
                                    killed = True
                            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired):
                                pass
                        if killed:
                            log_callback("[INFO] 已关闭残留的 Excel 进程")
                            time.sleep(1)  # 等待进程完全退出
                    
                    while attempt < retries:
                        try:
                            # 首次尝试或重试时清理缓存和进程
                            if attempt == 0:
                                kill_excel_processes()
                            elif attempt > 0:
                                clear_win32com_cache()
                                kill_excel_processes()
                            
                            # 延迟导入，确保缓存清理后再加载
                            from win32com.client import Dispatch
                            
                            # 确保路径正确编码
                            input_file = os.path.abspath(input_file)
                            output_file = os.path.abspath(output_file)
                            
                            # 检查文件是否存在
                            if not os.path.exists(input_file):
                                log_callback(f"[ERROR] 输入文件不存在: {input_file}")
                                return False
                            
                            # 创建新的 Excel 实例
                            excel = Dispatch('Excel.Application')
                            excel.Visible = False
                            excel.DisplayAlerts = False

                            # 打开工作簿
                            workbook = excel.Workbooks.Open(input_file, IgnoreReadOnlyRecommended=True)
                            
                            # 如果输出文件已存在，先删除
                            if os.path.exists(output_file):
                                os.remove(output_file)
                            
                            # 保存为xlsx格式
                            workbook.SaveAs(output_file, FileFormat=51, ConflictResolution=2)
                            
                            # 关闭工作簿但不退出Excel
                            workbook.Close(SaveChanges=False)
                            workbook = None
                            
                            log_callback(f"[INFO] 文件转换成功: {os.path.basename(output_file)}")
                            os.remove(input_file)  # 删除转换后的 .xls 文件
                            break  # Exit the loop if successful
                            
                        except Exception as e:
                            log_callback(f"[ERROR] 转换失败 (尝试 {attempt + 1}/{retries}): {str(e)}")
                            attempt += 1
                            if attempt < retries:
                                log_callback(f"[INFO] 等待5秒后重试...")
                                time.sleep(5)  # Wait before retrying
                            else:
                                log_callback("[ERROR] 多次尝试后仍然失败，请检查文件是否被占用")
                        finally:
                            # 关闭工作簿
                            if workbook:
                                try:
                                    workbook.Close(SaveChanges=False)
                                except:
                                    pass
                            # 退出 Excel 实例
                            if excel:
                                try:
                                    excel.Quit()
                                except:
                                    pass
                                excel = None

                # 指定输入和输出文件路径
                input_file = os.path.join(data_folder, labor_config['extracted_filename'])
                output_file = os.path.join(data_folder, labor_config['output_filename'])

                # 检查解压后的文件是否存在
                if not os.path.exists(input_file):
                    log_callback(f"[ERROR] 解压后的文件不存在: {input_file}")
                    return False

                # 转换文件
                success = convert_xls_to_xlsx(input_file, output_file)
                if not success:
                    return False
                
                # 转换完成后，再次清理所有YPP开头的xls文件
                try:
                    for file in os.listdir(data_folder):
                        if file.startswith('YPP') and file.endswith('.xls'):
                            file_path = os.path.join(data_folder, file)
                            try:
                                os.remove(file_path)
                                log_callback(f"[INFO] 清理转换后的xls文件: {file}")
                            except Exception as e:
                                log_callback(f"[WARN] 删除文件 {file} 时出错: {e}")
                except Exception as e:
                    log_callback(f"[WARN] 最终清理文件时出错: {e}")
                
            except Exception as e:
                log_callback(f"[ERROR] 处理过程中出错: {e}")
                return False
        else:
            log_callback(f"[ERROR] 未找到ZIP文件: {target_zip_path}")
            return False
        
        log_callback("[INFO] 工时数据格式化完成")
        return True
    
    except InterruptedError as e:
        log_callback(f"⚠️ 工时数据格式化已中断: {e}")
        return False
    except Exception as e:
        log_callback(f"[CRITICAL] 程序运行时发生未捕获的异常: {e}")
        return False
    finally:
        # 释放任务锁
        release_task_lock(task_name)

if __name__ == "__main__":
    format_labor_hour()

