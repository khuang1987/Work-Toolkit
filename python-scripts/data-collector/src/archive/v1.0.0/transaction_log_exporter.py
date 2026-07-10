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

def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.dirname(__file__))

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

def main(callback=None):
    # 如果没有提供回调函数，使用默认的日志处理
    if callback is None:
        log_callback = lambda message: print(message)
    else:
        # 修改回调函数定义，只传递message参数
        log_callback = lambda message: callback(message)
    # 检查无线网络名称
    def get_connected_ssid():
        # 方法1：使用netsh命令 - 更高效的实现
        def get_ssid_netsh():
            try:
                result = subprocess.check_output(["netsh", "wlan", "show", "interfaces"], 
                                               stderr=subprocess.DEVNULL,
                                               timeout=3)
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
        return ssid

    try:
        ssid = get_connected_ssid()
        if not ssid:
            log_callback("无法获取无线网络名称")
            return
        if ssid.lower() != 'mdtmobile':
            log_callback(f"当前无线网络不是 'mdtmobile'，当前网络: {ssid}")
            return
    except Exception as e:
        log_callback(f"程序终止: {e}")
        return

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
        return

    # 定义保存路径
    save_path = os.path.join(os.path.expanduser("~"), "OneDrive - Medtronic PLC", "General - CZ Production", "POWER BI 数据源 V2", "20-GoodsMovement")

    # 计算年份列表: 当前年份及前4年，共5年
    current_year = datetime.now().year
    years = [current_year - i for i in range(5)]

    # 循环导出每个年份的数据
    for year in years:
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
            return

if __name__ == "__main__":
    main()
