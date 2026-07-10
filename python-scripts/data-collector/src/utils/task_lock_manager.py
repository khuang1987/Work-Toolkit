import threading
import time
import os
import tempfile
from datetime import datetime
import logging

# 全局中断标志
_interrupt_flag = threading.Event()

def request_interrupt():
    """请求中断所有任务"""
    _interrupt_flag.set()
    logging.info("🛑 已请求中断所有任务")

def clear_interrupt():
    """清除中断标志"""
    _interrupt_flag.clear()
    logging.info("✅ 已清除中断标志")

def is_interrupted():
    """检查是否已请求中断"""
    return _interrupt_flag.is_set()

def check_interrupt():
    """
    检查中断状态，如果已中断则抛出异常
    在任务循环中调用此函数以支持快速中断
    """
    if _interrupt_flag.is_set():
        raise InterruptedError("任务已被用户中断")

class InterruptedError(Exception):
    """任务中断异常"""
    pass

class TaskLockManager:
    """任务锁管理器，防止重复执行"""
    
    def __init__(self):
        self._locks = {}
        self._lock_files = {}
        self._temp_dir = tempfile.gettempdir()
        
    def acquire_lock(self, task_name, timeout=300):
        """
        获取任务锁
        
        Args:
            task_name: 任务名称
            timeout: 锁超时时间（秒），默认5分钟
            
        Returns:
            bool: 是否成功获取锁
        """
        try:
            # 检查是否已有锁
            if task_name in self._locks:
                lock = self._locks[task_name]
                if lock['lock'].locked():
                    # 检查锁是否超时
                    if time.time() - lock['acquire_time'] > timeout:
                        self._release_lock(task_name)
                    else:
                        return False
            
            # 创建新锁
            lock = threading.Lock()
            if lock.acquire(blocking=False):
                self._locks[task_name] = {
                    'lock': lock,
                    'acquire_time': time.time(),
                    'task_name': task_name
                }
                
                # 创建锁文件
                lock_file = os.path.join(self._temp_dir, f"datacollector_{task_name}.lock")
                try:
                    with open(lock_file, 'w') as f:
                        f.write(f"Task: {task_name}\nAcquire Time: {datetime.now()}\nPID: {os.getpid()}")
                    self._lock_files[task_name] = lock_file
                except Exception as e:
                    logging.warning(f"创建锁文件失败: {e}")
                
                logging.info(f"✅ 成功获取任务锁: {task_name}")
                return True
            else:
                return False
                
        except Exception as e:
            logging.error(f"获取任务锁失败 {task_name}: {e}")
            return False
    
    def release_lock(self, task_name):
        """
        释放任务锁
        
        Args:
            task_name: 任务名称
        """
        self._release_lock(task_name)
    
    def _release_lock(self, task_name):
        """内部释放锁方法"""
        try:
            if task_name in self._locks:
                lock_info = self._locks[task_name]
                if lock_info['lock'].locked():
                    lock_info['lock'].release()
                
                # 删除锁文件
                if task_name in self._lock_files:
                    lock_file = self._lock_files[task_name]
                    try:
                        if os.path.exists(lock_file):
                            os.remove(lock_file)
                    except Exception as e:
                        logging.warning(f"删除锁文件失败: {e}")
                    del self._lock_files[task_name]
                
                del self._locks[task_name]
                logging.info(f"✅ 成功释放任务锁: {task_name}")
                
        except Exception as e:
            logging.error(f"释放任务锁失败 {task_name}: {e}")
    
    def is_locked(self, task_name):
        """
        检查任务是否被锁定
        
        Args:
            task_name: 任务名称
            
        Returns:
            bool: 是否被锁定
        """
        if task_name in self._locks:
            lock_info = self._locks[task_name]
            return lock_info['lock'].locked()
        return False
    
    def get_lock_info(self, task_name):
        """
        获取锁信息
        
        Args:
            task_name: 任务名称
            
        Returns:
            dict: 锁信息
        """
        if task_name in self._locks:
            lock_info = self._locks[task_name]
            return {
                'task_name': task_name,
                'is_locked': lock_info['lock'].locked(),
                'acquire_time': lock_info['acquire_time'],
                'lock_file': self._lock_files.get(task_name)
            }
        return None
    
    def cleanup_expired_locks(self, timeout=300):
        """
        清理过期的锁
        
        Args:
            timeout: 超时时间（秒）
        """
        current_time = time.time()
        expired_tasks = []
        
        for task_name, lock_info in self._locks.items():
            if current_time - lock_info['acquire_time'] > timeout:
                expired_tasks.append(task_name)
        
        for task_name in expired_tasks:
            logging.warning(f"清理过期锁: {task_name}")
            self._release_lock(task_name)

# 全局锁管理器实例
task_lock_manager = TaskLockManager()

def acquire_task_lock(task_name, timeout=300):
    """获取任务锁的便捷函数"""
    return task_lock_manager.acquire_lock(task_name, timeout)

def release_task_lock(task_name):
    """释放任务锁的便捷函数"""
    task_lock_manager.release_lock(task_name)

def is_task_locked(task_name):
    """检查任务是否被锁定的便捷函数"""
    return task_lock_manager.is_locked(task_name)


