import os
import logging
import logging.handlers
from datetime import datetime
from typing import Optional, Callable

class LogManager:
    def __init__(self, log_dir: str = "logs", max_bytes: int = 3*1024*1024, backup_count: int = 3):
        """初始化日志管理器
        Args:
            log_dir: 日志目录
            max_bytes: 单个日志文件最大大小（字节），默认3MB
            backup_count: 保留的日志文件数量，默认3个备份
        """
        self.log_dir = log_dir
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        self.callbacks = []
        self.setup_logging()

    def setup_logging(self) -> None:
        """设置日志系统"""
        # 创建日志目录
        if not os.path.exists(self.log_dir):
            os.makedirs(self.log_dir)

        # 设置日志文件名（使用当前日期）
        log_file = os.path.join(self.log_dir, f"app_{datetime.now().strftime('%Y%m%d')}.log")

        # 配置日志
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            handlers=[
                logging.handlers.RotatingFileHandler(
                    log_file,
                    maxBytes=self.max_bytes,
                    backupCount=self.backup_count,
                    encoding='utf-8'
                ),
                logging.StreamHandler()
            ]
        )

    def add_callback(self, callback: Callable[[str], None]) -> None:
        """添加日志回调函数
        Args:
            callback: 接收日志消息的回调函数
        """
        if callback not in self.callbacks:
            self.callbacks.append(callback)

    def remove_callback(self, callback: Callable[[str], None]) -> None:
        """移除日志回调函数
        Args:
            callback: 要移除的回调函数
        """
        if callback in self.callbacks:
            self.callbacks.remove(callback)

    def _notify_callbacks(self, message: str) -> None:
        """通知所有回调函数
        Args:
            message: 日志消息
        """
        for callback in self.callbacks:
            try:
                callback(message)
            except Exception as e:
                print(f"日志回调执行失败: {str(e)}")

    def log(self, level: int, message: str, *args, **kwargs) -> None:
        """记录日志
        Args:
            level: 日志级别
            message: 日志消息
            *args: 格式化参数
            **kwargs: 格式化参数
        """
        # 格式化消息
        formatted_message = message % args if args else message
        
        # 记录到文件和控制台
        logging.log(level, formatted_message, **kwargs)
        
        # 通知回调函数
        self._notify_callbacks(formatted_message)

    def debug(self, message: str, *args, **kwargs) -> None:
        """记录调试日志"""
        self.log(logging.DEBUG, message, *args, **kwargs)

    def info(self, message: str, *args, **kwargs) -> None:
        """记录信息日志"""
        self.log(logging.INFO, message, *args, **kwargs)

    def warning(self, message: str, *args, **kwargs) -> None:
        """记录警告日志"""
        self.log(logging.WARNING, message, *args, **kwargs)

    def error(self, message: str, *args, **kwargs) -> None:
        """记录错误日志"""
        self.log(logging.ERROR, message, *args, **kwargs)

    def critical(self, message: str, *args, **kwargs) -> None:
        """记录严重错误日志"""
        self.log(logging.CRITICAL, message, *args, **kwargs)

    def exception(self, message: str, *args, **kwargs) -> None:
        """记录异常日志"""
        self.log(logging.ERROR, message, *args, exc_info=True, **kwargs) 