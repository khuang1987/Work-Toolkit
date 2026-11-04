"""Copied from ../caleb-desktop-pet/app/right_ctrl.py (1.8.1) for the toolbox AI hotkey.

Original notes follow.

Ctrl 单击检测：单独按一下触发键（默认左右 Ctrl 都算）就打开“聊聊”输入框。

三个刻意的选择：

* **不过滤“注入”事件**。改键工具（比如 PowerToys 键盘管理器）、远程桌面、虚拟机
  都会把按键标成注入；这个程序从不自己发按键，过滤只会让快捷键在别人机器上
  “看起来没反应”。
* **触发键可配置**。默认左右 Ctrl 都行；如果你的 Ctrl 被改键成了别的键码，在
  配置面板里把改键后的那颗键捕获进来即可——钩子看到的本来就是改键后的键。
* **保留 solo 判定**：按下触发键之后又按了别的键（Ctrl+C 之类）就不算单击，
  免得用个快捷键就蹦出输入框。
"""
import ctypes as c
from ctypes import wintypes as w
import queue
import threading
import time

CONTROL_KEYS = (0xA2, 0xA3)  # VK_LCONTROL, VK_RCONTROL
KEY_MESSAGES = (0x100, 0x101, 0x104, 0x105)  # KEYDOWN / KEYUP / SYSKEYDOWN / SYSKEYUP
# 修饰键：捕获触发键时跳过它们，只捕获“能当热键”的普通键。
MODIFIER_KEYS = (0x10, 0xA0, 0xA1, 0x11, 0xA2, 0xA3, 0x12, 0x5B, 0x5C)


KEYEVENTF_KEYUP = 0x0002
INPUT_KEYBOARD = 1


def press_key(vk: int, hold: float = 0.05) -> bool:
    """真实地按一次某颗键（SendInput）。用来唤起输入法的热键，比如微信语音的 Alt。"""
    class MOUSEINPUT(c.Structure):
        _fields_ = [('dx', w.LONG), ('dy', w.LONG), ('mouseData', w.DWORD),
                    ('dwFlags', w.DWORD), ('time', w.DWORD), ('dwExtraInfo', c.POINTER(c.c_ulong))]

    class KEYBDINPUT(c.Structure):
        _fields_ = [('wVk', w.WORD), ('wScan', w.WORD), ('dwFlags', w.DWORD),
                    ('time', w.DWORD), ('dwExtraInfo', c.POINTER(c.c_ulong))]

    class HARDWAREINPUT(c.Structure):
        _fields_ = [('uMsg', w.DWORD), ('wParamL', w.WORD), ('wParamH', w.WORD)]

    class U(c.Union):
        _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]

    class INPUT(c.Structure):
        _fields_ = [('type', w.DWORD), ('union', U)]

    down, up = INPUT(type=INPUT_KEYBOARD), INPUT(type=INPUT_KEYBOARD)
    down.union.ki = KEYBDINPUT(wVk=vk)
    up.union.ki = KEYBDINPUT(wVk=vk, dwFlags=KEYEVENTF_KEYUP)
    events = (INPUT * 2)(down, up)
    sent = c.windll.user32.SendInput(2, events, c.sizeof(INPUT))
    if hold:
        time.sleep(hold)
    return bool(sent)


class TapDetector:
    def __init__(self, accept=None):
        self.accept = set(accept) if accept else set(CONTROL_KEYS)
        self.down = set()
        self.solo = False
        self.taps = 0

    def feed(self, vk, pressed):
        if pressed:
            if vk in self.accept and vk not in self.down:
                self.solo = not self.down
            elif vk not in self.accept:
                self.solo = False
            self.down.add(vk)
            return False
        fire = vk in self.accept and vk in self.down and self.solo
        self.down.discard(vk)
        if vk in self.accept:
            self.solo = False
        if fire:
            self.taps += 1
        return fire


class RightCtrl:
    def __init__(self, accept=None):
        self.events = queue.Queue()
        self.captured = queue.Queue()   # 捕获触发键时，把按下的键码丢进来
        self.capturing = False
        self.thread_id = None
        self.stopped = threading.Event()
        self.available = False
        self.taps = 0
        self.accept = set(accept) if accept else set(CONTROL_KEYS)
        threading.Thread(target=self._run, daemon=True, name='toolbox-ai-hotkey').start()

    def set_accept(self, keys) -> None:
        """更新触发键集合（不改键的话默认就是左右 Ctrl）。"""
        self.accept = set(keys)
        if getattr(self, 'detector', None):
            self.detector.accept = set(keys)

    def start_capture(self) -> None:
        self.captured = queue.Queue()
        self.capturing = True

    def _run(self):
        u, k = c.windll.user32, c.windll.kernel32
        callback_type = c.WINFUNCTYPE(c.c_ssize_t, c.c_int, w.WPARAM, w.LPARAM)
        class Key(c.Structure):
            _fields_ = [('vk', w.DWORD), ('scan', w.DWORD), ('flags', w.DWORD), ('time', w.DWORD), ('extra', c.c_size_t)]
        u.SetWindowsHookExW.argtypes = [c.c_int, callback_type, w.HINSTANCE, w.DWORD]
        u.SetWindowsHookExW.restype = w.HANDLE
        u.CallNextHookEx.argtypes = [w.HANDLE, c.c_int, w.WPARAM, w.LPARAM]
        u.CallNextHookEx.restype = c.c_ssize_t
        u.UnhookWindowsHookEx.argtypes = [w.HANDLE]
        k.GetModuleHandleW.argtypes = [w.LPCWSTR]
        k.GetModuleHandleW.restype = w.HMODULE
        self.detector = detector = TapDetector(self.accept)
        @callback_type
        def callback(code, message, data):
            if code >= 0 and not self.stopped.is_set() and message in KEY_MESSAGES:
                key = c.cast(data, c.POINTER(Key)).contents
                pressed = message in (0x100, 0x104)
                if self.capturing and pressed and key.vk not in MODIFIER_KEYS:
                    self.captured.put(key.vk)   # 捕获模式：记下这颗键，这次不算快捷键
                    self.capturing = False
                elif detector.feed(key.vk, pressed):
                    self.taps = detector.taps
                    self.events.put(True)
            return u.CallNextHookEx(None, code, message, data)
        msg = w.MSG()
        u.PeekMessageW(c.byref(msg), None, 0, 0, 0)
        self.thread_id = k.GetCurrentThreadId()
        hook = u.SetWindowsHookExW(13, callback, k.GetModuleHandleW(None), 0)
        self.available = bool(hook)
        if not hook:
            return
        try:
            while not self.stopped.is_set() and u.GetMessageW(c.byref(msg), None, 0, 0) > 0:
                u.TranslateMessage(c.byref(msg))
                u.DispatchMessageW(c.byref(msg))
        finally:
            u.UnhookWindowsHookEx(hook)
            self.available = False

    def close(self):
        self.stopped.set()
        if self.thread_id:
            c.windll.user32.PostThreadMessageW(self.thread_id, 0x12, 0, 0)
