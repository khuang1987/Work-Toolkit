"""Read-only Windows geometry; never enumerate titles or inspect app contents."""
import ctypes
from ctypes import wintypes as W
from dataclasses import dataclass


@dataclass(frozen=True)
class Rect:
    left: int
    top: int
    right: int
    bottom: int

    def clamp(self, x, y, width=192, height=208):
        return (max(self.left, min(x, self.right - width)),
                max(self.top, min(y, self.bottom - height)))


class MonitorInfo(ctypes.Structure):
    _fields_ = [('size', W.DWORD), ('monitor', W.RECT), ('work', W.RECT), ('flags', W.DWORD)]


class DesktopWorld:
    def __init__(self):
        self.u = ctypes.windll.user32
        self.u.MonitorFromPoint.argtypes = [W.POINT, W.DWORD]
        self.u.MonitorFromPoint.restype = W.HANDLE
        self.u.GetForegroundWindow.restype = W.HWND
        self.u.GetMonitorInfoW.argtypes = [W.HANDLE, ctypes.POINTER(MonitorInfo)]
        self.u.GetWindowRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]
        self.u.IsWindowVisible.argtypes = [W.HWND]
        self.u.IsIconic.argtypes = [W.HWND]
        self.u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
        self.u.IsWindow.argtypes = [W.HWND]
        self.u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
        self.last_external = None
        self.window_rect = None
        self.window_id = None

    def observe(self, x, y):
        monitor = self.u.MonitorFromPoint(W.POINT(int(x), int(y)), 2)
        info = MonitorInfo()
        info.size = ctypes.sizeof(info)
        if not self.u.GetMonitorInfoW(monitor, ctypes.byref(info)):
            raise OSError('GetMonitorInfoW failed')
        work = Rect(info.work.left, info.work.top, info.work.right, info.work.bottom)
        edge = None
        fullscreen = False
        hwnd = self.u.GetForegroundWindow()
        pid = W.DWORD()
        import os
        self.u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        # Our non-activating pet/menu may become foreground briefly. Keep the
        # explicitly observed external window instead of losing its ledge.
        if pid.value == os.getpid():
            hwnd = self.last_external
        else:
            self.last_external = hwnd
        class_name = ctypes.create_unicode_buffer(256)
        if hwnd:
            self.u.GetClassNameW(hwnd, class_name, len(class_name))
            if class_name.value in ('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'):
                hwnd = None
                self.last_external = None
        rect = W.RECT()
        self.window_rect = None
        self.window_id = None
        if hwnd and self.u.IsWindow(hwnd) and self.u.IsWindowVisible(hwnd) and not self.u.IsIconic(hwnd) and self.u.GetWindowRect(hwnd, ctypes.byref(rect)):
            # DWM visible frame excludes invisible resize borders when available.
            try:
                ctypes.windll.dwmapi.DwmGetWindowAttribute(W.HWND(hwnd), 9, ctypes.byref(rect), ctypes.sizeof(rect))
            except OSError:
                pass
            fullscreen = (rect.left <= info.monitor.left and rect.top <= info.monitor.top and
                          rect.right >= info.monitor.right and rect.bottom >= info.monitor.bottom)
            self.window_rect = Rect(rect.left, rect.top, rect.right, rect.bottom)
            self.window_id = hwnd
            if rect.top >= work.top + 208 and rect.right - rect.left >= 240:
                edge = Rect(max(work.left, rect.left), rect.top, min(work.right, rect.right), rect.bottom)
                if edge.right - edge.left < 240:
                    edge = None
        return work, edge, fullscreen
