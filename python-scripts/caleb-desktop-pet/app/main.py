from __future__ import annotations

import ctypes
import json
import math
import os
import random
import threading
import sys
import time
import textwrap
import tkinter as tk
from tkinter import simpledialog
from tkinter import font as tkfont
from ctypes import wintypes
from datetime import date, datetime
from pathlib import Path

from PIL import Image, ImageTk
from alpha_window import AlphaWindow
from dialogue import DialogueBook
from desktop_world import DesktopWorld
from weather import Weather
from scenes import SCENES
from calm_motion import CalmMotion

try:
    from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
    from comtypes import CLSCTX_ALL, CoInitialize, CoUninitialize, cast
    from comtypes import POINTER
except Exception:  # microphone support is optional on machines without an audio endpoint
    AudioUtilities = None

try:
    import pystray
except Exception:  # the pet still works when tray integration is unavailable
    pystray = None


APP_NAME = "Caleb Desktop Pet"
CELL_W, CELL_H = 192, 208
# Use a key color absent from the character palette. It is only the Tk window
# transparency color; the sprite source itself is already RGBA and lossless.
CHROMA_KEY = "#00FF00"
BUBBLE_KEY = "#17131C"
# 气泡的默认存活时间。鼠标停在气泡上时不倒计时，方便看清长回复。
BUBBLE_MS = 7000
AI_BUBBLE_TITLE = "夏以昼"
# 回答要读，所以比普通气泡活得久；鼠标停在上面会暂停倒计时，点一下就收起。
AI_BUBBLE_MS = 15000
AI_BUBBLE_MAX_LINES = 14
SPRITE_ASSET = "spritesheet.png"
FRAME_MS = {
    # Six source poses; CalmMotion owns the varied runtime idle timing.
    "idle": [4180, 110, 110, 140, 140, 320],
    "running-right": [120] * 7 + [220],
    "running-left": [120] * 7 + [220],
    "waving": [140, 140, 140, 280],
    "jumping": [140, 140, 140, 140, 280],
    "failed": [140] * 7 + [240],
    "waiting": [150] * 5 + [260],
    "running": [120] * 5 + [220],
    "review": [150] * 5 + [280],
}
ROW_FOR_STATE = {
    "idle": 0,
    "running-right": 1,
    "running-left": 2,
    "waving": 3,
    "jumping": 4,
    "failed": 5,
    "waiting": 6,
    "running": 7,
    "review": 8,
}
ONE_SHOT = {"waving", "jumping", "failed"}
TRANSIENT_STATES = ONE_SHOT | {"running-right", "running-left"}
AUTO_ACTION_GAP_SECONDS = 4.0
AUTO_SAME_ACTION_GAP_SECONDS = 12.0
AUTO_WAVE_GAP_SECONDS = 18.0
AUTO_MOUSE_MOVE_THRESHOLD = 18
REMINDER_INTERVALS = {"water": 45 * 60, "break": 60 * 60}
REMINDER_CROSS_GAP = 20 * 60
REMINDER_COPY = {
    "water": {
        "title": "小小补水提醒",
        "text": "忙了一会儿啦，要不要喝几口水？我会安静等你回来。",
    },
    "break": {
        "title": "给眼睛放个假",
        "text": "你已经专注很久了。我们一起离开屏幕一会儿，好吗？",
    },
}
CHAT_COPY = [
    ("我在这里", "今天也慢慢来就好，我会安静陪着你。"),
    ("小声说", "如果有点累了，可以把肩膀放松一点。"),
    ("给你打气", "一步一步来，你已经做得很好了。"),
    ("我有听到", "敲键盘的声音很认真，但记得别把肩膀缩起来。"),
    ("悄悄夸你", "刚刚那一步处理得很稳，给你一颗小小的星星。"),
    ("需要帮忙吗", "如果卡住了，就先深呼吸，再从最小的一步开始。"),
    ("陪你发呆", "不用急着回答，我陪你安静几秒也可以。"),
    ("再靠近一点", "今天的目标不用一次完成，我们把下一步做好就好。"),
]
RPS_CHOICES = ("石头", "剪刀", "布")
RPS_BEATS = {"石头": "剪刀", "剪刀": "布", "布": "石头"}
IDLE_CHAT_MIN_SECONDS = 150
IDLE_CHAT_MAX_SECONDS = 300
QUIET_MODE_SECONDS = 60 * 60


def resource_path(*parts: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return base.joinpath(*parts)


def profile_path() -> Path:
    app_data = os.environ.get("APPDATA")
    base = Path(app_data) if app_data else Path.home() / "AppData" / "Roaming"
    return base / "CalebDesktopPet" / "profile.json"


class SYSTEMTIME(ctypes.Structure):
    _fields_ = [
        ("wYear", wintypes.WORD), ("wMonth", wintypes.WORD),
        ("wDayOfWeek", wintypes.WORD), ("wDay", wintypes.WORD),
        ("wHour", wintypes.WORD), ("wMinute", wintypes.WORD),
        ("wSecond", wintypes.WORD), ("wMilliseconds", wintypes.WORD),
    ]


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def cursor_position() -> tuple[int, int]:
    point = wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
    return int(point.x), int(point.y)


def last_input_tick() -> int:
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return int(info.dwTime)
    return 0


class LoadSampler:
    def __init__(self) -> None:
        self.previous_idle = 0
        self.previous_kernel = 0
        self.previous_user = 0
        self.cpu = 0.0
        self.memory = 0.0

    def sample(self) -> tuple[float, float]:
        idle = ctypes.c_ulonglong()
        kernel = ctypes.c_ulonglong()
        user = ctypes.c_ulonglong()
        ok = ctypes.windll.kernel32.GetSystemTimes(
            ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)
        )
        if ok and self.previous_kernel:
            idle_delta = idle.value - self.previous_idle
            total_delta = (kernel.value - self.previous_kernel) + (user.value - self.previous_user)
            self.cpu = max(0.0, min(100.0, 100.0 * (1.0 - idle_delta / max(1, total_delta))))
        self.previous_idle, self.previous_kernel, self.previous_user = idle.value, kernel.value, user.value

        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            self.memory = float(status.dwMemoryLoad)
        return self.cpu, self.memory


class MicSampler:
    def __init__(self) -> None:
        self.enabled = True
        self.available = False
        self.level = 0.0
        self._volume = None
        self._initialized = False

    def _connect(self) -> None:
        if not AudioUtilities or self._initialized:
            return
        self._initialized = True
        try:
            CoInitialize()
            devices = AudioUtilities.GetAllDevices()
            capture = next(
                (
                    d for d in devices
                    if "microphone" in str(getattr(d, "FriendlyName", "")).lower()
                    or "mic" in str(getattr(d, "FriendlyName", "")).lower()
                ),
                None,
            )
            if capture is None:
                return
            interface = capture._dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
            self._volume = cast(interface, POINTER(IAudioEndpointVolume))
            self.available = True
        except Exception:
            self._volume = None
            self.available = False

    def sample(self) -> float:
        if not self.enabled:
            self.level = 0.0
            return self.level
        self._connect()
        try:
            self.level = float(self._volume.GetMasterPeakValue()) if self._volume else 0.0
        except Exception:
            self.level = 0.0
        return self.level

    def close(self) -> None:
        if self._initialized:
            try:
                CoUninitialize()
            except Exception:
                pass


class CalebPet:
    def __init__(self, root: tk.Tk, welcome: bool = True) -> None:
        self.root = root
        self.root.title(APP_NAME)
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=CHROMA_KEY)
        self.root.resizable(False, False)

        # Use the complete, original-derived atlas as-is. The old heuristic
        # orange removal also matched legitimate brown hair and clothing
        # pixels, which created holes in some animation frames.
        self.sheet = Image.open(resource_path("assets", SPRITE_ASSET)).convert("RGBA")
        self.frames: dict[str, list[Image.Image]] = {}
        self.look_frames: list[Image.Image] = []
        self._slice_frames()

        self.label = tk.Label(self.root, bg=CHROMA_KEY, bd=0, highlightthickness=0, width=CELL_W, height=CELL_H)
        self.label.place(x=0, y=0, width=CELL_W, height=CELL_H)
        self.label.bind("<ButtonPress-1>", self._drag_start)
        self.label.bind("<B1-Motion>", self._drag_move)
        self.label.bind("<ButtonRelease-1>", self._drag_end)
        self.label.bind("<Button-3>", self._show_menu)
        # Recognize complete click pairs ourselves on release. Tk's double-
        # press event can race dragging and the delayed single-click callback.
        # Esc 只负责收窗口，不再退出程序：原来它直接退掉整只宠物，用户按 Esc 关
        # “聊聊”输入框时会把宠物也一起关掉。退出统一走托盘菜单。
        self.root.bind("<Escape>", self._escape)

        self.menu = tk.Menu(self.root, tearoff=0)
        demo_menu = tk.Menu(self.menu, tearoff=0)
        for state, label in [
            ("idle", "Idle / 待机"), ("running", "Running / 工作中"),
            ("running-right", "向右移动"), ("running-left", "向左移动"),
            ("waving", "挥手"), ("jumping", "跳跃"), ("failed", "失败反应"),
            ("waiting", "等待确认"), ("review", "审阅中"),
        ]:
            demo_menu.add_command(label=label, command=lambda s=state: self.demo(s))
        self.menu.add_cascade(label="演示动画", menu=demo_menu)
        self.menu.add_separator()
        self.auto_var = tk.BooleanVar(value=True)
        self.mic_var = tk.BooleanVar(value=True)
        self.menu.add_checkbutton(label="自动键鼠互动", variable=self.auto_var)
        self.menu.add_checkbutton(label="麦克风互动", variable=self.mic_var, command=self._sync_mic)
        self.follow_var = tk.BooleanVar(value=False)
        self.menu.add_checkbutton(label="可选：跟随鼠标", variable=self.follow_var, command=self._sync_follow)
        self.menu.add_separator()
        self.menu.add_command(label="演示喝水提醒", command=lambda: self.show_reminder("water", force=True))
        self.menu.add_command(label="演示休息提醒", command=lambda: self.show_reminder("break", force=True))
        self.menu.add_command(label="和我聊一句", command=self.show_chat)
        self.menu.add_command(label="摸摸我 / 陪伴状态", command=self.show_status)
        self.menu.add_command(label="猜拳小游戏", command=self.show_rps)
        self.menu.add_command(label="安静模式 1 小时", command=self.toggle_quiet_mode)
        focus_menu = tk.Menu(self.menu, tearoff=0)
        for minutes in (25, 45, 60):
            focus_menu.add_command(label=f"开始 {minutes} 分钟", command=lambda m=minutes: self.start_focus(m))
        focus_menu.add_command(label="结束专注", command=self.end_focus)
        self.menu.add_cascade(label="专注计时", menu=focus_menu)
        self.menu.add_separator()
        self.menu.add_command(label="隐藏 10 秒", command=self.hide_temporarily)
        self.menu.add_command(label="退出", command=self.quit)

        self.mic_sampler = MicSampler()
        self.paused = False
        self.state: str | None = "waving"
        self.frame = 0
        self.frame_started = time.monotonic()
        self.manual_until = 0.0
        self.last_cursor = cursor_position()
        self.last_input_tick = last_input_tick()
        self.last_input_event = time.monotonic()
        self.last_input_reaction = 0.0
        self.last_auto_action: str | None = None
        self.last_auto_action_at = 0.0
        self.auto_action_cooldown_until = 0.0
        self.work_session_started = time.monotonic()
        self.next_water_at = self.work_session_started + REMINDER_INTERVALS["water"]
        self.next_break_at = self.work_session_started + REMINDER_INTERVALS["break"]
        self.last_reminder_kind = None
        self.last_reminder_at = 0.0
        self.menu_timer_id = None
        self.menu_dismiss_id = None
        self.drag_origin: tuple[int, int, int, int] | None = None
        self.click_timer_id = None
        self.pending_click = None
        self.last_double_response = None
        self.drag_moved = False
        self.suppress_click_release = False
        self.last_sound_reaction = 0.0
        self.follow_mouse = False
        self.focus_until: float | None = None
        self.focus_minutes = 0
        self.profile = self._load_profile()
        saved_name = self.profile.get('nickname', '')
        self.nickname = ' '.join(saved_name.split())[:20] if isinstance(saved_name, str) else ''
        self.greeting_seen = bool(self.profile.get('greeting_seen', False)) or bool(self.nickname)
        self.greeting_timer_id = None
        self.affection = min(100, self._profile_int(self.profile.get("affection", 0)))
        self.total_interactions = self._profile_int(self.profile.get("total_interactions", 0))
        self.daily_interactions = self._profile_int(self.profile.get("daily_interactions", 0))
        self.profile_date = str(self.profile.get("date", date.today().isoformat()))
        self.quiet_until = 0.0
        self.last_pet_at = 0.0
        self.next_idle_chat_at = time.monotonic() + random.uniform(IDLE_CHAT_MIN_SECONDS, IDLE_CHAT_MAX_SECONDS)
        self.bubble: tk.Toplevel | None = None
        self.bubble_canvas: tk.Canvas | None = None
        self.bubble_button_targets: list[tuple[int, int, int, int, object]] = []
        self.bubble_title_font = None
        self.bubble_body_font = None
        self.ai_bubble = False
        # Plain attribute on purpose: the tray menu label is evaluated on the
        # tray thread, where touching Tk would be unsafe.
        self.pet_hidden = False
        self.menu_window: tk.Toplevel | None = None
        self.reminder_kind: str | None = None
        self.tray_icon = None
        self.after_id: str | None = None
        self.bubble_timeout_id = None
        self.bubble_lifetime_ms = BUBBLE_MS
        self.bubble_hovered = False
        self.thinking = False
        self.hotkey_capturing = False
        self.bubble_rewarded = False
        self.dialogue = DialogueBook()
        self.world = DesktopWorld()
        self.load_sampler = LoadSampler()
        self.next_world_at = 0.0
        self.next_load_at = 0.0
        self.cpu_high_since = None
        self.cpu_busy = False
        self.fullscreen = False
        self.work_area = None
        self.window_edge = None
        self.walk_target = None
        self.edge_motion = None
        self.walk_enabled = bool(self.profile.get('walk_enabled', True))
        self.edge_enabled = True
        self.walk_last_tick = time.monotonic()
        self.next_walk_at = time.monotonic() + random.uniform(45, 90)
        self.next_gaze_at = time.monotonic() + random.uniform(15, 30)
        self.gaze_until = 0.0
        self.calm_motion = CalmMotion()
        self.next_pose_at = time.monotonic() + random.uniform(35, 65)
        self.last_pose = None
        self.pending_return = False
        self.weather = Weather()
        self.weather_city = ''
        self.weather_text = None
        self.weather_pending = False
        self.scene_name = None
        self.scene_index = 0
        self.next_weather_at = 0.0
        self.next_idle_chat_at = time.monotonic() + random.uniform(240, 420)
        self._place_bottom_right()
        self.alpha_window = AlphaWindow(self.root)
        self._start_tray_icon()
        self._tick()
        if welcome and not self.greeting_seen:
            self.greeting_timer_id = self.root.after(800, self._first_run_greeting)

    def _slice_frames(self) -> None:
        for state, row in ROW_FOR_STATE.items():
            count = len(FRAME_MS[state])
            self.frames[state] = [
                self.sheet.crop((col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H))
                for col in range(count)
            ]
        for index in range(16):
            row, col = (9, index) if index < 8 else (10, index - 8)
            self.look_frames.append(self.sheet.crop((col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H)))
        # Supplementary rows are separate assets; never change the v2 atlas.
        for state in ('climb', 'lean'):
            path = resource_path('assets', state + '.png')
            if path.exists():
                with Image.open(path) as source:
                    if source.size != (CELL_W * 4, CELL_H) or source.mode != 'RGBA':
                        raise ValueError(f'Invalid supplemental animation: {path}')
                    self.frames[state] = [source.crop((i * CELL_W, 0, (i + 1) * CELL_W, CELL_H)) for i in range(4)]
                FRAME_MS[state] = [220] * 4 if state == 'climb' else [650] * 4

    def _load_profile(self) -> dict[str, object]:
        try:
            value = json.loads(profile_path().read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError, TypeError):
            return {}

    @staticmethod
    def _profile_int(value: object, default: int = 0) -> int:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return default

    def _sync_daily_profile(self) -> None:
        today = date.today().isoformat()
        if self.profile_date != today:
            self.profile_date = today
            self.daily_interactions = 0

    def _save_profile(self) -> bool:
        self._sync_daily_profile()
        payload = {
            "date": self.profile_date,
            "affection": self.affection,
            "total_interactions": self.total_interactions,
            "daily_interactions": self.daily_interactions,
            "walk_enabled": self.walk_enabled,
            "nickname": self.nickname,
            "greeting_seen": self.greeting_seen,
        }
        try:
            target = profile_path()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            return True
        except OSError:
            # The pet remains fully usable when profile persistence is blocked.
            return False

    def _first_run_greeting(self) -> None:
        self.greeting_timer_id = None
        if self.greeting_seen:
            return
        if self.bubble or self.menu_window or self.fullscreen or self.root.state() == 'withdrawn':
            self.greeting_timer_id = self.root.after(5000, self._first_run_greeting)
            return
        self.greeting_seen = True
        self._save_profile()
        self.demo('waving', seconds=1.2)
        self._open_bubble('初次见面，你好', '你好，我是夏以昼。以后就在这里陪着你了。\n我可以怎么称呼你？',
                          [('告诉你', self.edit_nickname), ('稍后再说', self._close_bubble)])

    def edit_nickname(self) -> None:
        self._close_bubble()
        value = simpledialog.askstring('我可以怎么称呼你？', '告诉我一个你喜欢的称呼吧（1–20字）。\n不必使用真实姓名，只会保存在这台电脑。',
                                       parent=self.root, initialvalue=self.nickname)
        if value is None:
            return
        value = ' '.join(value.split())
        if not value or len(value) > 20:
            self.show_message('换个短一点的称呼吧', '请输入1–20字的称呼，原来的称呼没有改变。')
            return
        self.nickname = value
        self.greeting_seen = True
        if self._save_profile():
            self.show_message('记住啦', f'{self.nickname}，以后就这样叫你。想换称呼，随时到托盘配置里告诉我。')
        else:
            self.show_message('先这样叫你', f'{self.nickname}，这次我记住了。不过本机保存失败，下次启动可能需要再告诉我。')

    def _addressed(self, text: str) -> str:
        return f'{self.nickname}，{text}' if self.nickname else text

    def _record_interaction(self, affection_gain: int = 1) -> None:
        self._sync_daily_profile()
        self.affection = min(100, max(0, self.affection + affection_gain))
        self.total_interactions += 1
        self.daily_interactions += 1
        self._save_profile()

    def _mood_text(self) -> str:
        now = time.monotonic()
        if self.focus_until is not None:
            return "正在陪你专注"
        if self.quiet_until > now:
            return "安静陪伴中"
        if now - self.last_input_event > 5 * 60:
            return "在安静等你回来"
        if self.affection >= 70:
            return "心情很好"
        return "心情平静"

    def _place_bottom_right(self) -> None:
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(f"{CELL_W}x{CELL_H}+{max(0, sw - CELL_W - 36)}+{max(0, sh - CELL_H - 56)}")

    def _show_menu(self, event: tk.Event) -> None:
        self._show_action_panel(event.x_root, event.y_root)

    @staticmethod
    def _draw_round_box(
        canvas: tk.Canvas,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        fill: str,
        outline: str,
        radius: int = 18,
    ) -> None:
        radius = max(4, min(radius, (x2 - x1) // 2, (y2 - y1) // 2))
        # The old implementation gave both helper rectangles an outline;
        # those outlines crossed the corner arcs and recreated square corners.
        # Fill the body first, then draw only the four arcs and straight edge
        # segments that belong to the rounded outline.
        canvas.create_rectangle(x1 + radius, y1, x2 - radius, y2, fill=fill, outline="")
        canvas.create_rectangle(x1, y1 + radius, x2, y2 - radius, fill=fill, outline="")
        corners = (
            (90, (x1, y1, x1 + radius * 2, y1 + radius * 2)),
            (0, (x2 - radius * 2, y1, x2, y1 + radius * 2)),
            (180, (x1, y2 - radius * 2, x1 + radius * 2, y2)),
            (270, (x2 - radius * 2, y2 - radius * 2, x2, y2)),
        )
        for start, box in corners:
            canvas.create_arc(*box, start=start, extent=90, style="pieslice", fill=fill, outline="")
            canvas.create_arc(*box, start=start, extent=90, style="arc", outline=outline)
        canvas.create_line(x1 + radius, y1, x2 - radius, y1, fill=outline)
        canvas.create_line(x1 + radius, y2, x2 - radius, y2, fill=outline)
        canvas.create_line(x1, y1 + radius, x1, y2 - radius, fill=outline)
        canvas.create_line(x2, y1 + radius, x2, y2 - radius, fill=outline)

    @staticmethod
    def _draw_round_rect(canvas: tk.Canvas, width: int, height: int, fill: str, outline: str) -> None:
        CalebPet._draw_round_box(canvas, 2, 2, width - 2, height - 2, fill, outline)

    def _close_action_panel(self) -> None:
        if self.menu_dismiss_id:
            self.root.after_cancel(self.menu_dismiss_id)
            self.menu_dismiss_id = None
        if self.menu_timer_id:
            self.root.after_cancel(self.menu_timer_id)
            self.menu_timer_id = None
        if self.menu_window and self.menu_window.winfo_exists():
            self.menu_window.destroy()
        self.menu_window = None

    def _show_action_panel(self, x: int, y: int, configuration: bool = False) -> None:
        self._close_action_panel()
        panel_key = BUBBLE_KEY
        panel_fill = "#FFF9F1"
        panel_edge = "#D9B39C"
        window = tk.Toplevel(self.root)
        self.menu_window = window
        window.overrideredirect(True)
        window.attributes("-topmost", True)
        window.withdraw()
        window.attributes("-transparentcolor", panel_key)
        window.configure(bg=panel_key)
        window.bind("<Escape>", lambda _e: self._close_action_panel())
        window.protocol("WM_DELETE_WINDOW", self._close_action_panel)
        body = tk.Frame(window, bg=panel_fill, padx=12, pady=10)
        tk.Label(body, text="陪伴配置" if configuration else "和夏以昼互动", bg=panel_fill, fg="#6D4E43", font=("Segoe UI", 11, "bold")).pack(anchor="w")
        tk.Label(body, text="按你的习惯，轻轻调整。" if configuration else "想做什么？轻轻点一下。", bg=panel_fill, fg="#8A746B", font=("Segoe UI", 8)).pack(anchor="w", pady=(2, 8))
        actions = tk.Frame(body, bg=panel_fill)
        actions.pack(fill="x")

        def action(callback):
            self._close_action_panel()
            callback()

        demo_buttons = [] if configuration else [
            ("随机动作", self.random_action),
            ("结束专注" if self.focus_until is not None else "专注 25 分钟", self.end_focus if self.focus_until is not None else lambda: self.start_focus(25)),
            ("猜拳", self.show_rps),
            ("小剧场", self.start_scene),
            ("聊聊", self.open_ai_chat),
            ("显示夏以昼" if self.pet_hidden else "隐藏夏以昼", self.toggle_pet_visibility),
        ]
        for index, (label, callback) in enumerate(demo_buttons):
            button = tk.Button(actions, text=label, command=lambda cb=callback: action(cb), bg="#F4E7DE", fg="#624940", activebackground="#E6CDBD", relief="flat", padx=7, pady=4, cursor="hand2", font=("Segoe UI", 8))
            if index == 0:
                button.grid(row=0, column=0, columnspan=2, sticky="ew", padx=2, pady=(2, 7))
            else:
                button.grid(row=1 + (index - 1) // 2, column=(index - 1) % 2, sticky="ew", padx=2, pady=2)
        actions.grid_columnconfigure(0, weight=1)
        actions.grid_columnconfigure(1, weight=1)

        tools = tk.Frame(body, bg=panel_fill)
        tools.pack(fill="x", pady=(7, 0))

        def add_group(title, buttons, columns=2):
            """把按钮按用途分组：开关是开关，演示是演示，一眼能扫出来。"""
            tk.Label(tools, text=title, bg=panel_fill, fg="#B08968",
                     font=("Segoe UI", 7, "bold")).pack(anchor="w", pady=(8, 1))
            grid = tk.Frame(tools, bg=panel_fill)
            grid.pack(fill="x")
            for index, (label, callback) in enumerate(buttons):
                button = tk.Button(grid, text=label, command=lambda cb=callback: action(cb),
                                   bg="#FBF1E9", fg="#78645C", activebackground="#EBD7C8",
                                   relief="flat", padx=7, pady=3, cursor="hand2", font=("Segoe UI", 8))
                button.grid(row=index // columns, column=index % columns, sticky="ew", padx=2, pady=2)
            for column in range(columns):
                grid.grid_columnconfigure(column, weight=1)

        if configuration:
            add_group("AI 与快捷键", [
                ("AI 设置", lambda: self._ai().configure()),
                (self._hotkey_label(), self.toggle_ai_hotkey),
                ("添加触发键", self._capture_hotkey),
                ("修改称呼", self.edit_nickname),
            ])
            add_group("提醒与状态", [
                ("安静 1 小时", self.toggle_quiet_mode),
                ("陪伴状态", self.show_status),
                ("测试喝水提醒", lambda: self.show_reminder("water", force=True)),
                ("测试休息提醒", lambda: self.show_reminder("break", force=True)),
                ("天气城市 / 关闭", self.configure_weather),
            ])
            add_group("动作与巡游", [
                (f"键鼠互动：{'开' if self.auto_var.get() else '关'}", self._toggle_auto_input),
                (f"麦克风：{'开' if self.mic_var.get() else '关'}", self._toggle_mic),
                (f"巡游：{'开' if self.walk_enabled else '关'}", self._toggle_walk),
                ("沿窗体上沿走走", self.walk_window_edge),
                ("沿边攀爬" if 'climb' in self.frames else "攀爬（制作中）", lambda: self.start_edge_action('climb')),
                ("靠边歇一会", lambda: self.start_edge_action('lean')),
                ("隐藏 10 秒", self.hide_temporarily),
            ])
            add_group("其他", [
                ("返回互动", lambda: self._show_action_panel(x, y)),
            ])
        countdown = tk.Label(body, bg=panel_fill, fg='#8A746B', font=('Segoe UI', 8))
        countdown.pack(fill='x', pady=(7, 0))

        def refresh_countdown():
            if self.menu_window is not window or not window.winfo_exists():
                return
            now = time.monotonic()
            countdown.configure(text=f"喝水 {self._reminder_countdown('water', now)}  ·  休息 {self._reminder_countdown('break', now)}")
            self.menu_timer_id = self.root.after(1000, refresh_countdown)

        refresh_countdown()
        body.update_idletasks()
        width = max(250, body.winfo_reqwidth() + 20)
        height = body.winfo_reqheight() + 20
        canvas = tk.Canvas(window, width=width, height=height, bg=panel_key, highlightthickness=0)
        canvas.pack()
        self._draw_round_rect(canvas, width, height, panel_fill, panel_edge)
        body.lift()
        body.place(x=10, y=10, width=width - 20, height=height - 20)
        # Use the actual pointer position after the panel has been measured.
        # This avoids Tk returning a stale event origin and placing the panel
        # at the fallback corner (8, 8), especially with transparent windows.
        try:
            pointer_x, pointer_y = cursor_position()
            get_metrics = ctypes.windll.user32.GetSystemMetrics
            screen_left = int(get_metrics(76))
            screen_top = int(get_metrics(77))
            screen_width = int(get_metrics(78))
            screen_height = int(get_metrics(79))
            if screen_width <= 0 or screen_height <= 0:
                raise RuntimeError("invalid virtual screen metrics")
        except (RuntimeError, OSError, AttributeError):
            pointer_x, pointer_y = x, y
            screen_left, screen_top = 0, 0
            screen_width, screen_height = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        screen_right = screen_left + screen_width
        screen_bottom = screen_top + screen_height
        try:
            pointer_work, _, _ = self.world.observe(pointer_x, pointer_y)
            screen_left, screen_top = pointer_work.left, pointer_work.top
            screen_right, screen_bottom = pointer_work.right, pointer_work.bottom
        except OSError:
            pass
        px = pointer_x + 12
        py = pointer_y + 12
        if px + width > screen_right - 8:
            px = pointer_x - width - 12
        if py + height > screen_bottom - 8:
            py = pointer_y - height - 12
        px = max(screen_left + 8, min(px, screen_right - width - 8))
        py = max(screen_top + 8, min(py, screen_bottom - height - 8))
        window.geometry(f"{width}x{height}+{px}+{py}")
        window.deiconify()
        window.focus_force()
        self._watch_menu_dismiss(window)

    def _watch_menu_dismiss(self, window) -> None:
        # Read button states only; no global hook, input capture, or suppression.
        get_key = ctypes.windll.user32.GetAsyncKeyState
        buttons = (1, 2, 4)
        previous = {key: bool(get_key(key) & 0x8000) for key in buttons}

        def poll():
            self.menu_dismiss_id = None
            if self.menu_window is not window or not window.winfo_exists():
                return
            pressed = False
            for key in buttons:
                state = get_key(key)
                down = bool(state & 0x8000)
                # Do not use the low-order "has been pressed" bit here. It
                # can still belong to the right-click that opened this panel
                # and would immediately dismiss a correctly placed menu.
                # The high-order transition is enough at the 25 ms polling
                # interval and avoids a timing-dependent first-open failure.
                pressed |= down and not previous[key]
                previous[key] = down
            if pressed:
                x, y = cursor_position()
                left, top = window.winfo_rootx(), window.winfo_rooty()
                if not (left <= x < left + window.winfo_width() and top <= y < top + window.winfo_height()):
                    self._close_action_panel()
                    return
            self.menu_dismiss_id = self.root.after(25, poll)

        self.menu_dismiss_id = self.root.after(25, poll)

    def random_action(self) -> None:
        choices = [s for s in ('waving', 'jumping', 'waiting', 'review', 'running')
                   if s != getattr(self, 'last_random_action', None)]
        self.last_random_action = random.choice(choices)
        self.demo(self.last_random_action, seconds=2.4)

    def _toggle_auto_input(self) -> None:
        self.auto_var.set(not self.auto_var.get())

    def _toggle_mic(self) -> None:
        self.mic_var.set(not self.mic_var.get())
        self._sync_mic()

    def _toggle_follow(self) -> None:
        self.follow_var.set(not self.follow_var.get())
        self._sync_follow()

    def _drag_start(self, event: tk.Event) -> None:
        self.drag_moved = False
        self.suppress_click_release = False
        self.edge_motion = None
        self.walk_target = None
        self.gaze_until = 0.0
        self.next_walk_at = time.monotonic() + random.uniform(60, 120)
        self.drag_origin = (event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y())

    def _drag_move(self, event: tk.Event) -> None:
        if not self.drag_origin:
            return
        sx, sy, wx, wy = self.drag_origin
        if abs(event.x_root - sx) >= 6 or abs(event.y_root - sy) >= 6:
            self.drag_moved = True
            self._cancel_single_click()
        self.root.geometry(f"{CELL_W}x{CELL_H}+{wx + event.x_root - sx}+{wy + event.y_root - sy}")
        self._position_bubble()

    def _drag_end(self, event: tk.Event) -> None:
        if self.drag_origin:
            sx, sy, _, _ = self.drag_origin
            if not self.drag_moved and not self.suppress_click_release and abs(event.x_root - sx) < 6 and abs(event.y_root - sy) < 6:
                now = time.monotonic()
                delay = max(500, int(ctypes.windll.user32.GetDoubleClickTime()))
                previous = self.pending_click
                if previous and self.click_timer_id:
                    when, x, y = previous
                    if now - when <= delay / 1000 and abs(event.x_root - x) <= 8 and abs(event.y_root - y) <= 8:
                        self._double_click(event)
                        self.drag_origin = None
                        return
                    self._cancel_single_click()
                    self.random_action()
                self._cancel_single_click()
                self.pending_click = (now, event.x_root, event.y_root)
                self.click_timer_id = self.root.after(delay + 50, self._finish_single_click)
        self.drag_origin = None
        self.suppress_click_release = False

    def _cancel_single_click(self) -> None:
        if self.click_timer_id:
            self.root.after_cancel(self.click_timer_id)
            self.click_timer_id = None
        self.pending_click = None

    def _finish_single_click(self) -> None:
        self.click_timer_id = None
        self.pending_click = None
        self.random_action()

    def _double_click(self, event: tk.Event) -> None:
        self._cancel_single_click()
        self.drag_origin = None
        self.suppress_click_release = False
        self._close_action_panel()
        self._close_bubble()
        self.last_input_event = time.monotonic()
        self.pet_touch(force=True)

    def show_configuration(self) -> None:
        x, y = cursor_position()
        self._show_action_panel(x, y, configuration=True)

    def _sync_mic(self) -> None:
        self.mic_sampler.enabled = bool(self.mic_var.get())

    def _sync_follow(self) -> None:
        self.follow_mouse = bool(self.follow_var.get())
        if self.follow_mouse:
            self.show_message("鼠标跟随已打开", "我会慢慢靠近鼠标，不需要时可以在右键菜单里关掉。")

    def show_chat(self, category: str | None = None) -> None:
        if category is None:
            categories = ['idle', 'story']
            if self.affection >= 30:
                categories.append('warm')
            if self.affection >= 70:
                categories.append('close')
            category = random.choice(categories)
        text = self._addressed(self.dialogue.choose(category, self.affection))
        self.reminder_kind = None
        self.demo('review' if category in ('story', 'busy') else 'idle', seconds=1.4)
        self._open_bubble(
            '巡航小剧场 · 原创' if category == 'story' else '夏以昼 · 小声说',
            text,
            [("再说一句", self.show_chat), ("好啦", self._close_bubble)],
        )

    def start_scene(self) -> None:
        choices = [name for name in SCENES if name != self.scene_name]
        self.scene_name = random.choice(choices)
        self.scene_index = 0
        self.next_scene_line()

    def next_scene_line(self) -> None:
        pose, lines = SCENES[self.scene_name]
        text = lines[self.scene_index]
        self.scene_index += 1
        self.reminder_kind = None
        self.demo(pose, seconds=1.3)
        buttons = [('换个场景', self.start_scene), ('下次再听', self._close_bubble)]
        if self.scene_index < len(lines):
            buttons.insert(0, ('继续听', self.next_scene_line))
        self._open_bubble(f'{self.scene_name} · 原创 {self.scene_index}/{len(lines)}', text, buttons)

    def pet_touch(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_pet_at < 0.75:
            return
        self.last_pet_at = now
        self._record_interaction(affection_gain=2)
        self.demo(random.choice(("waving", "idle")), seconds=1.4)
        responses = [
            ("收到摸摸", "嗯，我在这里。今天也一起慢慢来。"),
            ("被你发现了", "再摸一下也可以，但别忘了照顾好自己。"),
            ("谢谢你", "这份陪伴我收到了。亲密度也悄悄增加了一点。"),
        ]
        title, text = random.choice(responses)
        if self.daily_interactions in (3, 10):
            text += f" 今天已经互动 {self.daily_interactions} 次啦。"
        self.show_message(title, text)

    def show_status(self) -> None:
        self._sync_daily_profile()
        text = (
            f"亲密度：{self.affection}/100\n"
            f"今天互动：{self.daily_interactions} 次\n"
            f"累计互动：{self.total_interactions} 次\n"
            f"现在的状态：{self._mood_text()}"
        )
        self._open_bubble(
            "陪伴状态",
            text,
            [("摸摸他", self.pet_touch), ("玩猜拳", self.show_rps), ("好啦", self._close_bubble)],
        )

    def show_rps(self) -> None:
        self.demo("waving", seconds=1.2)
        self._open_bubble(
            "小小猜拳",
            "来一局吗？赢了可以获得一点陪伴值。",
            [
                ("石头", lambda: self._play_rps("石头")),
                ("剪刀", lambda: self._play_rps("剪刀")),
                ("布", lambda: self._play_rps("布")),
                ("先不了", self._close_bubble),
            ],
        )

    def _play_rps(self, player_choice: str) -> None:
        pet_choice = random.choice(RPS_CHOICES)
        if player_choice == pet_choice:
            result = "平局，再来一局也可以。"
            gain = 1
        elif RPS_BEATS[player_choice] == pet_choice:
            result = "你赢啦，今天也很厉害。"
            gain = 3
        else:
            result = "这局我赢了，但我不会得意太久。"
            gain = 1
        self._record_interaction(affection_gain=gain)
        self.demo("waving" if gain >= 3 else "idle", seconds=1.4)
        self._open_bubble(
            "猜拳结果",
            f"你出了{player_choice}，我出了{pet_choice}。\n{result}",
            [("再来一局", self.show_rps), ("查看状态", self.show_status), ("结束", self._close_bubble)],
        )

    def toggle_quiet_mode(self) -> None:
        now = time.monotonic()
        if self.quiet_until > now:
            self.quiet_until = 0.0
            self.show_message("安静模式已关闭", "我会恢复低频互动和提醒。")
            return
        self.quiet_until = now + QUIET_MODE_SECONDS
        self._close_bubble()
        self.show_message("安静模式已开启", "接下来一小时我会安静陪着你，不主动弹聊天或提醒。")

    def start_focus(self, minutes: int) -> None:
        self.focus_minutes = minutes
        self.focus_until = time.monotonic() + minutes * 60
        self.demo("review", seconds=2.5)
        self.show_message("专注开始", f"接下来 {minutes} 分钟，我会安静陪你。结束后我会提醒你休息。")

    def end_focus(self) -> None:
        self.focus_until = None
        self.focus_minutes = 0
        self.show_message("专注结束", "辛苦啦，先活动一下眼睛和肩膀吧。")

    def demo(self, state: str, seconds: float | None = None) -> None:
        self.edge_motion = None
        self.walk_target = None
        self.gaze_until = 0.0
        self.state = state
        self.frame = 0
        self.frame_started = time.monotonic()
        self.manual_until = time.monotonic() + (seconds if seconds is not None else (3.5 if state in ONE_SHOT else 4.0))

    def _start_tray_icon(self) -> None:
        if pystray is None:
            return
        try:
            icon_image = Image.open(resource_path("assets", "tray.ico")).convert("RGBA")
            def call_on_ui(callback):
                return lambda _icon, _item: self.root.after(0, callback)
            menu = pystray.Menu(
                pystray.MenuItem(lambda _item: "显示夏以昼" if self.pet_hidden else "隐藏夏以昼",
                                 call_on_ui(self.toggle_pet_visibility)),
                pystray.MenuItem("配置…", call_on_ui(self.show_configuration)),
                pystray.MenuItem("暂停 / 继续互动", call_on_ui(self.toggle_pause)),
                pystray.MenuItem("安静模式 1 小时", call_on_ui(self.toggle_quiet_mode)),
                pystray.MenuItem("退出", call_on_ui(self.quit)),
            )
            self.tray_icon = pystray.Icon("caleb-desktop-pet", icon_image, APP_NAME, menu)
            threading.Thread(target=self.tray_icon.run, name="caleb-tray", daemon=True).start()
        except Exception:
            self.tray_icon = None

    def show_pet(self) -> None:
        self.pet_hidden = False
        self.root.deiconify()
        self.root.attributes("-topmost", True)
        self.root.lift()
        self._position_bubble()

    def hide_pet(self) -> None:
        """Hide the pet until it is asked for again (tray → 显示夏以昼)."""
        self.pet_hidden = True
        if self.bubble and self.bubble.winfo_exists():
            self.bubble.withdraw()
        self.root.withdraw()

    def toggle_pet_visibility(self) -> None:
        if self.pet_hidden:
            self.show_pet()
        else:
            self.hide_pet()

    def toggle_pause(self) -> None:
        self.paused = not self.paused

    def _position_bubble(self) -> None:
        if not self.bubble or not self.bubble.winfo_exists():
            return
        self.root.update_idletasks()
        self.bubble.update_idletasks()
        wx, wy = self.root.winfo_rootx(), self.root.winfo_rooty()
        bw, bh = self.bubble.winfo_width(), self.bubble.winfo_height()
        try:
            get_metrics = ctypes.windll.user32.GetSystemMetrics
            screen_left = int(get_metrics(76))
            screen_top = int(get_metrics(77))
            screen_width = int(get_metrics(78))
            screen_height = int(get_metrics(79))
            if screen_width <= 0 or screen_height <= 0:
                raise RuntimeError("invalid virtual screen metrics")
        except (RuntimeError, OSError, AttributeError):
            screen_left, screen_top = 0, 0
            screen_width, screen_height = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        screen_right = screen_left + screen_width
        screen_bottom = screen_top + screen_height
        if self.work_area:
            screen_left, screen_top = self.work_area.left, self.work_area.top
            screen_right, screen_bottom = self.work_area.right, self.work_area.bottom
        # 气泡挂在头顶、水平居中；越界时往屏内夹，头顶放不下就落到脚下。
        bx = wx + (CELL_W - bw) // 2
        by = wy - bh - 10
        if by < screen_top + 8:
            by = min(wy + CELL_H + 10, screen_bottom - bh - 8)
        bx = max(screen_left + 8, min(bx, screen_right - 8 - bw))
        by = max(screen_top + 8, min(by, screen_bottom - bh - 8))
        self.bubble.geometry(f"{bw}x{bh}+{bx}+{by}")

    def _open_bubble(
        self,
        title: str,
        text: str,
        buttons: list[tuple[str, object]],
        timeout_ms: int = BUBBLE_MS,
        reserve_lines: int = 0,
    ) -> None:
        self.edge_motion = None
        if self.bubble_timeout_id:
            self.root.after_cancel(self.bubble_timeout_id)
        self.bubble_timeout_id = None
        self.bubble_rewarded = False
        self.bubble_hovered = False
        self.ai_bubble = False
        self.walk_target = None
        if self.bubble and self.bubble.winfo_exists():
            self.bubble.destroy()
        self.bubble = tk.Toplevel(self.root)
        self.bubble.overrideredirect(True)
        self.bubble.attributes("-topmost", True)
        self.bubble.withdraw()
        # Leave the four outer corners transparent so the popup itself is a
        # rounded rectangle, not a rounded drawing inside a square window.
        self.bubble.attributes("-transparentcolor", BUBBLE_KEY)
        self.bubble.configure(bg=BUBBLE_KEY)
        # Fonts are created once and reused: a streaming reply redraws this
        # canvas many times per answer.
        if self.bubble_title_font is None:
            self.bubble_title_font = tkfont.Font(family='Microsoft YaHei UI', size=10, weight='bold')
        if self.bubble_body_font is None:
            self.bubble_body_font = tkfont.Font(family='Microsoft YaHei UI', size=9)
        canvas = self.bubble_canvas = tk.Canvas(self.bubble, bg=BUBBLE_KEY, highlightthickness=0)
        canvas.pack()
        canvas.bind("<Button-1>", self._bubble_click)
        # 鼠标停在气泡上时暂停倒计时，移开再重新计时：7 秒的显示时间也够读完。
        canvas.bind("<Enter>", self._bubble_hover_in)
        canvas.bind("<Leave>", self._bubble_hover_out)
        self._draw_bubble(title, text, buttons, reserve_lines)
        self.bubble.deiconify()
        self.bubble.lift()
        self.bubble_lifetime_ms = timeout_ms
        self.bubble_timeout_id = self.root.after(timeout_ms, self._close_bubble)

    def _bubble_hover_in(self, _event=None) -> None:
        self.bubble_hovered = True
        if self.bubble_canvas:
            self.bubble_canvas.configure(cursor="hand2")
        if self.bubble_timeout_id:
            self.root.after_cancel(self.bubble_timeout_id)
            self.bubble_timeout_id = None

    def _bubble_hover_out(self, _event=None) -> None:
        self.bubble_hovered = False
        if self.bubble_canvas:
            self.bubble_canvas.configure(cursor="arrow")
        if self.bubble and self.bubble.winfo_exists() and not self.bubble_timeout_id:
            self.bubble_timeout_id = self.root.after(self.bubble_lifetime_ms, self._close_bubble)

    @staticmethod
    def _wrap_bubble_lines(value: str, font) -> list[str]:
        lines: list[str] = []
        for paragraph in value.splitlines() or [""]:
            current = ''
            for char in paragraph:
                if current and font.measure(current + char) > 262:
                    lines.append(current)
                    current = ''
                current += char
            lines.append(current)
        return lines or [""]

    def _draw_bubble(self, title: str, text: str, buttons: list[tuple[str, object]], reserve_lines: int = 0) -> None:
        """(Re)draw the bubble canvas. Safe to call repeatedly on a live bubble."""
        canvas = self.bubble_canvas
        panel_fill = "#FFF9F1"
        panel_edge = "#D9B39C"
        title_lines = self._wrap_bubble_lines(title, self.bubble_title_font) if title else []
        body_lines = self._wrap_bubble_lines(text, self.bubble_body_font)
        if len(body_lines) > AI_BUBBLE_MAX_LINES:
            # A very long answer must not turn the bubble into a wall of text;
            # the full text still stays in the session history.
            body_lines = body_lines[:AI_BUBBLE_MAX_LINES]
            body_lines[-1] = body_lines[-1].rstrip() + '……'
        has_buttons = bool(buttons)
        if has_buttons:
            width = 300
        else:
            # 没有标题和按钮的极简气泡（比如思考时的“。”），宽度跟着内容走。
            longest = max((len(line) for line in body_lines), default=0)
            width = max(88, min(300, 44 + longest * 13))
        rows = max(len(body_lines), reserve_lines)
        height = 14 + len(title_lines) * 22 + 6 + rows * 20 + (46 if has_buttons else 16)
        canvas.configure(width=width, height=height)
        canvas.delete("all")
        self._draw_round_rect(canvas, width, height, panel_fill, panel_edge)
        if title_lines:
            canvas.create_text(
                18,
                14,
                text="\n".join(title_lines),
                fill="#6D4E43",
                font=('Microsoft YaHei UI', 10, 'bold'),
                anchor="nw",
            )
        body_y = 14 + len(title_lines) * 22 + 4
        canvas.create_text(
            18,
            body_y,
            text="\n".join(body_lines),
            fill="#725F58",
            font=('Microsoft YaHei UI', 9),
            anchor="nw",
        )
        self.bubble_button_targets = []
        button_y = height - 36
        gap = 8
        button_width = (width - 36 - gap * max(0, len(buttons) - 1)) // max(1, len(buttons))
        for index, (label, callback) in enumerate(buttons):
            left = 18 + index * (button_width + gap)
            right = left + button_width
            fill = "#E6BDA3" if index == 0 else "#F0E4DA"
            outline = "#C89B83" if index == 0 else "#D9C8BC"
            self._draw_round_box(canvas, left, button_y, right, button_y + 24, fill, outline, radius=8)
            canvas.create_text(
                (left + right) // 2,
                button_y + 12,
                text=label,
                fill="#3E2A25" if index == 0 else "#6D5C56",
                font=("Segoe UI", 8),
            )
            self.bubble_button_targets.append((left, button_y, right, button_y + 24, callback))
        self.bubble.geometry(f"{width}x{height}")
        self._position_bubble()

    def _set_bubble_body(
        self,
        title: str,
        text: str,
        buttons: list[tuple[str, object]],
        reserve_lines: int = 0,
        timeout_ms: int | None = None,
    ) -> bool:
        """Update a live bubble in place. Returns False when there is no bubble."""
        if not (self.bubble and self.bubble.winfo_exists()):
            return False
        self._draw_bubble(title, text, buttons, reserve_lines)
        if timeout_ms is not None:
            self.bubble_lifetime_ms = timeout_ms
            if self.bubble_timeout_id:
                self.root.after_cancel(self.bubble_timeout_id)
                self.bubble_timeout_id = None
            if not self.bubble_hovered:
                self.bubble_timeout_id = self.root.after(timeout_ms, self._close_bubble)
        return True

    def show_ai_reply(self, text: str, title: str = AI_BUBBLE_TITLE, reserve_lines: int = 0,
                      buttons: list[tuple[str, object]] | None = None) -> None:
        """AI answers are spoken through the pet bubble, never a second window."""
        buttons = buttons or [("好", self._close_bubble)]
        if self.ai_bubble and self._set_bubble_body(title, text, buttons, reserve_lines, AI_BUBBLE_MS):
            return
        self._open_bubble(title, text, buttons, timeout_ms=AI_BUBBLE_MS, reserve_lines=reserve_lines)
        self.ai_bubble = True

    def set_thinking(self, active: bool) -> None:
        """聊聊等待回复时摆托腮思考的姿态；回复落地后回到自然状态。

        用的是素材里的 waiting 行（手托下巴），它会先播几帧再定格——比直接冻住
        更像“在想事情”。
        """
        if active:
            self.demo('waiting', seconds=3600)
            self.thinking = True
            return
        self.thinking = False
        self.manual_until = 0.0
        self.state = 'idle'
        self.frame = 0
        self.frame_started = time.monotonic()
        self.gaze_until = 0.0
        self._render()

    def show_thinking_bubble(self, text: str) -> None:
        """思考中的极简指示：头顶只有几个点，没有标题、没有按钮。"""
        self._open_bubble('', text, [], timeout_ms=BUBBLE_MS)

    def show_user_reminder(self, text: str) -> None:
        """A reminder the user asked for in plain language; waves to get attention."""
        self.demo('waving', seconds=1.2)
        self.reminder_kind = None
        self._open_bubble('你交代过的事', text, [('知道了', self._close_bubble),
                                                ('十分钟后再提醒', lambda: self._ai().snooze(text))])

    def _bubble_click(self, event: tk.Event) -> None:
        if not self.bubble_rewarded:
            self.bubble_rewarded = True
            self._record_interaction(affection_gain=1)
        for left, top, right, bottom, callback in self.bubble_button_targets:
            if left <= event.x <= right and top <= event.y <= bottom:
                callback()
                return
        # 点空白处＝“我看完了”：AI 回答气泡随手点掉，不用等它自己走。
        if self.ai_bubble:
            self._close_bubble()

    def show_message(self, title: str, text: str) -> None:
        self.reminder_kind = None
        self._open_bubble(title, text, [("好", self._close_bubble)])

    def _close_bubble(self) -> None:
        if self.bubble_timeout_id:
            self.root.after_cancel(self.bubble_timeout_id)
            self.bubble_timeout_id = None
        if self.bubble and self.bubble.winfo_exists():
            self.bubble.destroy()
        self.bubble = None
        self.bubble_canvas = None
        self.bubble_button_targets = []
        self.bubble_hovered = False
        self.ai_bubble = False
        self.reminder_kind = None

    def show_reminder(self, kind: str, force: bool = False) -> None:
        now = time.monotonic()
        cross_due = self.last_reminder_at + REMINDER_CROSS_GAP
        if self.last_reminder_kind not in (None, kind) and now < cross_due:
            if force and not self.bubble:
                minutes = math.ceil((cross_due - now) / 60)
                self.show_message('提醒错开一点', f'两类提醒至少间隔20分钟。这次还需等待约{minutes}分钟，不会连续打扰你。')
            return
        if self.bubble and self.bubble.winfo_exists() and not force:
            return
        self.last_reminder_kind, self.last_reminder_at = kind, now
        if kind == 'water':
            self.next_water_at = now + REMINDER_INTERVALS[kind]
        else:
            self.next_break_at = now + REMINDER_INTERVALS[kind]
        self.reminder_kind = kind
        self.demo("waiting", seconds=6.0)
        if kind == "water":
            buttons = [
                ("喝好了", lambda: self._answer_reminder("ack")),
                ("稍后再说", lambda: self._answer_reminder("snooze")),
            ]
        else:
            buttons = [
                ("去休息", lambda: self._answer_reminder("ack")),
                ("再工作5分钟", lambda: self._answer_reminder("snooze")),
            ]
        self._open_bubble(
            REMINDER_COPY[kind]["title"],
            self._addressed(REMINDER_COPY[kind]["text"]),
            buttons,
        )

    def _answer_reminder(self, answer: str) -> None:
        kind = self.reminder_kind or "water"
        now = time.monotonic()
        if answer == "ack":
            delay = REMINDER_INTERVALS[kind]
            if kind == "water":
                follow_up = ("收到啦", "谢谢你，喝几口水就很好。")
            else:
                follow_up = ("去吧，我等你", "离开屏幕走动一下，回来时再继续就好。")
            self.demo("waving", seconds=1.5)
        else:
            delay = 15 * 60 if kind == "water" else 5 * 60
            if kind == "water":
                follow_up = ("好呀", "我过一会儿再轻轻提醒你，不着急。")
            else:
                follow_up = ("再专注一会儿", "好，再工作5分钟，我不催你。")
            self.demo("idle", seconds=1.5)
        if kind == "water":
            self.next_water_at = now + delay
        else:
            self.next_break_at = now + delay
        self._close_bubble()
        self.show_message(*follow_up)

    def _update_idle_social(self, now: float) -> None:
        if self.quiet_until > now or self.focus_until is not None:
            return
        if self.bubble and self.bubble.winfo_exists():
            return
        if now < self.next_idle_chat_at or self.state not in (None, "idle"):
            return
        self.next_idle_chat_at = now + random.uniform(240, 480)
        if self.weather_pending and self.weather_text:
            self.weather_pending = False
            self.show_message('窗外天气 · 请核对城市', self.weather_text)
            return
        hour = datetime.now().hour
        category = 'night' if hour < 6 or hour >= 23 else 'morning' if hour < 11 else 'noon' if hour < 14 else 'evening' if hour >= 18 else 'idle'
        if self.pending_return:
            category = 'return'
            self.pending_return = False
        elif self.cpu_busy:
            category = 'busy'
        elif random.random() < 0.4:
            category = random.choice(['story', 'warm', 'close'])
        # Ambient cruise dialogue is automatic, but never starts a game,
        # focus session, or multi-step scene on the user's behalf.
        self.reminder_kind = None
        text = self._addressed(self.dialogue.choose(category, self.affection))
        self._open_bubble('巡航碎碎念 · 原创', text, [('听到啦', self._close_bubble)])

    def _update_input_interaction(self) -> None:
        now = time.monotonic()
        current_tick = last_input_tick()
        current_cursor = cursor_position()
        moved_x = current_cursor[0] - self.last_cursor[0]
        moved_y = current_cursor[1] - self.last_cursor[1]
        if current_tick and current_tick != self.last_input_tick:
            was_idle = now - self.last_input_event > 5 * 60
            self.last_input_tick = current_tick
            self.last_input_event = now
            if was_idle:
                self.pending_return = True
                self.work_session_started = now
                self.next_water_at = now + REMINDER_INTERVALS["water"]
                self.next_break_at = now + REMINDER_INTERVALS["break"]
            # Input records activity only. It no longer triggers foot-running.
        self.last_cursor = current_cursor

    def _auto_demo(self, state: str, seconds: float) -> bool:
        now = time.monotonic()
        if now < self.auto_action_cooldown_until or now < self.manual_until:
            return False
        same_gap = AUTO_SAME_ACTION_GAP_SECONDS if state.startswith("running-") else AUTO_WAVE_GAP_SECONDS
        if state == self.last_auto_action and now - self.last_auto_action_at < same_gap:
            return False
        self.demo(state, seconds=seconds)
        self.last_auto_action = state
        self.last_auto_action_at = now
        self.auto_action_cooldown_until = now + AUTO_ACTION_GAP_SECONDS
        return True

    def _update_reminders(self) -> None:
        if self.bubble and self.bubble.winfo_exists():
            return
        now = time.monotonic()
        if self.quiet_until > now:
            return
        if now - self.last_input_event > 5 * 60:
            return
        kind = min(('break', 'water'), key=self._reminder_due)
        if now >= self._reminder_due(kind):
            self.show_reminder(kind)

    def _reminder_due(self, kind: str) -> float:
        due = self.next_water_at if kind == 'water' else self.next_break_at
        if self.last_reminder_kind not in (None, kind):
            due = max(due, self.last_reminder_at + REMINDER_CROSS_GAP)
        return max(due, self.quiet_until, self.focus_until or 0)

    def _reminder_countdown(self, kind: str, now: float) -> str:
        seconds = max(0, math.ceil(self._reminder_due(kind) - now))
        return f'{seconds // 60:02d}:{seconds % 60:02d}'

    def _update_follow_mouse(self) -> None:
        if not self.follow_mouse or (self.bubble and self.bubble.winfo_exists()):
            return
        x, y = cursor_position()
        wx, wy = self.root.winfo_rootx(), self.root.winfo_rooty()
        dx = x - (wx + CELL_W // 2)
        dy = y - (wy + CELL_H // 2)
        distance = math.hypot(dx, dy)
        if distance < 180:
            return
        step = min(5.0, max(1.0, distance / 75.0))
        nx = int(wx + dx / distance * step)
        ny = int(wy + dy / distance * step)
        self.root.geometry(f"{CELL_W}x{CELL_H}+{nx}+{ny}")
        self._position_bubble()

    def hide_temporarily(self) -> None:
        self.hide_pet()
        self.root.after(10000, self.show_pet)

    def _mouse_look_index(self) -> int | None:
        x, y = cursor_position()
        wx, wy = self.root.winfo_rootx(), self.root.winfo_rooty()
        dx, dy = x - (wx + CELL_W // 2), y - (wy + CELL_H // 2)
        distance = math.hypot(dx, dy)
        if distance < 95:
            return None
        angle = (math.degrees(math.atan2(dx, -dy)) + 360.0) % 360.0
        return int(round(angle / 22.5)) % 16

    def _update_automatic_state(self) -> None:
        now = time.monotonic()
        if self.quiet_until and now >= self.quiet_until:
            self.quiet_until = 0.0
        self._update_input_interaction()
        self._update_world(now)

        # Explicit completed gestures take precedence over ambient behavior
        # and reminders, so a fresh response isn't immediately overwritten.
        if now < self.manual_until and not self.drag_origin and not self.menu_window:
            return
        if self.fullscreen or self.drag_origin or self.menu_window or self.root.state() == 'withdrawn' or now - self.last_input_event > 300:
            self.edge_motion = None
            self.walk_target = None
            self.gaze_until = 0.0
            self.state = 'idle'
            return
        mic = self.mic_sampler.sample()
        if self.focus_until is not None and now >= self.focus_until:
            self.focus_until = None
            self.focus_minutes = 0
            self.next_break_at = now
        if self.focus_until is None:
            self._update_reminders()
        if now < self.manual_until:
            return
        if self.edge_motion and not (self.focus_until or self.quiet_until > now or self.bubble):
            self._update_edge_action(now)
            return
        self.edge_motion = None
        if self.state != 'idle' and self.walk_target is None:
            self.state = 'idle'
            self.frame = 0
        if self.focus_until is not None or self.quiet_until > now or self.bubble:
            self.walk_target = None
            self.gaze_until = 0.0
            return
        if mic > 0.34 and now - self.last_sound_reaction > 90.0 and self.walk_target is None:
            self.last_sound_reaction = now
            self.demo("waving", seconds=1.0)
            return
        self._update_calm_motion(now)
        self._update_idle_social(now)

    def _update_world(self, now: float) -> None:
        if self.weather_city and now >= self.next_weather_at:
            if self.weather.request(self.weather_city):
                self.next_weather_at = now + 3600
        while not self.weather.results.empty():
            city, text, error = self.weather.results.get_nowait()
            if city == self.weather_city:
                self.weather_text = text
                self.weather_pending = bool(text)
                if error:
                    self.weather_pending = False
        if now >= self.next_world_at:
            self.next_world_at = now + 1.0
            try:
                self.work_area, self.window_edge, self.fullscreen = self.world.observe(
                    self.root.winfo_rootx() + CELL_W // 2, self.root.winfo_rooty() + CELL_H // 2)
            except OSError:
                self.walk_target = None
        if now >= self.next_load_at:
            self.next_load_at = now + 10.0
            cpu, _memory = self.load_sampler.sample()
            if cpu >= 80:
                if self.cpu_high_since is None:
                    self.cpu_high_since = now
                self.cpu_busy = now - self.cpu_high_since >= 30
            else:
                self.cpu_high_since = None
                self.cpu_busy = False

    def _toggle_walk(self) -> None:
        self.edge_motion = None
        self.walk_enabled = not self.walk_enabled
        self._save_profile()
        self.walk_target = None
        self.state, self.frame = 'idle', 0
        self.next_walk_at = time.monotonic() + random.uniform(60, 120)
        self.show_message('桌面巡游', '已开启低频短距离巡游。' if self.walk_enabled else '已停止巡游，可以拖动我换位置。')

    def configure_weather(self) -> None:
        city = simpledialog.askstring('可选天气', '输入城市名（同名时建议用拼音）。\n会向 Open-Meteo 查询，每小时更新；不定位。\n留空关闭，仅本次运行有效。', parent=self.root, initialvalue=self.weather_city)
        if city is None:
            return
        self.weather_city = city.strip()[:80]
        self.weather_text = None
        self.weather_pending = False
        self.next_weather_at = 0.0
        self.show_message('天气设置', '已开启。查询结果会显示匹配城市，请核对地点；网络不可用时不播报天气。' if self.weather_city else '天气查询已关闭。')

    def start_edge_action(self, kind: str, automatic: bool = False) -> bool:
        if kind not in self.frames:
            if not automatic:
                self.show_message('这个动作还在准备', '专用动作素材通过检查后才会启用，不会拿跑步动作代替。')
            return False
        self._update_world(time.monotonic() + 1)
        if not self.work_area or self.fullscreen:
            return False
        x, y = self.root.winfo_rootx(), self.root.winfo_rooty()
        rect = self.world.window_rect
        # Both supplemental rows face a vertical support on screen-right.
        contact = 178
        support_x = self.work_area.right
        low, high = self.work_area.top, self.work_area.bottom - CELL_H
        window_id = None
        if rect and abs(x + contact - rect.left) <= 65 and rect.bottom - rect.top >= CELL_H:
            support_x = rect.left
            low, high = max(low, rect.top), min(high, rect.bottom - CELL_H)
            window_id = self.world.window_id
        elif abs(x + CELL_W - self.work_area.right) > 65:
            if not automatic:
                self.show_message('靠近一点就好', '请把我拖到屏幕右边，或普通窗口的左侧边缘，再试一次。')
            return False
        nx = support_x - (contact if window_id else CELL_W)
        if low > high or nx < self.work_area.left or y < low - 30 or y > high + 30:
            if not automatic:
                self.show_message('这里有点窄', '给头发和鞋子留出完整空间，我们换一段宽敞的边缘吧。')
            return False
        self._close_bubble()
        self.walk_target = None
        self.gaze_until = 0
        self.manual_until = 0
        now = time.monotonic()
        self.edge_motion = {'kind': kind, 'window': window_id, 'support': support_x,
                            'x': nx, 'target_y': max(low, min(y - 130, high)),
                            'last': now, 'until': now + (6 if kind == 'lean' else 8)}
        self.state, self.frame, self.frame_started = kind, 0, now
        self.next_walk_at = now + random.uniform(90, 180)
        return True

    def _update_edge_action(self, now: float) -> None:
        motion = self.edge_motion
        rect = self.world.window_rect
        invalid = motion['window'] and (self.world.window_id != motion['window'] or not rect or abs(rect.left - motion['support']) > 8 or
                                        self.root.winfo_rooty() < rect.top - 8 or self.root.winfo_rooty() + CELL_H > rect.bottom + 8)
        if invalid or self.cpu_busy or now >= motion['until']:
            self.edge_motion = None
            self.state, self.frame = 'idle', 0
            self.next_pose_at = now + random.uniform(35, 60)
            return
        dt = min(.15, max(0, now - motion['last']))
        motion['last'] = now
        y = self.root.winfo_rooty()
        if motion['kind'] == 'climb':
            y = max(motion['target_y'], y - max(1, round(32 * dt)))
            if y <= motion['target_y']:
                if 'lean' in self.frames:
                    motion['kind'], self.state, self.frame = 'lean', 'lean', 0
                    motion['until'] = now + 4
                else:
                    motion['until'] = now
        nx, ny = self.work_area.clamp(motion['x'], y)
        ctypes.windll.user32.SetWindowPos(wintypes.HWND(self.alpha_window.hwnd), None, nx, ny, 0, 0, 0x0015)

    def walk_window_edge(self) -> None:
        self._update_world(time.monotonic() + 1)
        edge = self.window_edge
        if not edge or not self.work_area:
            self.show_message('还没有合适的窗沿', '请先打开一个非最大化窗口，并在窗口上方留出人物站立的空间。')
            return
        x, y = self.root.winfo_rootx(), self.root.winfo_rooty()
        if abs(y + 200 - edge.top) > 70 or x < edge.left - 40 or x + CELL_W > edge.right + 40:
            self.show_message('靠近窗沿再出发', '把我拖到窗口上沿附近，再点一次。我不会突然穿过你的工作区。')
            return
        self._close_bubble()
        target = edge.left if x > (edge.left + edge.right - CELL_W) / 2 else edge.right - CELL_W
        self.walk_target = (target, edge.top - 200, True)
        self.walk_last_tick = time.monotonic()
        self.manual_until = 0.0

    def _update_calm_motion(self, now: float) -> None:
        dt = max(0.0, min(0.15, now - self.walk_last_tick))
        self.walk_last_tick = now
        if self.cpu_busy:
            self.walk_target = None
            self.state, self.frame = 'idle', 0
            return
        x, y = self.root.winfo_rootx(), self.root.winfo_rooty()
        if self.walk_target and self.work_area:
            tx, ty, on_edge = self.walk_target
            if on_edge:
                edge = self.window_edge
                if not edge or abs(edge.top - 200 - ty) > 8:
                    self.walk_target = None
                    self.state, self.frame = 'idle', 0
                    self.next_walk_at = now + 90
                    return
                tx = max(edge.left, min(tx, edge.right - CELL_W))
            tx, ty = self.work_area.clamp(tx, ty)
            dx, dy = tx - x, ty - y
            distance = math.hypot(dx, dy)
            if distance < 4:
                self.walk_target = None
                self.state, self.frame = 'idle', 0
                self.next_walk_at = now + random.uniform(60, 150)
                self.next_pose_at = now + random.uniform(20, 40)
                return
            step = min(distance, 65 * dt)
            nx, ny = self.work_area.clamp(round(x + dx / distance * step), round(y + dy / distance * step))
            # Explicit signed screen coordinates also support left-hand monitors.
            ctypes.windll.user32.SetWindowPos(wintypes.HWND(self.alpha_window.hwnd), None,
                                            nx, ny, 0, 0, 0x0015)
            state = 'running-right' if dx >= 0 else 'running-left'
            if self.state != state:
                self.state, self.frame = state, 0
                self.frame_started = now
            self.gaze_until = 0.0
            return
        if self.walk_enabled and self.work_area and now >= self.next_walk_at:
            self.next_walk_at = now + random.uniform(60, 150)
            if random.random() < .25 and self.start_edge_action(random.choice(('climb', 'lean')), automatic=True):
                return
            tx = x + random.choice((-1, 1)) * random.uniform(100, 240)
            tx, ty = self.work_area.clamp(tx, y)
            edge = self.window_edge
            on_edge = bool(edge and abs(y + 200 - edge.top) < 20 and edge.left <= x <= edge.right - CELL_W)
            if on_edge:
                tx, ty = max(edge.left, min(tx, edge.right - CELL_W)), edge.top - 200
            if abs(tx - x) > 30:
                self.walk_target = (tx, ty, on_edge)
            return
        if self.auto_var.get() and now >= self.next_gaze_at:
            self.gaze_until = now + random.uniform(4, 8)
            self.next_gaze_at = now + random.uniform(35, 65)
        if now >= self.next_pose_at and now >= self.gaze_until:
            choices = [s for s in ('review', 'waiting', 'idle') if s != self.last_pose]
            self.last_pose = random.choice(choices)
            self.demo(self.last_pose, seconds=random.uniform(2.2, 3.2))
            self.next_pose_at = now + random.uniform(40, 80)

    def _advance_state_frame(self) -> None:
        if self.state is None:
            return
        if self.state == 'idle':
            if self.calm_motion.was_looking:
                self.frame = 0
                return
            self.frame = self.calm_motion.idle_frame(time.monotonic())
            return
        self.calm_motion.active = False
        durations = FRAME_MS[self.state]
        self.frame %= len(durations)
        now = time.monotonic()
        if (now - self.frame_started) * 1000 >= durations[self.frame]:
            if self.state in ('review', 'waiting') and self.frame == len(durations) - 1:
                return
            self.frame = (self.frame + 1) % len(durations)
            self.frame_started = now

    def _render(self) -> None:
        look_index = self._mouse_look_index() if self.state in (None, "idle") and time.monotonic() < self.gaze_until else None
        if look_index is not None:
            look_index = self.calm_motion.look_frame(look_index, time.monotonic())
            self.calm_motion.was_looking = True
            self.calm_motion.active = False
            image = self.look_frames[look_index]
        else:
            if self.calm_motion.was_looking:
                self.calm_motion.was_looking = False
                self.calm_motion.gaze = None
                self.calm_motion.active = False
                if self.state in (None, 'idle'):
                    self.frame = 0
            frames = self.frames.get(self.state, self.frames['idle'])
            image = frames[self.frame % len(frames)]
        self.alpha_window.render(image)

    def _ai(self):
        if not getattr(self, 'ai_chat', None):
            from ai_chat import AIChat
            self.ai_chat = AIChat(self, resource_path('assets', 'personality.json'),
                                  profile_path().with_name('ai-key.bin'),
                                  profile_path().with_name('ai-config.json'),
                                  profile_path().with_name('ai-history.jsonl'),
                                  profile_path().with_name('ai-memory.json'),
                                  profile_path().with_name('ai-reminders.json'))
        return self.ai_chat

    def open_ai_chat(self):
        self._ai().open()

    def _escape(self, _event=None) -> None:
        """Esc：先收气泡，再收菜单，什么都不开时不动——不再退出程序。"""
        if self.bubble and self.bubble.winfo_exists():
            self._close_bubble()
            return
        if self.menu_window and self.menu_window.winfo_exists():
            self._close_action_panel()

    def _hotkey_label(self) -> str:
        """让“按了没反应”这件事可以自查：能看出钩子装没装上、到底触发过几次。"""
        hotkey = getattr(self, 'ai_hotkey', None)
        if self.hotkey_capturing:
            return "触发键：请按一个键…"
        if not hotkey:
            return "Ctrl 快捷键：关"
        if not hotkey.available:
            return "Ctrl 快捷键：装不上"
        keys = '+'.join(f'VK{v}' for v in sorted(hotkey.accept))
        return f"触发键 {keys}·{hotkey.taps}次"

    def toggle_ai_hotkey(self):
        if getattr(self, 'ai_hotkey', None):
            self.ai_hotkey.close()
            self.ai_hotkey = None
        else:
            import queue as _queue
            from ai_service import load_config as _load_config
            from right_ctrl import RightCtrl, CONTROL_KEYS
            accept = set(CONTROL_KEYS)
            extra = int(_load_config(profile_path().with_name('ai-config.json')).get('hotkey_vk') or 0)
            if extra:
                accept.add(extra)
            self.ai_hotkey = RightCtrl(accept=accept)

    def _capture_hotkey(self):
        """把改键后的那颗键捕获为触发键：点按钮 → 按一下 → 写进配置。"""
        import queue as _queue
        if not getattr(self, 'ai_hotkey', None):
            self.toggle_ai_hotkey()
        self.hotkey_capturing = True
        getattr(self, 'ai_hotkey').start_capture()
        self.root.after(150, self._poll_capture)

    def _poll_capture(self):
        import queue as _queue
        hotkey = getattr(self, 'ai_hotkey', None)
        if not self.hotkey_capturing or not hotkey:
            return
        try:
            vk = hotkey.captured.get_nowait()
        except _queue.Empty:
            self.root.after(150, self._poll_capture)
            return
        self.hotkey_capturing = False
        accept = set(hotkey.accept) | {vk}
        hotkey.set_accept(accept)
        from ai_service import load_config, save_config
        cfg_path = profile_path().with_name('ai-config.json')
        cfg = load_config(cfg_path)
        cfg['hotkey_vk'] = int(vk)
        save_config(cfg_path, cfg)

    def _tick(self) -> None:
        hotkey = getattr(self, 'ai_hotkey', None)
        if hotkey and not hotkey.events.empty():
            while not hotkey.events.empty():
                hotkey.events.get_nowait()
            if getattr(self, 'ai_chat', None) and self.ai_chat.window is not None:
                if self.ai_chat.voice_on:
                    # 语音开着：关输入框 + 关语音
                    self.ai_chat.close_bar_and_voice()
                else:
                    # 输入框开着、语音没开：开启语音
                    self.ai_chat.send_voice_trigger()
            else:
                self.open_ai_chat()
        ai = getattr(self, 'ai_chat', None)
        waiting = bool(ai and ai.waiting)
        # 等回复期间宠物摆思考姿态：这时只跳过“自动状态切换”，帧照常推进，姿态才会动。
        # 被隐藏的宠物不渲染任何帧，没人看得见。
        if not self.pet_hidden and not self.drag_origin and not self.click_timer_id:
            if waiting:
                self._advance_state_frame()
                self._render()
            elif not self.paused or time.monotonic() < self.manual_until:
                self._update_automatic_state()
                self._advance_state_frame()
                self._render()
        self.after_id = self.root.after(90, self._tick)

    def quit(self) -> None:
        if getattr(self, 'ai_hotkey', None):
            self.ai_hotkey.close()
        if getattr(self, 'ai_chat', None):
            self.ai_chat.close()
        if self.greeting_timer_id:
            self.root.after_cancel(self.greeting_timer_id)
            self.greeting_timer_id = None
        self._cancel_single_click()
        if self.after_id:
            self.root.after_cancel(self.after_id)
        self._close_bubble()
        self._close_action_panel()
        if self.tray_icon:
            try:
                self.tray_icon.stop()
            except Exception:
                pass
        self.mic_sampler.close()
        self.root.destroy()


def _acquire_single_instance() -> bool:
    """第二次启动直接退出：双击两次不该跑出两只宠物。"""
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CreateMutexW.argtypes = [wintypes.HANDLE, wintypes.BOOL, wintypes.LPCWSTR]
    handle = kernel32.CreateMutexW(None, False, "CalebDesktopPet.SingleInstance")
    return bool(handle) and kernel32.GetLastError() != 183  # 183 = ERROR_ALREADY_EXISTS


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == '--self-test':
        from package_smoke import run
        raise SystemExit(run(CalebPet, sys.argv[2]))
    if not _acquire_single_instance():
        print("夏以昼已经在运行了：去托盘找它，或者先退出那一只再启动。")
        return
    root = tk.Tk()
    app = CalebPet(root)
    app.toggle_ai_hotkey()
    root.protocol("WM_DELETE_WINDOW", app.quit)
    root.mainloop()


if __name__ == "__main__":
    main()
