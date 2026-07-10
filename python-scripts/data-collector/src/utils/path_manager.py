import os
import sys
import csv
import shutil
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

class PathManager:
    def __init__(self):
        # 获取应用根目录
        if getattr(sys, 'frozen', False):
            self.app_dir = os.path.dirname(sys.executable)
        else:
            self.app_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            
        # 设置配置文件路径
        self.config_path = os.path.join(self.app_dir, 'config', 'path_config.csv')
        
        # 加载配置
        self.paths = self.load_config()
        
    def load_config(self):
        """加载路径配置（使用 csv 模块代替 pandas 加速启动）"""
        if os.path.exists(self.config_path):
            result = {}
            with open(self.config_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    result[row['path_name']] = row['path_value']
            return result
        return {}
        
    def save_config(self, paths=None):
        """保存路径配置（使用 csv 模块代替 pandas）"""
        try:
            # 创建配置目录
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            
            # 使用传入的paths或当前paths
            paths_to_save = paths if paths is not None else self.paths
            
            # 保存配置
            with open(self.config_path, 'w', encoding='utf-8', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(['path_name', 'path_value'])
                for name, value in paths_to_save.items():
                    writer.writerow([name, value])
            
            # 更新当前paths
            if paths is not None:
                self.paths = paths
                
            return True
        except Exception as e:
            # 使用全局日志函数
            try:
                from main import log_with_timestamp
                log_with_timestamp(f"保存配置时出错: {str(e)}")
            except:
                print(f"保存配置时出错: {str(e)}")
            return False
        
    def get_path(self, path_name):
        """获取指定路径
        Args:
            path_name: 路径名称，支持以下值：
                - 'planner_folder': Planner数据文件夹
                - 'transaction_folder': 交易日志文件夹
                - 'laborhour_folder': 工时数据文件夹
                - 'cmes_folder': CMES数据文件夹
                - 'config_folder': 配置文件目录
                - 'log_folder': 日志文件目录
                - 'assets_folder': assets文件夹
        """
        if path_name == 'assets_folder':
            return os.path.join(self.app_dir, 'assets')
            
        if path_name in self.paths:
            path = self.paths[path_name]
            path = path.replace('{username}', os.getlogin())
            path = path.replace('{app_dir}', self.app_dir)
            return path
        return None
        
    def get_planner_folder(self):
        """获取Planner数据文件夹路径"""
        return self.get_path('planner_folder')
        
    def get_transaction_folder(self):
        """获取交易日志文件夹路径"""
        return self.get_path('transaction_folder')
        
    def get_laborhour_folder(self):
        """获取工时数据文件夹路径"""
        return self.get_path('laborhour_folder')
        
    def get_cmes_folder(self):
        """获取CMES数据文件夹路径"""
        return self.get_path('cmes_folder')
        
    def get_config_folder(self):
        """获取配置文件目录路径"""
        return self.get_path('config_folder')
        
    def get_log_folder(self):
        """获取日志文件目录路径"""
        return self.get_path('log_folder')
        
    def get_assets_folder(self):
        """获取assets文件夹路径"""
        return self.get_path('assets_folder')
        
    def get_icon_path(self, icon_type='ico'):
        """获取图标路径
        Args:
            icon_type: 'ico' 或 'png'，默认为 'ico'
        """
        icon_name = f'app_icon.{icon_type}'
        icon_path = os.path.join(self.app_dir, 'assets', icon_name)
        if not os.path.exists(icon_path):
            # 使用全局日志函数
            try:
                from main import log_with_timestamp
                log_with_timestamp(f"警告：找不到图标文件：{icon_path}")
            except:
                print(f"警告：找不到图标文件：{icon_path}")
            return None
        return icon_path
            
    def show_config_dialog(self, parent):
        """显示路径配置对话框"""
        dialog = PathConfigDialog(parent, self)
        dialog.transient(parent)
        dialog.grab_set()
        parent.wait_window(dialog)

class PathConfigDialog(tk.Toplevel):
    def __init__(self, parent, path_manager):
        super().__init__(parent)
        self.path_manager = path_manager
        self.title("路径配置")
        self.geometry("700x500")
        self.resizable(True, True)
        
        # 创建主框架
        main_frame = ttk.Frame(self, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # 创建笔记本控件
        notebook = ttk.Notebook(main_frame)
        notebook.pack(fill=tk.BOTH, expand=True, pady=(0, 10))
        
        # 创建业务路径配置页面
        business_frame = ttk.Frame(notebook)
        notebook.add(business_frame, text="业务路径配置")
        
        # 创建软件路径配置页面
        system_frame = ttk.Frame(notebook)
        notebook.add(system_frame, text="软件路径配置")
        
        # 创建业务路径表格
        self.business_tree = ttk.Treeview(business_frame, columns=('path_name', 'path_value'), show='headings')
        self.business_tree.heading('path_name', text='路径名称')
        self.business_tree.heading('path_value', text='路径值')
        self.business_tree.column('path_name', width=150)
        self.business_tree.column('path_value', width=500, anchor='e')  # 设置右对齐
        
        # 添加业务路径滚动条
        business_scrollbar = ttk.Scrollbar(business_frame, orient=tk.VERTICAL, command=self.business_tree.yview)
        self.business_tree.configure(yscrollcommand=business_scrollbar.set)
        
        # 布局业务路径表格和滚动条
        self.business_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        business_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # 创建软件路径表格
        self.system_tree = ttk.Treeview(system_frame, columns=('path_name', 'path_value'), show='headings')
        self.system_tree.heading('path_name', text='路径名称')
        self.system_tree.heading('path_value', text='路径值')
        self.system_tree.column('path_name', width=150)
        self.system_tree.column('path_value', width=500, anchor='e')  # 设置右对齐
        
        # 添加软件路径滚动条
        system_scrollbar = ttk.Scrollbar(system_frame, orient=tk.VERTICAL, command=self.system_tree.yview)
        self.system_tree.configure(yscrollcommand=system_scrollbar.set)
        
        # 布局软件路径表格和滚动条
        self.system_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        system_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # 绑定双击事件
        self.business_tree.bind('<Double-1>', self.on_double_click)
        self.system_tree.bind('<Double-1>', self.on_double_click)
        
        # 创建日志框架
        log_frame = ttk.LabelFrame(main_frame, text="检查结果", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 10))
        
        # 创建日志文本框和滚动条
        self.log_text = tk.Text(log_frame, height=6, wrap=tk.WORD)
        log_scrollbar = ttk.Scrollbar(log_frame, orient=tk.VERTICAL, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scrollbar.set)
        
        # 布局日志文本框和滚动条
        self.log_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        log_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # 创建按钮框架
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X, pady=(0, 10))
        
        # 添加按钮
        ttk.Button(button_frame, text="检查路径", command=self.check_paths).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="保存配置", command=self.save_config).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="关闭", command=self.destroy).pack(side=tk.RIGHT, padx=5)
        
        # 添加工具提示
        self.tooltip = None
        self.business_tree.bind('<Motion>', self.show_path_tooltip)
        self.system_tree.bind('<Motion>', self.show_path_tooltip)
        
        # 填充表格
        self.update_trees()
        
    def format_path(self, path, max_visible_chars=70):
        """格式化路径显示，保留最右侧的内容"""
        if len(path) <= max_visible_chars:
            return path
        return "..." + path[-(max_visible_chars-3):]
        
    def update_trees(self):
        """更新两个表格的显示"""
        # 清除现有内容
        for item in self.business_tree.get_children():
            self.business_tree.delete(item)
        for item in self.system_tree.get_children():
            self.system_tree.delete(item)
            
        # 系统路径（固定的三个）
        system_paths = ['config_folder', 'log_folder', 'assets_folder']
        
        # 遍历所有路径
        for name, path in self.path_manager.paths.items():
            # 替换占位符
            full_path = path.replace('{username}', os.getlogin())
            full_path = full_path.replace('{app_dir}', self.path_manager.app_dir)
            
            # 格式化路径显示
            display_path = self.format_path(full_path)
            
            # 根据路径类型添加到相应的表格
            if name in system_paths:
                self.system_tree.insert('', 'end', values=(name, display_path), tags=(full_path,))
            else:
                self.business_tree.insert('', 'end', values=(name, display_path), tags=(full_path,))
    
    def show_path_tooltip(self, event):
        """显示完整路径的工具提示"""
        tree = event.widget
        item = tree.identify_row(event.y)
        if item:
            # 获取鼠标所在列
            column = tree.identify_column(event.x)
            if column == '#2':  # 路径值列
                full_path = tree.item(item)['tags'][0]
                
                # 如果已经有工具提示且显示的是相同的路径，则不更新
                if hasattr(self, '_last_tooltip_path') and self._last_tooltip_path == full_path:
                    return
                
                # 销毁旧的工具提示
                if self.tooltip:
                    self.tooltip.destroy()
                
                # 创建新的工具提示
                self.tooltip = tk.Toplevel(self)
                self.tooltip.wm_overrideredirect(True)
                label = tk.Label(self.tooltip, text=full_path, justify=tk.LEFT,
                               background="#ffffe0", relief=tk.SOLID, borderwidth=1)
                label.pack()
                
                # 计算工具提示位置
                x = event.x_root + 10
                y = event.y_root + 10
                self.tooltip.wm_geometry(f"+{x}+{y}")
                
                # 记录当前显示的路径
                self._last_tooltip_path = full_path
        else:
            # 鼠标离开路径时销毁工具提示
            if self.tooltip:
                self.tooltip.destroy()
                self.tooltip = None
                self._last_tooltip_path = None
                
    def on_double_click(self, event):
        """处理双击事件"""
        tree = event.widget
        item = tree.identify('item', event.x, event.y)
        if item:
            # 获取路径信息
            path_name = tree.item(item)['values'][0]
            full_path = tree.item(item)['tags'][0]
            
            # 选择文件夹
            folder_path = filedialog.askdirectory(
                title=f"选择{path_name}",
                initialdir=os.path.dirname(full_path) if os.path.exists(full_path) else None
            )
            
            if folder_path:
                # 更新路径
                self.path_manager.paths[path_name] = folder_path
                self.update_trees()

    def save_config(self):
        """保存配置"""
        if self.path_manager.save_config():
            messagebox.showinfo("成功", "配置已保存")
        else:
            messagebox.showerror("错误", "保存配置时出错")
            
    def destroy(self):
        """关闭对话框时清理工具提示"""
        if self.tooltip:
            self.tooltip.destroy()
        super().destroy()

    def add_log(self, message, is_error=False):
        """添加日志消息"""
        self.log_text.insert(tk.END, message + '\n')
        if is_error:
            # 获取最后一行的起始和结束位置
            last_line_start = self.log_text.get("1.0", tk.END).rstrip().rfind('\n') + 1
            self.log_text.tag_add("error", f"1.{last_line_start}", "end-1c")
            self.log_text.tag_config("error", foreground="red")
        self.log_text.see(tk.END)

    def check_paths(self):
        """检查所有路径的有效性"""
        self.log_text.delete(1.0, tk.END)  # 清空日志
        self.add_log("开始检查路径...\n")
        
        all_valid = True
        system_paths = ['config_folder', 'log_folder', 'assets_folder']
        
        for name, path in self.path_manager.paths.items():
            # 替换占位符
            full_path = path.replace('{username}', os.getlogin())
            full_path = full_path.replace('{app_dir}', self.path_manager.app_dir)
            
            # 检查路径是否存在
            if os.path.exists(full_path):
                if os.path.isdir(full_path):
                    # 检查是否有读写权限
                    try:
                        test_file = os.path.join(full_path, '.test_write')
                        with open(test_file, 'w') as f:
                            f.write('test')
                        os.remove(test_file)
                        self.add_log(f"✓ {name}: 路径正常，具有读写权限")
                    except Exception as e:
                        all_valid = False
                        self.add_log(f"✗ {name}: 路径存在但没有读写权限 - {str(e)}", True)
                else:
                    all_valid = False
                    self.add_log(f"✗ {name}: 路径存在但不是文件夹", True)
            else:
                # 对于系统路径，尝试创建
                if name in system_paths:
                    try:
                        os.makedirs(full_path, exist_ok=True)
                        self.add_log(f"✓ {name}: 路径不存在，已自动创建")
                    except Exception as e:
                        all_valid = False
                        self.add_log(f"✗ {name}: 路径不存在且无法创建 - {str(e)}", True)
                else:
                    all_valid = False
                    self.add_log(f"✗ {name}: 路径不存在", True)
        
        # 添加总结
        self.add_log(f"\n检查完成: {'所有路径正常' if all_valid else '存在异常路径，请检查红色提示'}") 

def get_base_path():
    """获取项目根目录路径"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        current_dir = os.path.dirname(__file__)  # utils目录
        src_dir = os.path.dirname(current_dir)   # src目录
        return os.path.dirname(src_dir)         # 项目根目录

def get_path_from_config(path_name):
    """从配置文件获取路径（使用 csv 模块代替 pandas）"""
    base_path = get_base_path()
    config_path = os.path.join(base_path, 'config', 'path_config.csv')
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"配置文件不存在: {config_path}")

    # 使用 csv 模块读取配置
    with open(config_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['path_name'] == path_name:
                path_value = row['path_value']
                return path_value.replace('{username}', os.getlogin()).replace('{app_dir}', base_path)

    raise ValueError(f"未找到路径配置: {path_name}")