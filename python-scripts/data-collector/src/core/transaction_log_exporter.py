import pandas as pd
import pyodbc
import os
from datetime import datetime, timedelta
import subprocess
import sys
import time
from sqlalchemy import create_engine
from sqlalchemy.pool import QueuePool
import contextlib
import logging
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

# 创建数据库引擎，使用连接池提高性能
def create_db_engine(server, database, username, password):
    connection_string = f'mssql+pyodbc://{username}:{password}@{server}/{database}?driver=SQL+Server'
    return create_engine(
        connection_string,
        poolclass=QueuePool,
        pool_size=5,
        max_overflow=10,
        pool_timeout=30,
        pool_recycle=1800
    )

# 使用上下文管理器安全地管理数据库连接
@contextlib.contextmanager
def get_db_connection(engine):
    connection = engine.connect()
    try:
        yield connection
    finally:
        connection.close()

def get_path_from_config(path_name):
    base_path = get_base_path()
    config_path = os.path.join(base_path, 'config', 'path_config.csv')
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"配置文件不存在: {config_path}")
    df = pd.read_csv(config_path)
    path_value = df[df['path_name'] == path_name]['path_value'].values[0]
    return path_value.replace('{username}', os.getlogin()).replace('{app_dir}', base_path)

def export_transaction_log(callback=None):
    """导出交易日志数据"""
    # 检查任务锁
    task_name = "交易日志导出"
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
    
    try:
        # 设置日志
        base_path = get_base_path()
        
        # 检查无线网络名称
        def get_connected_ssid():
            # 方法1：使用netsh命令 - 更高效的实现
            def get_ssid_netsh():
                try:
                    result = subprocess.check_output(["netsh", "wlan", "show", "interfaces"], 
                                                   stderr=subprocess.DEVNULL,
                                                   timeout=3,
                                                   creationflags=subprocess.CREATE_NO_WINDOW)
                    result = result.decode("utf-8", errors='ignore')
                    # 使用更高效的字符串搜索方式
                    for line in result.splitlines():
                        if "SSID" in line and "BSSID" not in line:
                            return line.split(":", 1)[1].strip()
                except (subprocess.SubprocessError, IndexError, UnicodeDecodeError, TimeoutError):
                    return None

            # 方法2：使用WMI查询 - 仅在必要时导入wmi模块
            def get_ssid_wmi():
                try:
                    import wmi
                    c = wmi.WMI()
                    # 优化查询条件，减少遍历次数
                    for interface in c.Win32_NetworkAdapter(NetEnabled=True, PhysicalAdapter=True):
                        for config in c.Win32_NetworkAdapterConfiguration(InterfaceIndex=interface.InterfaceIndex):
                            if config.Description and "wireless" in config.Description.lower():
                                return config.SettingID
                except Exception:
                    return None

            # 减少重试次数和等待时间，提高响应速度
            max_retries = 2
            retry_delay = 0.5  # 秒

            # 首先尝试netsh方法（最常用且最快的方法）
            ssid = get_ssid_netsh()
            if ssid:
                return ssid

            # 如果netsh方法失败，尝试WMI方法
            ssid = get_ssid_wmi()
            if ssid:
                return ssid
                
            # 如果两种方法都失败，最多再尝试一次netsh方法
            time.sleep(retry_delay)
            ssid = get_ssid_netsh()
            if not ssid:
                log_callback("无法获取无线网络名称")
                return None
            return ssid

        try:
            ssid = get_connected_ssid()
            if not ssid:
                log_callback("无法获取无线网络名称")
                return False
            if ssid.lower() != 'mdtmobile':
                log_callback(f"当前无线网络不是 'mdtmobile'，当前网络: {ssid}")
                return False
        except Exception as e:
            log_callback(f"程序终止: {e}")
            return False

        # SQL 数据库连接配置
        server = '192.168.103.1'
        database = 'sps'
        username = 'sa'
        password = 'sps'
        connection_string = f'mssql+pyodbc://{username}:{password}@{server}/{database}?driver=SQL+Server'

        try:
            # 使用优化后的数据库连接方式
            engine = create_db_engine(server, database, username, password)
            # 测试连接是否成功
            with get_db_connection(engine) as conn:
                pass
        except Exception as e:
            log_callback(f"数据库连接失败: {str(e)}")
            return False

        # 定义保存路径
        save_path = get_path_from_config('transaction_folder')
        log_callback(f"保存路径: {save_path}")

        # 计算年份列表: 当前年份及前4年，共5年
        current_year = datetime.now().year
        years = [current_year - i for i in range(5)]

        # 循环导出每个年份的数据
        for year in years:
            # 检查中断标志
            if is_interrupted():
                log_callback("⚠️ 检测到中断请求，停止任务...")
                raise InterruptedError("任务已被用户中断")
            
            file_name = f'exported_data-{year}.csv'
            csv_file_path = os.path.join(save_path, file_name)
            
            # 对于前几年的数据，如果文件已存在则跳过
            if year != current_year and os.path.exists(csv_file_path):
                log_callback(f"{year} 年数据文件已存在，跳过导出")
                continue
            
            # 定义查询时间范围
            start_time = datetime(year, 1, 1, 0, 0, 0)
            if year == current_year:
                end_time = datetime.now()
            else:
                end_time = datetime(year + 1, 1, 1, 0, 0, 0)
            
            # SQL 查询
            query_date_range = """
            SELECT 
                T.TRANSTARTDATETIME AS 下单时间,
                T.TRANENDDATETIME AS 结束时间,
                T.ITEMNUMBER AS 物料号,
                I.DESCR AS 物料描述,
                I.ITEMGROUP AS 物料组,
                T.JOBNUMBER AS 产品号,
                T.AUX1 AS 批次号,
                T.AUX2 AS 工序号,
                T.MACHINENUMBER AS 机床号,
                U.DESCR AS 员工姓名,
                T.QTY AS 领取数量,
                V.DESCR AS 库位描述,
                T.LOCATIONTEXT AS 位置信息,
                T.USERGROUP01 AS 区域描述
            FROM dbo.TransactionLog T
            JOIN dbo.Users U ON T.USERNUMBER = U.USERNUMBER
            JOIN dbo.VendingMachines V ON T.VMID = V.VMID
            JOIN dbo.Items I ON T.ITEMNUMBER = I.ITEMNUMBER
            WHERE T.TRANENDDATETIME >= ? 
              AND T.TRANENDDATETIME < ?
            ORDER BY T.TRANSTARTDATETIME
            """
        
            try:
                # 使用上下文管理器确保连接正确关闭
                with get_db_connection(engine) as conn:
                    # 设置pandas选项以避免警告
                    pd.options.mode.chained_assignment = None
                    
                    # 使用分块读取大数据集，减少内存使用
                    log_callback(f"开始导出 {year} 年数据...")
                    
                    # 对于大数据集，使用分块处理
                    if year != current_year:  # 历史数据可能较大，使用分块处理
                        chunks = []
                        # 使用chunksize参数分块读取数据
                        for chunk in pd.read_sql(query_date_range, conn, params=(start_time, end_time), chunksize=10000):
                            chunks.append(chunk)
                        
                        if chunks:  # 确保有数据
                            df_date_range = pd.concat(chunks, ignore_index=True)
                            # 使用更高效的CSV写入方式
                            df_date_range.to_csv(csv_file_path, index=False, encoding='utf-8-sig', mode='w')
                            log_callback(f"{year} 年数据已导出，共 {len(df_date_range)} 条记录")
                        else:
                            log_callback(f"{year} 年无数据")
                    else:  # 当前年份数据量可能较小，直接处理
                        df_date_range = pd.read_sql(query_date_range, conn, params=(start_time, end_time))
                        df_date_range.to_csv(csv_file_path, index=False, encoding='utf-8-sig')
                        log_callback(f"{year} 年数据已导出，共 {len(df_date_range)} 条记录")
                        
            except Exception as e:
                log_callback(f"查询执行失败: {str(e)}")
                return False

        # 导出完成后，输出文件夹中最新的文件名称和更新时间
        latest_file = max(os.listdir(save_path), key=lambda x: os.path.getmtime(os.path.join(save_path, x)))
        latest_file_path = os.path.join(save_path, latest_file)
        latest_file_time = datetime.fromtimestamp(os.path.getmtime(latest_file_path)).strftime('%Y-%m-%d %H:%M:%S')
        log_callback(f"导出完成，最新文件: {latest_file}，更新时间: {latest_file_time}")
        return True
    
    except InterruptedError as e:
        log_callback(f"⚠️ 交易日志导出已中断: {e}")
        return False
    except Exception as e:
        log_callback(f"交易日志导出过程中出错: {str(e)}")
        return False
    finally:
        # 释放任务锁
        release_task_lock(task_name)

if __name__ == "__main__":
    export_transaction_log()
