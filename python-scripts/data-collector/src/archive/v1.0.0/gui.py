import tkinter as tk
from tkinter import ttk
from tkinter import messagebox
import os
import sys
from PyQt5.QtWidgets import QSystemTrayIcon, QMenu, QAction, QApplication
from PyQt5.QtGui import QIcon

class GUI:
    def __init__(self, app):
        self.app = app
        self.init_gui()
        self.init_system_tray()

    def init_gui(self):
        """初始化GUI界面"""
        # 创建主容器
        main_frame = ttk.Frame(self.app, padding=10)
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
        self.status_bar = ttk.Label(self.app, text="就绪", relief=tk.SUNKEN)
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)
        self.status_bar.configure(background="#90EE90")  # 初始状态为绿色

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
            (("导出Planner数据", self.app.run_export_planner),
             ("Planner文件夹", self.app.open_planner_folder)),
            (("导出交易日志", self.app.run_export_transaction_log),
             ("交易日志文件夹", self.app.open_transaction_folder)),
            (("格式化工时数据", self.app.run_format_laborhour),
             ("工时数据文件夹", self.app.open_laborhour_folder)),
            (("格式化产量数据", self.app.run_format_product_qty),
             ("产量数据文件夹", self.app.open_product_folder))
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
            ("执行所有任务", self.app.run_all_tasks),
            ("中断所有任务", self.app.interrupt_all_tasks),
            ("团队班次数据", self.app.run_team_shift)
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
        
        add_time_btn = ttk.Button(button_row, text="添加时间", command=self.app.add_schedule_time)
        add_time_btn.pack(side=tk.LEFT, padx=5)
        
        delete_btn = ttk.Button(button_row, text="删除时间", command=self.app.delete_schedule_time)
        delete_btn.pack(side=tk.LEFT)

        # 控制按钮区
        btn_frame = ttk.Frame(left_panel)
        btn_frame.pack(fill=tk.X, pady=5)
        
        self.start_btn = ttk.Button(btn_frame, text="启动定时任务", command=self.app.toggle_schedule)
        self.start_btn.pack(side=tk.LEFT, padx=5)
        
        save_btn = ttk.Button(btn_frame, text="保存配置", command=self.app.save_config)
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

    def init_system_tray(self):
        """初始化系统托盘"""
        # 创建QApplication实例（如果不存在）
        self.qt_app = QApplication.instance()
        if not self.qt_app:
            self.qt_app = QApplication([])
        
        # 创建系统托盘图标
        self.tray_icon = QSystemTrayIcon()
        self.tray_icon.setIcon(QIcon(self.app.icon_path))
        self.tray_icon.setToolTip("Toolkit DataCollector")
        
        # 创建托盘菜单
        tray_menu = QMenu()
        exit_action = QAction("彻底退出", self.qt_app)
        exit_action.triggered.connect(self.app.quit_app)
        tray_menu.addAction(exit_action)
        
        # 设置托盘菜单
        self.tray_icon.setContextMenu(tray_menu)
        
        # 绑定托盘图标的双击事件
        self.tray_icon.activated.connect(self.on_tray_icon_activated)

    def on_tray_icon_activated(self, reason):
        """处理托盘图标的激活事件"""
        # 双击托盘图标时恢复窗口
        if reason == QSystemTrayIcon.DoubleClick:
            self.app.deiconify()
            self.app.lift()
            self.app.focus_force()

    def show_tray_message(self, title, message):
        """显示托盘消息"""
        self.tray_icon.showMessage(title, message, QSystemTrayIcon.Information, 2000)

    def update_status_bar(self, text, background="#90EE90"):
        """更新状态栏"""
        self.status_bar.config(text=text, background=background)

    def update_time_listbox(self, times):
        """更新时间列表显示"""
        self.time_listbox.delete(0, tk.END)
        for time_str in times:
            self.time_listbox.insert(tk.END, time_str)

    def add_info_message(self, message):
        """添加信息到日志区"""
        self.info_text.insert(tk.END, message + '\n')
        self.info_text.see(tk.END)