from PyQt5.QtWidgets import QSystemTrayIcon, QMenu, QAction, QApplication
from PyQt5.QtGui import QIcon

class SystemTray:
    def __init__(self, app, icon_path):
        self.app = app
        self.icon_path = icon_path
        self.init_system_tray()

    def init_system_tray(self):
        """初始化系统托盘"""
        # 创建QApplication实例（如果不存在）
        self.qt_app = QApplication.instance()
        if not self.qt_app:
            self.qt_app = QApplication([])
        
        # 创建系统托盘图标
        self.tray_icon = QSystemTrayIcon()
        self.tray_icon.setIcon(QIcon(self.icon_path))
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

    def show_message(self, title, message):
        """显示托盘消息"""
        self.tray_icon.showMessage(title, message, QSystemTrayIcon.Information, 2000)

    def hide(self):
        """隐藏托盘图标"""
        self.tray_icon.hide()