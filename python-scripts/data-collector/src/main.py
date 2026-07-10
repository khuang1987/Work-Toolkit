import tkinter as tk
from tkinter import messagebox
import ttkbootstrap as ttk
from ttkbootstrap.constants import *
import os
import sys
import psutil
import threading
import time
import webbrowser
from PIL import Image, ImageTk
from gui.gui import GUI, THEME_NAME
from gui.system_tray import SystemTray
from utils.scheduler import Scheduler
from utils.path_manager import PathManager
from utils.log_manager import LogManager
from utils.config_manager import ConfigManager
from utils.task_lock_manager import request_interrupt, clear_interrupt

class ToolKitApp(ttk.Window):
    def __init__(self):
        # 先初始化路径管理器获取图标路径
        self.path_manager = PathManager()
        self.icon_path = self.path_manager.get_icon_path('ico')
        
        # 初始化窗口（不传 iconphoto，稍后设置）
        super().__init__(themename=THEME_NAME)
            
        self.title("数据采集工具 v1.4.1")
        self.geometry("600x560")
        
        # 设置窗口图标
        if self.icon_path and os.path.exists(self.icon_path):
            try:
                # 使用 iconbitmap 设置任务栏图标（.ico 格式）
                self.iconbitmap(self.icon_path)
                # 使用 iconphoto 设置窗口标题栏图标
                icon_image = ImageTk.PhotoImage(Image.open(self.icon_path))
                self.iconphoto(True, icon_image)
                self._icon_image = icon_image  # 保存引用防止垃圾回收
            except Exception as e:
                print(f"设置图标失败: {e}")
        else:
            self.log_with_timestamp(f"警告：找不到图标文件")
        
        # 添加窗口状态标志
        self._is_minimized = False
        self._is_hidden = False
        self._balloon_shown = False
        self._is_quitting = False
        
        # 添加PowerBI刷新任务锁
        self._powerbi_refresh_lock = threading.Lock()
        self._powerbi_refresh_running = False
        
        # 确保PowerBI刷新状态正确初始化
        self.log_with_timestamp("PowerBI刷新任务锁已初始化")
        
        # 初始化GUI
        self.gui = GUI(self)
        
        # 初始化系统托盘
        self.system_tray = SystemTray(self)
        
        # 初始化定时任务管理器
        self.scheduler = Scheduler(self, os.path.join(self.path_manager.get_config_folder(), 'schedule_run_config.csv'))
        
        # 创建菜单栏
        self.create_menu()
        
        # 绑定窗口事件
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.bind("<Unmap>", self.on_minimize)
        self.bind("<Configure>", self.on_configure)
        
        # 添加初始信息
        self.log_with_timestamp("程序已启动")
        
        # 设置初始窗口状态
        self.attributes('-alpha', 1.0)
        self.deiconify()
        self.lift()
        self.focus_force()
        
        # 确保系统托盘图标显示
        self.after(1000, self._ensure_tray_icon)
        
        self.logger = LogManager(log_dir=self.path_manager.get_log_folder())
        self.logger.info("正在初始化应用程序...")
        self.config_manager = ConfigManager()

    def create_menu(self):
        """创建菜单栏"""
        menubar = tk.Menu(self)
        
        # 设置菜单（放在最左边）
        settings_menu = tk.Menu(menubar, tearoff=0)
        settings_menu.add_command(
            label="路径配置",
            command=self.show_path_config
        )
        settings_menu.add_command(
            label="安装Playwright浏览器",
            command=self.install_playwright_browsers
        )
        settings_menu.add_command(
            label="强制重置PowerBI按钮",
            command=self.force_reset_powerbi_button
        )
        settings_menu.add_separator()
        settings_menu.add_command(
            label="退出",
            command=self.quit_app
        )
        menubar.add_cascade(label="设置", menu=settings_menu)
        
        # 浏览器菜单
        browser_menu = tk.Menu(menubar, tearoff=0)
        browser_menu.add_checkbutton(
            label="无头模式",
            variable=self.gui.headless_mode
        )
        browser_menu.add_separator()
        browser_menu.add_radiobutton(
            label="Chrome (推荐)",
            variable=self.gui.browser_type,
            value="chrome"
        )
        browser_menu.add_radiobutton(
            label="Edge",
            variable=self.gui.browser_type,
            value="edge"
        )
        menubar.add_cascade(label="浏览器", menu=browser_menu)
        
        # 系统自检菜单（独立选项）
        menubar.add_command(label="系统自检", command=self.run_system_check)
        
        # 帮助菜单（直接打开HTML）
        menubar.add_command(label="帮助", command=self.show_help)
        
        self.config(menu=menubar)
        
    def show_path_config(self):
        """显示路径配置对话框"""
        self.path_manager.show_config_dialog(self)
    
    def show_about(self):
        """显示关于对话框"""
        self.show_readme()
    
    def run_system_check(self):
        """运行系统自检"""
        self.gui.add_info_message("=" * 40)
        self.gui.add_info_message("🔍 开始系统自检...")
        self.gui.add_info_message("=" * 40)
        
        # 检查 Playwright 状态
        self.gui.add_info_message("\n📦 检查 Playwright 浏览器...")
        self.gui.check_webdriver()
        
        # 检查 PowerBI 状态
        self.gui.add_info_message("\n🔄 检查 PowerBI 刷新状态...")
        self.check_powerbi_lock_status()
        
        self.gui.add_info_message("\n✅ 系统自检完成")
        self.gui.add_info_message("=" * 40)
    
    def show_help(self):
        """打开帮助页面"""
        import webbrowser
        from utils.path_manager import get_base_path
        
        # 获取帮助文件路径
        if getattr(sys, 'frozen', False):
            # 打包后的可执行文件
            help_path = os.path.join(os.path.dirname(sys.executable), 'docs', 'help.html')
        else:
            # 开发环境
            help_path = os.path.join(get_base_path(), 'docs', 'help.html')
        
        if os.path.exists(help_path):
            # 使用默认浏览器打开帮助页面
            webbrowser.open(f'file:///{help_path}')
        else:
            messagebox.showinfo("帮助", "帮助文件不存在，请联系技术支持。")
    
    def show_readme(self):
        """显示README内容"""
        try:
            # 导入get_base_path函数
            from utils.path_manager import get_base_path
            
            # 获取README文件路径（优先检查可执行文件目录）
            if getattr(sys, 'frozen', False):
                # 打包后的可执行文件
                readme_path = os.path.join(os.path.dirname(sys.executable), 'readme.md')
            else:
                # 开发环境
                readme_path = os.path.join(get_base_path(), 'readme.md')
            
            if os.path.exists(readme_path):
                # 读取README文件内容
                with open(readme_path, 'r', encoding='utf-8') as f:
                    readme_content = f.read()
                
                # 创建README显示窗口
                self.show_readme_window(readme_content)
            else:
                # 如果找不到README文件，显示默认信息
                default_content = """# Toolkit DataCollector v1.1

**数据采集与处理工具**

一个专为数据收集和处理而设计的自动化工具，提供直观的界面和强大的功能，让数据管理工作变得简单高效。

## 主要功能

- 📊 数据处理：Planner数据导出、交易日志处理、工时数据格式化、产量数据统计
- 🔄 PowerBI刷新：智能刷新机制、任务互斥保护、状态实时反馈
- ⏰ 定时任务：灵活时间配置、后台运行、任务选择
- 🎛️ 系统管理：路径配置管理、WebDriver自动管理、系统托盘集成

## 系统要求

- **操作系统**：Windows 10 或更高版本
- **内存**：4GB RAM（推荐8GB）
- **浏览器**：Microsoft Edge（最新版本）
- **网络**：稳定的互联网连接

## 技术支持

如有问题或建议，请联系开发团队。"""
                
                self.show_readme_window(default_content)
                
        except Exception as e:
            self.log_with_timestamp(f"显示README时出错: {str(e)}")
            messagebox.showerror("错误", f"无法显示帮助信息: {str(e)}")
    
    def show_readme_window(self, content):
        """显示README窗口"""
        # 创建新窗口
        readme_window = tk.Toplevel(self)
        readme_window.title("帮助 - Toolkit DataCollector v1.1")
        readme_window.geometry("400x600")
        readme_window.resizable(True, True)
        
        # 设置窗口图标
        if self.icon_path:
            readme_window.iconbitmap(self.icon_path)
        
        # 创建主框架
        main_frame = ttk.Frame(readme_window, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # 创建文本框和滚动条
        text_frame = ttk.Frame(main_frame)
        text_frame.pack(fill=tk.BOTH, expand=True)
        
        # 创建文本框
        text_widget = tk.Text(text_frame, wrap=tk.WORD, font=("Consolas", 10))
        text_widget.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        # 创建垂直滚动条
        v_scrollbar = ttk.Scrollbar(text_frame, orient=tk.VERTICAL, command=text_widget.yview)
        v_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        text_widget.configure(yscrollcommand=v_scrollbar.set)
        
        # 创建水平滚动条
        h_scrollbar = ttk.Scrollbar(main_frame, orient=tk.HORIZONTAL, command=text_widget.xview)
        h_scrollbar.pack(side=tk.BOTTOM, fill=tk.X)
        text_widget.configure(xscrollcommand=h_scrollbar.set)
        
        # 插入README内容
        text_widget.insert(tk.END, content)
        
        # 设置只读模式
        text_widget.configure(state=tk.DISABLED)
        
        # 创建按钮框架
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X, pady=(10, 0))
        
        # 添加关闭按钮
        close_button = ttk.Button(button_frame, text="关闭", command=readme_window.destroy)
        close_button.pack(side=tk.RIGHT)
        
        # 设置窗口位置（居中）
        readme_window.transient(self)
        readme_window.grab_set()
        
        # 将焦点设置到文本框
        text_widget.focus_set()
    
    def check_powerbi_lock_status(self):
        """检查PowerBI刷新锁状态（调试用）"""
        with self._powerbi_refresh_lock:
            status = "运行中" if self._powerbi_refresh_running else "空闲"
            self.log_with_timestamp(f"🔍 PowerBI刷新锁状态: {status}")
            return self._powerbi_refresh_running
    
    def force_reset_powerbi_button(self):
        """强制重置PowerBI按钮状态"""
        with self._powerbi_refresh_lock:
            self._powerbi_refresh_running = False
            self.log_with_timestamp("🔄 强制重置PowerBI刷新状态")
        
        # 恢复GUI按钮状态
        if hasattr(self, 'gui') and hasattr(self.gui, 'powerbi_btn'):
            self.gui.powerbi_btn.configure(text="刷新PowerBI", state="normal")
            self.gui.add_info_message("🔄 PowerBI按钮状态已强制重置")
            # 添加任务完成分隔符
            self.gui.add_task_completion_separator()

    def _ensure_tray_icon(self):
        """确保系统托盘图标显示"""
        try:
            if not self.system_tray.tray_icon:
                self.system_tray.init_system_tray()
        except Exception as e:
            self.log_with_timestamp(f"确保系统托盘图标显示时出错: {str(e)}")

    def run_export_planner(self):
        """导出Planner数据"""
        self._run_task("导出Planner数据", "core.planner_exporter", "export_planner_data", callback=self.gui.add_info_message)

    def run_export_transaction_log(self):
        """导出交易日志"""
        self._run_task("导出交易日志", "core.transaction_log_exporter", "export_transaction_log", callback=self.gui.add_info_message)

    def run_format_laborhour(self):
        """格式化工时数据"""
        self._run_task("格式化工时数据", "core.labor_hour_formatter", "format_labor_hour", callback=self.gui.add_info_message)

    def run_format_product_qty(self):
        """格式化产量数据"""
        self._run_task("格式化产量数据", "core.product_quantity_formatter", "format_product_quantity")

    def run_team_shift(self):
        """处理团队班次数据"""
        self._run_task("处理团队班次数据", "core.team_shift_manager")

    def run_all_tasks(self):
        """立即执行所有任务"""
        self.gui.update_status_bar("正在执行所有任务")
        self.log_with_timestamp("开始执行所有任务")
        
        # 创建任务列表，只包含被勾选的任务
        tasks = []
        if self.gui.task_vars["transaction"].get():
            tasks.append(("导出交易日志", "core.transaction_log_exporter", "export_transaction_log", self.gui.add_info_message))
        if self.gui.task_vars["laborhour"].get():
            tasks.append(("格式化工时数据", "core.labor_hour_formatter", "format_labor_hour", self.gui.add_info_message))
        if self.gui.task_vars.get("product", tk.BooleanVar(value=False)).get():
            tasks.append(("格式化产量数据", "core.product_quantity_formatter", "format_product_quantity", self.gui.add_info_message))
        if self.gui.task_vars["planner"].get():
            tasks.append(("导出Planner数据", "core.planner_exporter", "export_planner_data", self.gui.add_info_message))
        if self.gui.task_vars.get("cmes", tk.BooleanVar(value=False)).get():
            tasks.append(("CMES数据采集", "core.cmes_data_collector", "collect_cmes_data", self.gui.add_info_message))
        
        if not tasks:
            self.log_with_timestamp("没有选中任何任务")
            self.gui.update_status_bar("就绪")
            return
        
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
                self.after(0, lambda name=task_name: self.log_with_timestamp(f"开始执行{name}..."))
                
                # 执行任务
                self._run_task(task_name, module_name, function_name, callback)
                
                # 等待任务完成
                self.task_complete.wait()
                self.task_complete.clear()
                
                # 在GUI线程中更新状态
                self.after(0, lambda name=task_name: self.log_with_timestamp(f"{name}执行完成"))
                time.sleep(2)  # 短暂等待以确保系统状态更新
            
            # 所有任务完成
            self.after(0, lambda: self.log_with_timestamp("所有任务执行完成"))
            self.after(0, lambda: self.gui.update_status_bar("就绪"))
        except Exception as e:
            self.after(0, lambda error=str(e): self.log_with_timestamp(f"任务队列执行出错: {error}"))
            self.after(0, lambda: self.gui.update_status_bar("执行失败", "error"))

    def _run_task(self, task_name, module_name, function_name="main", callback=None, **kwargs):
        """通用任务执行函数"""
        try:
            self.log_with_timestamp(f"开始{task_name}...")
            self.gui.update_status_bar(f"正在{task_name}", "running")  # 设置为运行中状态
            
            # 创建事件对象用于任务完成通知
            self.task_complete = threading.Event()
            
            # 使用线程而不是进程来执行任务
            task_thread = threading.Thread(
                target=self._run_task_thread,
                args=(task_name, module_name, function_name, callback),
                kwargs=kwargs
            )
            task_thread.daemon = True
            task_thread.start()
            
        except Exception as error:
            error_msg = str(error)
            self.after(0, lambda error=error_msg: self.log_with_timestamp(f"{task_name}时发生错误: {error}"))
            self.after(0, lambda: self.gui.update_status_bar("执行失败", "error"))  # 恢复绿色

    def _run_task_thread(self, task_name, module_name, function_name, callback=None, **kwargs):
        """在线程中执行任务"""
        # 清除中断标志，确保新任务可以正常执行
        clear_interrupt()
        
        try:
            # 获取当前文件的目录
            current_dir = os.path.dirname(os.path.abspath(__file__))
            # 获取src目录
            src_dir = os.path.dirname(current_dir)
            
            # 将src目录添加到Python路径
            if src_dir not in sys.path:
                sys.path.append(src_dir)
            
            # 导入模块
            module = __import__(module_name, fromlist=[function_name])
            if hasattr(module, function_name):
                func = getattr(module, function_name)
                # 传递所有参数给函数
                if callback:
                    kwargs['callback'] = callback
                func(**kwargs) if kwargs else func()
            else:
                # 尝试从模块中获取main函数
                if hasattr(module, 'main'):
                    func = getattr(module, 'main')
                    # 传递所有参数给函数
                    if callback:
                        kwargs['callback'] = callback
                    func(**kwargs) if kwargs else func()
                else:
                    raise AttributeError(f"模块 '{module_name}' 中未找到函数 '{function_name}' 或 'main'")

            self.after(0, lambda: self.log_with_timestamp(f"{task_name}完成"))
            self.after(0, lambda: self.gui.update_status_bar("就绪", "success"))
        except Exception as e:
            import traceback
            error_msg = f"{str(e)}\n完整堆栈跟踪:\n{traceback.format_exc()}"
            self.after(0, lambda error=error_msg: self.log_with_timestamp(f"{task_name}时发生错误: {error}"))
            self.after(0, lambda: self.gui.update_status_bar("执行失败", "error"))  # 恢复绿色
        finally:
            # 如果是PowerBI刷新任务，确保释放锁
            if task_name == "刷新PowerBI数据":
                with self._powerbi_refresh_lock:
                    self._powerbi_refresh_running = False
                    self.after(0, lambda: self.log_with_timestamp("✅ PowerBI刷新任务锁已释放"))
                
                # 通知GUI更新按钮状态（在主线程中执行）
                def update_gui():
                    try:
                        if hasattr(self, 'gui') and hasattr(self.gui, 'powerbi_btn'):
                            self.gui.powerbi_btn.configure(text="刷新PowerBI", state="normal")
                            self.gui.add_info_message("✅ PowerBI刷新任务已完成，按钮已恢复")
                            # 添加任务完成分隔符
                            self.gui.add_task_completion_separator()
                    except Exception as e:
                        self.log_with_timestamp(f"更新GUI按钮状态时出错: {str(e)}")
                
                self.after(0, update_gui)
            
            if hasattr(self, 'task_complete'):
                self.task_complete.set()

    def interrupt_all_tasks(self):
        """中断所有任务"""
        self.gui.add_info_message("🛑 正在中断所有任务...")
        
        # 设置全局中断标志
        request_interrupt()
        
        # 停止定时任务
        self.scheduler.running = False
        
        # 检查并终止定时任务线程
        if hasattr(self.scheduler, 'schedule_thread') and self.scheduler.schedule_thread.is_alive():
            self.scheduler.schedule_thread.join(timeout=1.0)
        
        # 检查并终止正在运行的任务线程
        if hasattr(self, 'task_complete'):
            self.task_complete.set()
        
        # 终止所有Python子进程和浏览器进程
        current_process = psutil.Process()
        
        # 终止所有由本程序启动的浏览器进程（Chrome 和 Edge）
        browser_names = ['chrome.exe', 'msedge.exe']
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                proc_name = proc.info['name'].lower() if proc.info['name'] else ''
                if proc_name in browser_names:
                    # 只终止包含 Playwright 用户配置目录的浏览器进程
                    cmdline = proc.info.get('cmdline', []) or []
                    cmdline_str = ' '.join(cmdline) if cmdline else ''
                    if 'User Data - Playwright' in cmdline_str:
                        process = psutil.Process(proc.info['pid'])
                        self.gui.add_info_message(f"正在终止浏览器进程: {process.pid}")
                        process.terminate()
                        process.wait(timeout=3)
            except (psutil.NoSuchProcess, psutil.TimeoutExpired, psutil.AccessDenied):
                try:
                    process.kill()
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
                            self.gui.add_info_message(f"保留GUI进程: {child.pid} ({child.name()})")
                            continue
                            
                        self.gui.add_info_message(f"正在终止子进程: {child.pid} ({child.name()})")
                        child.terminate()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                
                gone, alive = psutil.wait_procs(children, timeout=3)
                for p in alive:
                    try:
                        # 再次检查是否为toolkit_datacollector进程
                        if 'toolkit_datacollector' in p.name().lower():
                            continue
                            
                        self.gui.add_info_message(f"强制终止子进程: {p.pid}")
                        p.kill()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                
                return len(gone), len(alive)
            except Exception as e:
                self.gui.add_info_message(f"终止进程树时出错: {str(e)}")
                return 0, 0
        
        # 终止当前进程的所有子进程
        terminated, killed = terminate_process_tree(current_process.pid)
        self.gui.add_info_message(f"已终止 {terminated} 个子进程，强制终止 {killed} 个子进程")
        self.gui.update_status_bar("所有任务已中断")
        self.gui.add_info_message("所有任务已中断")
        
        # 重置按钮状态
        if hasattr(self.gui, 'start_btn'):
            self.gui.start_btn.config(text="启动定时任务")
        
        # 延迟5秒后自动重置中断标志，允许继续执行新任务
        def reset_interrupt_flag():
            import time
            time.sleep(5)
            clear_interrupt()
            # 清理所有任务锁
            from utils.task_lock_manager import task_lock_manager
            task_lock_manager.cleanup_expired_locks(timeout=0)  # 强制清理所有锁
            self.after(0, lambda: self.gui.add_info_message("✅ 系统已重置，可以继续执行任务"))
            self.after(0, lambda: self.gui.update_status_bar("就绪"))
        
        import threading
        reset_thread = threading.Thread(target=reset_interrupt_flag)
        reset_thread.daemon = True
        reset_thread.start()

    def open_planner_folder(self):
        """Planner数据"""
        folder_path = self.path_manager.get_planner_folder()
        if folder_path and os.path.exists(folder_path):
            os.startfile(folder_path)
            self.log_with_timestamp("已打开Planner数据文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在或未配置")

    def open_transaction_folder(self):
        """交易日志"""
        folder_path = self.path_manager.get_transaction_folder()
        if folder_path and os.path.exists(folder_path):
            os.startfile(folder_path)
            self.log_with_timestamp("已打开交易日志文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在或未配置")

    def open_laborhour_folder(self):
        """工时数据"""
        folder_path = self.path_manager.get_laborhour_folder()
        if folder_path and os.path.exists(folder_path):
            os.startfile(folder_path)
            self.log_with_timestamp("已打开工时数据文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在或未配置")

    def open_cmes_folder(self):
        """CMES数据"""
        folder_path = self.path_manager.get_cmes_folder()
        if folder_path and os.path.exists(folder_path):
            os.startfile(folder_path)
            self.log_with_timestamp("已打开CMES数据文件夹")
        else:
            messagebox.showerror("错误", "文件夹不存在或未配置")

    def add_schedule_time(self):
        """添加定时执行时间"""
        hour = int(self.gui.hour_var.get())
        minute = int(self.gui.minute_var.get())
        self.scheduler.add_schedule_time(hour, minute)

    def delete_schedule_time(self):
        """删除选中的定时执行时间"""
        selection = self.gui.time_listbox.curselection()
        if selection:
            self.scheduler.delete_schedule_time(selection[0])

    def toggle_schedule(self):
        """切换定时任务状态"""
        self.scheduler.toggle_schedule()

    def save_config(self):
        """保存定时任务配置"""
        self.scheduler.save_config()

    def quit_app(self):
        """退出应用程序"""
        try:
            # 设置退出标志
            self._is_quitting = True
            
            # 中断所有任务
            self.interrupt_all_tasks()
            
            # 保存配置
            self.save_config()
            
            # 关闭系统托盘图标
            if hasattr(self, 'system_tray') and self.system_tray:
                self.system_tray.hide()
            
            # 退出程序
            self.quit()
            sys.exit(0)
        except Exception as e:
            self.gui.add_info_message(f"退出程序时发生错误: {str(e)}")
            sys.exit(1)

    def on_close(self):
        """处理窗口关闭事件"""
        if not self._is_quitting:
            self._is_hidden = True
            self.withdraw()  # 隐藏主窗口
            if not self._balloon_shown:
                self.system_tray.show_balloon("程序已最小化", "程序将在后台继续运行")
                self._balloon_shown = True

    def on_configure(self, event):
        """处理窗口大小变化事件"""
        # 忽略窗口大小变化事件，防止触发最小化
        pass

    def on_minimize(self, event):
        """处理窗口最小化事件"""
        # 只有当窗口真正被最小化时才执行最小化操作
        if not self._is_quitting and not self._is_minimized and not self._is_hidden:
            # 检查窗口是否真的被最小化
            if self.state() == 'iconic':
                self._is_minimized = True
                self.iconify()  # 最小化到任务栏
                if not self._balloon_shown:
                    self.system_tray.show_balloon("程序已最小化", "程序将在后台继续运行")
                    self._balloon_shown = True

    def refresh_powerbi(self):
        """刷新PowerBI数据"""
        # 检查是否有PowerBI刷新任务正在运行
        with self._powerbi_refresh_lock:
            if self._powerbi_refresh_running:
                self.log_with_timestamp("⚠️ PowerBI刷新任务正在运行中，请等待当前任务完成")
                messagebox.showwarning("任务冲突", "PowerBI刷新任务正在运行中，请等待当前任务完成后再试。")
                return
            self._powerbi_refresh_running = True
        
        # 获取GUI中的无头模式和浏览器类型设置
        headless_mode = self.gui.headless_mode.get()
        browser_type = self.gui.browser_type.get()
        self._run_task("刷新PowerBI数据", "core.powerbi_refresh", "refresh_all_powerbi_data", 
                      callback=self.gui.add_info_message, headless=headless_mode, browser_type=browser_type)

    def show_window(self):
        """显示主窗口"""
        try:
            self._is_minimized = False
            self._is_hidden = False
            self.deiconify()
            self.lift()
            self.focus_force()
            self.update_idletasks()
        except Exception as e:
            self.log_with_timestamp(f"显示主窗口失败: {str(e)}")
            import traceback
            self.log_with_timestamp(f"错误详情: {traceback.format_exc()}")

    def check_webdriver(self):
        """检查WebDriver状态"""
        self.gui.check_webdriver()
    
    def install_playwright_browsers(self):
        """检查并安装Playwright浏览器"""
        import subprocess
        import threading
        
        def install_task():
            try:
                self.gui.add_info_message("🔍 正在检查Playwright浏览器安装状态...")
                
                # 检查是否已安装 Chromium
                chromium_installed = False
                msedge_installed = False
                
                try:
                    # 尝试导入 playwright 并检查浏览器
                    from playwright.sync_api import sync_playwright
                    with sync_playwright() as p:
                        # 尝试启动 Chromium
                        try:
                            browser = p.chromium.launch(headless=True)
                            browser.close()
                            chromium_installed = True
                            self.gui.add_info_message("✅ Chromium 浏览器已安装")
                        except Exception as e:
                            self.gui.add_info_message(f"❌ Chromium 未安装: {str(e)[:50]}")
                        
                        # 尝试启动 Edge
                        try:
                            browser = p.chromium.launch(channel="msedge", headless=True)
                            browser.close()
                            msedge_installed = True
                            self.gui.add_info_message("✅ Edge 浏览器已安装")
                        except Exception as e:
                            self.gui.add_info_message(f"⚠️ Edge 未配置: {str(e)[:50]}")
                except Exception as e:
                    self.gui.add_info_message(f"检查失败: {str(e)}")
                
                # 如果 Chromium 未安装，则安装
                if not chromium_installed:
                    self.gui.add_info_message("📦 正在安装 Chromium 浏览器，请稍候...")
                    self.gui.add_info_message("（这可能需要几分钟，取决于网络速度）")
                    
                    result = subprocess.run(
                        ["playwright", "install", "chromium"],
                        capture_output=True,
                        text=True,
                        timeout=600,  # 10分钟超时
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                    
                    if result.returncode == 0:
                        self.gui.add_info_message("✅ Chromium 浏览器安装成功！")
                    else:
                        self.gui.add_info_message(f"❌ Chromium 安装失败: {result.stderr[:100]}")
                
                self.gui.add_info_message("")
                self.gui.add_info_message("🎉 Playwright 浏览器检查完成！")
                self.gui.add_info_message("提示: 本程序使用系统已安装的 Chrome/Edge 浏览器")
                self.gui.add_info_message("请确保电脑上已安装 Chrome 或 Edge 浏览器")
                
            except subprocess.TimeoutExpired:
                self.gui.add_info_message("❌ 安装超时，请检查网络连接后重试")
            except FileNotFoundError:
                self.gui.add_info_message("❌ 未找到 playwright 命令")
                self.gui.add_info_message("请先运行: pip install playwright")
            except Exception as e:
                self.gui.add_info_message(f"❌ 安装过程出错: {str(e)}")
        
        # 在后台线程执行安装
        thread = threading.Thread(target=install_task)
        thread.daemon = True
        thread.start()
            
    def toggle_headless(self):
        """切换无头模式"""
        # 无头模式现在通过 GUI 的 headless_mode 变量控制
        current = self.gui.headless_mode.get()
        self.gui.headless_mode.set(not current)
        messagebox.showinfo("提示", f"无头模式已{'启用' if not current else '禁用'}")

    def log_message(self, message: str) -> None:
        """记录日志消息
        Args:
            message: 日志消息
        """
        self.logger.info(message)
        if hasattr(self, 'log_text'):
            self.log_text.insert(tk.END, f"{message}\n")
            self.log_text.see(tk.END)

    def handle_error(self, error: Exception, context: str = "") -> None:
        """处理错误
        Args:
            error: 异常对象
            context: 错误上下文
        """
        error_msg = f"{context}: {str(error)}" if context else str(error)
        self.logger.exception(error_msg)
        messagebox.showerror("错误", error_msg)

    def init_ui(self):
        try:
            self.logger.info("正在初始化用户界面...")
            # 窗体尺寸已在 __init__ 中设置，此处不再重复设置
            # 菜单栏已在 __init__ 中创建，此处不再重复调用
            # GUI的初始化已经在GUI类的__init__方法中完成
        except Exception as e:
            self.logger.exception("初始化用户界面时出错")
            raise

    def on_closing(self):
        self.logger.info("正在关闭应用程序...")
        if messagebox.askokcancel("退出", "确定要退出吗？"):
            self.destroy()

    def log_with_timestamp(self, message):
        """带时间戳的日志输出"""
        from datetime import datetime
        timestamp = datetime.now().strftime('%b-%d %H:%M:%S')
        formatted_message = f"[{timestamp}] {message}"
        print(formatted_message)
        if hasattr(self, 'gui'):
            self.gui.add_info_message(message)  # 传递原始消息，让GUI添加时间戳

    def show_error(self, message):
        self.logger.error(message)
        messagebox.showerror("错误", message)

# 全局日志函数
def log_with_timestamp(message):
    """带时间戳的日志输出（全局函数）"""
    from datetime import datetime
    timestamp = datetime.now().strftime('%b-%d %H:%M:%S')
    formatted_message = f"[{timestamp}] {message}"
    print(formatted_message)
    # 尝试获取应用程序实例并显示到GUI
    try:
        import sys
        for frame in sys._current_frames().values():
            if 'self' in frame.f_locals:
                obj = frame.f_locals['self']
                if hasattr(obj, 'gui') and hasattr(obj.gui, 'add_info_message'):
                    obj.gui.add_info_message(message)  # 传递原始消息，让GUI添加时间戳
                    break
    except:
        pass

def main():
    """主函数"""
    
    try:
        # 设置异常处理
        def handle_exception(exc_type, exc_value, exc_traceback):
            if issubclass(exc_type, KeyboardInterrupt):
                sys.__excepthook__(exc_type, exc_value, exc_traceback)
                return
            error_msg = f"未捕获的异常: {exc_type.__name__}: {exc_value}"
            log_with_timestamp(error_msg)
            # 尝试写入日志文件
            try:
                log_dir = os.path.join(os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.dirname(__file__)), 'config', 'logs')
                os.makedirs(log_dir, exist_ok=True)
                log_file = os.path.join(log_dir, f'error_{time.strftime("%Y%m%d_%H%M%S")}.log')
                with open(log_file, 'w', encoding='utf-8') as f:
                    f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} - {error_msg}\n")
                    import traceback
                    f.write(traceback.format_exc())
            except Exception as e:
                log_with_timestamp(f"写入日志文件失败: {str(e)}")
        
        sys.excepthook = handle_exception
        
        # 检查资源文件
        def check_resources():
            base_path = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.dirname(__file__))
            required_files = {
                'config/schedule_run_config.csv': '定时任务配置文件',
                'config/planner_config.csv': 'Planner配置文件',
                'config/powerbi_config.csv': 'PowerBI配置文件',
                'assets/app_icon.ico': '应用程序图标'
            }
            
            missing_files = []
            for file, description in required_files.items():
                file_path = os.path.join(base_path, file)
                if not os.path.exists(file_path):
                    missing_files.append(f"{description} ({file})")
            
            if missing_files:
                error_msg = "缺少必要的资源文件:\n" + "\n".join(missing_files)
                log_with_timestamp(error_msg)
                try:
                    log_dir = os.path.join(base_path, 'config', 'logs')
                    os.makedirs(log_dir, exist_ok=True)
                    log_file = os.path.join(log_dir, f'error_{time.strftime("%Y%m%d_%H%M%S")}.log')
                    with open(log_file, 'w', encoding='utf-8') as f:
                        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} - {error_msg}\n")
                except Exception as e:
                    log_with_timestamp(f"写入日志文件失败: {str(e)}")
                return False
            return True
        
        if not check_resources():
            messagebox.showerror("错误", "缺少必要的资源文件，程序即将退出。")
            return
        
        # 创建应用程序实例
        app = ToolKitApp()
        
        # 运行主循环
        app.mainloop()
        
    except Exception as e:
        error_msg = f"程序启动失败: {str(e)}"
        log_with_timestamp(error_msg)
        try:
            log_dir = os.path.join(os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.dirname(__file__)), 'config', 'logs')
            os.makedirs(log_dir, exist_ok=True)
            log_file = os.path.join(log_dir, f'error_{time.strftime("%Y%m%d_%H%M%S")}.log')
            with open(log_file, 'w', encoding='utf-8') as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} - {error_msg}\n")
                import traceback
                f.write(traceback.format_exc())
        except Exception as e:
            log_with_timestamp(f"写入日志文件失败: {str(e)}")
        messagebox.showerror("错误", error_msg)
        return

if __name__ == "__main__":
    main()