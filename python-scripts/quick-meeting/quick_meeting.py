# -*- coding: utf-8 -*-
"""一键开会:每年固定一个 Teams 会议「快捷会议纪要YYYY」,所有一键会议都加入它并开启文字记录,
会议聊天和转录集中在同一个对话里。年度会议不存在时自动创建(12/31 22:00 的单次会议,全年可提前加入);
任何环节失败时退回“立即开会 -> 命名为日期时间”的旧流程。
通过 Windows UI Automation(comtypes)直接调用 Teams 按钮,不打开任何主界面,只在右下角显示进度。
"""

import ctypes
import datetime
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

import tkinter as tk

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)
except Exception:
    pass

CONFIG_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "MeetingNotes")
CONFIG_FILE = os.path.join(CONFIG_DIR, "quick-meeting.json")


def launch_meet_now(subject):
    """打开 Teams 主界面,再由 UI Automation 点击“立即开会”按钮。"""
    candidates = (
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\ms-teams.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Teams\current\ms-teams.exe"),
        "msteams://",
    )
    for link in candidates:
        try:
            if os.path.isfile(link):
                subprocess.Popen([link])
            else:
                os.startfile(link)
            return "teams_app"
        except OSError:
            continue
    return None


_USER32 = ctypes.windll.user32
_SW_RESTORE = 9
_SW_SHOW = 5
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004
_KEYEVENTF_KEYUP = 0x0002
_VK_CONTROL = 0x11
_VK_ESCAPE = 0x1B


def _window_text(hwnd):
    length = _USER32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    _USER32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _window_class(hwnd):
    buffer = ctypes.create_unicode_buffer(256)
    _USER32.GetClassNameW(hwnd, buffer, 256)
    return buffer.value


def _window_rect(hwnd):
    rect = wintypes.RECT()
    if not _USER32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return rect.left, rect.top, rect.right, rect.bottom


def _window_cloaked(hwnd):
    """Teams 会保留隐藏(cloaked)的窗口,截图/识别时要跳过。"""
    value = ctypes.c_int(0)
    try:
        ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(value), ctypes.sizeof(value))
    except Exception:
        return False
    return value.value != 0


def _top_level_windows():
    """返回当前顶层窗口,EnumWindows 顺序通常是前台到后台。"""
    windows = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def callback(hwnd, _):
        windows.append(hwnd)
        return True

    _USER32.EnumWindows(callback, 0)
    return windows


def _teams_windows():
    result = []
    for hwnd in _top_level_windows():
        title = _window_text(hwnd)
        cls = _window_class(hwnd)
        if cls != "TeamsWebView" and "Microsoft Teams" not in title:
            continue
        if not _USER32.IsWindowVisible(hwnd) or _window_cloaked(hwnd):
            continue
        rect = _window_rect(hwnd)
        if not rect or rect[2] - rect[0] < 300 or rect[3] - rect[1] < 200:
            continue
        result.append({"hwnd": hwnd, "title": title, "class": cls, "rect": rect})
    return result


def _focus_window(hwnd):
    if _USER32.IsIconic(hwnd):
        _USER32.ShowWindow(hwnd, _SW_RESTORE)
    else:
        _USER32.ShowWindow(hwnd, _SW_SHOW)
    _USER32.SetForegroundWindow(hwnd)
    time.sleep(0.35)


def _click_screen(x, y):
    _USER32.SetCursorPos(int(x), int(y))
    time.sleep(0.08)
    _USER32.mouse_event(_MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.06)
    _USER32.mouse_event(_MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("ki", _KEYBDINPUT), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def _send_ctrl_a():
    for key, flags in ((_VK_CONTROL, 0), (0x41, 0), (0x41, _KEYEVENTF_KEYUP), (_VK_CONTROL, _KEYEVENTF_KEYUP)):
        _USER32.keybd_event(key, 0, flags, 0)
    time.sleep(0.1)


def _press_escape():
    _USER32.keybd_event(_VK_ESCAPE, 0, 0, 0)
    _USER32.keybd_event(_VK_ESCAPE, 0, _KEYEVENTF_KEYUP, 0)
    time.sleep(0.3)


def _type_unicode(text):
    inputs = []
    for char in text:
        for flags in (0x0004, 0x0004 | _KEYEVENTF_KEYUP):  # KEYEVENTF_UNICODE
            item = _INPUT(type=1)
            item.ki = _KEYBDINPUT(0, ord(char), flags, 0, 0)
            inputs.append(item)
    array = (_INPUT * len(inputs))(*inputs)
    _USER32.SendInput(len(inputs), array, ctypes.sizeof(_INPUT))


def _normalized_text(value):
    return re.sub(r"\s+", "", value or "").casefold()


UIA_BUTTON = 50000
UIA_MENUITEM = 50011
UIA_CHECKBOX = 50002
UIA_WINDOW = 50032
UIA_COMBOBOX = 50003
UIA_EDIT = 50004
UIA_HYPERLINK = 50005
UIA_LISTITEM = 50007
UIA_VALUE_PATTERN = 10002
UIA_SCROLLITEM_PATTERN = 10017
MENU_TYPES = (UIA_BUTTON, UIA_MENUITEM, UIA_CHECKBOX)
UIA_TOGGLE_PATTERN = 10015
UIA_INVOKE_PATTERN = 10000
UIA_EXPAND_PATTERN = 10005
UIA_LEGACY_PATTERN = 10018

MEET_NOW_NAMES = ("开始即时 Teams 会议", "立即开会", "Meet now", "Start an instant Teams meeting", "Start an instant meeting")
CALENDAR_NAMES = ("日历 (Ctrl+5)", "Calendar (Ctrl+5)", "日历", "Calendar")
JOIN_NAMES = ("立即加入", "Join now")
START_MEETING_NAMES = ("开始会议", "Start meeting")
LEAVE_NAMES = ("退出", "离开", "Leave", "挂断", "Hang up")
INVITE_DIALOG_NAMES = ("邀请其他人加入", "Invite people to join", "Invite others to join")
CLOSE_NAMES = ("关闭", "Close", "Dismiss")
MORE_NAMES = ("更多", "更多操作", "More", "More actions")
RECORD_MENU_NAMES = ("录制和转录", "录制和转写", "Record and transcribe", "Recording and transcription")
START_TRANSCRIPT_NAMES = ("开始文字记录", "开始转录", "开始转写", "Start transcription")
TRANSCRIPT_ON_NAMES = ("停止文字记录", "停止转录", "停止转写", "Stop transcription")
CONFIRM_NAMES = ("确认", "确定", "Confirm", "OK")
PANE_CLOSE_NAMES = ("关闭",)  # 不能用 "Close":会命中 Teams 窗口标题栏的关闭按钮
NEXT_WEEK_NAMES = ("转到下周", "Go to next week")
TODAY_NAMES = ("转到今日", "Go to today")
VIEW_EVENT_NAMES = ("查看事件", "View event")
SAVE_NAMES = ("保存", "Save")
TRANSCRIBE_SETTING_NAMES = ("自动录制和听录", "自动录制和转录", "Record and transcribe automatically")
TRANSCRIBE_ONLY_NAMES = ("仅转录", "Transcript only", "Transcription only")
LANGUAGE_SETTING_NAMES = ("此会议中的口述语言", "Spoken language in this meeting")
LANGUAGE_NAMES = ("简体中文(中国)", "简体中文 (中国)", "Chinese (Simplified, China)")


class TeamsUia:
    def __init__(self):
        import comtypes
        import comtypes.client as cc

        comtypes.CoInitialize()
        cc.GetModule("UIAutomationCore.dll")
        from comtypes.gen import UIAutomationClient as uia_types

        self.types = uia_types
        self.uia = cc.CreateObject(uia_types.CUIAutomation, interface=uia_types.IUIAutomation)

    def controls(self, hwnd, control_types=(UIA_BUTTON,)):
        try:
            root = self.uia.ElementFromHandle(hwnd)
            cond = None
            for kind in control_types:
                part = self.uia.CreatePropertyCondition(30003, kind)
                cond = part if cond is None else self.uia.CreateOrCondition(cond, part)
            found = root.FindAll(4, cond)
        except Exception:
            return []
        result = []
        for index in range(found.Length):
            element = found.GetElement(index)
            try:
                if element.CurrentIsEnabled:
                    result.append((element.CurrentName or "", element))
            except Exception:
                continue
        return result

    @staticmethod
    def match(name, phrases, prefix=False):
        text = _normalized_text(name).rstrip("。.")
        for phrase in phrases:
            wanted = _normalized_text(phrase)
            if text == wanted or (prefix and text.startswith(wanted)):
                return True
        return False

    def find(self, hwnd, phrases, prefix=False, control_types=(UIA_BUTTON,)):
        for phrase in phrases:
            for name, element in self.controls(hwnd, control_types):
                if self.match(name, (phrase,), prefix):
                    return element
        return None

    def invoke(self, element):
        types = self.types
        for pattern_id, interface, action in (
            (UIA_INVOKE_PATTERN, types.IUIAutomationInvokePattern, lambda p: p.Invoke()),
            (UIA_TOGGLE_PATTERN, types.IUIAutomationTogglePattern, lambda p: p.Toggle()),
            (UIA_EXPAND_PATTERN, types.IUIAutomationExpandCollapsePattern, lambda p: p.Expand()),
            (UIA_LEGACY_PATTERN, types.IUIAutomationLegacyIAccessiblePattern, lambda p: p.DoDefaultAction()),
        ):
            try:
                pattern = element.GetCurrentPattern(pattern_id)
                if pattern:
                    action(pattern.QueryInterface(interface))
                    return True
            except Exception:
                continue
        try:
            rect = element.CurrentBoundingRectangle
            _click_screen((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
            return True
        except Exception:
            return False

    def wait_invoke(self, phrases, timeout, prefix=False, control_types=(UIA_BUTTON,), windows=None):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for window in (windows() if windows else _teams_windows()):
                element = self.find(window["hwnd"], phrases, prefix, control_types)
                if element is not None and self.invoke(element):
                    return window
            time.sleep(0.6)
        return None

    def set_meeting_title(self, hwnd, subject):
        """预览页的会议标题输入框,改成“日期 时间”便于会后辨认。"""
        try:
            edits = self.uia.ElementFromHandle(hwnd).FindAll(4, self.uia.CreatePropertyCondition(30003, 50004))
        except Exception:
            return False
        for index in range(edits.Length):
            edit = edits.GetElement(index)
            try:
                pattern = edit.GetCurrentPattern(10002)
                if not pattern:
                    continue
                value = pattern.QueryInterface(self.types.IUIAutomationValuePattern)
                if value.CurrentIsReadOnly:
                    continue
                value.SetValue(subject)
                time.sleep(0.3)
                if value.CurrentValue == subject:
                    return True
                # SetValue 未被网页接受时,用键盘全选后输入。
                _focus_window(hwnd)
                edit.SetFocus()
                _send_ctrl_a()
                _type_unicode(subject)
                time.sleep(0.3)
                return value.CurrentValue == subject
            except Exception:
                continue
        return False

    def close_invite_dialog(self, hwnd):
        """立即开会后 Teams 弹出“邀请其他人加入”模态框,会把会议工具栏从 UIA 树中隐藏。"""
        try:
            dialogs = self.uia.ElementFromHandle(hwnd).FindAll(4, self.uia.CreatePropertyCondition(30003, UIA_WINDOW))
        except Exception:
            return False
        for index in range(dialogs.Length):
            dialog = dialogs.GetElement(index)
            if not self.match(dialog.CurrentName or "", INVITE_DIALOG_NAMES, prefix=True):
                continue
            buttons = dialog.FindAll(4, self.uia.CreatePropertyCondition(30003, UIA_BUTTON))
            for button_index in range(buttons.Length):
                button = buttons.GetElement(button_index)
                if self.match(button.CurrentName or "", CLOSE_NAMES):
                    return self.invoke(button)
        return False

    def meeting_window(self):
        for window in _teams_windows():
            if self.close_invite_dialog(window["hwnd"]):
                time.sleep(0.8)
            if self.find(window["hwnd"], LEAVE_NAMES) is not None:
                return window
        return None


def _wait_teams_ready(timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _teams_windows():
            return True
        time.sleep(0.8)
    return False


def _restore_minimized_teams():
    """最小化的 Teams 主窗口会被过滤掉;不抢焦点地还原它,便于 UIA 查找按钮。"""
    restored = False
    for hwnd in _top_level_windows():
        if _window_class(hwnd) == "TeamsWebView" and _USER32.IsWindowVisible(hwnd) and _USER32.IsIconic(hwnd):
            _USER32.ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE
            restored = True
    if restored:
        time.sleep(1.2)


def _quick_log(text):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(os.path.join(CONFIG_DIR, "quick-meeting.log"), "a", encoding="utf-8") as f:
            f.write(datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")
    except OSError:
        pass


def quick_meeting_subject():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")


def _uia_start_transcription(uia, window):
    """更多 -> 录制和转录 -> 开始文字记录。返回 (ok, detail)。"""
    if uia.find(window["hwnd"], TRANSCRIPT_ON_NAMES, prefix=True, control_types=MENU_TYPES) is not None:
        return True, "Teams 已经在转录。"
    current = lambda: [window]
    for _attempt in range(2):
        # 菜单可能已经展开;能直接找到“开始文字记录”就不再点“更多”(再点会把菜单收起)。
        if uia.wait_invoke(START_TRANSCRIPT_NAMES, 0.5, prefix=True, control_types=MENU_TYPES, windows=current) is None:
            if uia.find(window["hwnd"], RECORD_MENU_NAMES, prefix=True, control_types=MENU_TYPES) is None:
                if uia.wait_invoke(MORE_NAMES, 6, windows=current) is None:
                    break
                time.sleep(0.6)
            if uia.wait_invoke(RECORD_MENU_NAMES, 4, prefix=True, control_types=MENU_TYPES, windows=current) is None:
                continue
            time.sleep(0.6)
            if uia.find(window["hwnd"], TRANSCRIPT_ON_NAMES, prefix=True, control_types=MENU_TYPES) is not None:
                _focus_window(window["hwnd"])
                _press_escape()
                _press_escape()
                return True, "Teams 已经在转录(会议设置为自动转录)。"
            if uia.wait_invoke(START_TRANSCRIPT_NAMES, 4, prefix=True, control_types=MENU_TYPES, windows=current) is None:
                continue
        time.sleep(1.0)
        uia.wait_invoke(CONFIRM_NAMES, 3, windows=current)
        return True, "已开启 Teams 文字记录(转录)。"
    return False, "未找到“更多 / 录制和转录 / 开始文字记录”。"


def yearly_subject(year=None):
    return "快捷会议纪要%d" % (year or datetime.date.today().year)


def _load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_yearly_url(year, subject, url):
    data = _load_config()
    data.setdefault("yearly_meetings", {})[str(year)] = {"subject": subject, "join_url": url}
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _stored_yearly_url(year):
    entry = _load_config().get("yearly_meetings", {}).get(str(year)) or {}
    url = entry.get("join_url") or ""
    return url if "/l/meetup-join/" in url else ""


def _teams_link(url):
    """https://teams.microsoft.com/l/... 改成 msteams: 协议,直接由 Teams 客户端打开,不经过浏览器。"""
    match = re.match(r"https://teams\.microsoft\.com(/l/.*)$", url)
    return "msteams:" + match.group(1) if match else url


def _main_teams_window(uia):
    windows = _teams_windows()
    for window in windows:
        if uia.find(window["hwnd"], CALENDAR_NAMES, prefix=True) is not None:
            return window
    return windows[0] if windows else None


def _value_of(uia, element):
    try:
        pattern = element.GetCurrentPattern(UIA_VALUE_PATTERN)
        return pattern.QueryInterface(uia.types.IUIAutomationValuePattern).CurrentValue if pattern else ""
    except Exception:
        return ""


def _open_calendar_week_view(uia, window):
    """切到日历周视图;若停在事件详情等子页面,先返回再切。"""
    current = lambda: [window]
    for _attempt in range(3):
        uia.wait_invoke(CALENDAR_NAMES, 5, prefix=True, windows=current)
        time.sleep(2.0)
        if uia.find(window["hwnd"], NEXT_WEEK_NAMES, prefix=True) is not None:
            uia.wait_invoke(TODAY_NAMES, 2, prefix=True, windows=current)
            time.sleep(1.0)
            return True
        if uia.wait_invoke(PANE_CLOSE_NAMES, 1, windows=current) is None:
            uia.wait_invoke(("返回", "Back"), 1, windows=current)
        time.sleep(1.0)
    return False


def _find_yearly_on_calendar(uia, subject, year, log):
    """日历逐周翻到年底,打开「subject」事件详情,读取 meetup-join 加入链接。
    返回 (url, searched):searched=False 表示日历没能翻完,结果不可信,不能据此新建会议。"""
    window = _main_teams_window(uia)
    if window is None or not _open_calendar_week_view(uia, window):
        return "", False
    hwnd = window["hwnd"]
    weeks = max(2, (datetime.date(year, 12, 31) - datetime.date.today()).days // 7 + 3)
    event = None
    for _week in range(weeks):
        event = next((e for n, e in uia.controls(hwnd) if n.startswith(subject + ",")), None)
        if event is not None:
            break
        if uia.wait_invoke(NEXT_WEEK_NAMES, 3, prefix=True, windows=lambda: [window]) is None:
            return "", False
        time.sleep(1.2)
    if event is None:
        return "", True
    log("已在日历找到「%s」,读取加入链接…" % subject)
    uia.invoke(event)
    time.sleep(2.0)
    if uia.wait_invoke(VIEW_EVENT_NAMES, 6, windows=lambda: [window]) is None:
        return ""
    deadline = time.time() + 15
    while time.time() < deadline:
        for _name, link in uia.controls(hwnd, (UIA_HYPERLINK,)):
            url = _value_of(uia, link)
            if "/l/meetup-join/" in url:
                if uia.wait_invoke(PANE_CLOSE_NAMES, 2, windows=lambda: [window]) is None:
                    _focus_window(hwnd)
                    _press_escape()
                return url, True
        time.sleep(0.8)
    return "", False


def _choose_option(uia, hwnd, combo_names, option_names):
    """日历表单里的下拉框:展开后要真实点击选项,SelectionItem.Select 不会提交。"""
    combo = uia.find(hwnd, combo_names, prefix=True, control_types=(UIA_COMBOBOX,))
    if combo is None:
        return False
    uia.invoke(combo)
    time.sleep(0.8)
    option = uia.find(hwnd, option_names, control_types=(UIA_LISTITEM,))
    if option is None:
        _press_escape()
        return False
    try:
        option.GetCurrentPattern(UIA_SCROLLITEM_PATTERN).QueryInterface(uia.types.IUIAutomationScrollItemPattern).ScrollIntoView()
        time.sleep(0.3)
    except Exception:
        pass
    option = uia.find(hwnd, option_names, control_types=(UIA_LISTITEM,))
    if option is None:
        return False
    _focus_window(hwnd)
    rect = option.CurrentBoundingRectangle
    _click_screen((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
    time.sleep(0.8)
    return True


def _create_yearly_meeting(uia, subject, year, log):
    """用 Teams 新建会议深链接预填标题/时间,设置“仅转录 + 简体中文”后保存。"""
    offset = datetime.datetime.now().astimezone().strftime("%z")
    offset = offset[:3] + ":" + offset[3:]
    link = "msteams:/l/meeting/new?subject=%s&startTime=%d-12-31T22:00:00%s&endTime=%d-12-31T22:30:00%s" % (
        subject, year, offset, year, offset)
    log("正在创建年度会议「%s」…" % subject)
    os.startfile(link)
    form = None
    deadline = time.time() + 30
    while time.time() < deadline and form is None:
        time.sleep(1.0)
        for window in _teams_windows():
            if uia.find(window["hwnd"], SAVE_NAMES) is not None and uia.controls(window["hwnd"], (UIA_COMBOBOX,)):
                form = window
                break
    if form is None:
        return False
    hwnd = form["hwnd"]
    time.sleep(1.5)
    for _name, edit in uia.controls(hwnd, (UIA_EDIT,)):
        if (edit.CurrentAutomationId or "").endswith("meeting-subject-input") and _value_of(uia, edit) != subject:
            uia.set_meeting_title(hwnd, subject)
            break
    if _choose_option(uia, hwnd, TRANSCRIBE_SETTING_NAMES, TRANSCRIBE_ONLY_NAMES):
        _choose_option(uia, hwnd, LANGUAGE_SETTING_NAMES, LANGUAGE_NAMES)
    if uia.wait_invoke(SAVE_NAMES, 5, windows=lambda: [form]) is None:
        return False
    time.sleep(4.0)
    return True


def _yearly_join_url(uia, log):
    year = datetime.date.today().year
    subject = yearly_subject(year)
    url = _stored_yearly_url(year)
    if url:
        return subject, url
    log("首次使用,正在查找年度会议「%s」…" % subject)
    url, searched = _find_yearly_on_calendar(uia, subject, year, log)
    if not url and searched and _create_yearly_meeting(uia, subject, year, log):
        url, _searched = _find_yearly_on_calendar(uia, subject, year, log)
    if url:
        _save_yearly_url(year, subject, url)
        _quick_log("年度会议链接已保存 %s" % subject)
    return subject, url


def _join_from_prejoin(uia, rename=None, timeout=60):
    """等待预览页并点击“立即加入”;rename 不为空时先把会议标题改掉(仅“立即开会”需要)。"""
    named = rename is None
    joins = 0
    deadline = time.time() + timeout
    while time.time() < deadline and uia.meeting_window() is None:
        prejoin = next((w for w in _teams_windows() if uia.find(w["hwnd"], JOIN_NAMES) is not None), None)
        if prejoin is None:
            uia.wait_invoke(START_MEETING_NAMES, 0.6)
            time.sleep(0.6)
            continue
        if not named:
            ok = uia.set_meeting_title(prejoin["hwnd"], rename)
            _quick_log("会议命名 %s" % ("成功" if ok else "失败"))
            named = True
        button = uia.find(prejoin["hwnd"], JOIN_NAMES)
        if button is None:
            continue
        joins += 1
        if joins <= 2:
            uia.invoke(button)
        else:
            # UIA Invoke 偶尔被 Teams 忽略,改用真实鼠标点击。
            _focus_window(prejoin["hwnd"])
            rect = button.CurrentBoundingRectangle
            _click_screen((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
        _quick_log("点击立即加入 #%d" % joins)
        settle = time.time() + 10
        while time.time() < settle and uia.meeting_window() is None:
            time.sleep(0.8)
    return uia.meeting_window() is not None


def _meet_now(uia, subject, log):
    log("正在点击“立即开会”…")
    clicked = uia.wait_invoke(MEET_NOW_NAMES, 4, prefix=True)
    if clicked is None:
        uia.wait_invoke(CALENDAR_NAMES, 8, prefix=True)
        clicked = uia.wait_invoke(MEET_NOW_NAMES, 20, prefix=True)
    if clicked is None:
        return False
    log("正在加入会议:%s" % subject)
    return _join_from_prejoin(uia, rename=subject)


def _log_to_daily_note(text):
    """在 Obsidian 今日日志的“工作记录”下追加一行;失败不影响开会。"""
    try:
        toolbox = Path(__file__).resolve().parent.parent / "work-toolbox"
        if str(toolbox) not in sys.path:
            sys.path.insert(0, str(toolbox))
        from daily_note import DailyNote, default_vault
        DailyNote(default_vault()).log(text)
    except Exception as error:
        _quick_log("写入今日日志失败:%s" % error)


def quick_meeting_flow(report, subject=None):
    """不打开本应用界面:拉起 Teams -> 加入年度会议(或立即开会)-> 开始转录。report(text) 报告进度。"""
    log = lambda text: (_quick_log(text), report(text))
    uia = TeamsUia()
    log("正在打开 Teams…")
    _restore_minimized_teams()
    if uia.meeting_window() is None:
        if not _teams_windows():
            if not launch_meet_now(subject) or not _wait_teams_ready():
                return False, "无法打开 Teams,请确认 Teams 已安装并登录。"
            _restore_minimized_teams()
        joined = False
        if subject is None:
            subject, url = _yearly_join_url(uia, log)
            if url:
                log("正在加入「%s」…" % subject)
                os.startfile(_teams_link(url))
                joined = _join_from_prejoin(uia)
                if not joined:
                    _quick_log("年度会议加入失败,改用立即开会")
        if not joined:
            subject = quick_meeting_subject() if subject is None or subject.startswith("快捷会议纪要") else subject
            if not _meet_now(uia, subject, log):
                return False, "未能自动加入会议,请在 Teams 中手动点“立即加入”。"
    subject = subject or yearly_subject()

    window = uia.meeting_window()
    log("已入会,正在开启转录…")
    time.sleep(1.5)
    ok, detail = _uia_start_transcription(uia, window)
    _quick_log("结果 %s %s" % (ok, detail))
    _log_to_daily_note("🎙 一键会议「%s」%s" % (subject, "已开始并开启转录" if ok else "已开始(转录未自动开启)"))
    return ok, ("会议「%s」已开始," % subject + detail) if ok else ("会议已开始,但未能自动开启转录:" + detail)


class QuickMeetingToast(tk.Tk):
    """一键开会的右下角进度提示,不打开主界面。"""

    def __init__(self):
        super().__init__()
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg="#2A2D33")
        width, height = 300, 84
        work = wintypes.RECT()
        ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(work), 0)
        self.geometry("%dx%d+%d+%d" % (width, height, work.right - width - 16, work.bottom - height - 16))
        body = tk.Frame(self, bg="#1E2024", highlightthickness=1, highlightbackground="#3A3E46")
        body.pack(fill="both", expand=True)
        self.title_label = tk.Label(body, text="一键开会", bg="#1E2024", fg="#F2F4F7", font=("Microsoft YaHei UI", 9, "bold"), anchor="w")
        self.title_label.pack(fill="x", padx=14, pady=(10, 2))
        self.detail = tk.Label(body, text="准备中…", bg="#1E2024", fg="#A9AFBA", font=("Microsoft YaHei UI", 8), anchor="w", justify="left", wraplength=width - 28)
        self.detail.pack(fill="x", padx=14)
        for widget in (self, body, self.title_label, self.detail):
            widget.bind("<Button-1>", lambda _e: self.destroy())
        self.jobs = queue.Queue()
        self.after(100, self._poll)
        threading.Thread(target=self._worker, daemon=True).start()

    def _worker(self):
        try:
            ok, detail = quick_meeting_flow(lambda text: self.jobs.put((None, text)))
        except Exception as error:
            ok, detail = False, "自动化异常:%s" % error
        self.jobs.put((ok, detail))

    def _poll(self):
        try:
            while True:
                ok, text = self.jobs.get_nowait()
                self.detail.configure(text=text)
                if ok is not None:
                    self.title_label.configure(text="一键开会 · 完成" if ok else "一键开会 · 需要手动处理", fg="#5BD68A" if ok else "#FFB547")
                    self.after(6000 if ok else 20000, self.destroy)
        except queue.Empty:
            pass
        if self.winfo_exists():
            self.after(150, self._poll)


def run_quick_meeting():
    mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\WorkToolkitQuickMeeting")
    if ctypes.windll.kernel32.GetLastError() == 183:
        return
    QuickMeetingToast().mainloop()
    ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    run_quick_meeting()
