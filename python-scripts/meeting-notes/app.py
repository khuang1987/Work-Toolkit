# -*- coding: utf-8 -*-
"""会议纪要助手
一键打开 Teams 开会 -> 导入 Teams 转写文件 (.vtt/.txt) -> DeepSeek AI 生成会议纪要
会议纪要部分仅依赖标准库;自动操作使用 Windows 内置 OCR 和 mss 截图组件。
"""

import ctypes
import datetime
import html
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from ctypes import wintypes

import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk, filedialog, messagebox

try:
    import mss as _mss
    from mss import tools as _mss_tools
except ImportError:
    _mss = None
    _mss_tools = None

try:
    from PIL import Image as _PILImage
    from PIL import ImageDraw as _PILImageDraw
    from PIL import ImageTk as _PILImageTk
except ImportError:
    _PILImage = None
    _PILImageDraw = None
    _PILImageTk = None

try:
    import win32com.client as _win32_client
except ImportError:
    _win32_client = None

try:
    import pythoncom as _pythoncom
except ImportError:
    _pythoncom = None

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)
except Exception:
    pass

APP_NAME = "会议纪要助手"
FONT_NAME = "Microsoft YaHei UI"
COLORS = {
    "background": "#F4F7FB",
    "card": "#FFFFFF",
    "text": "#111827",
    "muted": "#6B7280",
    "subtle": "#9CA3AF",
    "border": "#E5EAF1",
    "primary": "#2563EB",
    "primary_dark": "#1D4ED8",
    "primary_soft": "#EAF1FF",
    "green": "#16A34A",
    "green_soft": "#EAF8EF",
    "orange": "#EA580C",
    "orange_soft": "#FFF1E8",
}
CONFIG_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "MeetingNotes")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
DEFAULT_SAVE_DIR = os.path.join(os.path.expanduser("~"), "Documents", "会议纪要")

DEFAULT_CONFIG = {
    "api_key": "",
    "model": "deepseek-chat",
    "base_url": "https://api.deepseek.com/v1",
    "temperature": 0.3,
    "save_dir": DEFAULT_SAVE_DIR,
    "fixed_meeting_url": "",
    "fixed_chat_url": "",
    "meeting_prompt": "",
}

MAX_TRANSCRIPT_CHARS = 30000
OUTLOOK_CALENDAR_FOLDER = 9
MEETING_CACHE_PATH = os.path.join(CONFIG_DIR, "meetings_cache.json")
MEETING_URL_RE = re.compile(
    r"https?://[^\s<>\"']+",
    re.IGNORECASE,
)


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def save_config(cfg):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        messagebox.showerror("错误", "配置保存失败: %s" % e)


# ---------------- 转写文件解析 ----------------

def clean_cue(content):
    """解析一句 VTT cue:提取发言人,去掉标签,返回 (speaker, text)。"""
    content = content.replace("\n", " ")
    m = re.search(r"<v ([^>]+)>", content)
    speaker = m.group(1).strip() if m else ""
    text = re.sub(r"<[^>]+>", "", content)
    text = text.replace("&nbsp;", " ").replace("\\h", " ")
    text = html.unescape(text)
    text = " ".join(text.split())
    return speaker, text


def vtt_to_text(raw):
    """把 Teams 导出的 .vtt 转写文件解析为带发言人的纯文本。"""
    blocks = re.split(r"\n\s*\n", raw)
    parts = []
    last_speaker = None
    for block in blocks:
        block = block.strip()
        if not block or block.startswith("WEBVTT") or "-->" not in block:
            continue
        lines = block.splitlines()
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            continue
        content = "\n".join(lines[idx + 1:]).strip()
        if not content:
            continue
        speaker, text = clean_cue(content)
        if not text:
            continue
        if speaker and speaker != last_speaker:
            parts.append("[%s] %s" % (speaker, text))
            last_speaker = speaker
        else:
            parts.append(text)
    return "\n".join(parts)


def read_transcript_file(path):
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    if path.lower().endswith(".vtt"):
        return vtt_to_text(raw), "vtt"
    return raw, "txt"


def _outlook_datetime(value):
    if hasattr(value, "replace"):
        try:
            return value.replace(tzinfo=None)
        except TypeError:
            return value
    return None


def _load_meeting_cache():
    try:
        if not os.path.exists(MEETING_CACHE_PATH):
            return None
        with open(MEETING_CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        for item in data:
            try:
                item["start"] = datetime.datetime.strptime(item["start"], "%Y-%m-%dT%H:%M:%S")
            except Exception:
                item["start"] = datetime.datetime.now()
        return data
    except Exception:
        return None


def _save_meeting_cache(meetings):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        data = [{
            "subject": item["subject"],
            "start": item["start"].strftime("%Y-%m-%dT%H:%M:%S"),
            "url": item.get("url", ""),
            "provider": item.get("provider", "Outlook"),
            "entry_id": item.get("entry_id", ""),
            "store_id": item.get("store_id", ""),
        } for item in meetings]
        with open(MEETING_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _meeting_provider(url):
    lower = (url or "").casefold()
    if any(host in lower for host in ("teams.microsoft.com", "teams.microsoft.us", "teams.live.com", "teams.cloud.microsoft")):
        return "Teams"
    if "zoom.us" in lower or "zoom.com" in lower:
        return "Zoom"
    if "webex.com" in lower:
        return "Webex"
    if "meet.google.com" in lower:
        return "Google Meet"
    if "gotomeeting.com" in lower or "gotowebinar.com" in lower:
        return "GoTo"
    if "bluejeans.com" in lower:
        return "BlueJeans"
    return "在线会议"


def _extract_meeting_url(value):
    if not value:
        return ""
    value = html.unescape(str(value))
    matches = [match.group(0).rstrip(".,;)]}") for match in MEETING_URL_RE.finditer(value)]
    if not matches:
        return ""
    preferred_hosts = (
        "teams.microsoft.com", "teams.microsoft.us", "teams.live.com", "teams.cloud.microsoft",
        "zoom.us", "zoom.com", "webex.com", "meet.google.com", "gotomeeting.com", "gotowebinar.com",
    )
    for url in matches:
        if any(host in url.casefold() for host in preferred_hosts):
            return url
    return matches[0]


def _extract_teams_url(value):
    # Compatibility alias for older callers.
    return _extract_meeting_url(value)


def outlook_meetings(days=14):
    """读取经典 Outlook 默认日历中的近期项目,提取各平台会议加入链接。"""
    if _win32_client is None:
        raise RuntimeError("当前运行环境缺少 Outlook 组件。请使用打包版,或执行 pip install pywin32。")

    initialized = False
    if _pythoncom is not None:
        _pythoncom.CoInitialize()
        initialized = True
    try:
        try:
            outlook = _win32_client.Dispatch("Outlook.Application")
            namespace = outlook.GetNamespace("MAPI")
            calendar = namespace.GetDefaultFolder(OUTLOOK_CALENDAR_FOLDER)
            items = calendar.Items
            items.Sort("[Start]")
            items.IncludeRecurrences = True
        except Exception as e:
            raise RuntimeError("无法读取 Outlook 日历,请确认 Outlook 已安装并完成登录: %s" % e)

        now = datetime.datetime.now()
        end = now + datetime.timedelta(days=days)
        result = []

        # 直接让 Outlook 过滤时间,避免历史循环日程占满 Items 前几百项。
        date_filter = "[Start] >= '%s' AND [Start] <= '%s'" % (
            now.strftime("%m/%d/%Y %I:%M %p"),
            end.strftime("%m/%d/%Y %I:%M %p"),
        )
        try:
            candidates = items.Restrict(date_filter)
            candidates.Sort("[Start]")
        except Exception:
            candidates = items

        try:
            count = min(int(candidates.Count), 5000)
        except Exception:
            count = 500

        for index in range(1, count + 1):
            try:
                item = candidates.Item(index)

                def com_value(name):
                    try:
                        return getattr(item, name, "")
                    except Exception:
                        return ""

                start = _outlook_datetime(com_value("Start"))
                if not start or start < now or start > end:
                    continue
                subject = str(com_value("Subject") or "").strip()

                # 先读便宜的字段;只有正文疑似包含会议链接时才读昂贵的 HTMLBody。
                cheap_fields = (
                    com_value("Location"),
                    com_value("Body"),
                    com_value("OnlineMeetingUrl"),
                    com_value("JoinOnlineMeetingUrl"),
                )
                url = ""
                for field in cheap_fields:
                    url = _extract_meeting_url(field)
                    if url:
                        break
                if not url:
                    cheap_text = " ".join(str(v) for v in cheap_fields if v).casefold()
                    keywords = ("http", "teams", "zoom", "webex", "meet", "join", "会议", "链接", "link", "@")
                    if any(keyword in cheap_text for keyword in keywords):
                        url = _extract_meeting_url(com_value("HTMLBody"))
                result.append({
                    "subject": subject or "未命名会议",
                    "start": start,
                    "end": _outlook_datetime(com_value("End")),
                    "url": url,
                    "provider": _meeting_provider(url) if url else "无链接",
                    "entry_id": str(com_value("EntryID") or ""),
                    "store_id": str(getattr(getattr(item, "Parent", None), "StoreID", "") or ""),
                })
            except Exception:
                continue
        return result
    finally:
        if initialized:
            _pythoncom.CoUninitialize()


def open_outlook_item(item):
    """在经典 Outlook 中打开一个没有在线链接的日程。"""
    if _win32_client is None:
        raise RuntimeError("当前环境没有 Outlook COM 组件")
    initialized = False
    if _pythoncom is not None:
        _pythoncom.CoInitialize()
        initialized = True
    try:
        outlook = _win32_client.Dispatch("Outlook.Application")
        namespace = outlook.GetNamespace("MAPI")
        outlook_item = None
        entry_id = item.get("entry_id") or ""
        store_id = item.get("store_id") or ""
        if entry_id:
            try:
                outlook_item = namespace.GetItemFromID(entry_id, store_id) if store_id else namespace.GetItemFromID(entry_id)
            except Exception:
                outlook_item = None

        # 兼容旧缓存:按主题和开始时间回查,避免旧版本缓存没有 EntryID 时按钮失效。
        if outlook_item is None:
            calendar = namespace.GetDefaultFolder(OUTLOOK_CALENDAR_FOLDER)
            items = calendar.Items
            items.Sort("[Start]")
            items.IncludeRecurrences = True
            target_subject = str(item.get("subject", "")).strip().casefold()
            target_start = item.get("start")
            candidates = items
            if isinstance(target_start, datetime.datetime):
                begin = target_start - datetime.timedelta(days=1)
                finish = target_start + datetime.timedelta(days=1)
                try:
                    candidates = items.Restrict("[Start] >= '%s' AND [Start] <= '%s'" % (
                        begin.strftime("%m/%d/%Y %I:%M %p"),
                        finish.strftime("%m/%d/%Y %I:%M %p"),
                    ))
                except Exception:
                    candidates = items
            try:
                count = min(int(candidates.Count), 5000)
            except Exception:
                count = 500
            best = None
            best_delta = None
            for index in range(1, count + 1):
                try:
                    candidate = candidates.Item(index)
                    subject = str(getattr(candidate, "Subject", "") or "").strip().casefold()
                    if target_subject and subject != target_subject:
                        continue
                    start = _outlook_datetime(getattr(candidate, "Start", None))
                    delta = abs((start - target_start).total_seconds()) if start and target_start else 0
                    if best is None or delta < best_delta:
                        best = candidate
                        best_delta = delta
                except Exception:
                    continue
            outlook_item = best
        if outlook_item is None:
            raise RuntimeError("没有找到对应的 Outlook 日程")
        outlook_item.Display()
    finally:
        if initialized:
            _pythoncom.CoUninitialize()


# ---------------- DeepSeek API ----------------

def call_deepseek(cfg, system, user):
    """调用 OpenAI 兼容的 chat/completions 接口(默认 DeepSeek)。"""
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": float(cfg.get("temperature", 0.3)),
        "stream": False,
    }
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg["api_key"],
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        msg = {
            400: "请求参数错误",
            401: "API Key 无效,请到设置中检查",
            402: "DeepSeek 账户余额不足,请充值",
            403: "无权访问,请检查 Key 和模型",
            404: "模型不存在,请检查模型名称",
            429: "请求过于频繁,请稍后再试",
        }.get(e.code, "接口错误 %s" % e.code)
        try:
            detail = json.loads(body).get("error", {}).get("message", "")
            if detail:
                msg += " - " + detail
        except Exception:
            pass
        raise RuntimeError(msg)
    except urllib.error.URLError as e:
        raise RuntimeError("网络连接失败,请检查网络: %s" % e.reason)
    except Exception as e:
        raise RuntimeError("请求失败: %s" % e)
    return data["choices"][0]["message"]["content"]


SYSTEM_PROMPT = (
    "你是一名专业的行政助理,擅长整理会议纪要。"
    "请根据会议转写文本生成结构化、简洁、忠实原文的会议纪要,"
    "使用简体中文和 Markdown 格式。不要编造转写中没有的内容。"
)


def build_user_prompt(title, attendees, transcript):
    return (
        "会议标题:%s\n"
        "参会人员:%s\n\n"
        "以下是会议的语音转写文本(可能含错别字和口语重复,请自行理解修正):\n"
        "--------\n%s\n--------\n\n"
        "请生成会议纪要,严格包含以下部分:\n"
        "1. 会议主题\n"
        "2. 会议时间(如转写中无法判断,写 '——')\n"
        "3. 参会人员(如无法判断,写 '——')\n"
        "4. 讨论要点(分条列出,按话题归类)\n"
        "5. 决议事项(分条;没有就写 '无')\n"
        "6. 待办事项(用 Markdown 表格:事项 | 负责人 | 截止时间;不确定写 '——')\n"
        "7. 风险与遗留问题(没有就写 '无')\n"
        "最后附一段 100 字以内的总结。"
    ) % (title or "——", attendees or "——", transcript)


def generate_minutes(title, attendees, transcript, cfg):
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = transcript[:MAX_TRANSCRIPT_CHARS] + "\n[转写过长,已截断]"
    system_prompt = SYSTEM_PROMPT
    fixed_prompt = str(cfg.get("meeting_prompt", "") or "").strip()
    if fixed_prompt:
        system_prompt += "\n\n固定纪要规则:\n" + fixed_prompt
    return call_deepseek(cfg, system_prompt, build_user_prompt(title, attendees, transcript))


# ---------------- 拉起 Teams ----------------

def launch_teams(link=None, subject=None):
    """打开已知会议链接,否则直接启动 Teams 主程序,避免新版客户端黑屏深链。"""
    if link and link.strip():
        try:
            os.startfile(link.strip())
            return "link"
        except OSError:
            pass
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Teams\current\Teams.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft\Teams\current\Teams.exe"),
        os.path.expandvars(r"%PROGRAMFILES%\Microsoft\Teams\current\Teams.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\ms-teams.exe"),
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                subprocess.Popen([c])
                return "exe"
            except OSError:
                continue
    try:
        os.startfile("msteams://")
        return "app_link"
    except OSError:
        pass
    return None


def launch_meet_now(subject):
    """打开 Teams 主界面,再由 OCR 点击真实的“立即开会”按钮。"""
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


def launch_fixed_entry(chat_url="", meeting_url=""):
    """优先打开固定对话,没有对话链接时打开固定会议链接。"""
    target = (chat_url or meeting_url or "").strip()
    if not target:
        return None
    try:
        os.startfile(target)
        return "fixed_entry"
    except OSError:
        return None


def launch_meet_now_fallback():
    """某些 Teams 版本不注册 meetnow 深链,回退到官方新会议调度入口。"""
    link = "msteams://l/meeting/new?subject=" + urllib.parse.quote("现场会议")
    try:
        os.startfile(link)
        return link
    except OSError:
        return None


_USER32 = ctypes.windll.user32
_SW_RESTORE = 9
_SW_SHOW = 5
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004
_KEYEVENTF_KEYUP = 0x0002
_VK_CONTROL = 0x11
_VK_SHIFT = 0x10
_VK_U = 0x55


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
        rect = _window_rect(hwnd)
        if not rect or rect[2] - rect[0] < 300 or rect[3] - rect[1] < 200:
            continue
        result.append({"hwnd": hwnd, "title": title, "class": cls, "rect": rect})
    return result


def _frontmost_teams_window():
    windows = _teams_windows()
    if not windows:
        return None
    foreground = _USER32.GetForegroundWindow()
    for window in windows:
        if window["hwnd"] == foreground:
            return window

    meeting_hints = ("会议", "meeting", "meet now", "teams call", "通话")
    for window in windows:
        title = window["title"].casefold()
        if any(hint in title for hint in meeting_hints):
            return window

    return max(windows, key=lambda item: (item["rect"][2] - item["rect"][0]) * (item["rect"][3] - item["rect"][1]))


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


def _send_transcription_hotkey():
    """Teams 快捷键 Ctrl+Shift+U:开关会议转录/录制。"""
    for key in (_VK_CONTROL, _VK_SHIFT, _VK_U):
        _USER32.keybd_event(key, 0, 0, 0)
    for key in (_VK_U, _VK_SHIFT, _VK_CONTROL):
        _USER32.keybd_event(key, 0, _KEYEVENTF_KEYUP, 0)


def _ocr_script_path():
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "ocr.ps1")


def _capture_and_ocr(window):
    """截图并调用 Windows 内置 OCR,返回窗口矩形和带坐标的文字行。"""
    if _mss is None or _mss_tools is None:
        raise RuntimeError("缺少截图组件 mss,请重新运行打包版或执行 pip install mss")

    rect = window["rect"]
    width = rect[2] - rect[0]
    height = rect[3] - rect[1]
    if width <= 0 or height <= 0:
        return rect, []

    token = str(os.getpid()) + "_" + str(threading.get_ident())
    image_path = os.path.join(tempfile.gettempdir(), "meeting_notes_%s.png" % token)
    output_path = os.path.join(tempfile.gettempdir(), "meeting_notes_%s.txt" % token)
    try:
        with _mss.mss() as screen:
            shot = screen.grab({"left": rect[0], "top": rect[1], "width": width, "height": height})
            _mss_tools.to_png(shot.rgb, shot.size, output=image_path)

        script = _ocr_script_path()
        if not os.path.exists(script):
            raise RuntimeError("找不到 OCR 脚本: %s" % script)
        startupinfo = None
        if hasattr(subprocess, "STARTUPINFO"):
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
             "-ImagePath", image_path, "-OutFile", output_path],
            capture_output=True,
            timeout=20,
            startupinfo=startupinfo,
        )
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError("Windows OCR 失败" + ((": " + detail) if detail else ""))

        lines = []
        if os.path.exists(output_path):
            with open(output_path, "r", encoding="utf-8-sig", errors="replace") as f:
                for raw in f:
                    match = re.match(r"TEXT\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(.*)", raw.strip())
                    if match:
                        lines.append({
                            "left": int(match.group(1)),
                            "top": int(match.group(2)),
                            "right": int(match.group(3)),
                            "bottom": int(match.group(4)),
                            "text": match.group(5).strip(),
                        })
        return rect, lines
    finally:
        for path in (image_path, output_path):
            try:
                os.remove(path)
            except OSError:
                pass


def _normalized_text(value):
    return re.sub(r"\s+", "", value or "").casefold()


def _find_ocr_line(lines, phrases, avoid=()):
    normalized_avoid = [_normalized_text(x) for x in avoid]
    for phrase in phrases:
        wanted = _normalized_text(phrase)
        for line in lines:
            text = _normalized_text(line["text"])
            if wanted and wanted in text and not any(a and a in text for a in normalized_avoid):
                return line
    return None


def _uia_click_names(names):
    """优先用 Windows UI Automation 点击可访问的 Teams 控件。"""
    try:
        from pywinauto import Desktop
    except ImportError:
        return False
    wanted = {_normalized_text(name) for name in names}
    try:
        desktop = Desktop(backend="uia")
        for window in _teams_windows():
            try:
                root = desktop.window(handle=window["hwnd"])
                for control in root.descendants(depth=12):
                    try:
                        text = _normalized_text(control.window_text())
                        control_type = control.element_info.control_type
                        if text in wanted and control_type in ("Button", "MenuItem", "Hyperlink", "ListItem"):
                            control.click_input()
                            return True
                    except Exception:
                        continue
            except Exception:
                continue
    except Exception:
        return False
    return False


def _try_click_fixed_entry_action(timeout=45):
    """打开固定 Teams 对话/会议链接后,点击立即开会或加入。"""
    deadline = time.time() + timeout
    exact_actions = (
        "立即开会", "Meet now", "Start meeting", "Start an instant meeting",
        "加入", "立即加入", "加入会议", "Join", "Join now", "Join meeting",
    )
    context_words = (
        "麦克风", "摄像头", "Microphone", "Camera", "音频", "视频", "Audio", "Video",
        "立即开会", "Meet now", "会议", "Meeting",
    )
    while time.time() < deadline:
        if _uia_click_names(exact_actions):
            return True
        for window in _teams_windows():
            try:
                _, lines = _capture_and_ocr(window)
            except Exception:
                continue
            line = None
            for candidate in lines:
                text = _normalized_text(candidate.get("text", ""))
                if text in {_normalized_text(name) for name in exact_actions}:
                    line = candidate
                    break
            if line:
                _focus_window(window["hwnd"])
                _click_ocr_line(window, line)
                return True
            has_context = _find_ocr_line(lines, context_words) is not None
            join = _find_ocr_line(lines, ("加入", "Join", "立即加入", "Join now"))
            if has_context and join:
                _focus_window(window["hwnd"])
                _click_ocr_line(window, join)
                return True
        time.sleep(0.8)
    return False


def _click_ocr_line(window, line):
    rect = window["rect"]
    x = rect[0] + (line["left"] + line["right"]) // 2
    y = rect[1] + (line["top"] + line["bottom"]) // 2
    _click_screen(x, y)


def _wait_for_ocr(window, phrases, timeout=5.0, avoid=()):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            _, lines = _capture_and_ocr(window)
        except Exception:
            lines = []
        line = _find_ocr_line(lines, phrases, avoid=avoid)
        if line:
            return line
        time.sleep(0.45)
    return None


def _try_auto_join(allow_link_context=False, timeout=45):
    """只在识别到会议/加入界面时点击,避免误点 Teams 主界面。"""
    deadline = time.time() + timeout
    join_phrases = ("立即加入", "加入会议", "Join now", "Join meeting", "加入", "Join")
    dialog_phrases = ("新会议", "New meeting", "立即开会", "Meet now", "加入会议", "Join meeting")
    meeting_context = (
        "麦克风", "摄像头", "Microphone", "Camera", "背景滤镜", "Background filters",
        "音频", "Audio", "视频", "Video",
    )
    while time.time() < deadline:
        windows = _teams_windows()
        if not windows:
            time.sleep(0.7)
            continue
        for window in windows:
            try:
                _, lines = _capture_and_ocr(window)
            except Exception:
                continue
            dialog = _find_ocr_line(lines, dialog_phrases)
            join = _find_ocr_line(lines, join_phrases)
            has_context = _find_ocr_line(lines, meeting_context) is not None
            if join and (dialog or (allow_link_context and has_context)):
                _focus_window(window["hwnd"])
                _click_ocr_line(window, join)
                return True
        time.sleep(0.7)
    return False


def _try_click_meet_now(timeout=14):
    """在 Teams 日历/主页中识别并点击“立即开会/Meet now”。"""
    deadline = time.time() + timeout
    phrases = ("立即开会", "Meet now", "Meet Now", "Start an instant meeting")
    while time.time() < deadline:
        windows = _teams_windows()
        if not windows:
            time.sleep(0.7)
            continue
        for window in windows:
            try:
                _, lines = _capture_and_ocr(window)
            except Exception:
                continue
            line = _find_ocr_line(lines, phrases)
            if line:
                _focus_window(window["hwnd"])
                _click_ocr_line(window, line)
                return True
        time.sleep(0.7)
    return False


def _try_join_after_meet_now(timeout=12):
    """处理 Meet now 可能出现的预览页,仅点击明确的入会按钮。"""
    deadline = time.time() + timeout
    exact_join = ("立即加入", "加入会议", "Join now", "Join meeting")
    broad_join = ("加入", "Join")
    meeting_context = (
        "麦克风", "摄像头", "Microphone", "Camera", "背景滤镜", "Background filters",
        "音频", "Audio", "视频", "Video",
    )
    while time.time() < deadline:
        window = _frontmost_teams_window()
        if not window:
            time.sleep(0.7)
            continue
        try:
            _, lines = _capture_and_ocr(window)
        except Exception:
            time.sleep(0.7)
            continue
        join = _find_ocr_line(lines, exact_join)
        if not join:
            join = _find_ocr_line(lines, broad_join)
            if not join or not _find_ocr_line(lines, meeting_context):
                time.sleep(0.7)
                continue
        _focus_window(window["hwnd"])
        _click_ocr_line(window, join)
        return True
    return False


def _is_teams_shell(window):
    title = (window.get("title") or "").strip().casefold()
    return title in ("microsoft teams", "calendar | microsoft teams") or title.startswith("calendar |") or title.startswith("日历 |")


def _meeting_toolbar_score(window, lines, subject=""):
    if _is_teams_shell(window):
        return 0
    title = _normalized_text(window.get("title", ""))
    wanted_subject = _normalized_text(subject)
    combined = _normalized_text(" ".join(line.get("text", "") for line in lines))
    groups = (
        ("离开", "退出会议", "挂断", "结束通话", "Leave", "Hang up", "End call"),
        ("共享", "分享", "Share"),
        ("参与者", "参会者", "人员", "Participants", "People"),
        ("更多", "更多操作", "More", "More actions"),
        ("聊天", "Chat"),
        ("录制", "转录", "录音", "Record", "Transcript", "Recording"),
        ("麦克风", "麦克风已关闭", "静音", "Microphone", "Mute"),
    )
    score = sum(1 for group in groups if any(_normalized_text(word) in combined for word in group))
    prejoin = any(_normalized_text(word) in combined for word in (
        "立即加入", "加入会议", "Join now", "Join meeting", "开始会议", "Start meeting",
        "加入前", "Join before", "检查设备", "Device check",
    ))
    title_match = bool(wanted_subject and wanted_subject in title)
    if prejoin and score < 2:
        return 0
    if title_match and score >= 1:
        return score + 2
    return score


def _wait_for_active_meeting(subject="", timeout=300):
    """等待用户在 Teams 预览页手动开始后,识别真正的会议工具栏。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for window in _teams_windows():
            try:
                _, lines = _capture_and_ocr(window)
            except Exception:
                continue
            if _meeting_toolbar_score(window, lines, subject) >= 2:
                return window
        time.sleep(1.5)
    return None


def _confirm_transcription_dialog(window):
    """处理 Teams 开始转录后的语言选择/确认弹窗。"""
    language = _wait_for_ocr(
        window,
        ("中文(简体)", "中文（简体）", "Chinese (Simplified)", "Chinese Simplified", "简体中文"),
        timeout=4,
    )
    if language:
        _click_ocr_line(window, language)
        time.sleep(0.4)
    confirm = _wait_for_ocr(window, ("确认", "Confirm", "确定", "OK"), timeout=4)
    if confirm:
        _click_ocr_line(window, confirm)
        time.sleep(1.2)
        return True
    return False


def _caption_lines(lines, rect, min_ratio=0.68):
    """从 OCR 结果中提取会议窗口底部的实时字幕行。"""
    height = rect[3] - rect[1]
    if height <= 0:
        return []
    bottom = [line for line in lines if line["bottom"] > height * min_ratio]
    bottom.sort(key=lambda line: line["bottom"])
    texts = [line["text"] for line in bottom if line["text"].strip()]
    return texts[-2:]


def _transcription_already_on(lines):
    return _find_ocr_line(lines, (
        "正在转录", "转录中", "转录已开启", "已开始转录", "Transcribing", "Transcription on",
        "Transcription started", "Stop transcription", "停止转录",
    )) is not None


def _start_transcription_on_window(window):
    """先识别按钮点击菜单,失败后使用 Teams 官方快捷键兜底。"""
    _focus_window(window["hwnd"])
    try:
        _, lines = _capture_and_ocr(window)
    except Exception:
        lines = []
    if _transcription_already_on(lines):
        return True, "检测到 Teams 已经在转录。"

    # 会议工具栏可能自动隐藏,把鼠标移到底部让它显示。
    rect = window["rect"]
    _USER32.SetCursorPos((rect[0] + rect[2]) // 2, rect[3] - 70)
    time.sleep(0.6)
    try:
        _, lines = _capture_and_ocr(window)
    except Exception:
        lines = []

    more = _find_ocr_line(lines, ("更多操作", "更多", "More actions", "More options", "More"))
    if more:
        _click_ocr_line(window, more)
        # 优先开启“录制和转录”(会后可下载 .vtt);企业策略不允许时回退到“打开实时字幕”。
        record = _wait_for_ocr(
            window,
            ("录制和转录", "录制和转写", "Record and transcribe", "Record & transcribe", "Recording and transcription"),
            timeout=4,
        )
        if record:
            _click_ocr_line(window, record)
            start = _wait_for_ocr(
                window,
                ("开始转录", "开始转写", "Start transcription", "Turn on transcription"),
                timeout=5,
            )
            if start:
                _click_ocr_line(window, start)
                _confirm_transcription_dialog(window)
                return True, "已点击开始转录,Teams 正在处理语言确认。"
        live_caption = _wait_for_ocr(
            window,
            ("打开实时字幕", "开启实时字幕", "打开字幕", "Turn on live captions", "Live captions"),
            timeout=4,
        )
        if live_caption:
            _click_ocr_line(window, live_caption)
            return True, "已开启 Teams 实时字幕,应用将自动抓取屏幕字幕写入文本区。"

    # Teams 官方快捷键,不依赖界面语言或按钮位置。
    _focus_window(window["hwnd"])
    _send_transcription_hotkey()
    time.sleep(2.2)
    try:
        _, after = _capture_and_ocr(window)
    except Exception:
        after = []
    if _transcription_already_on(after):
        return True, "已通过 Teams 快捷键 Ctrl+Shift+U 开启转录。"
    return False, "未能确认转录状态,请确认已进入会议并重试“仅自动开始转录”。"


def _auto_start_transcription(subject="", window=None, timeout=300):
    if window is None:
        window = _wait_for_active_meeting(subject, timeout=timeout)
    if not window:
        return False, "等待会议进入超时。请确认已在 Teams 预览页点击“开始会议/立即加入”。"
    return _start_transcription_on_window(window)


MEETING_GUIDE = (
    "本应用会尝试自动完成以下操作:\n\n"
    "1. 识别 Teams 的\"加入/立即开会\"按钮并点击;\n"
    "2. 识别\"更多 -> 录制和转录 -> 开始转录\"并点击;\n"
    "3. 如果按钮识别失败,自动发送 Teams 快捷键 Ctrl+Shift+U。\n\n"
    "Teams 版本、语言或公司策略不同可能导致自动识别失败。\n"
    "失败时请将 Teams 会议窗口切到前台,再点击\"仅自动开始转录\"。\n\n"
    "会后仍需在 Teams 聊天中下载 .vtt 转写文件,再回到本应用导入。"
)


# ---------------- 界面 ----------------

def _parent_background(widget, fallback):
    try:
        return widget.cget("bg")
    except (tk.TclError, AttributeError):
        return fallback


def _rounded_shape(canvas, x1, y1, x2, y2, radius, fill, outline="", tag="shape"):
    radius = max(1, min(radius, int((x2 - x1) / 2), int((y2 - y1) / 2)))
    canvas.create_rectangle(x1 + radius, y1, x2 - radius, y2, fill=fill, outline=outline, tags=tag)
    canvas.create_rectangle(x1, y1 + radius, x2, y2 - radius, fill=fill, outline=outline, tags=tag)
    canvas.create_arc(x1, y1, x1 + radius * 2, y1 + radius * 2, start=90, extent=90, fill=fill, outline=outline, tags=tag)
    canvas.create_arc(x2 - radius * 2, y1, x2, y1 + radius * 2, start=0, extent=90, fill=fill, outline=outline, tags=tag)
    canvas.create_arc(x1, y2 - radius * 2, x1 + radius * 2, y2, start=180, extent=90, fill=fill, outline=outline, tags=tag)
    canvas.create_arc(x2 - radius * 2, y2 - radius * 2, x2, y2, start=270, extent=90, fill=fill, outline=outline, tags=tag)


class RoundedButton(tk.Canvas):
    def __init__(self, parent, text, command, primary=False, compact=False):
        self._surface = _parent_background(parent, COLORS["background"])
        self._text = text
        self._command = command
        self._primary = primary
        self._compact = compact
        self._enabled = True
        self._hovered = False
        size = 9 if compact else 10
        weight = "bold" if primary else "normal"
        self._font = tkfont.Font(family=FONT_NAME, size=size, weight=weight)
        self._height = 34 if compact else (44 if primary else 40)
        self._min_width = 74 if compact else 112
        width = max(self._min_width, self._font.measure(text) + (28 if compact else 36))
        super().__init__(parent, width=width, height=self._height, bg=self._surface, highlightthickness=0, bd=0, cursor="hand2")
        self.bind("<Configure>", self._redraw)
        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<Button-1>", self._on_click)
        self._redraw()

    def _colors(self):
        if not self._enabled:
            return "#E5E7EB", COLORS["subtle"]
        if self._primary:
            return (COLORS["primary_dark"] if self._hovered else COLORS["primary"]), "white"
        return (COLORS["primary_soft"] if self._hovered else COLORS["card"]), COLORS["text"]

    def _redraw(self, _event=None):
        width = max(self.winfo_width(), self._min_width)
        height = max(self.winfo_height(), self._height)
        fill, text_color = self._colors()
        self.delete("all")
        if _PILImage is not None and _PILImageDraw is not None and _PILImageTk is not None:
            scale = 4
            image = _PILImage.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
            draw = _PILImageDraw.Draw(image)
            radius = min(14, height // 2) * scale
            box = (scale, scale, (width - 1) * scale, (height - 1) * scale)
            if self._primary or not self._enabled:
                draw.rounded_rectangle(box, radius=radius, fill=fill)
            else:
                draw.rounded_rectangle(box, radius=radius, fill=COLORS["border"])
                inner = (2 * scale, 2 * scale, (width - 2) * scale, (height - 2) * scale)
                draw.rounded_rectangle(inner, radius=max(1, radius - scale), fill=fill)
            image = image.resize((width, height), _PILImage.Resampling.LANCZOS)
            self._image = _PILImageTk.PhotoImage(image)
            self.create_image(width // 2, height // 2, image=self._image, anchor="center", tags="button")
        else:
            if self._primary or not self._enabled:
                _rounded_shape(self, 1, 1, width - 1, height - 1, min(14, height // 2), fill, tag="button")
            else:
                _rounded_shape(self, 1, 1, width - 1, height - 1, min(14, height // 2), COLORS["border"], tag="button-border")
                _rounded_shape(self, 2, 2, width - 2, height - 2, min(13, height // 2), fill, tag="button")
        self.create_text(width // 2, height // 2, text=self._text, fill=text_color, font=self._font, tags="label")

    def _on_enter(self, _event=None):
        if self._enabled:
            self._hovered = True
            self._redraw()

    def _on_leave(self, _event=None):
        self._hovered = False
        self._redraw()

    def _on_click(self, _event=None):
        if self._enabled and self._command:
            self._command()

    def configure(self, cnf=None, **kwargs):
        cnf = cnf or {}
        state = kwargs.pop("state", cnf.pop("state", None))
        text = kwargs.pop("text", cnf.pop("text", None))
        if state is not None:
            self._enabled = state != "disabled"
        if text is not None:
            self._text = text
        self._redraw()
        return super().configure(cnf, **kwargs)

    config = configure


class RoundedPanel(tk.Frame):
    def __init__(self, parent, padding=8):
        self._surface = _parent_background(parent, COLORS["background"])
        self._padding = padding
        super().__init__(parent, bg=self._surface, highlightthickness=0, bd=0)
        self.canvas = tk.Canvas(self, bg=self._surface, highlightthickness=0, bd=0)
        self.canvas.place(x=0, y=0, relwidth=1, relheight=1)
        self.content = tk.Frame(self, bg=COLORS["card"], highlightthickness=0, bd=0)
        self.content.pack(fill="both", expand=True, padx=padding, pady=padding)
        self.bind("<Configure>", self._redraw)
        self.after_idle(self._redraw)

    def _redraw(self, _event=None):
        width = max(self.winfo_width(), 2 * self._padding + 4)
        height = max(self.winfo_height(), 2 * self._padding + 4)
        self.canvas.config(width=width, height=height)
        self.canvas.delete("panel")
        _rounded_shape(self.canvas, 1, 1, width - 1, height - 1, 18, COLORS["card"], tag="panel")
        self.canvas.tag_lower("panel")

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_NAME)
        self.geometry("430x760")
        self.minsize(390, 620)
        self.configure(bg=COLORS["background"])
        self._apply_windows_rounding()
        self.cfg = load_config()

        import tkinter.font as tkfont
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tkfont.nametofont(name).configure(family=FONT_NAME, size=10)
            except Exception:
                pass

        self.title_var = tk.StringVar()
        self.attendees_var = tk.StringVar()
        self.link_var = tk.StringVar()
        self.outlook_items = []
        self.home_frame = None
        self.workspace_frame = None
        self.workspace_open = False
        self.meeting_list = None
        self.meeting_hint = None
        self._capturing = False
        self._last_caption = ""
        self._fixed_entry_mode = False
        self.jobs = queue.Queue()

        self._build_menu()
        self._build_ui()
        self._poll_jobs()
        self.status("准备就绪")
        self.after(250, self.load_outlook_meetings)

    def _apply_windows_rounding(self):
        """Windows 11 原生圆角;旧版 Windows 忽略即可。"""
        try:
            hwnd = self.winfo_id()
            DWMWA_WINDOW_CORNER_PREFERENCE = 33
            DWMWCP_ROUND = 2
            value = ctypes.c_int(DWMWCP_ROUND)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ctypes.byref(value), ctypes.sizeof(value)
            )
        except Exception:
            pass

    # ---------- 布局 ----------
    def _build_menu(self):
        # Keep the main surface clean; the primary actions are visible in the app.
        self.config(menu=tk.Menu(self, tearoff=0))

    def _build_ui(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Modern.Vertical.TScrollbar", background=COLORS["border"], troughcolor=COLORS["background"], bordercolor=COLORS["background"], arrowcolor=COLORS["muted"])

        self.page_container = tk.Frame(self, bg=COLORS["background"])
        self.page_container.pack(fill="both", expand=True)
        self.status_var = tk.StringVar(value="就绪。")
        self.status_label = tk.Label(
            self, textvariable=self.status_var, anchor="w", bg=COLORS["background"],
            fg=COLORS["muted"], font=(FONT_NAME, 9), padx=18, pady=8,
        )
        self.status_label.pack(fill="x", side="bottom")

        self._build_home()
        self._build_workspace()
        self.show_home()

    def _button(self, parent, text, command, primary=False, compact=False):
        return RoundedButton(parent, text, command, primary=primary, compact=compact)

    def _card(self, parent, **kwargs):
        return RoundedPanel(parent, **kwargs)

    def _build_home(self):
        self.home_frame = tk.Frame(self.page_container, bg=COLORS["background"])
        self.home_frame.pack(fill="both", expand=True)

        header = tk.Frame(self.home_frame, bg=COLORS["background"])
        header.pack(fill="x", padx=22, pady=(22, 10))
        title_box = tk.Frame(header, bg=COLORS["background"])
        title_box.pack(side="left")
        tk.Label(title_box, text="会议纪要", bg=COLORS["background"], fg=COLORS["text"], font=(FONT_NAME, 21, "bold")).pack(anchor="w")
        tk.Label(title_box, text="Teams · Outlook · AI", bg=COLORS["background"], fg=COLORS["muted"], font=(FONT_NAME, 9)).pack(anchor="w", pady=(2, 0))
        actions = tk.Frame(header, bg=COLORS["background"])
        actions.pack(side="right", anchor="n")
        self.btn_settings = self._button(actions, "设置", self.open_settings, compact=True)
        self.btn_settings.pack(side="left", padx=(0, 6))
        self.btn_help = self._button(actions, "帮助", self.show_help, compact=True)
        self.btn_help.pack(side="left")

        hero = self._card(self.home_frame)
        hero.pack(fill="x", padx=22, pady=(0, 12))
        tk.Frame(hero.content, bg=COLORS["primary"], width=5).pack(side="left", fill="y")
        hero_body = tk.Frame(hero.content, bg=COLORS["card"])
        hero_body.pack(fill="both", expand=True, padx=18, pady=16)
        tk.Label(hero_body, text="现场会议", bg=COLORS["card"], fg=COLORS["primary"], font=(FONT_NAME, 9, "bold")).pack(anchor="w")
        tk.Label(hero_body, text="好记性不如烂笔头", bg=COLORS["card"], fg=COLORS["text"], font=(FONT_NAME, 16, "bold")).pack(anchor="w", pady=(4, 2))
        tk.Label(hero_body, text="一键开会 → Teams 转录/实时字幕 → AI 纪要,自动记录每一场对话。", bg=COLORS["card"], fg=COLORS["muted"], font=(FONT_NAME, 9), wraplength=330, justify="left").pack(anchor="w")
        self.btn_field = self._button(hero_body, "立即开会并开始转录", self.start_field_meeting, primary=True)
        self.btn_field.pack(fill="x", pady=(14, 0))

        section = tk.Frame(self.home_frame, bg=COLORS["background"])
        section.pack(fill="x", padx=22, pady=(2, 8))
        self.section_label = tk.Label(section, text="近期会议", bg=COLORS["background"], fg=COLORS["text"], font=(FONT_NAME, 12, "bold"))
        self.section_label.pack(side="left")
        self.btn_outlook = self._button(section, "刷新", self.load_outlook_meetings, compact=True)
        self.btn_outlook.pack(side="right")

        list_card = self._card(self.home_frame)
        list_card.pack(fill="both", expand=True, padx=22, pady=(0, 12))
        list_view = tk.Frame(list_card.content, bg=COLORS["card"])
        list_view.pack(fill="both", expand=True, padx=8, pady=8)
        self.meeting_canvas = tk.Canvas(list_view, bg=COLORS["card"], highlightthickness=0, bd=0)
        meeting_scroll = ttk.Scrollbar(list_view, orient="vertical", command=self.meeting_canvas.yview, style="Modern.Vertical.TScrollbar")
        self.meeting_list = tk.Frame(self.meeting_canvas, bg=COLORS["card"])
        meeting_window = self.meeting_canvas.create_window((0, 0), window=self.meeting_list, anchor="nw")
        self.meeting_canvas.configure(yscrollcommand=meeting_scroll.set)
        self.meeting_list.bind("<Configure>", lambda _event: self.meeting_canvas.configure(scrollregion=self.meeting_canvas.bbox("all")))
        self.meeting_canvas.bind("<Configure>", lambda event: self.meeting_canvas.itemconfigure(meeting_window, width=event.width))
        self.meeting_canvas.bind("<MouseWheel>", lambda event: self.meeting_canvas.yview_scroll(-int(event.delta / 120), "units"))
        self.meeting_list.bind("<MouseWheel>", lambda event: self.meeting_canvas.yview_scroll(-int(event.delta / 120), "units"))
        self.meeting_canvas.bind("<Button-4>", lambda _event: self.meeting_canvas.yview_scroll(-3, "units"))
        self.meeting_canvas.bind("<Button-5>", lambda _event: self.meeting_canvas.yview_scroll(3, "units"))
        self.bind_all("<MouseWheel>", self._scroll_meeting_list)
        self.meeting_canvas.pack(side="left", fill="both", expand=True)
        meeting_scroll.pack(side="right", fill="y")
        self._render_meeting_list([])

        footer = tk.Frame(self.home_frame, bg=COLORS["background"])
        footer.pack(fill="x", padx=22, pady=(0, 12))
        self._button(footer, "导入转写并整理纪要", self.import_file, primary=False).pack(fill="x")

    def _scroll_meeting_list(self, event):
        if not self.workspace_open and getattr(self, "meeting_canvas", None):
            self.meeting_canvas.yview_scroll(-int(event.delta / 120), "units")
            return "break"

    def _build_workspace(self):
        self.workspace_frame = tk.Frame(self.page_container, bg=COLORS["background"])
        top = tk.Frame(self.workspace_frame, bg=COLORS["background"])
        top.pack(fill="x", padx=18, pady=(16, 8))
        self._button(top, "‹ 首页", self.show_home, compact=True).pack(side="left")
        tk.Label(top, text="会议整理", bg=COLORS["background"], fg=COLORS["text"], font=(FONT_NAME, 18, "bold")).pack(side="left", padx=12)
        self.btn_teams = self._button(top, "打开并转录", self.open_teams, primary=True, compact=True)
        self.btn_teams.pack(side="right")

        meta = self._card(self.workspace_frame)
        meta.pack(fill="x", padx=18, pady=(0, 8))
        meta_inner = tk.Frame(meta.content, bg=COLORS["card"])
        meta_inner.pack(fill="x", padx=12, pady=10)
        tk.Label(meta_inner, text="标题", bg=COLORS["card"], fg=COLORS["muted"], font=(FONT_NAME, 9)).grid(row=0, column=0, sticky="w", padx=(0, 8))
        title_entry = tk.Entry(meta_inner, textvariable=self.title_var, bg="#F8FAFC", fg=COLORS["text"], relief="flat", highlightthickness=1, highlightbackground=COLORS["border"], font=(FONT_NAME, 10))
        title_entry.grid(row=0, column=1, sticky="ew", padx=(0, 12), ipady=5)
        tk.Label(meta_inner, text="参会人", bg=COLORS["card"], fg=COLORS["muted"], font=(FONT_NAME, 9)).grid(row=0, column=2, sticky="w", padx=(0, 8))
        attendee_entry = tk.Entry(meta_inner, textvariable=self.attendees_var, bg="#F8FAFC", fg=COLORS["text"], relief="flat", highlightthickness=1, highlightbackground=COLORS["border"], font=(FONT_NAME, 10))
        attendee_entry.grid(row=0, column=3, sticky="ew", ipady=5)
        meta_inner.columnconfigure(1, weight=1)
        meta_inner.columnconfigure(3, weight=1)
        link_entry = tk.Entry(meta_inner, textvariable=self.link_var, bg="#F8FAFC", fg=COLORS["muted"], relief="flat", highlightthickness=1, highlightbackground=COLORS["border"], font=(FONT_NAME, 9))
        link_entry.grid(row=1, column=1, columnspan=3, sticky="ew", pady=(7, 0), ipady=4)
        tk.Label(meta_inner, text="链接", bg=COLORS["card"], fg=COLORS["muted"], font=(FONT_NAME, 9)).grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(7, 0))

        tools = tk.Frame(self.workspace_frame, bg=COLORS["background"])
        tools.pack(fill="x", padx=18, pady=(0, 8))
        self.btn_transcribe = self._button(tools, "仅自动开始转录", self.start_transcription, compact=True)
        self.btn_transcribe.pack(side="left", padx=(0, 6))
        self.btn_import = self._button(tools, "导入 .vtt", self.import_file, compact=True)
        self.btn_import.pack(side="left", padx=(0, 6))
        self.btn_paste = self._button(tools, "粘贴文字", self.paste_text, compact=True)
        self.btn_paste.pack(side="left", padx=(0, 6))
        self.btn_clear = self._button(tools, "清空", self.clear_all, compact=True)
        self.btn_clear.pack(side="left")
        self.btn_captions = self._button(tools, "实时字幕", self.toggle_captions, compact=True)
        self.btn_captions.pack(side="left", padx=(6, 0))

        paned = ttk.Panedwindow(self.workspace_frame, orient="vertical")
        paned.pack(fill="both", expand=True, padx=18, pady=(0, 10))

        transcript_card = self._card(paned)
        transcript_head = tk.Frame(transcript_card.content, bg=COLORS["card"])
        transcript_head.pack(fill="x", padx=12, pady=(10, 6))
        tk.Label(transcript_head, text="转写文本", bg=COLORS["card"], fg=COLORS["text"], font=(FONT_NAME, 11, "bold")).pack(side="left")
        self.chars_var = tk.StringVar(value="0 字")
        tk.Label(transcript_head, textvariable=self.chars_var, bg=COLORS["card"], fg=COLORS["muted"], font=(FONT_NAME, 9)).pack(side="right")
        text_frame = tk.Frame(transcript_card.content, bg=COLORS["card"])
        text_frame.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.transcript_text = tk.Text(text_frame, wrap="word", undo=True, bg="#FBFCFE", fg=COLORS["text"], insertbackground=COLORS["primary"], relief="flat", highlightthickness=1, highlightbackground=COLORS["border"], font=(FONT_NAME, 10), padx=10, pady=8)
        sb1 = ttk.Scrollbar(text_frame, orient="vertical", command=self.transcript_text.yview, style="Modern.Vertical.TScrollbar")
        self.transcript_text.configure(yscrollcommand=sb1.set)
        self.transcript_text.pack(side="left", fill="both", expand=True)
        sb1.pack(side="right", fill="y")
        self.transcript_text.bind("<KeyRelease>", self._on_transcript_change)
        paned.add(transcript_card, weight=1)

        result_card = self._card(paned)
        result_head = tk.Frame(result_card.content, bg=COLORS["card"])
        result_head.pack(fill="x", padx=12, pady=(10, 6))
        tk.Label(result_head, text="AI 会议纪要", bg=COLORS["card"], fg=COLORS["text"], font=(FONT_NAME, 11, "bold")).pack(side="left")
        self.btn_open_dir = self._button(result_head, "文件夹", self.open_save_dir, compact=True)
        self.btn_open_dir.pack(side="right", padx=(6, 0))
        self.btn_save = self._button(result_head, "保存", self.save_result, compact=True)
        self.btn_save.pack(side="right", padx=(6, 0))
        self.btn_copy = self._button(result_head, "复制", self.copy_result, compact=True)
        self.btn_copy.pack(side="right", padx=(6, 0))
        self.btn_generate = self._button(result_head, "生成纪要", self.generate, primary=True, compact=True)
        self.btn_generate.pack(side="right")
        result_frame = tk.Frame(result_card.content, bg=COLORS["card"])
        result_frame.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.result_text = tk.Text(result_frame, wrap="word", bg="#FBFCFE", fg=COLORS["text"], insertbackground=COLORS["primary"], relief="flat", highlightthickness=1, highlightbackground=COLORS["border"], font=(FONT_NAME, 10), padx=10, pady=8)
        sb2 = ttk.Scrollbar(result_frame, orient="vertical", command=self.result_text.yview, style="Modern.Vertical.TScrollbar")
        self.result_text.configure(yscrollcommand=sb2.set)
        self.result_text.pack(side="left", fill="both", expand=True)
        sb2.pack(side="right", fill="y")
        paned.add(result_card, weight=1)

    def _render_meeting_list(self, meetings, empty_text="正在读取 Outlook 会议..."):
        if not self.meeting_list:
            return
        for child in self.meeting_list.winfo_children():
            child.destroy()
        if not meetings:
            tk.Label(self.meeting_list, text=empty_text, bg=COLORS["card"], fg=COLORS["muted"], font=(FONT_NAME, 10), justify="left").pack(anchor="w", padx=10, pady=14)
            return
        for item in meetings:
            row = tk.Frame(self.meeting_list, bg=COLORS["card"], highlightbackground=COLORS["border"], highlightthickness=1)
            row.pack(fill="x", pady=4)
            info = tk.Frame(row, bg=COLORS["card"])
            info.pack(side="left", fill="both", expand=True, padx=12, pady=9)
            tk.Label(info, text=item["subject"], bg=COLORS["card"], fg=COLORS["text"], font=(FONT_NAME, 10, "bold"), anchor="w").pack(fill="x")
            tk.Label(info, text=item["start"].strftime("%m月%d日 %H:%M") + "  ·  " + item.get("provider", "Outlook"), bg=COLORS["card"], fg=COLORS["muted"], font=(FONT_NAME, 9), anchor="w").pack(fill="x", pady=(3, 0))
            action_text = "加入" if item.get("url") else "打开 Outlook"
            open_button = self._button(row, action_text, lambda meeting=item: self._use_outlook_meeting(meeting), primary=False, compact=True)
            open_button.pack(side="right", padx=10)

    def _use_outlook_meeting(self, item):
        self.title_var.set(item["subject"])
        url = item.get("url") or ""
        self.link_var.set(url)
        if not url:
            self.status("正在打开 Outlook 日程: %s" % item["subject"])
            threading.Thread(target=self._open_outlook_item_worker, args=(item,), daemon=True).start()
            return
        self.open_workspace()
        self.status("已打开会议链接(%s): %s" % (item.get("provider", "在线会议"), item["subject"]))
        if item.get("provider") == "Teams":
            self.open_teams()
        else:
            try:
                os.startfile(url)
            except OSError as e:
                messagebox.showwarning("提示", "无法打开会议链接: %s" % e)

    def _open_outlook_item_worker(self, item):
        try:
            open_outlook_item(item)
            subject = item["subject"]
            self.jobs.put(lambda subject=subject: self.status("已在 Outlook 中打开日程: %s" % subject))
        except Exception as e:
            detail = str(e)
            self.jobs.put(lambda detail=detail: self._outlook_item_failed(detail))

    def _outlook_item_failed(self, detail):
        self.open_workspace()
        self.status("无法打开 Outlook 日程: %s" % detail)
        messagebox.showwarning("无法打开日程", "该日程没有在线会议链接,请手动进入会议。\n\n%s" % detail)

    def open_workspace(self):
        if self.workspace_open:
            return
        self.workspace_open = True
        self.home_frame.pack_forget()
        self.workspace_frame.pack(fill="both", expand=True)
        self.geometry("1100x720")
        self.minsize(900, 600)

    def show_home(self):
        self.workspace_open = False
        if self.workspace_frame:
            self.workspace_frame.pack_forget()
        if self.home_frame:
            self.home_frame.pack(fill="both", expand=True)
        self.geometry("430x760")
        self.minsize(390, 620)

    # ---------- 工具 ----------
    def status(self, text):
        self.status_var.set(text)

    def _on_transcript_change(self, _=None):
        n = len(self.transcript_text.get("1.0", "end-1c"))
        self.chars_var.set("%d 字" % n)

    def _poll_jobs(self):
        try:
            while True:
                fn = self.jobs.get_nowait()
                fn()
        except queue.Empty:
            pass
        self.after(100, self._poll_jobs)

    # ---------- 实时字幕 ----------
    def toggle_captions(self):
        if self._capturing:
            self.stop_captions()
        else:
            self.start_captions()

    def start_captions(self):
        if self._capturing:
            return
        self._capturing = True
        self._last_caption = ""
        self.btn_captions.config(text="停止实时字幕")
        self.status("正在抓取 Teams 实时字幕...")
        threading.Thread(target=self._caption_worker, daemon=True).start()

    def stop_captions(self):
        self._capturing = False
        if getattr(self, "btn_captions", None):
            self.btn_captions.config(text="实时字幕")
        self.status("已停止抓取实时字幕。")

    def _append_caption(self, text):
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        self.transcript_text.insert("end", "[%s] %s\n" % (timestamp, text))
        self.transcript_text.see("end")
        self._on_transcript_change()

    def _caption_worker(self):
        while self._capturing:
            try:
                for window in _teams_windows():
                    if _is_teams_shell(window):
                        continue
                    rect, lines = _capture_and_ocr(window)
                    captions = _caption_lines(lines, rect)
                    if captions:
                        text = captions[-1]
                        if text and text != self._last_caption and len(text) >= 2:
                            self._last_caption = text
                            self.jobs.put(lambda value=text: self._append_caption(value))
                        break
            except Exception:
                pass
            time.sleep(3)

    # ---------- 动作 ----------
    def load_outlook_meetings(self):
        cached = _load_meeting_cache()
        if cached:
            self._show_outlook_meetings(cached, from_cache=True)
        self.btn_outlook.config(state="disabled")
        self.status("正在读取 Outlook 近期会议...")
        threading.Thread(target=self._outlook_worker, daemon=True).start()

    def _outlook_worker(self):
        try:
            meetings = outlook_meetings(14)
            _save_meeting_cache(meetings)
            self.jobs.put(lambda: self._show_outlook_meetings(meetings))
        except Exception as e:
            detail = str(e)
            self.jobs.put(lambda detail=detail: self._outlook_failed(detail))

    def _outlook_failed(self, detail):
        self.btn_outlook.config(state="normal")
        if not self.outlook_items:
            self._render_meeting_list([], "读取 Outlook 失败\n%s" % detail)
        else:
            self.status("刷新失败,已显示上次保存的会议列表。")
        self.status("读取 Outlook 失败。")

    def _show_outlook_meetings(self, meetings, from_cache=False):
        self.btn_outlook.config(state="normal")
        meetings = sorted(meetings, key=lambda item: (not bool(item.get("url")), item.get("start", datetime.datetime.max)))
        self.outlook_items = meetings
        if not meetings:
            self._render_meeting_list([], "没有找到近期会议\n请确认 Outlook 已同步,或点击下方导入转写")
            self.status("未来 14 天没有找到会议日程。")
            return
        self._render_meeting_list(meetings)
        if self.section_label:
            self.section_label.config(text="近期会议 (%d)" % len(meetings))
        if from_cache:
            self.status("显示最近保存的 %d 个会议,正在后台刷新..." % len(meetings))
        else:
            self.status("找到 %d 个近期 Outlook 会议。" % len(meetings))

    def start_field_meeting(self):
        cfg = load_config()
        fixed_url = str(cfg.get("fixed_meeting_url", "") or "").strip()
        fixed_chat = str(cfg.get("fixed_chat_url", "") or "").strip()
        if fixed_url or fixed_chat:
            subject = "固定会议 " + datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
            self.title_var.set(subject)
            self.link_var.set(fixed_url or fixed_chat)
            self._fixed_entry_mode = True
            self.open_workspace()
            self.btn_field.config(state="disabled")
            self.status("正在打开固定 Teams 对话/会议...")
            threading.Thread(target=self._fixed_entry_worker, args=(fixed_chat, fixed_url, subject), daemon=True).start()
            return
        self._fixed_entry_mode = False
        self.open_workspace()
        self.btn_field.config(state="disabled")
        self.status("正在打开 Teams 的现场立即开会入口...")
        threading.Thread(target=self._field_meeting_worker, daemon=True).start()

    def _fixed_entry_worker(self, chat_url, meeting_url, subject):
        try:
            mode = launch_fixed_entry(chat_url, meeting_url)
            if not mode:
                self.jobs.put(lambda: self._field_done(False, "固定 Teams 对话/会议链接无法打开,请在设置中检查链接。"))
                return
            self.jobs.put(lambda: self.status("已打开固定入口,正在查找“立即开会/加入”按钮..."))
            clicked = _try_click_fixed_entry_action(45)
            if not clicked:
                self.jobs.put(lambda: self.status("未自动识别按钮,请手动点击 Teams 对话中的“立即开会/加入”;应用会继续等待..."))
            else:
                self.jobs.put(lambda: self.status("已点击“立即开会/加入”,请手动完成入会;应用会持续等待并自动转录..."))
            ok, detail = _auto_start_transcription(subject=subject, timeout=300)
            self.jobs.put(lambda: self._field_done(ok, detail))
        except Exception as e:
            detail = "固定入口自动化异常: %s" % e
            self.jobs.put(lambda detail=detail: self._field_done(False, detail))

    def _field_meeting_worker(self):
        try:
            subject = "现场会议 " + datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
            self.jobs.put(lambda: self.title_var.set(subject))
            link = launch_meet_now(subject)
            if not link:
                self.jobs.put(lambda: self._field_done(False, "无法打开 Teams。请手动打开 Teams 后点击“立即开会”。"))
                return
            clicked = _try_click_meet_now(30)
            if clicked:
                self.jobs.put(lambda: self.status("已点击 Teams 的“立即开会”。请手动点击“开始会议”,应用会持续等待并自动开启转录..."))
            else:
                self.jobs.put(lambda: self.status("未识别到“立即开会”,请在 Teams 日历中手动点击;应用会持续等待会议进入..."))
            ok, detail = _auto_start_transcription(subject=subject, timeout=300)
            self.jobs.put(lambda: self._field_done(ok, detail))
        except Exception as e:
            detail = "现场会议自动化异常: %s" % e
            self.jobs.put(lambda detail=detail: self._field_done(False, detail))

    def _field_done(self, ok, detail):
        self.btn_field.config(state="normal")
        self.btn_transcribe.config(state="normal")
        self.status(detail)
        if ok:
            self.start_captions()
        elif not ok:
            messagebox.showwarning("现场会议未完全自动化", detail + "\n\n" + MEETING_GUIDE)

    def open_teams(self):
        has_link = bool(self.link_var.get().strip())
        subject = self.title_var.get().strip()
        mode = launch_teams(self.link_var.get().strip(), self.title_var.get().strip())
        if mode == "link":
            self.status("已打开会议链接,正在识别 Teams 的加入按钮...")
        elif mode == "deep_link":
            self.status("已拉起 Teams,正在尝试识别会议按钮...")
        elif mode == "exe":
            self.status("已启动 Teams 客户端,正在尝试识别会议按钮...")
        elif mode == "app_link":
            self.status("已打开 Teams 主界面,正在识别会议按钮...")
        else:
            messagebox.showwarning("提示", "未能自动打开 Teams,请手动打开 Teams 开会。")
            return
        self.btn_teams.config(state="disabled")
        threading.Thread(target=self._auto_meeting_worker, args=(has_link, subject), daemon=True).start()

    def _auto_meeting_worker(self, allow_link_context=False, subject=""):
        try:
            joined = _try_auto_join(allow_link_context=allow_link_context, timeout=45)
            if not joined:
                self.jobs.put(lambda: self.status("未自动识别到加入按钮,请手动点击加入;应用会继续等待会议进入并自动转录..."))
                ok, detail = _auto_start_transcription(subject=subject, timeout=300)
                self.jobs.put(lambda: self._automation_done(ok, detail))
                return
            self.jobs.put(lambda: self.status("已自动点击加入,等待会议工具栏加载..."))
            time.sleep(4)
            ok, detail = _auto_start_transcription(subject=subject, timeout=300)
            self.jobs.put(lambda: self._automation_done(ok, detail))
        except Exception as e:
            detail = "自动化异常: %s" % e
            self.jobs.put(lambda detail=detail: self._automation_done(False, detail))

    def _automation_done(self, ok, detail):
        self.btn_teams.config(state="normal")
        self.btn_transcribe.config(state="normal")
        self.btn_field.config(state="normal")
        self.status(detail)
        if ok:
            self.start_captions()
        elif not ok:
            messagebox.showwarning("自动化未完成", detail + "\n\n" + MEETING_GUIDE)

    def start_transcription(self):
        self.btn_transcribe.config(state="disabled")
        self.status("正在识别 Teams 会议窗口并开始转录...")
        threading.Thread(target=self._transcription_worker, daemon=True).start()

    def _transcription_worker(self):
        try:
            ok, detail = _auto_start_transcription()
            self.jobs.put(lambda: self._automation_done(ok, detail))
        except Exception as e:
            detail = "自动化异常: %s" % e
            self.jobs.put(lambda detail=detail: self._automation_done(False, detail))

    def import_file(self):
        self.open_workspace()
        path = filedialog.askopenfilename(
            title="选择 Teams 转写文件",
            filetypes=[("Teams 转写 / 文本文件", "*.vtt *.txt *.md"), ("所有文件", "*.*")],
        )
        if not path:
            return
        try:
            text, kind = read_transcript_file(path)
        except Exception as e:
            messagebox.showerror("错误", "读取文件失败: %s" % e)
            return
        if not text.strip():
            messagebox.showwarning("提示", "文件内容为空,无法导入。")
            return
        self.transcript_text.delete("1.0", "end")
        self.transcript_text.insert("1.0", text)
        self._on_transcript_change()
        self.status("已导入: %s (%d 字)" % (path, len(text)))

    def paste_text(self):
        win = tk.Toplevel(self)
        win.title("粘贴转写文本")
        win.geometry("600x400")
        win.transient(self)
        txt = tk.Text(win, wrap="word", font=("Microsoft YaHei UI", 10))
        sb = ttk.Scrollbar(win, orient="vertical", command=txt.yview)
        txt.configure(yscrollcommand=sb.set)
        txt.pack(side="left", fill="both", expand=True, padx=(10, 0), pady=(10, 0))
        sb.pack(side="right", fill="y", padx=(0, 10), pady=10)
        bar = ttk.Frame(win)
        bar.pack(fill="x", pady=8)

        def ok():
            text = txt.get("1.0", "end-1c").strip()
            if not text:
                messagebox.showwarning("提示", "内容为空。", parent=win)
                return
            self.transcript_text.delete("1.0", "end")
            self.transcript_text.insert("1.0", text)
            self._on_transcript_change()
            win.destroy()
            self.status("已粘贴转写文本 (%d 字)。" % len(text))

        ttk.Button(bar, text="确定", command=ok).pack(side="right", padx=10)
        ttk.Button(bar, text="取消", command=win.destroy).pack(side="right")

    def clear_all(self):
        self.transcript_text.delete("1.0", "end")
        self.result_text.delete("1.0", "end")
        self._on_transcript_change()
        self.status("已清空。")

    def generate(self):
        transcript = self.transcript_text.get("1.0", "end-1c").strip()
        if not transcript:
            messagebox.showwarning("提示", "请先导入或粘贴会议转写文本(第 2 步)。")
            return
        self.cfg = load_config()
        if not self.cfg.get("api_key"):
            messagebox.showwarning("提示", "请先在“设置”中填写 DeepSeek API Key。")
            return
        self.btn_generate.config(state="disabled")
        self.btn_import.config(state="disabled")
        self.status("正在调用 AI 生成会议纪要(转写较长时可能需要 1-3 分钟,请稍候)...")
        title = self.title_var.get().strip()
        attendees = self.attendees_var.get().strip()
        threading.Thread(target=self._gen_worker, args=(transcript, title, attendees, self.cfg), daemon=True).start()

    def _gen_worker(self, transcript, title, attendees, cfg):
        try:
            md = generate_minutes(title, attendees, transcript, cfg)
            self.jobs.put(lambda: self._gen_done(md))
        except Exception as e:
            detail = str(e)
            self.jobs.put(lambda detail=detail: self._gen_fail(detail))

    def _gen_done(self, md):
        self.btn_generate.config(state="normal")
        self.btn_import.config(state="normal")
        self.result_text.delete("1.0", "end")
        self.result_text.insert("1.0", md)
        self.status("会议纪要已生成,可复制或保存。")

    def _gen_fail(self, err):
        self.btn_generate.config(state="normal")
        self.btn_import.config(state="normal")
        messagebox.showerror("生成失败", err)
        self.status("生成失败。")

    def copy_result(self):
        text = self.result_text.get("1.0", "end-1c").strip()
        if not text:
            messagebox.showwarning("提示", "还没有生成纪要。")
            return
        self.clipboard_clear()
        self.clipboard_append(text)
        self.status("纪要已复制到剪贴板。")

    def save_result(self):
        text = self.result_text.get("1.0", "end-1c").strip()
        if not text:
            messagebox.showwarning("提示", "还没有生成纪要。")
            return
        title = self.title_var.get().strip() or "未命名"
        safe = re.sub(r'[\\/:*?"<>|]', "_", title)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        initial = os.path.join(self.cfg.get("save_dir") or DEFAULT_SAVE_DIR, "%s_%s.md" % (ts, safe))
        path = filedialog.asksaveasfilename(
            title="保存会议纪要",
            defaultextension=".md",
            initialfile=os.path.basename(initial),
            initialdir=os.path.dirname(initial),
            filetypes=[("Markdown 文件", "*.md"), ("文本文件", "*.txt")],
        )
        if not path:
            return
        try:
            header = "# 会议纪要\n\n- 会议标题:%s\n- 参会人:%s\n- 生成时间:%s\n\n---\n\n" % (
                title, self.attendees_var.get().strip() or "——",
                datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
            )
            with open(path, "w", encoding="utf-8") as f:
                f.write(header + text)
            self.cfg["save_dir"] = os.path.dirname(path)
            save_config(self.cfg)
            self.status("已保存: %s" % path)
        except Exception as e:
            messagebox.showerror("错误", "保存失败: %s" % e)

    def open_save_dir(self):
        d = self.cfg.get("save_dir") or DEFAULT_SAVE_DIR
        os.makedirs(d, exist_ok=True)
        os.startfile(d)

    # ---------- 设置 ----------
    def open_settings(self):
        cfg = load_config()
        win = tk.Toplevel(self)
        win.title("设置")
        win.geometry("760x580")
        win.minsize(660, 500)
        win.transient(self)
        win.grab_set()

        frame = ttk.Frame(win, padding=14)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="DeepSeek API Key:").grid(row=0, column=0, sticky="e", pady=4)
        e_key = ttk.Entry(frame, show="*", width=46)
        e_key.grid(row=0, column=1, sticky="ew", pady=4)
        e_key.insert(0, cfg.get("api_key", ""))

        ttk.Label(frame, text="模型:").grid(row=1, column=0, sticky="e", pady=4)
        e_model = ttk.Entry(frame, width=46)
        e_model.grid(row=1, column=1, sticky="ew", pady=4)
        e_model.insert(0, cfg.get("model", "deepseek-chat"))

        ttk.Label(frame, text="接口地址:").grid(row=2, column=0, sticky="e", pady=4)
        e_url = ttk.Entry(frame, width=46)
        e_url.grid(row=2, column=1, sticky="ew", pady=4)
        e_url.insert(0, cfg.get("base_url", "https://api.deepseek.com/v1"))

        ttk.Label(frame, text="温度:").grid(row=3, column=0, sticky="e", pady=4)
        e_temp = ttk.Spinbox(frame, from_=0.0, to=1.0, increment=0.1, width=10)
        e_temp.grid(row=3, column=1, sticky="w", pady=4)
        e_temp.insert(0, str(cfg.get("temperature", 0.3)))

        ttk.Label(frame, text="固定 Teams 会议链接:").grid(row=4, column=0, sticky="e", pady=4)
        e_fixed = ttk.Entry(frame, width=60)
        e_fixed.grid(row=4, column=1, sticky="ew", pady=4)
        e_fixed.insert(0, cfg.get("fixed_meeting_url", ""))

        ttk.Label(frame, text="固定 Teams 对话链接:").grid(row=5, column=0, sticky="e", pady=4)
        e_chat = ttk.Entry(frame, width=60)
        e_chat.grid(row=5, column=1, sticky="ew", pady=4)
        e_chat.insert(0, cfg.get("fixed_chat_url", ""))

        ttk.Label(frame, text="固定纪要规则:").grid(row=6, column=0, sticky="ne", pady=4)
        prompt_text = tk.Text(frame, height=5, wrap="word", font=(FONT_NAME, 10), bg="#F8FAFC", fg=COLORS["text"], relief="flat", highlightthickness=1, highlightbackground=COLORS["border"])
        prompt_text.grid(row=6, column=1, sticky="nsew", pady=4)
        prompt_text.insert("1.0", cfg.get("meeting_prompt", ""))
        ttk.Label(frame, text="例如:重点提取决定、行动项、负责人、截止日期;不确定内容标记为待确认。", foreground=COLORS["muted"]).grid(row=7, column=1, sticky="w", pady=(0, 4))

        bar = ttk.Frame(frame)
        bar.grid(row=8, column=0, columnspan=2, sticky="e", pady=(12, 0))
        frame.columnconfigure(1, weight=1)
        frame.rowconfigure(6, weight=1)

        def link_key():
            webbrowser.open("https://platform.deepseek.com")

        def test_key():
            api_key = e_key.get().strip()
            base_url = e_url.get().strip()
            model = e_model.get().strip()
            if not api_key:
                messagebox.showwarning("提示", "请先填写 API Key。", parent=win)
                return
            try:
                reply = call_deepseek(
                    {"api_key": api_key, "model": model, "base_url": base_url, "temperature": 0.0},
                    "你是一个连通性测试助手。", "请只回复两个字:正常",
                )
                messagebox.showinfo("测试成功", "接口连接正常,模型回复:%s" % reply.strip()[:100], parent=win)
            except Exception as e:
                messagebox.showerror("测试失败", str(e), parent=win)

        ttk.Button(bar, text="申请 API Key", command=link_key).pack(side="left", padx=(0, 8))
        ttk.Button(bar, text="测试连接", command=test_key).pack(side="left", padx=(0, 8))

        def ok():
            cfg["api_key"] = e_key.get().strip()
            cfg["model"] = e_model.get().strip() or "deepseek-chat"
            cfg["base_url"] = e_url.get().strip() or "https://api.deepseek.com/v1"
            try:
                cfg["temperature"] = float(e_temp.get())
            except Exception:
                pass
            cfg["fixed_meeting_url"] = e_fixed.get().strip()
            cfg["fixed_chat_url"] = e_chat.get().strip()
            cfg["meeting_prompt"] = prompt_text.get("1.0", "end-1c").strip()
            save_config(cfg)
            self.cfg = cfg
            win.destroy()
            self.status("设置已保存。")

        ttk.Button(bar, text="保存", command=ok).pack(side="right")
        ttk.Button(bar, text="取消", command=win.destroy).pack(side="right", padx=(0, 8))

    # ---------- 帮助 ----------
    def show_help(self):
        messagebox.showinfo(
            APP_NAME + " - 使用说明",
            "三步完成会议纪要:\n\n"
            "1. 自动打开 Teams 并开始转录\n"
            "   填好会议标题后点\"自动开会并开始转录\"(或粘贴常开的会议链接);\n"
            "   工具会识别 Teams 按钮并点击,识别失败时自动发送 Ctrl+Shift+U。\n"
            "   如果已经在会议中,可直接点\"仅自动开始转录\"。\n\n"
            "2. 会议结束后导入转写\n"
            "   在 Teams 聊天中打开 \"录制和转录\",点 \"下载\",保存 .vtt 文件;\n"
            "   然后点本应用 \"导入转写文件\" 选择该文件(或直接粘贴文字)。\n\n"
            "3. AI 生成纪要\n"
            "   点 \"AI 生成纪要\",等待 1-3 分钟,即可复制或保存为 Markdown。\n\n"
            "首次使用请先在 \"设置\" 中填写 DeepSeek API Key\n"
            "(申请地址: https://platform.deepseek.com ,点击 \"申请 API Key\")。\n"
            "所有数据仅发送给 DeepSeek 用于生成纪要,其余全部保存在本地。",
        )


if __name__ == "__main__":
    app = App()
    app.mainloop()
