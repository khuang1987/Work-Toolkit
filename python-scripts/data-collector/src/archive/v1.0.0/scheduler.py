import csv
import time
import threading
import os
import sys

class Scheduler:
    def __init__(self, app, config_path):
        self.app = app
        self.config_path = config_path
        self.refresh_times = []
        self.running = False
        self.load_config()

    def load_config(self):
        """加载定时任务配置"""
        try:
            with open(self.config_path, 'r') as f:
                reader = csv.reader(f)
                self.refresh_times = next(reader)
                self.app.gui.update_time_listbox(self.refresh_times)
        except (FileNotFoundError, StopIteration, IndexError):
            self.refresh_times = []  # 配置文件不存在或格式不正确时使用空列表

    def save_config(self):
        """保存定时任务配置"""
        try:
            with open(self.config_path, 'w', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(self.refresh_times)
            self.app.gui.update_status_bar("配置已保存")
            self.app.gui.add_info_message("配置已保存")
        except Exception as e:
            self.app.show_error("保存配置失败", str(e))

    def add_schedule_time(self, hour, minute):
        """添加定时执行时间"""
        try:
            if not (0 <= hour <= 23 and 0 <= minute <= 59):
                raise ValueError
            
            time_str = f"{hour:02d}:{minute:02d}"
            if time_str not in self.refresh_times:
                self.refresh_times.append(time_str)
                self.refresh_times.sort()
                self.app.gui.update_time_listbox(self.refresh_times)
        except ValueError:
            self.app.show_error("错误", "请输入有效的时间")

    def delete_schedule_time(self, index):
        """删除选中的定时执行时间"""
        if 0 <= index < len(self.refresh_times):
            self.refresh_times.pop(index)
            self.app.gui.update_time_listbox(self.refresh_times)

    def toggle_schedule(self):
        """切换定时任务状态"""
        if not self.running:
            if not self.refresh_times:
                self.app.show_error("错误", "请至少添加一个执行时间")
                return
            
            self.running = True
            self.app.gui.start_btn.config(text="停止定时任务")
            self.app.gui.update_status_bar("定时任务已启动")
            
            # 启动定时任务线程
            self.schedule_thread = threading.Thread(target=self.run_schedule)
            self.schedule_thread.daemon = True
            self.schedule_thread.start()
        else:
            self.running = False
            self.app.gui.start_btn.config(text="启动定时任务")
            self.app.gui.update_status_bar("定时任务已停止")

    def run_schedule(self):
        """运行定时任务"""
        while self.running:
            try:
                current_time = time.strftime("%H:%M")
                if current_time in self.refresh_times:
                    self.app.gui.update_status_bar(f"正在执行定时任务 - {current_time}")
                    self.app.gui.add_info_message(f"开始执行定时任务 - {current_time}")
                    
                    # 使用线程执行任务，避免阻塞主线程
                    task_thread = threading.Thread(target=self.app.run_all_tasks)
                    task_thread.daemon = True
                    task_thread.start()
                    
                    self.app.gui.add_info_message(f"定时任务执行完成 - {current_time}")
                    time.sleep(60)  # 等待1分钟，避免重复执行
                time.sleep(30)  # 每30秒检查一次
            except Exception as e:
                self.app.gui.add_info_message(f"定时任务执行出错: {str(e)}")
                self.app.gui.update_status_bar("定时任务出错")
                time.sleep(60)  # 出错后等待1分钟再继续