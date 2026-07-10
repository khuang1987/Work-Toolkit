import tkinter as tk
import sys
from tkinter import ttk
from tkinter import messagebox
from PyQt5.QtCore import QTime
import threading
import time
import subprocess
import csv
import os
import multiprocessing
from queue import Empty
import shutil

class ToolKitApp(tk.Tk):
    CONFIG_PATH = os.path.join(os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.dirname(__file__)), 'config', 'schedule_run_config.csv')
    def __init__(self):
        super().__init__()
        self.title("Toolkit DataCollector v1.0")
        self.geometry("700x500")
        
        # 设置应用图标
        icon_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'assets', 'app_icon.png')
        if os.path.exists(icon_path):
            self.iconphoto(True, tk.PhotoImage(file=icon_path))
        
        # 创建主容器
        main_frame = ttk.Frame(self, padding=10)
        main_frame.pack(expand=True, fill=tk.BOTH)
        
        # 创建上中下三栏容器
        top_panel = ttk.Frame(main_frame)
        top_panel.pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        middle_panel = ttk.Frame(main_frame)
        middle_panel.pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        bottom_panel = ttk.Frame(main_frame)
        bottom_panel.pack(side=tk.BOTTOM, fill=tk.BOTH, expand=True, padx=10, pady=5)

        # 创建上部分左右分栏容器
        left_panel = ttk.Frame(top_panel)
        left_panel.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10)
        
        right_panel = ttk.Frame(top_panel)
        right_panel.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=10)

        # 创建数据处理区（左侧）
        self.create_data_processing_section(left_panel)
        
        # 创建定时任务区（右侧）
        self.create_schedule_section(right_panel)
        
        # 创建工具区（中部）
        self.create_tool_section(middle_panel)
        
        # 创建运行日志区（下部）
        self.create_log_section(bottom_panel)
        
        # 状态栏
        self.status_bar = ttk.Label(self, text="就绪", relief=tk.SUNKEN)
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)
        self.status_bar.configure(background="#90EE90")  # 初始状态为绿色
        
        # 初始化定时任务相关变量
        self.refresh_times = []
        self.running = False
        self.load_config()
        
        # 添加初始信息
        self.add_info_message("程序已启动")

    def add_info_message(self, message, module_name="系统"):
        """添加信息到信息框"""
        # 根据不同的功能模块显示对应的名称
        module_names = {
            "planner_exporter": "Planner数据导出",
            "transaction_log_exporter": "交易日志导出",
            "labor_hour_formatter": "工时数据格式化",
            "product_quantity_formatter": "产量数据格式化",
            "team_shift_manager": "团队班次数据",
            "run_all_tasks": "批量任务执行"
        }
        
        # 如果module_name在映射表中存在，则使用映射的名称
        display_name = module_names.get(module_name, module_name)
        current_time = time.strftime("%Y-%m-%d %H:%M:%S")
        self.info_text.insert(tk.END, f"[{current_time}] [{display_name}] {message}\n")
        self.info_text.see(tk.END)  # 滚动到最新内容



    def create_schedule_section(self, parent):
        """创建定时任务区域"""
        # 创建定时任务框架
        schedule_frame = ttk.LabelFrame(parent, text="定时任务配置", padding=5)
        schedule_frame.pack(fill=tk.BOTH, expand=True, pady=10)

        # 创建左右分栏容器
        left_panel = ttk.Frame(schedule_frame)
        left_panel.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5)
        
        right_panel = ttk.Frame(schedule_frame)
        right_panel.pack(side=tk.RIGHT, fill=tk.BOTH, padx=5)

        # 定时配置区
        time_frame = ttk.Frame(left_panel)
        time_frame.pack(fill=tk.X, pady=5)
        
        # 时间输入区
        input_frame = ttk.Frame(time_frame)
        input_frame.pack(side=tk.LEFT)
        
        # 第一行：时间输入控件
        time_input_row = ttk.Frame(time_frame)
        time_input_row.pack(side=tk.TOP, fill=tk.X, pady=10)
        
        ttk.Label(time_input_row, text="执行时间：").pack(side=tk.LEFT, padx=2)
        
        self.hour_var = tk.StringVar(value="00")
        hour_spin = ttk.Spinbox(time_input_row, from_=0, to=23, width=5, textvariable=self.hour_var)
        hour_spin.pack(side=tk.LEFT, padx=2)
        
        ttk.Label(time_input_row, text=":").pack(side=tk.LEFT)
        
        self.minute_var = tk.StringVar(value="00")
        minute_spin = ttk.Spinbox(time_input_row, from_=0, to=59, width=5, textvariable=self.minute_var)
        minute_spin.pack(side=tk.LEFT, padx=2)

        # 第二行：操作按钮
        button_row = ttk.Frame(time_frame)
        button_row.pack(side=tk.TOP, pady=5, anchor=tk.W)
        
        add_time_btn = ttk.Button(button_row, text="添加时间", command=self.add_schedule_time)
        add_time_btn.pack(side=tk.LEFT, padx=5)
        
        delete_btn = ttk.Button(button_row, text="删除时间", command=self.delete_schedule_time)
        delete_btn.pack(side=tk.LEFT)

        # 控制按钮区
        btn_frame = ttk.Frame(left_panel)
        btn_frame.pack(fill=tk.X, pady=5)
        
        self.start_btn = ttk.Button(btn_frame, text="启动定时任务", command=self.toggle_schedule)
        self.start_btn.pack(side=tk.LEFT, padx=5)
        
        save_btn = ttk.Button(btn_frame, text="保存配置", command=self.save_config)
        save_btn.pack(side=tk.LEFT)

        # 时间列表区域（右侧）
        list_label = ttk.Label(right_panel, text="已设置时间")
        list_label.pack(pady=(0, 5))
        
        self.time_listbox = tk.Listbox(right_panel, height=2, width=15)
        self.time_listbox.pack(fill=tk.BOTH, expand=True)

        # 设置定时任务区固定高度和宽度
        schedule_frame.pack_propagate(False)
        schedule_frame.config(width=300, height=150)
        
        # 添加底部空白填充
        bottom_padding = ttk.Frame(schedule_frame)
        bottom_padding.pack(side=tk.BOTTOM, fill=tk.X, pady=10)

    def add_schedule_time(self):
        """添加定时执行时间"""
        try:
            hour = int(self.hour_var.get())
            minute = int(self.minute_var.get())
            if not (0 <= hour <= 23 and 0 <= minute <= 59):
                raise ValueError
            
            time_str = f"{hour:02d}:{minute:02d}"
            if time_str not in self.refresh_times:
                self.refresh_times.append(time_str)
                self.refresh_times.sort()
                self.update_time_listbox()
        except ValueError:
            messagebox.showerror("错误", "请输入有效的时间")

    def delete_schedule_time(self):
        """删除选中的定时执行时间"""
        selection = self.time_listbox.curselection()
        if selection:
            index = selection[0]
            self.refresh_times.pop(index)
            self.update_time_listbox()

    def update_time_listbox(self):
        """更新时间列表显示"""
        self.time_listbox.delete(0, tk.END)
        for time_str in self.refresh_times:
            self.time_listbox.insert(tk.END, time_str)

    def toggle_schedule(self):
        """切换定时任务状态"""
        if not self.running:
            if not self.refresh_times:
                messagebox.showerror("错误", "请至少添加一个执行时间")
                return
            
            self.running = True
            self.start_btn.config(text="停止定时任务")
            self.status_bar.config(text="定时任务已启动")
            
            # 启动定时任务线程
            self.schedule_thread = threading.Thread(target=self.run_schedule)
            self.schedule_thread.daemon = True
            self.schedule_thread.start()
        else:
            self.running = False
            self.start_btn.config(text="启动定时任务")
            self.status_bar.config(text="定时任务已停止")

    def run_all_tasks(self):
        """立即执行所有任务"""
        self.status_bar.config(text="正在执行所有任务")
        self.add_info_message("开始执行所有任务")
        
        # 创建任务列表
        tasks = [
            ("导出交易日志", "transaction_log_exporter"),
            ("格式化工时数据", "labor_hour_formatter"),
            ("格式化产量数据", "product_quantity_formatter"),
            ("导出Planner数据", "planner_exporter", "main", self.add_info_message)
        ]
        
        # 创建任务队列执行线程
        self.task_queue = tasks.copy()
        self.task_complete = threading.Event()
        
        # 启动任务执行线程
        task_thread = threading.Thread(target=self._process_task_queue)
        task_thread.daemon = True
        task_thread.start()
    
    def _process_task_queue(self):
        """处理任务队列"""
        try:
            while self.task_queue:
                # 获取下一个任务
                task = self.task_queue.pop(0)
                
                # 解析任务参数
                if len(task) == 2:
                    task_name, module_name = task
                    function_name, callback = "main", None
                elif len(task) == 3:
                    task_name, module_name, function_name = task
                    callback = None
                else:
                    task_name, module_name, function_name, callback = task
                
                # 在GUI线程中更新状态
                self.after(0, lambda name=task_name: self.add_info_message(f"开始执行{name}..."))
                
                # 执行任务
                self._run_task(task_name, module_name, function_name, callback)
                
                # 等待任务完成
                self.task_complete.wait()
                self.task_complete.clear()
                
                # 在GUI线程中更新状态
                self.after(0, lambda name=task_name: self.add_info_message(f"{name}执行完成"))
                time.sleep(2)  # 短暂等待以确保系统状态更新
            
            # 所有任务完成
            self.after(0, lambda: self.add_info_message("所有任务执行完成"))
            self.after(0, lambda: self.status_bar.config(text="就绪"))
        except Exception as e:
            self.after(0, lambda error=str(e): self.add_info_message(f"任务队列执行出错: {error}"))
            self.after(0, lambda: self.status_bar.config(text="执行失败", background="#90EE90"))

    def run_schedule(self):
        """运行定时任务"""
        while self.running:
            try:
                current_time = time.strftime("%H:%M")
                if current_time in self.refresh_times:
                    self.after(0, lambda: self.status_bar.config(text=f"正在执行定时任务 - {current_time}"))
                    self.after(0, lambda: self.add_info_message(f"开始执行定时任务 - {current_time}"))
                    
                    # 使用线程执行任务，避免阻塞主线程
                    task_thread = threading.Thread(target=self.run_all_tasks)
                    task_thread.daemon = True
                    task_thread.start()
                    
                    self.after(0, lambda: self.add_info_message(f"定时任务执行完成 - {current_time}"))
                    time.sleep(60)  # 等待1分钟，避免重复执行
                time.sleep(30)  # 每30秒检查一次
            except Exception as e:
                self.after(0, lambda: self.add_info_message(f"定时任务执行出错: {str(e)}"))
                self.after(0, lambda: self.status_bar.config(text="定时任务出错"))
                time.sleep(60)  # 出错后等待1分钟再继续

    def save_config(self):
        """保存定时任务配置"""
        try:
            with open(self.CONFIG_PATH, 'w', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(self.refresh_times)
            self.status_bar.config(text="配置已保存")
            self.add_info_message("配置已保存")
        except Exception as e:
            messagebox.showerror("错误", f"保存配置失败: {str(e)}")

    def load_config(self):
        """加载定时任务配置"""
        try:
            with open(self.CONFIG_PATH, 'r') as f:
                reader = csv.reader(f)
                self.refresh_times = next(reader)
                self.update_time_listbox()
        except (FileNotFoundError, StopIteration, IndexError):
            self.refresh_times = []  # 配置文件不存在或格式不正确时使用空列表

    def _run_task(self, task_name, module_name, function_name="main", callback=None):
        """通用任务执行函数"""
        try:
            self.add_info_message(f"开始{task_name}...", module_name)
            self.status_bar.config(text=f"正在{task_name}", background="#FF6B6B")  # 设置为红色表示运行中
            
            # 创建事件对象用于任务完成通知
            self.task_complete = threading.Event()
            
            # 使用线程而不是进程来执行任务
            task_thread = threading.Thread(
                target=self._run_task_thread,
                args=(task_name, module_name, function_name, callback)
            )
            task_thread.daemon = True
            task_thread.start()
            
        except Exception as error:
            error_msg = str(error)
            self.after(0, lambda error=error_msg: self.add_info_message(f"{task_name}时发生错误: {error}"))
            self.after(0, lambda: self.status_bar.config(text="执行失败", background="#90EE90"))  # 恢复绿色

    def _run_task_thread(self, task_name, module_name, function_name, callback=None):
        """在线程中执行任务"""
        try:
            module = __import__(module_name)
            func = getattr(module, function_name)
            func(callback=callback) if callback else func()
            self.after(0, lambda: self.add_info_message(f"{task_name}完成\n", module_name))
            self.after(0, lambda: self.status_bar.config(text="就绪", background="#90EE90"))  # 设置为绿色表示完成
        except Exception as e:
            import traceback
            error_msg = f"{str(e)}\n完整堆栈跟踪:\n{traceback.format_exc()}"
            self.after(0, lambda error=error_msg: self.add_info_message(f"{task_name}时发生错误: {error}", module_name))
            self.after(0, lambda: self.status_bar.config(text="执行失败", background="#90EE90"))  # 恢复绿色
        finally:
            if hasattr(self, 'task_complete'):
                self.task_complete.set()

    def run_export_planner(self):
        """导出Planner数据"""
        self._run_task("导出Planner数据", "planner_exporter", callback=self.add_info_message)

    def run_export_transaction_log(self):
        """导出交易日志"""
        self._run_task("导出交易日志", "transaction_log_exporter")

    def run_format_laborhour(self):
        """格式化工时数据"""
        self._run_task("格式化工时数据", "labor_hour_formatter")

    def run_format_product_qty(self):
        """格式化产量数据"""
        self._run_task("格式化产量数据", "product_quantity_formatter")

    def run_team_shift(self):
        """处理团队班次数据"""
        self._run_task("处理团队班次数据", "team_shift_manager")

    def interrupt_all_tasks(self):
        """中断所有任务"""
        # 停止定时任务
        self.running = False
        
        # 检查并终止定时任务线程
        if hasattr(self, 'schedule_thread') and self.schedule_thread.is_alive():
            self.schedule_thread.join(timeout=1.0)
        
        # 检查并终止正在运行的任务线程
        if hasattr(self, 'task_complete'):
            self.task_complete.set()
        
        # 终止所有Python子进程和Edge浏览器进程
        import psutil
        current_process = psutil.Process()
        
        # 终止所有Edge浏览器进程
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                if proc.info['name'].lower() == 'msedge.exe':
                    process = psutil.Process(proc.info['pid'])
                    self.add_info_message(f"正在终止Edge浏览器进程: {process.pid}")
                    process.terminate()
                    process.wait(timeout=3)
            except (psutil.NoSuchProcess, psutil.TimeoutExpired):
                try:
                    process.kill()
                    self.add_info_message(f"强制终止Edge浏览器进程: {process.pid}")
                except:
                    pass
        
        # 终止子进程
        def terminate_process_tree(parent_pid):
            try:
                parent = psutil.Process(parent_pid)
                children = parent.children(recursive=True)
                
                for child in children:
                    try:
                        # 检查进程是否为toolkit_datacollector进程
                        if 'toolkit_datacollector' in child.name().lower():
                            self.add_info_message(f"保留GUI进程: {child.pid} ({child.name()})")
                            continue
                            
                        self.add_info_message(f"正在终止子进程: {child.pid} ({child.name()})")
                        child.terminate()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                
                gone, alive = psutil.wait_procs(children, timeout=3)
                for p in alive:
                    try:
                        # 再次检查是否为toolkit_datacollector进程
                        if 'toolkit_datacollector' in p.name().lower():
                            continue
                            
                        self.add_info_message(f"强制终止子进程: {p.pid}")
                        p.kill()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                
                return len(gone), len(alive)
            except Exception as e:
                self.add_info_message(f"终止进程树时出错: {str(e)}")
                return 0, 0
        
        # 终止当前进程的所有子进程
        terminated, killed = terminate_process_tree(current_process.pid)
        self.add_info_message(f"已终止 {terminated} 个子进程，强制终止 {killed} 个子进程")
        
        # 更新界面状态
        self.status_bar.config(text="所有任务已中断")
        self.add_info_message("所有任务已中断")
        
        # 重置按钮状态
        if hasattr(self, 'start_btn'):
            self.start_btn.config(text="启动定时任务")


    def create_tool_section(self, parent):
        """创建工具区域"""
        # 创建工具框架
        tool_frame = ttk.LabelFrame(parent, text="执行区", padding=5)
        tool_frame.pack(fill=tk.BOTH, expand=True)

        # 创建按钮容器
        button_container = ttk.Frame(tool_frame)
        button_container.pack(fill=tk.X, expand=True, padx=5, pady=5)

        # 创建按钮
        buttons = [
            ("执行所有任务", self.run_all_tasks),
            ("中断所有任务", self.interrupt_all_tasks),
            ("团队班次数据", self.run_team_shift)
        ]

        for text, command in buttons:
            btn = ttk.Button(
                button_container,
                text=text,
                command=command,
                width=15,
                padding=(3, 5)
            )
            btn.pack(side=tk.LEFT, padx=5, expand=True)

    def create_log_section(self, parent):
        """创建日志区域"""
        # 创建日志框架
        log_frame = ttk.LabelFrame(parent, text="日志", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=True)

        # 创建文本框和滚动条
        self.info_text = tk.Text(log_frame, height=8, wrap=tk.WORD)
        scrollbar = ttk.Scrollbar(log_frame, orient=tk.VERTICAL, command=self.info_text.yview)
        self.info_text.configure(yscrollcommand=scrollbar.set)

        # 布局
        self.info_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

    def open_planner_folder(self):
        """Planner数据"""
        username = os.getlogin()
        folder_path = fr"C:\Users\{username}\OneDrive - Medtronic PLC\General - CZ Production\POWER BI 数据源 V2\B1_Planner 导出数据"
        if os.path.exists(folder_path):
            os.startfile(folder_path)
            self.add_info_message("已打开Planner数据文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在")

    def open_transaction_folder(self):
        """交易日志"""
        username = os.getlogin()
        folder_path = fr"C:\Users\{username}\OneDrive - Medtronic PLC\General - CZ Production\POWER BI 数据源 V2\20-GoodsMovement"
        if os.path.exists(folder_path):
            os.startfile(folder_path)
            self.add_info_message("已打开交易日志文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在")

    def open_laborhour_folder(self):
        """工时数据"""
        username = os.getlogin()
        folder_path = fr"C:\Users\{username}\OneDrive - Medtronic PLC\General - CZ Production\POWER BI 数据源 V2\40-SAP工时"
        if os.path.exists(folder_path):
            os.startfile(folder_path)
            self.add_info_message("已打开工时数据文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在")

    def open_product_folder(self):
        """产量数据"""
        username = os.getlogin()
        folder_path = fr"C:\Users\{username}\OneDrive - Medtronic PLC\General - CZ Production\POWER BI 数据源 V2\70-SFC导出数据\班组合格率数据"
        if os.path.exists(folder_path):
            os.startfile(folder_path)
            self.add_info_message("已打开产量数据文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在")

    def create_data_processing_section(self, parent):
        """创建数据处理区域"""
        # 创建数据处理框架
        data_frame = ttk.LabelFrame(parent, text="数据处理区", padding=5)
        data_frame.pack(fill=tk.BOTH, expand=True, pady=10)

        # 创建两列按钮容器
        left_column = ttk.Frame(data_frame)
        left_column.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5)
        
        right_column = ttk.Frame(data_frame)
        right_column.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5)

        # 创建按钮对
        button_pairs = [
            (("导出Planner数据", self.run_export_planner),
             ("Planner文件夹", self.open_planner_folder)),
            (("导出交易日志", self.run_export_transaction_log),
             ("交易日志文件夹", self.open_transaction_folder)),
            (("格式化工时数据", self.run_format_laborhour),
             ("工时数据文件夹", self.open_laborhour_folder)),
            (("格式化产量数据", self.run_format_product_qty),
             ("产量数据文件夹", self.open_product_folder))
        ]

        # 在左右列中创建按钮
        for (left_text, left_command), (right_text, right_command) in button_pairs:
            # 左列按钮
            left_btn = ttk.Button(
                left_column,
                text=left_text,
                command=left_command,
                width=15,
                padding=(3, 5)
            )
            left_btn.pack(side=tk.TOP, pady=3)

            # 右列按钮
            right_btn = ttk.Button(
                right_column,
                text=right_text,
                command=right_command,
                width=15,
                padding=(3, 5)
            )
            right_btn.pack(side=tk.TOP, pady=3)

def init_config():
    base_path = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(__file__)
    config_dir = os.path.join(base_path, 'config')
    
    if not os.path.exists(config_dir):
        os.makedirs(config_dir)

    # 从嵌入式资源复制配置文件
    if getattr(sys, 'frozen', False):
        for config_file in ['planner_config.csv', 'schedule_run_config.csv']:
            src_path = os.path.join(sys._MEIPASS, 'config', config_file)
            dst_path = os.path.join(config_dir, config_file)
            if not os.path.exists(dst_path):
                shutil.copy(src_path, dst_path)

    return config_dir

# 修改原有配置读取逻辑
config_dir = init_config()
planner_config_path = os.path.join(config_dir, 'planner_config.csv')
schedule_config_path = os.path.join(config_dir, 'schedule_run_config.csv')

def main():
    app = ToolKitApp()
    app.mainloop()

if __name__ == '__main__':
    main()