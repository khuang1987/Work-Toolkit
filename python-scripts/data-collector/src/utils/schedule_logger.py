import csv
import os
from datetime import datetime
from typing import List, Dict

class ScheduleLogger:
    """定时刷新日志管理器"""
    
    def __init__(self, log_path: str):
        """
        初始化日志管理器
        
        Args:
            log_path: 日志文件路径
        """
        self.log_path = log_path
        self._ensure_log_file()
    
    def _ensure_log_file(self):
        """确保日志文件存在，如果不存在则创建"""
        if not os.path.exists(self.log_path):
            os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
            with open(self.log_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=[
                    'execution_date',
                    'schedule_time',
                    'start_time',
                    'end_time',
                    'status',
                    'error_message'
                ])
                writer.writeheader()
    
    def log_execution(
        self,
        schedule_time: str,
        start_time: datetime,
        end_time: datetime,
        status: str,
        error_message: str = ""
    ):
        """
        记录一次定时执行
        
        Args:
            schedule_time: 计划执行时间 (HH:MM)
            start_time: 实际开始时间
            end_time: 实际结束时间
            status: 执行状态 (成功/失败)
            error_message: 错误信息（如果有）
        """
        with open(self.log_path, 'a', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=[
                'execution_date',
                'schedule_time',
                'start_time',
                'end_time',
                'status',
                'error_message'
            ])
            writer.writerow({
                'execution_date': start_time.strftime('%Y-%m-%d'),
                'schedule_time': schedule_time,
                'start_time': start_time.strftime('%Y-%m-%d %H:%M:%S'),
                'end_time': end_time.strftime('%Y-%m-%d %H:%M:%S'),
                'status': status,
                'error_message': error_message
            })
    
    def get_recent_logs(self, count: int = 10) -> List[Dict]:
        """
        获取最近的执行记录
        
        Args:
            count: 返回记录数量
            
        Returns:
            List[Dict]: 执行记录列表
        """
        try:
            with open(self.log_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                logs = list(reader)
                # 返回最近的 N 条记录（倒序）
                return logs[-count:] if len(logs) > count else logs
        except FileNotFoundError:
            return []
    
    def format_log_for_display(self, log: Dict) -> str:
        """
        格式化日志记录用于显示
        
        Args:
            log: 日志记录字典
            
        Returns:
            str: 格式化的日志字符串
        """
        status_icon = "✅" if log['status'] == "成功" else "❌"
        
        # 计算执行时长
        try:
            start = datetime.strptime(log['start_time'], '%Y-%m-%d %H:%M:%S')
            end = datetime.strptime(log['end_time'], '%Y-%m-%d %H:%M:%S')
            duration = (end - start).total_seconds()
            duration_str = f"{int(duration // 60)}分{int(duration % 60)}秒"
        except:
            duration_str = "未知"
        
        result = f"{status_icon} {log['execution_date']} {log['schedule_time']} - {log['status']} (耗时: {duration_str})"
        
        if log['error_message']:
            result += f"\n   错误: {log['error_message'][:100]}"
        
        return result
