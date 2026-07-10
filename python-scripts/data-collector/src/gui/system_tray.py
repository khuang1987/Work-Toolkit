import os
import sys
import tkinter as tk
from PIL import Image, ImageTk
import pystray
from pystray import MenuItem as item
import threading
import time
from utils.log_manager import LogManager

class SystemTray:
    def __init__(self, app):
        self.app = app
        self.logger = LogManager()
        self.icon_path = None
        self.tray_icon = None
        self.tray_thread = None
        self.last_click_time = 0
        self.init_system_tray()

    def init_system_tray(self):
        """初始化系统托盘"""
        try:
            icon_path = self.app.path_manager.get_icon_path('ico')
            if not icon_path:
                self.logger.error("找不到图标文件")
                raise FileNotFoundError("找不到图标文件")
            
            self.logger.info("正在初始化系统托盘...")
            # 获取图标路径
            icon_path = self.app.path_manager.get_icon_path('ico')
            if not icon_path:
                raise FileNotFoundError("找不到图标文件")
                
            # 创建托盘图标
            try:
                image = Image.open(icon_path)
                image = image.resize((64, 64), Image.Resampling.LANCZOS)
                try:
                    from main import log_with_timestamp
                    log_with_timestamp("图标加载成功")
                except:
                    print("图标加载成功")
            except Exception as e:
                try:
                    from main import log_with_timestamp
                    log_with_timestamp(f"加载图标文件失败: {str(e)}")
                except:
                    print(f"加载图标文件失败: {str(e)}")
                # 创建一个简单的默认图标
                image = Image.new('RGB', (64, 64), color='blue')
                try:
                    from main import log_with_timestamp
                    log_with_timestamp("使用默认蓝色图标")
                except:
                    print("使用默认蓝色图标")
            
            # 创建菜单，设置"显示主窗口"为默认动作（双击触发）
            menu = pystray.Menu(
                item("显示主窗口", self.show_window, default=True),
                item("彻底退出", self.quit_app)
            )
            
            # 创建托盘图标
            self.tray_icon = pystray.Icon(
                "Toolkit DataCollector",
                image,
                "Toolkit DataCollector",
                menu
            )
            
            # 在新线程中运行托盘图标
            if not hasattr(self, 'tray_thread') or not self.tray_thread or not self.tray_thread.is_alive():
                self.tray_thread = threading.Thread(target=self.tray_icon.run)
                self.tray_thread.daemon = True
                self.tray_thread.start()
            
            # 托盘图标在后台线程初始化，无需等待
        except Exception as e:
            self.logger.exception("初始化系统托盘时出错")
            # 如果系统托盘初始化失败，至少确保主窗口可以正常显示
            try:
                self.app.deiconify()
            except:
                pass

    def show_window(self):
        """显示主窗口"""
        try:
            # 使用 after 方法确保在主线程中执行
            self.app.after(0, self.app.show_window)
        except Exception as e:
            try:
                from main import log_with_timestamp
                log_with_timestamp(f"显示主窗口失败: {str(e)}")
                import traceback
                log_with_timestamp(f"错误详情: {traceback.format_exc()}")
            except:
                print(f"显示主窗口失败: {str(e)}")
                import traceback
                print(f"错误详情: {traceback.format_exc()}")

    def hide(self):
        """隐藏系统托盘图标"""
        try:
            if self.tray_icon:
                self.tray_icon.stop()
            # 移除线程join操作，因为可能导致死锁
            self.tray_thread = None
        except Exception as e:
            try:
                from main import log_with_timestamp
                log_with_timestamp(f"隐藏系统托盘图标失败: {str(e)}")
            except:
                print(f"隐藏系统托盘图标失败: {str(e)}")

    def quit_app(self):
        """退出应用程序"""
        try:
            self.logger.info("正在退出应用程序...")
            # 停止托盘图标
            if self.tray_icon:
                self.tray_icon.stop()
            # 调用主程序的退出方法
            self.app.quit_app()
        except Exception as e:
            try:
                from main import log_with_timestamp
                log_with_timestamp(f"退出应用程序失败: {str(e)}")
            except:
                print(f"退出应用程序失败: {str(e)}")
            # 如果正常退出失败，强制退出
            os._exit(1)

    def show_message(self, title, message):
        """显示托盘消息"""
        try:
            if self.tray_icon:
                self.tray_icon.notify(message, title)
        except Exception as e:
            try:
                from main import log_with_timestamp
                log_with_timestamp(f"显示托盘消息失败: {str(e)}")
            except:
                print(f"显示托盘消息失败: {str(e)}")

    def show_balloon(self, title, message):
        """显示气泡提示（兼容性方法，映射到show_message）"""
        self.show_message(title, message)

    def on_quit(self, icon, item):
        self.logger.info("正在退出应用程序...")
        self.quit_app()