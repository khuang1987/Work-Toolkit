import os
import zipfile
import shutil
import sys
from datetime import datetime
import time
from win32com.client import gencache, Dispatch
import psutil  # 用于进程管理
import re  # 用于路径处理

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

def main(callback=None):
    # 如果没有提供回调函数，使用默认的日志处理
    if callback is None:
        log_callback = lambda message: print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {simplify_log_message(message)}")
    else:
        # 包装回调函数以适配GUI日志格式
        log_callback = lambda message: callback(message)

    try:
        # 获取当前日期
        current_date = datetime.now().strftime("%d.%m.%Y")
        log_callback(f"[INFO] 当前日期: {current_date}")

        # 定义路径
        username = os.getlogin()  # 获取当前用户的用户名
        data_folder = f'C:\\Users\\{username}\\OneDrive - Medtronic PLC\\General - CZ Production\\POWER BI 数据源 V2\\40-SAP工时'
        attachment_name = 'YPP_M03_Q5003.ZIP'  # 更新文件名
        target_zip_path = os.path.join(data_folder, attachment_name)

        # 检查ZIP文件是否存在
        if os.path.exists(target_zip_path):
            log_callback(f"[INFO] 找到ZIP文件: {target_zip_path}")
            try:
                # 检查并删除已存在的.xls文件
                input_file = os.path.join(data_folder, 'YPP_M03_Q5003_00000.xls')
                if os.path.exists(input_file):
                    try:
                        # 检查是否有进程占用文件
                        for proc in psutil.process_iter(['pid', 'name', 'open_files']):
                            try:
                                for file in proc.info['open_files'] or []:
                                    if file.path.lower() == input_file.lower():
                                        log_callback(f"[INFO] 找到占用文件的进程: {proc.info['name']} (PID: {proc.info['pid']})")
                                        proc.terminate()
                                        proc.wait(timeout=3)
                                        log_callback(f"[INFO] 已终止进程: {proc.info['name']}")
                            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired) as e:
                                log_callback(f"[WARN] 检查进程时出现警告: {e}")
                        
                        # 尝试删除文件
                        os.remove(input_file)
                        log_callback(f"[INFO] 删除已存在的文件: {input_file}")
                    except Exception as e:
                        log_callback(f"[ERROR] 删除文件时出错: {e}")
                        raise

                # 解压文件到目标文件夹
                with zipfile.ZipFile(target_zip_path, 'r') as zip_ref:
                    zip_ref.extractall(data_folder)
                    log_callback(f"[INFO] 成功解压: {target_zip_path}")

                log_callback("[INFO] 开始转换文件，请不要关闭程序和窗口...")

                # Convert xls to xlsx
                def convert_xls_to_xlsx(input_file, output_file, retries=3):
                    excel = None
                    attempt = 0
                    while attempt < retries:
                        try:
                            # Clear and regenerate the cache
                            gencache.is_readonly = False
                            shutil.rmtree(gencache.GetGeneratePath(), ignore_errors=True)
                            excel = Dispatch('Excel.Application')
                            excel.Visible = False  # 设置Excel为不可见
                            excel.DisplayAlerts = False  # 禁用所有Excel警告

                            log_callback(f"[INFO] 打开文件: {input_file}")
                            # Add parameter to ignore errors and automatically overwrite existing files
                            workbook = excel.Workbooks.Open(input_file, IgnoreReadOnlyRecommended=True)
                            if os.path.exists(output_file):
                                log_callback(f"[INFO] 删除已有文件: {output_file}")
                                os.remove(output_file)  # 如果存在同名文件，则删除
                            log_callback(f"[INFO] 保存文件为: {output_file}")
                            workbook.SaveAs(output_file, FileFormat=51, ConflictResolution=2)  # ConflictResolution=2 is for automatically overwriting existing files
                            workbook.Close()
                            log_callback(f"[INFO] 文件转换成功并保存为 {output_file}")
                            os.remove(input_file)  # 删除转换后的 .xls 文件
                            log_callback(f"[INFO] 删除原始文件: {input_file}")
                            break  # Exit the loop if successful
                        except Exception as e:
                            log_callback(f"[ERROR] 发生错误: {e}")
                            attempt += 1
                            if attempt < retries:
                                log_callback(f"[INFO] 重试 {attempt}/{retries}...")
                                time.sleep(5)  # Wait before retrying
                            else:
                                log_callback("[ERROR] 多次尝试后仍然失败")
                        finally:
                            if excel:
                                excel.Quit()
                                log_callback("[INFO] 关闭Excel应用程序")

                # 指定输入和输出文件路径
                input_file = os.path.join(data_folder, 'YPP_M03_Q5003_00000.xls')
                output_file = os.path.join(data_folder, 'YPP_M03_Q5003_00000.xlsx')

                # 转换文件
                convert_xls_to_xlsx(input_file, output_file)
                
                # 删除 .xls 文件
                if os.path.exists(input_file):
                    os.remove(input_file)
                    log_callback(f"[INFO] 删除原始文件: {input_file}")
                
            except Exception as e:
                log_callback(f"[ERROR] 处理过程中出错: {e}")
            finally:
                # 清理
                log_callback("[INFO] 清理完成。")
        else:
            log_callback(f"[ERROR] 未找到ZIP文件: {target_zip_path}")
    except Exception as e:
        log_callback(f"[CRITICAL] 程序运行时发生未捕获的异常: {e}")

if __name__ == "__main__":
    main()

