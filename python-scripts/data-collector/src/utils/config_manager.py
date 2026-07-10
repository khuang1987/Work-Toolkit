import os
import json
from typing import Dict, Any

class ConfigManager:
    def __init__(self, config_file: str = "config.json"):
        self.config_file = config_file
        self.config: Dict[str, Any] = {}
        self.load_config()

    def load_config(self) -> None:
        """加载配置文件"""
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, 'r', encoding='utf-8') as f:
                    self.config = json.load(f)
            except Exception as e:
                # 使用全局日志函数
                try:
                    from main import log_with_timestamp
                    log_with_timestamp(f"加载配置文件失败: {str(e)}")
                except:
                    print(f"加载配置文件失败: {str(e)}")
                self.config = {}

    def save_config(self) -> None:
        """保存配置文件"""
        try:
            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, indent=4, ensure_ascii=False)
        except Exception as e:
            # 使用全局日志函数
            try:
                from main import log_with_timestamp
                log_with_timestamp(f"保存配置文件失败: {str(e)}")
            except:
                print(f"保存配置文件失败: {str(e)}")

    def get(self, key: str, default: Any = None) -> Any:
        """获取配置项"""
        return self.config.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """设置配置项"""
        self.config[key] = value
        self.save_config()

    def delete(self, key: str) -> None:
        """删除配置项"""
        if key in self.config:
            del self.config[key]
            self.save_config() 