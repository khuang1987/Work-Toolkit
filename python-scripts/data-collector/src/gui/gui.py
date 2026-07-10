import tkinter as tk
from tkinter import messagebox
import ttkbootstrap as ttk
from ttkbootstrap.constants import *
import os
import sys
import threading
import time
import json
import logging
import traceback
import winreg
from datetime import datetime

# 添加src目录到Python路径
current_dir = os.path.dirname(os.path.abspath(__file__))
src_dir = os.path.dirname(current_dir)
if src_dir not in sys.path:
    sys.path.append(src_dir)

from utils.config_manager import ConfigManager
from utils.log_manager import LogManager
from utils.path_manager import get_path_from_config

# 延迟导入 playwright_manager，加速启动
def check_playwright_installed():
    """延迟导入 check_playwright_installed"""
    from utils.playwright_manager import check_playwright_installed as _check
    return _check()

# ttkbootstrap 主题配置
THEME_NAME = "litera"  # 可选: flatly, cosmo, litera, minty, lumen, sandstone, yeti, pulse, united, morph, journal, darkly, superhero, solar, cyborg, vapor

class GUI:
    def __init__(self, app):
        self.app = app
        # 添加复选框变量
        self.task_vars = {
            "planner": tk.BooleanVar(value=True),
            "transaction": tk.BooleanVar(value=True),
            "laborhour": tk.BooleanVar(value=True),
            "cmes": tk.BooleanVar(value=True)
        }
        # 添加浏览器模式选择
        self.headless_mode = tk.BooleanVar(value=True)
        # 添加浏览器类型选择 ("edge" 或 "chrome")
        self.browser_type = tk.StringVar(value="chrome")  # 默认使用 Chrome（headless 更稳定）
        self.init_gui()

    def init_gui(self):
        """初始化GUI界面"""
        # 创建自定义粗体样式
        style = ttk.Style()
        style.configure("Bold.TCheckbutton", font=("Microsoft YaHei UI", 10, "bold"))
        style.configure("Bold.TLabel", font=("Microsoft YaHei UI", 10, "bold"))
        
        # 设置窗体背景为浅灰色
        self.app.configure(bg='#f0f0f0')
        
        # 创建主容器 - 浅灰背景增加层次感
        main_frame = ttk.Frame(self.app, padding=10, bootstyle="light")
        main_frame.pack(expand=True, fill=tk.BOTH)
        
        # 创建上部分容器（数据处理和定时任务）
        top_frame = ttk.Frame(main_frame)
        top_frame.pack(fill=tk.BOTH, pady=(0, 10))
        
        # 配置列宽度
        top_frame.grid_columnconfigure(0, weight=1)  # 左列
        top_frame.grid_columnconfigure(1, weight=1)  # 右列
        
        # 创建数据处理区（左列）- 使用 bootstyle
        data_frame = ttk.Labelframe(top_frame, text="📊 数据任务", padding=10, bootstyle="info")
        data_frame.grid(row=0, column=0, sticky='nsew', padx=(0, 5))
        
        # 创建定时任务区（右列）
        schedule_frame = ttk.Labelframe(top_frame, text="⏰ 定时配置", padding=10, bootstyle="info")
        schedule_frame.grid(row=0, column=1, sticky='nsew', padx=(5, 0))
        
        # 创建执行区
        tool_frame = ttk.Frame(main_frame, padding=5)
        tool_frame.pack(fill=tk.X, pady=10)
        
        # 创建日志区（底部）
        log_frame = ttk.Labelframe(main_frame, text="📋 运行日志", padding=10, bootstyle="secondary")
        log_frame.pack(fill=tk.BOTH, expand=True)
        
        # 初始化各个区域
        self.create_data_section(data_frame)
        self.create_schedule_section(schedule_frame)
        self.create_tool_section(tool_frame)
        self.create_log_section(log_frame)
        
        # 状态栏 - 使用 ttkbootstrap 样式
        status_frame = ttk.Frame(self.app)
        status_frame.pack(side=tk.BOTTOM, fill=tk.X)
        self.status_bar = ttk.Label(status_frame, text="✅ 就绪", bootstyle="inverse-success", padding=(10, 5))
        self.status_bar.pack(fill=tk.X)


    def create_data_section(self, parent):
        """创建数据处理区域"""
        # 任务配置：图标、标签、文件夹命令
        tasks = [
            ("planner", "📋 Planner数据", self.app.open_planner_folder),
            ("transaction", "📦 交易日志", self.app.open_transaction_folder),
            ("laborhour", "⏱️ 工时数据", self.app.open_laborhour_folder),
            ("cmes", "🏭 CMES数据", self.app.open_cmes_folder)
        ]
        
        # 创建网格布局 - 使用 grid 对齐
        for i, (task_key, label, folder_cmd) in enumerate(tasks):
            # 创建一行
            row_frame = ttk.Frame(parent)
            row_frame.pack(fill=tk.X, pady=4)
            row_frame.columnconfigure(1, weight=1)  # 标签列可扩展
            
            # 开关 - 使用 round-toggle 样式（和时间区域一致）
            cb = ttk.Checkbutton(
                row_frame,
                variable=self.task_vars[task_key],
                bootstyle="info-round-toggle"
            )
            cb.grid(row=0, column=0, sticky='w', padx=(5, 2))
            
            # 标签 - 粗体样式
            ttk.Label(row_frame, text=label, style="Bold.TLabel").grid(row=0, column=1, sticky='w', padx=2)
            
            # 执行按钮 - 只保留图标，灰色样式
            btn = ttk.Button(
                row_frame,
                text="▶",
                command=lambda k=task_key: self.run_single_task(k),
                width=3,
                bootstyle="secondary-outline"
            )
            btn.grid(row=0, column=2, padx=2)
            
            # 文件夹图标按钮 - outline 样式，固定宽度
            folder_btn = ttk.Button(
                row_frame,
                text="📁",
                command=folder_cmd,
                width=3,
                bootstyle="secondary-outline"
            )
            folder_btn.grid(row=0, column=3, padx=2)

    def create_tool_section(self, parent):
        """创建工具区域"""
        # 创建按钮容器 - 居中排列
        button_frame = ttk.Frame(parent)
        button_frame.pack(fill=tk.X, expand=True, pady=5)

        # 执行所有任务按钮 - 成功样式（圆角）
        ttk.Button(
            button_frame,
            text="▶ 执行所有任务",
            command=self.run_all_tasks,
            width=16,
            bootstyle="success-outline"
        ).pack(side=tk.LEFT, padx=8, expand=True)
        
        # 创建PowerBI刷新按钮（带状态检查）- 主色调
        self.powerbi_btn = ttk.Button(
            button_frame,
            text="🔄 刷新PowerBI",
            command=self.refresh_powerbi_with_status,
            width=16,
            bootstyle="primary-outline"
        )
        self.powerbi_btn.pack(side=tk.LEFT, padx=8, expand=True)
        
        # 中断所有任务按钮 - 危险样式
        ttk.Button(
            button_frame,
            text="⏹ 中断任务",
            command=self.app.interrupt_all_tasks,
            width=14,
            bootstyle="danger-outline"
        ).pack(side=tk.LEFT, padx=8, expand=True)
        
        # 确保按钮初始状态正确
        self.ensure_powerbi_button_state()
        
        # 延迟检查按钮状态（确保初始化完成）
        self.app.after(1000, self.ensure_powerbi_button_state)
    
    def ensure_powerbi_button_state(self):
        """确保PowerBI按钮状态正确"""
        try:
            if hasattr(self.app, '_powerbi_refresh_running') and self.app._powerbi_refresh_running:
                self.powerbi_btn.configure(text="PowerBI刷新中...", state="disabled")
            else:
                self.powerbi_btn.configure(text="🔄 刷新PowerBI", state="normal")
        except Exception as e:
            # 如果出错，强制设置为正常状态
            try:
                self.powerbi_btn.configure(text="🔄 刷新PowerBI", state="normal")
            except:
                pass

    def create_log_section(self, parent):
        """创建日志区域"""
        # 创建文本框容器
        text_frame = ttk.Frame(parent)
        text_frame.pack(fill=tk.BOTH, expand=True)
        
        # 创建文本框和滚动条 - 高度缩小30%（15*0.7≈10），启用自动换行
        self.info_text = tk.Text(text_frame, height=10, wrap=tk.WORD, 
                                  font=("Consolas", 9), bg="#fafafa", fg="#333")
        v_scrollbar = ttk.Scrollbar(text_frame, orient=tk.VERTICAL, command=self.info_text.yview)
        self.info_text.configure(yscrollcommand=v_scrollbar.set)

        # 布局 - 使用 grid 更好控制（自动换行后不需要水平滚动条）
        self.info_text.grid(row=0, column=0, sticky='nsew')
        v_scrollbar.grid(row=0, column=1, sticky='ns')
        text_frame.grid_rowconfigure(0, weight=1)
        text_frame.grid_columnconfigure(0, weight=1)

    def create_schedule_section(self, parent):
        """创建定时任务区域"""
        # 创建时间设置区域
        time_frame = ttk.Frame(parent)
        time_frame.pack(fill=tk.X, pady=5)
        
        # 创建3个时间设置行
        self.time_vars = []
        self.time_check_vars = []
        
        for i in range(3):
            row_frame = ttk.Frame(time_frame)
            row_frame.pack(fill=tk.X, pady=3)
            
            # 添加勾选框 - 使用 round-toggle 样式
            check_var = tk.BooleanVar(value=(i == 0))  # 只有第一个默认勾选
            self.time_check_vars.append(check_var)
            ttk.Checkbutton(
                row_frame, 
                variable=check_var, 
                command=self.save_time_config,
                bootstyle="info-round-toggle"
            ).pack(side=tk.LEFT, padx=2)
            
            ttk.Label(row_frame, text=f"时间{i+1}:", style="Bold.TLabel").pack(side=tk.LEFT, padx=3)
            
            # 小时选择
            hour_var = tk.StringVar(value="08" if i == 0 else "00")
            self.time_vars.append(hour_var)
            hour_spinbox = ttk.Spinbox(row_frame, from_=0, to=23, width=3, 
                                        textvariable=hour_var, bootstyle="info")
            hour_spinbox.pack(side=tk.LEFT, padx=2)
            # 只在失焦时保存
            hour_spinbox.bind('<FocusOut>', lambda e: self.save_time_config())
            
            ttk.Label(row_frame, text=":").pack(side=tk.LEFT)
            
            # 分钟选择
            minute_var = tk.StringVar(value="20" if i == 0 else "00")
            self.time_vars.append(minute_var)
            minute_spinbox = ttk.Spinbox(row_frame, from_=0, to=59, width=3, 
                                          textvariable=minute_var, bootstyle="info")
            minute_spinbox.pack(side=tk.LEFT, padx=2)
            # 只在失焦时保存
            minute_spinbox.bind('<FocusOut>', lambda e: self.save_time_config())
        
        # 创建控制按钮
        button_frame = ttk.Frame(parent)
        button_frame.pack(fill=tk.X, pady=8)
        
        self.start_btn = ttk.Button(
            button_frame, 
            text="▶ 启动定时", 
            command=self.app.toggle_schedule,
            bootstyle="primary-outline"
        )
        self.start_btn.pack(side=tk.LEFT, expand=True, padx=2)
        
        # 刷新记录按钮
        ttk.Button(
            button_frame,
            text="📋 刷新记录",
            command=self.show_schedule_history,
            bootstyle="info-outline"
        ).pack(side=tk.LEFT, expand=True, padx=2)

    def show_schedule_history(self):
        """显示定时刷新历史记录"""
        if hasattr(self.app, 'scheduler') and self.app.scheduler:
            history = self.app.scheduler.get_recent_history(10)
            self.add_info_message("=" * 50)
            self.add_info_message(history)
            self.add_info_message("=" * 50)
        else:
            self.add_info_message("定时任务未初始化")
    
    def save_time_config(self):
        """保存时间配置"""
        try:
            # 从GUI中获取当前设置的时间
            schedule_times = []
            for i in range(0, len(self.time_vars), 2):
                # 检查是否勾选
                if not self.time_check_vars[i//2].get():
                    continue
                    
                hour = self.time_vars[i].get().zfill(2)
                minute = self.time_vars[i+1].get().zfill(2)
                time_str = f"{hour}:{minute}"
                if time_str != "00:00":  # 忽略未设置的时间
                    schedule_times.append(time_str)
            
            # 更新调度器中的时间
            self.app.scheduler.schedule_times = schedule_times
            self.app.scheduler.save_config()
            
            self.update_status_bar("配置已自动保存")
        except Exception as e:
            self.app.show_error("保存配置失败", str(e))

    def update_status_bar(self, text, status="success"):
        """更新状态栏
        
        Args:
            text: 状态文本
            status: 状态类型 (success, warning, danger, info, running, error)
        """
        # 根据状态类型选择样式
        style_map = {
            "success": "inverse-success",
            "warning": "inverse-warning", 
            "danger": "inverse-danger",
            "info": "inverse-info",
            "running": "inverse-primary",
            "error": "inverse-danger"
        }
        bootstyle = style_map.get(status, "inverse-success")
        
        # 添加状态图标
        icon_map = {
            "success": "✅",
            "warning": "⚠️",
            "danger": "❌",
            "info": "ℹ️",
            "running": "🔄",
            "error": "❌"
        }
        icon = icon_map.get(status, "")
        
        self.status_bar.configure(text=f"{icon} {text}", bootstyle=bootstyle)

    def update_time_listbox(self, times):
        """更新时间列表显示"""
        # 清空当前时间设置
        for i in range(0, len(self.time_vars), 2):
            self.time_vars[i].set("00")
            self.time_vars[i+1].set("00")
            self.time_check_vars[i//2].set(False)
        
        # 设置新的时间
        for i, time_str in enumerate(times):
            if i >= 3:  # 最多显示3个时间
                break
            hour, minute = time_str.split(':')
            self.time_vars[i*2].set(hour)
            self.time_vars[i*2+1].set(minute)
            self.time_check_vars[i].set(True)

    def add_info_message(self, message):
        """添加信息到日志区"""
        # 添加时间戳
        timestamp = datetime.now().strftime('%b-%d %H:%M:%S')
        formatted_message = f"[{timestamp}] {message}"
        self.info_text.insert(tk.END, formatted_message + '\n')
        self.info_text.see(tk.END)
    
    def add_task_completion_separator(self):
        """添加任务完成分隔符"""
        # 添加空行
        self.info_text.insert(tk.END, '\n')
        # 添加分隔符
        separator = "─" * 80
        self.info_text.insert(tk.END, f"{separator}\n")
        # 添加任务完成标识
        timestamp = datetime.now().strftime('%b-%d %H:%M:%S')
        completion_message = f"[{timestamp}] 🎯 任务执行完成"
        self.info_text.insert(tk.END, f"{completion_message}\n")
        # 再添加分隔符
        self.info_text.insert(tk.END, f"{separator}\n")
        # 再添加一个空行
        self.info_text.insert(tk.END, '\n')
        self.info_text.see(tk.END)

    def run_all_tasks(self):
        """立即执行所有任务"""
        self.status_bar.config(text="正在执行所有任务")
        self.add_info_message("开始执行所有任务")
        
        # 创建任务列表，只包含被勾选的任务
        tasks = []
        if self.task_vars["transaction"].get():
            tasks.append(("导出交易日志", "core.transaction_log_exporter", "export_transaction_log", self.add_info_message))
        if self.task_vars["laborhour"].get():
            tasks.append(("格式化工时数据", "core.labor_hour_formatter", "format_labor_hour", self.add_info_message))
        if self.task_vars["cmes"].get():
            tasks.append(("CMES数据采集", "core.cmes_data_collector", "collect_cmes_data", self.add_info_message))
        if self.task_vars["planner"].get():
            tasks.append(("导出Planner数据", "core.planner_exporter", "export_planner_data", self.add_info_message))
        
        if not tasks:
            self.add_info_message("没有选中任何任务")
            self.status_bar.config(text="就绪")
            return
        
        # 创建任务队列执行线程
        self.task_queue = tasks.copy()
        self.task_complete = threading.Event()
        
        # 启动任务执行线程
        task_thread = threading.Thread(target=self._process_task_queue)
        task_thread.daemon = True
        task_thread.start()

    def run_schedule(self):
        """执行定时任务"""
        while self.running:
            current_time = datetime.now()
            current_time_str = current_time.strftime("%H:%M")
            
            # 检查是否到达设定的时间
            for i in range(0, len(self.time_vars), 2):
                hour = self.time_vars[i].get().zfill(2)
                minute = self.time_vars[i+1].get().zfill(2)
                target_time = f"{hour}:{minute}"
                
                if current_time_str == target_time:
                    self.status_bar.config(text="正在执行定时任务")
                    self.add_info_message(f"开始执行定时任务 - {target_time}")
                    
                    # 创建任务列表，只包含被勾选的任务
                    tasks = []
                    if self.task_vars["transaction"].get():
                        tasks.append(("导出交易日志", "core.transaction_log_exporter", "export_transaction_log", self.add_info_message))
                    if self.task_vars["laborhour"].get():
                        tasks.append(("格式化工时数据", "core.labor_hour_formatter", "format_labor_hour", self.add_info_message))
                    if self.task_vars["cmes"].get():
                        tasks.append(("CMES数据采集", "core.cmes_data_collector", "collect_cmes_data", self.add_info_message))
                    if self.task_vars["planner"].get():
                        tasks.append(("导出Planner数据", "core.planner_exporter", "export_planner_data", self.add_info_message))
                    
                    if not tasks:
                        self.add_info_message("没有选中任何任务")
                        self.status_bar.config(text="就绪")
                        time.sleep(60)  # 等待1分钟后继续检查
                        continue
                    
                    # 创建任务队列执行线程
                    self.task_queue = tasks.copy()
                    self.task_complete = threading.Event()
                    
                    # 启动任务执行线程
                    task_thread = threading.Thread(target=self._process_task_queue)
                    task_thread.daemon = True
                    task_thread.start()
                    
                    # 等待所有任务完成
                    self.task_complete.wait()
                    
                    self.status_bar.config(text="定时任务执行完成")
                    self.add_info_message("定时任务执行完成")
                    
                    # 等待1分钟，避免在同一分钟内重复执行
                    time.sleep(60)
                    break
            else:
                # 每分钟检查一次时间
                time.sleep(1)

    def _process_task_queue(self):
        """处理任务队列"""
        try:
            while self.task_queue:
                task = self.task_queue.pop(0)
                task_name = task[0]
                module_name = task[1]
                function_name = task[2] if len(task) > 2 else None
                callback = task[3] if len(task) > 3 else None
                
                self.add_info_message(f"开始执行任务: {task_name}")
                self.status_bar.config(text=f"正在执行: {task_name}")
                
                try:
                    # 修改导入路径，确保能正确找到模块
                    import sys
                    import os
                    
                    # 获取当前文件的目录
                    current_dir = os.path.dirname(os.path.abspath(__file__))
                    # 获取src目录
                    src_dir = os.path.dirname(current_dir)
                    
                    # 将src目录添加到Python路径
                    if src_dir not in sys.path:
                        sys.path.append(src_dir)
                    
                    # 导入模块
                    module = __import__(module_name, fromlist=[function_name])
                    
                    if function_name:
                        func = getattr(module, function_name)
                        # 只在需要WebDriver的任务中传递headless和browser_type参数
                        if module_name in ['core.planner_exporter', 'core.powerbi_refresh', 'core.cmes_data_collector']:
                            if callback:
                                func(callback=callback, headless=self.headless_mode.get(), browser_type=self.browser_type.get())
                            else:
                                func(headless=self.headless_mode.get(), browser_type=self.browser_type.get())
                        else:
                            if callback:
                                func(callback=callback)
                            else:
                                func()
                    else:
                        if callback:
                            module(callback=callback)
                        else:
                            module()
                            
                    # 获取任务对应的文件夹路径
                    folder_path = None
                    if task_name == "导出交易日志":
                        folder_path = get_path_from_config('transaction_folder')
                    elif task_name == "格式化工时数据":
                        folder_path = get_path_from_config('laborhour_folder')
                    elif task_name == "CMES数据采集":
                        folder_path = get_path_from_config('cmes_folder')
                    elif task_name == "导出Planner数据":
                        folder_path = get_path_from_config('planner_folder')
                    
                    # 如果找到了对应的文件夹，显示最新文件信息
                    if folder_path and os.path.exists(folder_path):
                        try:
                            files = [f for f in os.listdir(folder_path) if os.path.isfile(os.path.join(folder_path, f))]
                            if files:
                                latest_file = max(files, key=lambda x: os.path.getmtime(os.path.join(folder_path, x)))
                                latest_file_path = os.path.join(folder_path, latest_file)
                                latest_file_time = datetime.fromtimestamp(os.path.getmtime(latest_file_path)).strftime('%Y-%m-%d %H:%M:%S')
                                self.add_info_message(f"任务完成: {task_name}")
                                self.add_info_message(f"最新文件: {latest_file}，更新时间: {latest_file_time}")
                            else:
                                self.add_info_message(f"任务完成: {task_name}")
                        except Exception as e:
                            self.add_info_message(f"任务完成: {task_name}")
                            self.add_info_message(f"获取最新文件信息失败: {str(e)}")
                    else:
                        self.add_info_message(f"任务完成: {task_name}")
                            
                except Exception as e:
                    error_msg = f"{str(e)}\n完整堆栈跟踪:\n{traceback.format_exc()}"
                    self.add_info_message(f"任务 {task_name} 执行失败: {error_msg}")
                
                # 任务之间添加短暂延迟
                time.sleep(1)
                
                # 每个任务完成后添加分隔符
                self.add_task_completion_separator()
                
        except Exception as e:
            error_msg = f"{str(e)}\n完整堆栈跟踪:\n{traceback.format_exc()}"
            self.add_info_message(f"任务队列处理失败: {error_msg}")
        finally:
            self.status_bar.config(text="就绪")
            if hasattr(self, 'task_complete'):
                self.task_complete.set()

    def open_log_folder(self):
        """打开日志文件夹"""
        import subprocess
        log_folder = self.app.path_manager.get_log_folder()
        if log_folder and os.path.exists(log_folder):
            subprocess.Popen(['explorer', log_folder], creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            self.add_info_message("⚠️ 日志文件夹不存在")

    def check_webdriver(self):
        """检查 Playwright 状态并输出到日志"""
        # 在单独的线程中执行检查
        threading.Thread(target=self._check_playwright_thread, daemon=True).start()

    def _check_playwright_thread(self):
        """检查 Playwright 状态的线程函数"""
        try:
            self.app.after(0, lambda: self.add_info_message("正在检查 Playwright 状态..."))
            
            installed, message = check_playwright_installed()
            
            if installed:
                self.app.after(0, lambda: self.add_info_message(f"✅ {message}"))
            else:
                self.app.after(0, lambda: self.add_info_message(f"❌ {message}"))
                self.app.after(0, lambda: self.add_info_message("请运行: pip install playwright && playwright install msedge"))
            
        except Exception as e:
            self.app.after(0, lambda: self.add_info_message(f"检查过程中发生错误: {str(e)}"))
            import traceback
            self.app.after(0, lambda: self.add_info_message(f"错误详情:\n{traceback.format_exc()}"))

    def get_edge_version(self):
        """获取Edge浏览器版本"""
        try:
            # 从注册表获取Edge版本
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, 
                               r"Software\Microsoft\Edge\BLBeacon")
            version, _ = winreg.QueryValueEx(key, "version")
            return version
        except Exception as e:
            self.add_info_message(f"获取Edge版本失败: {str(e)}")
            return "未知版本"

    def refresh_powerbi_with_status(self):
        """带状态检查的PowerBI刷新"""
        # 检查PowerBI刷新任务是否正在运行
        if hasattr(self.app, '_powerbi_refresh_running') and self.app._powerbi_refresh_running:
            self.add_info_message("⚠️ PowerBI刷新任务正在运行中，请等待当前任务完成")
            # 更新按钮状态
            self.powerbi_btn.configure(text="PowerBI刷新中...", state="disabled")
            # 启动定时器检查状态
            self.app.after(2000, self.check_powerbi_status)
        else:
            # 更新按钮状态
            self.powerbi_btn.configure(text="PowerBI刷新中...", state="disabled")
            # 执行PowerBI刷新
            self.app.refresh_powerbi()
            # 立即启动状态检查
            self.app.after(1000, self.check_powerbi_status)
    
    def check_powerbi_status(self):
        """检查PowerBI刷新状态"""
        try:
            if hasattr(self.app, '_powerbi_refresh_running') and self.app._powerbi_refresh_running:
                # 如果还在运行，继续检查（更频繁）
                self.app.after(1000, self.check_powerbi_status)
            else:
                # 如果已完成，恢复按钮状态
                self.powerbi_btn.configure(text="刷新PowerBI", state="normal")
                self.add_info_message("✅ PowerBI刷新任务已完成，按钮状态已恢复")
        except Exception as e:
            # 如果出现异常，强制恢复按钮状态
            try:
                self.powerbi_btn.configure(text="刷新PowerBI", state="normal")
                self.add_info_message(f"⚠️ 状态检查异常，已强制恢复按钮状态: {str(e)}")
            except:
                pass
    
    def run_single_task(self, task_key):
        """执行单个任务"""
        task_map = {
            "planner": ("导出Planner数据", "core.planner_exporter", "export_planner_data", self.add_info_message),
            "transaction": ("导出交易日志", "core.transaction_log_exporter", "export_transaction_log", self.add_info_message),
            "laborhour": ("格式化工时数据", "core.labor_hour_formatter", "format_labor_hour", self.add_info_message),
            "cmes": ("CMES数据采集", "core.cmes_data_collector", "collect_cmes_data", self.add_info_message)
        }
        
        if task_key in task_map:
            task = task_map[task_key]
            self.task_queue = [task]
            self.task_complete = threading.Event()
            
            # 启动任务执行线程
            task_thread = threading.Thread(target=self._process_task_queue)
            task_thread.daemon = True
            task_thread.start()