import sys
from PyQt5.QtWidgets import QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit
from PyQt5.QtCore import Qt, QPropertyAnimation, QRect

class SlidePanelWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.initUI()
        
    def initUI(self):
        # 设置主窗口
        self.setWindowTitle('滑动面板测试')
        self.setGeometry(100, 100, 400, 200)
        
        # 创建中央部件
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        layout = QVBoxLayout(central_widget)
        
        # 创建主窗体的文本框和按钮
        self.main_text = QLineEdit()
        self.main_text.setReadOnly(True)
        self.show_panel_btn = QPushButton('显示输入面板')
        self.show_panel_btn.clicked.connect(self.toggleSidePanel)
        
        layout.addWidget(self.main_text)
        layout.addWidget(self.show_panel_btn)
        
        # 创建侧边面板
        self.side_panel = QWidget(self)
        self.side_panel.setGeometry(-200, 0, 200, self.height())
        self.side_panel.setStyleSheet('background-color: white; border-right: 1px solid gray;')
        
        # 侧边面板布局
        panel_layout = QVBoxLayout(self.side_panel)
        self.input_text = QLineEdit()
        save_btn = QPushButton('保存')
        save_btn.clicked.connect(self.savePanelInput)
        
        panel_layout.addWidget(self.input_text)
        panel_layout.addWidget(save_btn)
        
        # 初始化动画
        self.animation = QPropertyAnimation(self.side_panel, b'geometry')
        self.animation.setDuration(300)
        
        self.is_panel_visible = False
        
    def toggleSidePanel(self):
        if not self.is_panel_visible:
            # 显示面板
            self.animation.setStartValue(QRect(-200, 0, 200, self.height()))
            self.animation.setEndValue(QRect(0, 0, 200, self.height()))
        else:
            # 隐藏面板
            self.animation.setStartValue(QRect(0, 0, 200, self.height()))
            self.animation.setEndValue(QRect(-200, 0, 200, self.height()))
            
        self.animation.start()
        self.is_panel_visible = not self.is_panel_visible
        
    def savePanelInput(self):
        # 保存输入内容并隐藏面板
        self.main_text.setText(self.input_text.text())
        self.toggleSidePanel()
        
    def resizeEvent(self, event):
        # 窗口大小改变时调整侧边面板高度
        super().resizeEvent(event)
        if self.is_panel_visible:
            self.side_panel.setGeometry(0, 0, 200, self.height())
        else:
            self.side_panel.setGeometry(-200, 0, 200, self.height())

if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = SlidePanelWindow()
    window.show()
    sys.exit(app.exec_())