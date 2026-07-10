import csv
import time
import threading
import os
import sys
from datetime import datetime, date
from utils.schedule_logger import ScheduleLogger

class Scheduler:
    def __init__(self, app, config_path):
        self.app = app
        self.config_path = config_path
        self.schedule_times = []  # 存储计划时间
        self.last_executions = {}  # 存储每个时间的最后执行时间
        self.running = False
        self.today_executed = set()  # 今天已执行的时间点
        self.current_date = date.today()  # 当前日期，用于检测日期变化
        self.task_running = False  # 任务执行状态标志
        
        # 初始化日志管理器
        log_dir = os.path.join(os.path.dirname(config_path), 'schedule_history.csv')
        self.logger = ScheduleLogger(log_dir)
        
        self.load_config()

    def load_config(self):
        """加载定时任务配置"""
        try:
            with open(self.config_path, 'r') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    self.schedule_times.append(row['schedule_time'])
                    if row['last_execution_time']:
                        self.last_executions[row['schedule_time']] = row['last_execution_time']
                    else:
                        self.last_executions[row['schedule_time']] = None
                # 更新GUI中的时间设置
                self.app.gui.update_time_listbox(self.schedule_times)
        except (FileNotFoundError, StopIteration, IndexError):
            self.schedule_times = []  # 配置文件不存在或格式不正确时使用空列表
            self.last_executions = {}

    def save_config(self):
        """保存定时任务配置"""
        try:
            with open(self.config_path, 'w', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=['schedule_time', 'last_execution_time'])
                writer.writeheader()
                for time_str in self.schedule_times:
                    writer.writerow({
                        'schedule_time': time_str,
                        'last_execution_time': self.last_executions.get(time_str, '')
                    })
            self.app.gui.update_status_bar("配置已保存")
            self.app.gui.add_info_message("配置已保存")
        except Exception as e:
            self.app.show_error("保存配置失败", str(e))

    def update_execution_time(self, time_str):
        """更新指定时间的最后执行时间"""
        self.last_executions[time_str] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.save_config()

    def check_missed_executions(self):
        """检查是否有错过的执行时间 - 移除今天是否已执行的检查"""
        current_time = datetime.now()
        missed_times = []
        
        for time_str in self.schedule_times:
            # 检查是否已经过了今天的时间，不管是否已经执行过
            schedule_hour, schedule_minute = map(int, time_str.split(':'))
            schedule_time = current_time.replace(hour=schedule_hour, minute=schedule_minute, second=0, microsecond=0)
            if current_time > schedule_time:
                missed_times.append(time_str)
        
        return missed_times

    def toggle_schedule(self):
        """切换定时任务状态"""
        if not self.running:
            # 检查是否有设置有效的时间
            if not self.schedule_times:
                self.app.show_error("错误", "请至少设置一个执行时间")
                return
            
            # 显示最后一次刷新的时间
            if self.last_executions:
                # 获取最新的执行时间
                latest_execution = max(self.last_executions.values(), key=lambda x: x if x else '')
                if latest_execution:
                    self.app.gui.add_info_message(f"📅 最后一次刷新时间: {latest_execution}")
                else:
                    self.app.gui.add_info_message("📅 暂无刷新记录")
            else:
                self.app.gui.add_info_message("📅 暂无刷新记录")
            
            self.running = True
            self.app.gui.start_btn.config(text="停止定时刷新")
            self.app.gui.update_status_bar("定时任务已启动")
            
            # 启动定时任务线程
            self.schedule_thread = threading.Thread(target=self.run_schedule)
            self.schedule_thread.daemon = True
            self.schedule_thread.start()
        else:
            self.running = False
            self.app.gui.start_btn.config(text="启动定时刷新")
            self.app.gui.update_status_bar("定时任务已停止")

    def _check_date_change(self):
        """检查日期是否变化，如果变化则重置今日执行记录"""
        today = date.today()
        if today != self.current_date:
            self.current_date = today
            self.today_executed.clear()
            self.app.gui.add_info_message(f"📅 日期已更新: {today.strftime('%Y-%m-%d')}")

    def _should_execute(self, time_str: str) -> bool:
        """判断是否应该执行指定时间的任务
        
        使用时间窗口匹配，避免错过执行：
        - 当前时间在 [设定时间, 设定时间+2分钟) 范围内
        - 今天该时间点尚未执行
        - 当前没有任务正在执行
        """
        if time_str in self.today_executed:
            return False
        
        if self.task_running:
            return False
        
        try:
            now = datetime.now()
            schedule_hour, schedule_minute = map(int, time_str.split(':'))
            schedule_time = now.replace(hour=schedule_hour, minute=schedule_minute, second=0, microsecond=0)
            
            # 时间窗口：设定时间到设定时间后2分钟
            time_diff = (now - schedule_time).total_seconds()
            return 0 <= time_diff < 120  # 2分钟窗口
        except:
            return False

    def _execute_task(self, time_str: str):
        """执行定时任务（带状态跟踪和日志记录）"""
        self.task_running = True
        self.today_executed.add(time_str)
        
        start_time = datetime.now()
        task_success = True
        error_msg = ""
        
        try:
            self.app.gui.update_status_bar(f"正在执行定时任务 - {time_str}", "info")
            self.app.gui.add_info_message(f"⏰ 开始执行定时任务 - {time_str}")
            
            # 显示桌面通知 - 任务开始
            if hasattr(self.app, 'system_tray') and self.app.system_tray:
                self.app.system_tray.show_balloon(
                    "定时任务开始",
                    f"定时刷新任务开始执行\n执行时间: {time_str}"
                )
            
            # 启动任务执行
            self.app.run_all_tasks()
            
            # 等待所有任务完成 - 检查任务队列是否为空
            import time as time_module
            max_wait_time = 3600  # 最多等待1小时
            wait_start = time_module.time()
            
            while True:
                # 检查是否超时
                if time_module.time() - wait_start > max_wait_time:
                    raise TimeoutError("定时任务执行超时")
                
                # 检查任务队列是否为空（所有任务已完成）
                if not hasattr(self.app, 'task_queue') or not self.app.task_queue:
                    break
                
                # 短暂等待后再检查
                time_module.sleep(1)
            
            # 额外等待2秒确保最后一个任务完全完成
            time_module.sleep(2)
            
            # 更新执行时间
            self.update_execution_time(time_str)
            
            self.app.gui.add_info_message(f"✅ 定时任务执行完成 - {time_str}")
            self.app.gui.update_status_bar("定时任务执行完成", "success")
            
            # 显示桌面通知 - 成功
            if hasattr(self.app, 'system_tray') and self.app.system_tray:
                duration = (datetime.now() - start_time).total_seconds()
                duration_str = f"{int(duration // 60)}分{int(duration % 60)}秒"
                self.app.system_tray.show_balloon(
                    "定时任务完成",
                    f"今天的定时刷新任务已完成\n执行时间: {time_str}\n耗时: {duration_str}"
                )
        except Exception as e:
            task_success = False
            error_msg = str(e)
            
            self.app.gui.add_info_message(f"❌ 定时任务执行失败 - {time_str}: {error_msg}")
            self.app.gui.update_status_bar("定时任务执行失败", "danger")
            
            # 显示桌面通知 - 失败
            if hasattr(self.app, 'system_tray') and self.app.system_tray:
                self.app.system_tray.show_balloon(
                    "定时任务出错",
                    f"定时任务执行失败\n执行时间: {time_str}\n错误: {error_msg[:50]}..."
                )
        finally:
            end_time = datetime.now()
            
            # 记录执行日志
            self.logger.log_execution(
                schedule_time=time_str,
                start_time=start_time,
                end_time=end_time,
                status="成功" if task_success else "失败",
                error_message=error_msg
            )
            
            self.task_running = False
    
    def get_recent_history(self, count: int = 10) -> str:
        """获取最近的执行历史（格式化为字符串）"""
        logs = self.logger.get_recent_logs(count)
        if not logs:
            return "暂无刷新记录"
        
        result = f"最近 {len(logs)} 次定时刷新记录：\n\n"
        for log in reversed(logs):  # 倒序显示，最新的在前
            result += self.logger.format_log_for_display(log) + "\n\n"
        
        return result

    def run_schedule(self):
        """运行定时任务 - 优化版"""
        while self.running:
            try:
                # 检查日期变化，重置今日执行记录
                self._check_date_change()
                
                # 检查是否到达设定的时间
                for time_str in self.schedule_times:
                    if self._should_execute(time_str):
                        # 使用线程执行任务，避免阻塞调度循环
                        task_thread = threading.Thread(target=self._execute_task, args=(time_str,))
                        task_thread.daemon = True
                        task_thread.start()
                        break  # 一次只触发一个任务
                
                time.sleep(10)  # 每10秒检查一次，提高响应速度
            except Exception as e:
                self.app.gui.add_info_message(f"❌ 定时调度出错: {str(e)}")
                self.app.gui.update_status_bar("定时调度出错", "danger")
                time.sleep(30)  # 出错后等待30秒再继续