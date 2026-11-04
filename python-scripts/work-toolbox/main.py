from __future__ import annotations

import base64
import ctypes
from dataclasses import dataclass
from datetime import datetime, timezone
import importlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import tkinter.font as tkfont
import webbrowser

from pending_inbox import SOURCES as PENDING_SOURCES, PendingStore, PendingSummary, start_pending_server
from daily_note import DailyNote
import aa_draw
from todo_panel import TodoAssistant, TodoPanel, TodoStore
from tool_detail import ToolDetailPanel
from pending_inbox import short_date, relative_time, BADGE_GRAY, BADGE_RED
from daily_note import LOG_HEADING


APP_MUTEX_NAME = "Local\\WorkToolkit.WorkToolbox"
APP_SHOW_EVENT_NAME = "Local\\WorkToolkit.WorkToolbox.Show"
CREATE_NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0x00000010)
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
APP_USER_MODEL_ID = "Medtronic.WorkToolbox"
WIFI_SWITCH_RESULTS = {
    0: ("Wi-Fi / VPN：Zscaler 已验证，已回到旁路由 Wi-Fi", "ok"),
    1: ("Wi-Fi / VPN：公司资源验证失败，已回到旁路由 Wi-Fi", "error"),
    2: ("Wi-Fi / VPN：未能确认回到旁路由 Wi-Fi，请手动检查网络", "error"),
    3: ("Wi-Fi / VPN：已回到旁路由，但回切后公司资源不可达", "error"),
}
CONFIG_FILENAME = "tools.json"
UI_FONT = "Microsoft YaHei UI"
UI_FONT_CANDIDATES = ("Microsoft YaHei UI", "Noto Sans SC")

try:
    from PIL import Image, ImageDraw, ImageFont, ImageTk
except ImportError:
    Image = ImageDraw = ImageFont = ImageTk = None

THEMES = {
    "dark": {
        "bg": "#16171a",
        "panel": "#1e1f23",
        "card": "#25272c",
        "card_hover": "#2f3238",
        "card_press": "#3a3d45",
        "border": "#31343b",
        "text": "#f1f2f4",
        "muted": "#9aa0a8",
        "subtle": "#6c717a",
        "dock": "#1e1f23",
        "dock_border": "#3a3d44",
    },
    "light": {
        "bg": "#f2f3f5",
        "panel": "#ffffff",
        "card": "#ffffff",
        "card_hover": "#eef1f6",
        "card_press": "#e2e7ef",
        "border": "#e1e4e9",
        "text": "#1c1e22",
        "muted": "#646b75",
        "subtle": "#9aa1ab",
        "dock": "#ffffff",
        "dock_border": "#d9dce2",
    },
}
STATUS_TONES = {"ok": "#3ddc84", "warn": "#ffb020", "error": "#ff5c5c", "info": "#9aa0a8"}
DEFAULT_ACCENT = "#31A8FF"

# Adobe-style badge palettes: (dark tile background, bright letter colour).
BADGE_STYLES = {
    "wifi": ("#001E36", "#31A8FF"),
    "globe": ("#0E2A12", "#4BE37D"),
    "fabriq": ("#331405", "#FF7A45"),
    "terminal": ("#00005B", "#9999FF"),
    "play": ("#00005B", "#9999FF"),
    "stop": ("#00005B", "#9999FF"),
    "restart": ("#00005B", "#9999FF"),
    "lock": ("#330000", "#FF9A00"),
    "gear": ("#330000", "#FF9A00"),
    "notes": ("#2B2300", "#FFD21F"),
    "transfer": ("#00262B", "#2FE0E6"),
    "theme": ("#470137", "#FF61F6"),
    "folder": ("#49021F", "#FF3366"),
    "monitor": ("#0B1747", "#6F9BFF"),
    "ssh": ("#062B1F", "#3DDC97"),
    "ai": ("#1F0B33", "#D08CFF"),
    "todo": ("#062B14", "#34C759"),
    "obsidian": ("#1E0B3D", "#A88BFA"),
    "ehr": ("#002A33", "#2FD5FF"),
    "codex": ("#0D0D0D", "#F5F5F5"),
    "workbuddy": ("#002B24", "#19E3B1"),
    "copilot": ("#161B3D", "#8FA2FF"),
    "opencode": ("#241400", "#FFA43B"),
    "cursor": ("#101010", "#C8C8C8"),
    "toolbox": ("#1E1E1E", "#E6E6E6"),
    "app": ("#2D0B47", "#C77DFF"),
}


DEFAULT_DRAWERS = [
    {"title": "网络与远程", "groups": ["网络", "SSH", "RDP"], "columns": 1},
    {"title": "AI Agent", "groups": ["AI Agent"], "columns": 1},
    {"title": "公司系统", "groups": ["公司系统"], "columns": 2},
    {"title": "办公效率", "groups": ["办公效率"], "columns": 2},
    {"title": "工具箱", "groups": ["工具箱管理"], "columns": 2},
]


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def mix_hex(start: str, end: str, ratio: float) -> str:
    a, b = hex_to_rgb(start), hex_to_rgb(end)
    return "#" + "".join(f"{round(x + (y - x) * ratio):02x}" for x, y in zip(a, b))


def build_theme(app_config: dict) -> dict:
    name = str(app_config.get("theme", "dark")).strip().lower()
    if name not in THEMES:
        name = "dark"
    theme = dict(THEMES[name])
    accent = str(app_config.get("accent", DEFAULT_ACCENT)).strip()
    theme["accent"] = accent if re.fullmatch(r"#[0-9a-fA-F]{6}", accent) else DEFAULT_ACCENT
    theme["name"] = name
    return theme


def get_icon_kind(tool_id: str) -> str:
    known = {
        "wifi-zscaler": "wifi",
        "windchill": "globe",
        "fabriq": "fabriq",
        "opencode-status": "terminal",
        "opencode-start": "play",
        "opencode-stop": "stop",
        "opencode-restart": "restart",
        "sfc-login": "lock",
        "uac-password": "lock",
        "sfc-settings": "gear",
        "quick-meeting": "notes",
        "line-tour-transfer": "transfer",
        "toggle-theme": "theme",
        "toolbox-folder": "folder",
        "worktoolkit-folder": "folder",
        "open-toolbox": "brand",
        "ai-chat": "ai",
        "todo": "todo",
        "obsidian": "obsidian",
        "ehr": "ehr",
        "agent-codex": "codex",
        "agent-workbuddy": "workbuddy",
        "agent-copilot": "copilot",
        "agent-opencode": "opencode",
        "agent-cursor": "cursor",
    }
    if tool_id in known:
        return known[tool_id]
    if tool_id.startswith("ssh:"):
        return "ssh"
    if tool_id.startswith("rdp:"):
        return "monitor"
    return "app"


def get_tool_abbr(tool: dict) -> str:
    abbr = str(tool.get("abbr", "")).strip()
    if abbr:
        return abbr[:2]
    source = str(tool.get("label") or tool.get("id") or "")
    if tool.get("kind") == "ssh-host":
        source = str(tool["host"].get("alias") or source)
    words = re.findall(r"[A-Za-z0-9]+", source)
    if len(words) >= 2:
        return words[0][0].upper() + words[1][0].lower()
    if words and len(words[0]) >= 2:
        return words[0][0].upper() + words[0][1].lower()
    if words:
        return words[0][0].upper()
    return source.strip()[:1] or "•"


def get_badge_colors(kind: str, accent: str) -> tuple[str, str]:
    if kind == "brand":
        return mix_hex(accent, "#000000", 0.82), accent
    return BADGE_STYLES.get(kind, BADGE_STYLES["app"])


_FONT_CACHE: dict[tuple[bool, int], object] = {}


def load_badge_font(ascii_text: bool, pixels: int):
    key = (ascii_text, pixels)
    if key not in _FONT_CACHE:
        candidates = ["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"] if ascii_text else ["msyhbd.ttc", "msyh.ttc"]
        font = None
        for name in candidates:
            try:
                font = ImageFont.truetype(name, pixels)
                break
            except OSError:
                continue
        _FONT_CACHE[key] = font or ImageFont.load_default()
    return _FONT_CACHE[key]


def render_badge(abbr: str, kind: str, size: int, accent: str = DEFAULT_ACCENT) -> "Image.Image":
    """Adobe-style app badge: dark rounded tile, thin tinted border, two bright letters."""
    scale = 4
    full = size * scale
    background, foreground = get_badge_colors(kind, accent)
    image = Image.new("RGBA", (full, full), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = round(full * 0.2)
    draw.rounded_rectangle((0, 0, full - 1, full - 1), radius=radius, fill=hex_to_rgb(background) + (255,))
    border = max(scale, round(full * 0.045))
    inset = border / 2
    draw.rounded_rectangle((inset, inset, full - 1 - inset, full - 1 - inset), radius=max(1, radius - inset), outline=hex_to_rgb(foreground) + (120,), width=border)
    ascii_text = abbr.isascii()
    font = load_badge_font(ascii_text, round(full * (0.44 if ascii_text else 0.5)))
    draw.text((full / 2, full / 2 + full * 0.01), abbr, fill=hex_to_rgb(foreground) + (255,), font=font, anchor="mm")
    return image.resize((size, size), Image.LANCZOS)


_BADGE_PHOTOS: dict[tuple, object] = {}


def draw_badge(canvas: tk.Canvas, x: float, y: float, abbr: str, kind: str, size: int, accent: str = DEFAULT_ACCENT) -> None:
    if ImageTk is not None:
        key = (abbr, kind, size, accent)
        if key not in _BADGE_PHOTOS:
            _BADGE_PHOTOS[key] = ImageTk.PhotoImage(render_badge(abbr, kind, size, accent), master=canvas)
        canvas.create_image(x, y, image=_BADGE_PHOTOS[key])
        return
    background, foreground = get_badge_colors(kind, accent)
    half = size / 2
    rounded_polygon(canvas, x - half, y - half, x + half, y + half, size * 0.2, fill=background, outline=foreground)
    canvas.create_text(x, y, text=abbr, fill=foreground, font=("Segoe UI Semibold", -int(size * 0.44)))


_COUNT_PHOTOS: dict[tuple, object] = {}


def draw_count_badge(canvas: tk.Canvas, x: float, y: float, count: int, ring: str, fill: str = "#FF3B30") -> None:
    """iOS-style notification badge centred at (x, y); count 0 draws a dot. Gray fill = stale data."""
    text = "" if count <= 0 else ("99+" if count > 99 else str(count))
    if ImageTk is None:
        radius = 7 if text else 4
        aa_draw.oval(canvas, x - radius, y - radius, x + radius, y + radius, fill=fill, outline=ring, width=2)
        if text:
            canvas.create_text(x, y, text=text, fill="#ffffff", font=("Segoe UI Semibold", -9))
        return
    key = (text, ring, fill)
    if key not in _COUNT_PHOTOS:
        scale = 4
        font = load_badge_font(True, 10 * scale)
        height = (15 if text else 9) * scale
        text_width = int(font.getlength(text)) if text else 0
        width = max(height, text_width + 9 * scale)
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=height // 2, fill=hex_to_rgb(ring) + (255,))
        inset = int(1.5 * scale)
        draw.rounded_rectangle((inset, inset, width - 1 - inset, height - 1 - inset), radius=height // 2 - inset, fill=hex_to_rgb(fill) + (255,))
        if text:
            draw.text((width / 2, height / 2), text, fill=(255, 255, 255, 255), font=font, anchor="mm")
        _COUNT_PHOTOS[key] = ImageTk.PhotoImage(image.resize((width // scale, height // scale), Image.LANCZOS), master=canvas)
    photo = _COUNT_PHOTOS[key]
    canvas.create_image(x, y, image=photo)


def rounded_polygon(canvas: tk.Canvas, x1: float, y1: float, x2: float, y2: float, radius: float, **options) -> int:
    radius = max(0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
    points = [
        x1 + radius, y1, x2 - radius, y1, x2, y1, x2, y1 + radius,
        x2, y2 - radius, x2, y2, x2 - radius, y2, x1 + radius, y2,
        x1, y2, x1, y2 - radius, x1, y1 + radius, x1, y1,
    ]
    return aa_draw.round_rect(canvas, x1, y1, x2, y2, radius, **options)


def resolve_ui_font(root: tk.Misc, preferred: object = None) -> str:
    """Prefer Microsoft YaHei UI: TrueType hinting renders crisply with ClearType under Tk/GDI."""
    global UI_FONT
    families = set(tkfont.families(root))
    candidates = ([str(preferred)] if preferred else []) + list(UI_FONT_CANDIDATES)
    UI_FONT = next((name for name in candidates if name in families), UI_FONT)
    import pending_inbox

    pending_inbox.UI_FONT = UI_FONT
    import todo_panel

    todo_panel.UI_FONT = UI_FONT
    return UI_FONT


def get_native_hwnd(window: tk.Misc) -> int:
    window.update_idletasks()
    return ctypes.windll.user32.GetParent(window.winfo_id()) or window.winfo_id()


def apply_title_bar_theme(window: tk.Misc, dark: bool) -> None:
    try:
        value = ctypes.c_int(1 if dark else 0)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(get_native_hwnd(window), 20, ctypes.byref(value), ctypes.sizeof(value))
    except (AttributeError, OSError):
        pass


def truncate_text(font: tkfont.Font, text: str, width: int) -> str:
    if width <= 0 or font.measure(text) <= width:
        return text
    while text and font.measure(text + "…") > width:
        text = text[:-1]
    return text + "…"


class ToolCard(tk.Canvas):
    """Flat rounded card drawn on a single canvas so hover and tooltips never flicker over child widgets."""

    ACTION_WIDTH = 26

    def __init__(self, parent: tk.Widget, theme: dict, abbr: str, kind: str, title: str, command, subtitle: str = "", layout: str = "row", tag: str = "", action=None, action_active: bool = False, action_glyph: str = "\uE8D7") -> None:
        height = 60 if layout == "stack" else 44
        super().__init__(parent, height=height, background=theme["bg"], highlightthickness=0, bd=0, cursor="hand2")
        self.theme = theme
        self.abbr = abbr
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.tag = tag
        self.layout = layout
        self.command = command
        self.state = "normal"
        self.title_font = tkfont.Font(family=UI_FONT, size=8)
        self.subtitle_font = tkfont.Font(family=UI_FONT, size=7)
        self.tag_font = tkfont.Font(family=UI_FONT, size=6, weight="bold")
        self.action = action
        self.action_active = action_active
        self.action_glyph = action_glyph
        self.action_hover = False
        self.bind("<Motion>", self.on_motion, add="+")
        self.bind("<Configure>", lambda _event: self.redraw(), add="+")
        self.bind("<Enter>", lambda _event: self.set_state("hover"), add="+")
        self.bind("<Leave>", lambda _event: self.set_state("normal"), add="+")
        self.bind("<ButtonPress-1>", lambda _event: self.set_state("press"), add="+")
        self.bind("<ButtonRelease-1>", self.on_release, add="+")

    def in_action(self, x: int) -> bool:
        return self.action is not None and self.layout == "row" and x >= self.winfo_width() - self.ACTION_WIDTH - 6

    def on_motion(self, event: tk.Event) -> None:
        hovered = self.in_action(event.x)
        if hovered != self.action_hover:
            self.action_hover = hovered
            self.redraw()

    def set_state(self, state: str) -> None:
        self.state = state
        if state == "normal":
            self.action_hover = False
        self.redraw()

    def on_release(self, event: tk.Event) -> None:
        inside = 0 <= event.x < self.winfo_width() and 0 <= event.y < self.winfo_height()
        self.set_state("hover" if inside else "normal")
        if inside:
            if self.in_action(event.x):
                self.action()
            else:
                self.command()

    def redraw(self) -> None:
        self.delete("all")
        width = self.winfo_width()
        height = int(self.cget("height"))
        if width <= 4:
            return
        theme = self.theme
        fill = {"hover": theme["card_hover"], "press": theme["card_press"]}.get(self.state, theme["card"])
        outline = theme["accent"] if self.state != "normal" else theme["border"]
        rounded_polygon(self, 1, 1, width - 2, height - 2, 16, fill=fill, outline=outline)
        if self.layout == "stack":
            draw_badge(self, width / 2, 22, self.abbr, self.kind, 26, theme["accent"])
            self.create_text(width / 2, height - 14, text=truncate_text(self.title_font, self.title, width - 10), fill=theme["text"], font=self.title_font)
            return
        draw_badge(self, 22, height / 2, self.abbr, self.kind, 24, theme["accent"])
        text_width = width - 50
        right = width - 10
        if self.action is not None:
            action_left = width - self.ACTION_WIDTH - 6
            if self.action_hover:
                rounded_polygon(self, action_left, height / 2 - 12, width - 6, height / 2 + 12, 12, fill=theme["card_press"], outline="")
            color = theme["accent"] if self.action_active else (theme["text"] if self.action_hover else theme["subtle"])
            self.create_text(action_left + self.ACTION_WIDTH / 2, height / 2, text=self.action_glyph, fill=color, font=("Segoe MDL2 Assets", 10))
            right = action_left - 4
            text_width -= self.ACTION_WIDTH + 6
        if self.tag:
            _, tag_color = get_badge_colors(self.kind, theme["accent"])
            pill_width = self.tag_font.measure(self.tag) + 12
            rounded_polygon(self, right - pill_width, height / 2 - 8, right, height / 2 + 8, 8, fill=mix_hex(tag_color, fill, 0.82), outline=mix_hex(tag_color, fill, 0.45))
            self.create_text(right - pill_width / 2, height / 2, text=self.tag, fill=tag_color, font=self.tag_font)
            text_width -= pill_width + 8
        if self.subtitle:
            self.create_text(42, height / 2 - 8, text=truncate_text(self.title_font, self.title, text_width), fill=theme["text"], font=self.title_font, anchor="w")
            self.create_text(42, height / 2 + 9, text=truncate_text(self.subtitle_font, self.subtitle, text_width), fill=theme["muted"], font=self.subtitle_font, anchor="w")
        else:
            self.create_text(42, height / 2, text=truncate_text(self.title_font, self.title, text_width), fill=theme["text"], font=self.title_font, anchor="w")


TOOL_TYPE_NAMES = {
    "url": "网页", "app": "应用", "exe": "程序", "batch": "批处理", "powershell": "PowerShell 脚本",
    "folder": "文件夹", "sfc-login": "SFC 自动登录", "sfc-settings": "SFC 设置", "secret-copy": "密码快速复制",
    "ai-chat": "AI 助理", "todo": "待办",
}


class FlatButton(tk.Canvas):
    """Rounded pill button drawn on a canvas; hover shows a soft rounded background."""

    def __init__(self, parent: tk.Widget, theme: dict, text: str, command, background: str | None = None, size: int = 9, font_family: str | None = None, square: bool = False) -> None:
        self.theme = theme
        self.base_background = background or theme["panel"]
        self.command = command
        self.text = text
        self.square = square
        self.font = tkfont.Font(family=font_family or UI_FONT, size=size)
        self.hovered = False
        self.pressed = False
        height = self.font.metrics("linespace") + 10
        super().__init__(parent, height=height, width=self.measure_width(height), background=self.base_background, highlightthickness=0, bd=0, cursor="hand2")
        self.bind("<Enter>", lambda _event: self.set_hover(True), add="+")
        self.bind("<Leave>", lambda _event: self.set_hover(False), add="+")
        self.bind("<ButtonPress-1>", lambda _event: self.set_pressed(True), add="+")
        self.bind("<ButtonRelease-1>", self.on_release, add="+")
        self.redraw()

    def measure_width(self, height: int) -> int:
        return height if self.square else self.font.measure(self.text) + 20

    def set_text(self, text: str) -> None:
        self.text = text
        self.configure(width=self.measure_width(int(self.cget("height"))))
        self.redraw()

    def set_hover(self, hovered: bool) -> None:
        self.hovered = hovered
        if not hovered:
            self.pressed = False
        self.redraw()

    def set_pressed(self, pressed: bool) -> None:
        self.pressed = pressed
        self.redraw()

    def redraw(self) -> None:
        self.delete("all")
        width = int(self.cget("width"))
        height = int(self.cget("height"))
        if self.hovered:
            fill = self.theme["card_press"] if self.pressed else self.theme["card_hover"]
            rounded_polygon(self, 1, 1, width - 1, height - 1, height / 2, fill=fill, outline="")
        color = self.theme["text"] if self.hovered else self.theme["muted"]
        self.create_text(width / 2, height / 2, text=self.text, fill=color, font=self.font)

    def on_release(self, event: tk.Event) -> None:
        self.pressed = False
        self.redraw()
        if 0 <= event.x < self.winfo_width() and 0 <= event.y < self.winfo_height():
            self.command()


class DrawerHeader(tk.Canvas):
    """Rounded drawer title bar: chevron, bold title, muted summary."""

    def __init__(self, parent: tk.Widget, theme: dict, title: str, summary: str, command) -> None:
        super().__init__(parent, height=38, background=theme["bg"], highlightthickness=0, bd=0, cursor="hand2")
        self.theme = theme
        self.title = title
        self.summary = summary
        self.command = command
        self.active = False
        self.hovered = False
        self.title_font = tkfont.Font(family=UI_FONT, size=8, weight="bold")
        self.summary_font = tkfont.Font(family=UI_FONT, size=7)
        self.bind("<Configure>", lambda _event: self.redraw(), add="+")
        self.bind("<Enter>", lambda _event: self.set_hover(True), add="+")
        self.bind("<Leave>", lambda _event: self.set_hover(False), add="+")
        self.bind("<ButtonRelease-1>", self.on_release, add="+")

    def set_hover(self, hovered: bool) -> None:
        self.hovered = hovered
        self.redraw()

    def set_active(self, active: bool) -> None:
        self.active = active
        self.redraw()

    def on_release(self, event: tk.Event) -> None:
        if 0 <= event.x < self.winfo_width() and 0 <= event.y < self.winfo_height():
            self.command()

    def redraw(self) -> None:
        self.delete("all")
        width = self.winfo_width()
        height = int(self.cget("height"))
        if width <= 4:
            return
        theme = self.theme
        fill = theme["card_hover"] if self.hovered else theme["panel"]
        outline = theme["accent"] if self.active else theme["border"]
        rounded_polygon(self, 1, 1, width - 2, height - 2, 16, fill=fill, outline=outline)
        self.create_text(18, height / 2, text="▾" if self.active else "▸", fill=theme["accent"] if self.active else theme["muted"], font=(UI_FONT, 10))
        self.create_text(34, height / 2, text=self.title, fill=theme["text"], font=self.title_font, anchor="w")
        self.create_text(width - 16, height / 2, text=self.summary, fill=theme["subtle"], font=self.summary_font, anchor="e")


@dataclass
class CodexStatus:
    state: str
    detail: str
    hover_text: str
    completion_time: datetime | None = None


class CodexSessionMonitor:
    """Read recent Codex JSONL session tails without reading message bodies."""

    TAIL_BYTES = 256 * 1024
    ACTIVE_SECONDS = 120
    COMPLETION_SECONDS = 5 * 60
    ERROR_SECONDS = 10 * 60

    def __init__(self) -> None:
        codex_home = os.environ.get("CODEX_HOME")
        self.sessions_root = Path(codex_home) / "sessions" if codex_home else Path.home() / ".codex" / "sessions"
        self.seen_completions: set[str] = set()
        self.completion_source: str | None = None
        self.completion_time: datetime | None = None

    def read(self) -> CodexStatus:
        if not self.sessions_root.is_dir():
            return CodexStatus("idle", "Codex 空闲", f"状态：空闲\n数据源：{self.sessions_root}\n未找到会话日志")

        try:
            latest_files = sorted(
                self.sessions_root.rglob("*.jsonl"),
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            )[:4]
        except (OSError, RuntimeError) as error:
            return CodexStatus("error", "Codex 状态读取失败", f"状态：读取异常\n错误：{error}")

        if not latest_files:
            return CodexStatus("idle", "Codex 空闲", f"状态：空闲\n数据源：{self.sessions_root}\n未找到会话日志")

        now = datetime.now(timezone.utc)
        candidates: list[dict] = []
        for path in latest_files:
            try:
                snapshot = self.read_tail(path)
                file_time = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
                event_time = snapshot["last_event_time"] or file_time
                age = max(0.0, (now - event_time).total_seconds())
                candidates.append({"path": str(path), "snapshot": snapshot, "age": age})
            except (OSError, UnicodeError) as error:
                candidates.append(
                    {
                        "path": str(path),
                        "snapshot": {
                            "last_event": "error",
                            "last_event_time": None,
                            "completion_id": None,
                            "total_tokens": None,
                            "rate_limit_text": None,
                            "rate_limit_reached": False,
                            "read_error": str(error),
                        },
                        "age": 0.0,
                    }
                )

        for candidate in candidates:
            snapshot = candidate["snapshot"]
            if snapshot["last_event"] != "completed" or candidate["age"] > self.COMPLETION_SECONDS:
                continue
            completion_id = snapshot.get("completion_id")
            if not completion_id:
                continue
            completion_key = f"{candidate['path']}|{completion_id}"
            if completion_key not in self.seen_completions:
                self.seen_completions.add(completion_key)
                self.completion_source = candidate["path"]
                self.completion_time = snapshot["last_event_time"] or now

        if len(self.seen_completions) > 64:
            self.seen_completions = set(list(self.seen_completions)[-64:])

        if self.completion_source:
            source = next((item for item in candidates if item["path"] == self.completion_source), None)
            source_time = source["snapshot"].get("last_event_time") if source else None
            if source and source["snapshot"]["last_event"] == "active" and source_time and self.completion_time and source_time > self.completion_time:
                self.completion_source = None
                self.completion_time = None

        completion_visible = bool(
            self.completion_source
            and self.completion_time
            and (now - self.completion_time).total_seconds() <= self.COMPLETION_SECONDS
        )
        by_age = sorted(candidates, key=lambda item: item["age"])
        error_candidate = next(
            (
                item
                for item in by_age
                if item["age"] <= self.ERROR_SECONDS
                and (
                    item["snapshot"]["rate_limit_reached"]
                    or item["snapshot"]["last_event"] == "error"
                    or item["snapshot"]["last_event"] == "active" and item["age"] > self.ACTIVE_SECONDS
                )
            ),
            None,
        )
        active_candidate = next(
            (
                item
                for item in by_age
                if item["snapshot"]["last_event"] == "active" and item["age"] <= self.ACTIVE_SECONDS
            ),
            None,
        )
        completion_candidate = next((item for item in candidates if item["path"] == self.completion_source), None)
        display_candidate = error_candidate or (completion_candidate if completion_visible else None) or active_candidate or by_age[0]
        snapshot = display_candidate["snapshot"]

        if error_candidate:
            state, detail = "error", "额度受限或任务异常"
        elif completion_visible:
            state, detail = "recently_stopped", "任务刚完成"
        elif active_candidate:
            state, detail = "active", "任务执行中"
        else:
            state, detail = "idle", "Codex 空闲"

        token_text = f"\n会话累计 Token：{snapshot['total_tokens']:,}" if snapshot.get("total_tokens") is not None else ""
        quota_text = snapshot.get("rate_limit_text") or "当前供应商未返回额度"
        hover = (
            f"状态：{detail}\n数据源：Codex 会话日志\n最近活动：{self.format_age(display_candidate['age'])}"
            f"{token_text}\n额度：{quota_text}\n文件：{display_candidate['path']}"
        )
        return CodexStatus(state, detail, hover, self.completion_time if state == "recently_stopped" else None)

    @classmethod
    def read_tail(cls, path: Path) -> dict:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - cls.TAIL_BYTES))
            raw = stream.read()

        text = raw.decode("utf-8", errors="replace")
        if raw and not text.startswith("{"):
            _, _, text = text.partition("\n")
        snapshot = {
            "last_event": "none",
            "last_event_time": None,
            "completion_id": None,
            "total_tokens": None,
            "rate_limit_text": None,
            "rate_limit_reached": False,
        }
        for line in text.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            payload_type = payload.get("type")
            timestamp = cls.parse_timestamp(event.get("timestamp"))
            if event_type == "event_msg" and payload_type == "task_complete":
                snapshot.update(last_event="completed", last_event_time=timestamp, completion_id=timestamp.isoformat() if timestamp else str(hash(line)))
            elif event_type == "event_msg" and payload_type in {"error", "stream_error", "task_aborted"}:
                snapshot.update(last_event="error", last_event_time=timestamp)
            elif cls.is_activity(event_type, payload_type):
                snapshot.update(last_event="active", last_event_time=timestamp)

            if event_type == "event_msg" and payload_type == "token_count":
                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                usage = info.get("total_token_usage") if isinstance(info.get("total_token_usage"), dict) else {}
                total_tokens = usage.get("total_tokens")
                if isinstance(total_tokens, (int, float)):
                    snapshot["total_tokens"] = int(total_tokens)
                rate_limits = payload.get("rate_limits")
                if isinstance(rate_limits, dict):
                    snapshot["rate_limit_text"] = cls.format_rate_limits(rate_limits)
                    snapshot["rate_limit_reached"] = cls.is_rate_limit_reached(rate_limits)
        return snapshot

    @staticmethod
    def is_activity(event_type: str | None, payload_type: str | None) -> bool:
        return event_type in {"response_item", "compacted", "turn_context", "world_state"} or (
            event_type == "event_msg"
            and payload_type in {"agent_reasoning", "agent_message", "token_count", "mcp_tool_call_end", "patch_apply_end"}
        )

    @staticmethod
    def parse_timestamp(value: object) -> datetime | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            return None

    @staticmethod
    def format_rate_limits(rate_limits: dict) -> str | None:
        windows = []
        for name, label in (("primary", "主窗口"), ("secondary", "次窗口")):
            window = rate_limits.get(name)
            used = window.get("used_percent") if isinstance(window, dict) else None
            if not isinstance(used, (int, float)):
                continue
            minutes = window.get("window_minutes")
            if isinstance(minutes, (int, float)):
                label = f"{round(minutes / 1440):.0f} 天" if minutes >= 1440 else f"{round(minutes / 60):.0f} 小时"
            windows.append(f"{label}剩余 {max(0, min(100, 100 - float(used))):.0f}%")
        return "；".join(windows) if windows else None

    @staticmethod
    def is_rate_limit_reached(rate_limits: dict) -> bool:
        if isinstance(rate_limits.get("rate_limit_reached_type"), str) and rate_limits["rate_limit_reached_type"].strip():
            return True
        return any(
            isinstance(rate_limits.get(name), dict)
            and isinstance(rate_limits[name].get("used_percent"), (int, float))
            and float(rate_limits[name]["used_percent"]) >= 100
            for name in ("primary", "secondary")
        )

    @staticmethod
    def format_age(seconds: float) -> str:
        if seconds < 60:
            return f"{max(0, int(seconds))} 秒前"
        if seconds < 3600:
            return f"{int(seconds // 60)} 分钟前"
        return f"{int(seconds // 3600)} 小时前"


def get_sfc_integration():
    import importlib
    import importlib.util

    if not getattr(sys, "frozen", False):
        return importlib.import_module("sfc_integration")
    candidates = [
        Path(sys.executable).resolve().parent / "sfc_integration.py",
        get_toolkit_root() / "python-scripts" / "work-toolbox" / "sfc_integration.py",
    ]
    module_path = next((path for path in candidates if path.is_file()), None)
    if module_path is None:
        raise FileNotFoundError("找不到工作工具箱内置的 SFC 模块。")
    site_packages = get_toolkit_root() / ".venv" / "Lib" / "site-packages"
    if site_packages.is_dir() and str(site_packages) not in sys.path:
        sys.path.insert(0, str(site_packages))
    module_name = "work_toolbox_sfc_integration"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 SFC 模块：{module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def write_startup_error(message: str) -> None:
    path = Path(os.environ.get("TEMP", str(Path.home()))) / "WorkToolbox-startup-error.log"
    try:
        with path.open("a", encoding="utf-8") as file:
            file.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}]\n{message}\n\n")
    except OSError:
        pass


def get_desktop_path() -> Path:
    candidates = []
    for env_name in ("OneDriveCommercial", "OneDrive"):
        if os.environ.get(env_name):
            candidates.append(Path(os.environ[env_name]) / "Desktop")
    if os.environ.get("USERPROFILE"):
        candidates.append(Path(os.environ["USERPROFILE"]) / "Desktop")
    return next((candidate for candidate in candidates if candidate.is_dir()), candidates[-1] if candidates else Path.home() / "Desktop")


def get_codespace_root() -> Path:
    if os.environ.get("CODESPACE_ROOT"):
        return Path(os.environ["CODESPACE_ROOT"])
    for candidate in (Path(r"C:\CodeSpace"), Path(r"C:\CodeSpeace")):
        if candidate.is_dir():
            return candidate
    return Path(__file__).resolve().parents[3]


def get_toolkit_root() -> Path:
    if getattr(sys, "frozen", False):
        installed_root = get_codespace_root() / "Work-Toolkit"
        if installed_root.is_dir():
            return installed_root
        return Path(sys.executable).resolve().parents[3]
    return Path(__file__).resolve().parents[2]


def get_local_toolkit_root() -> Path:
    return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Work-Toolkit-Local"


def get_config_candidates() -> list[Path]:
    if getattr(sys, "frozen", False):
        return [
            Path(sys.executable).resolve().parent / CONFIG_FILENAME,
            get_toolkit_root() / "python-scripts" / "work-toolbox" / CONFIG_FILENAME,
            Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent)) / CONFIG_FILENAME,
        ]
    return [Path(__file__).resolve().parent / CONFIG_FILENAME]


def resolve_value(value: str) -> str:
    replacements = {
        "{CODESPACE}": str(get_codespace_root()),
        "{WORK_TOOLKIT}": str(get_toolkit_root()),
        "{DESKTOP}": str(get_desktop_path()),
        "{LOCAL_TOOLKIT}": str(get_local_toolkit_root()),
        "{USERPROFILE}": os.environ.get("USERPROFILE", str(Path.home())),
        "{LOCALAPPDATA}": os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")),
    }
    for token, replacement in replacements.items():
        value = value.replace(token, replacement)
    return os.path.expandvars(os.path.expanduser(value))


def find_ssh_executable() -> str | None:
    found = shutil.which("ssh.exe") or shutil.which("ssh")
    if found:
        return found
    candidate = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "OpenSSH" / "ssh.exe"
    return str(candidate) if candidate.is_file() else None


def parse_ssh_config(config_path: Path) -> list[dict]:
    if not config_path.is_file():
        return []
    try:
        content = config_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        return []
    hosts = []
    active = []
    known = set()
    for raw_line in content.splitlines():
        line = re.sub(r"\s+#.*$", "", raw_line.strip())
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        key, value = parts[0].lower(), parts[1].strip()
        if key == "host":
            active = []
            aliases = [alias for alias in value.split() if not alias.startswith(("!", "*", "?")) and alias not in known]
            if aliases:
                # One "Host a b" line is a single server with several aliases, not several servers.
                entry = {"alias": aliases[0], "aliases": aliases, "display_name": aliases[0], "hostname": aliases[0], "user": "", "port": 22, "config_path": str(config_path)}
                hosts.append(entry)
                active.append(entry)
                known.update(aliases)
        elif active and key == "hostname":
            for host in active:
                host["hostname"] = value
        elif active and key == "user":
            for host in active:
                host["user"] = value
        elif active and key == "port":
            try:
                port = int(value)
            except ValueError:
                port = 22
            for host in active:
                host["port"] = port
    return hosts


def load_extra_ssh_settings(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def read_rdp_profile(path: Path) -> dict | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    text = ""
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            candidate = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        if re.search(r"(?im)^\s*full address:", candidate):
            text = candidate
            break
    if not text:
        return None
    values = {}
    for line in text.splitlines():
        match = re.match(r"^([^:]+):[^:]*:(.*)$", line.strip())
        if match:
            values[match.group(1).lower()] = match.group(2).strip()
    address = values.get("full address", "")
    return {"name": path.stem, "address": address, "username": values.get("username", ""), "path": str(path)} if address else None


def find_rdp_profiles(paths: list[Path]) -> list[dict]:
    profiles = []
    seen_paths = set()
    for search_path in paths:
        if search_path.is_file() and search_path.suffix.lower() == ".rdp":
            candidates = [search_path]
        elif search_path.is_dir():
            candidates = sorted(search_path.rglob("*.rdp"), key=lambda path: str(path).lower())
        else:
            candidates = []
        for path in candidates:
            normalized = str(path.resolve()).lower()
            if normalized in seen_paths:
                continue
            seen_paths.add(normalized)
            profile = read_rdp_profile(path)
            if profile:
                profiles.append(profile)
    unique = {}
    for profile in profiles:
        address = profile["address"].lower()
        current = unique.get(address)
        if current is None or (current["name"].lower().startswith("default") and not profile["name"].lower().startswith("default")):
            unique[address] = profile
    return list(unique.values())


def set_clipboard_private(text: str) -> bool:
    """Put text on the Windows clipboard, excluded from Win+V history and cloud sync."""
    if os.name != "nt":
        return False
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    user32.RegisterClipboardFormatW.restype = wintypes.UINT
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]

    def put(fmt: int, data: bytes) -> bool:
        handle = kernel32.GlobalAlloc(0x0002, len(data))
        if not handle:
            return False
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            kernel32.GlobalFree(handle)
            return False
        ctypes.memmove(pointer, data, len(data))
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(fmt, handle):
            kernel32.GlobalFree(handle)
            return False
        return True

    for _attempt in range(5):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.03)
    else:
        return False
    try:
        user32.EmptyClipboard()
        if not put(13, (text + "\0").encode("utf-16-le")):
            return False
        zero = (0).to_bytes(4, "little")
        put(user32.RegisterClipboardFormatW("ExcludeClipboardContentFromMonitorProcessing"), zero)
        put(user32.RegisterClipboardFormatW("CanIncludeInClipboardHistory"), zero)
        put(user32.RegisterClipboardFormatW("CanUploadToCloudClipboard"), zero)
        return True
    finally:
        user32.CloseClipboard()


class RdpProfileStore:
    """Per-user RDP display names and DPAPI-protected passwords, keyed by server address.

    Lives in %LOCALAPPDATA%\\WorkToolbox\\rdp-profiles.json, outside the repository.
    """

    def __init__(self) -> None:
        local_app_data = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        self.path = Path(local_app_data) / "WorkToolbox" / "rdp-profiles.json"

    def read_all(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return {}
        profiles = data.get("profiles") if isinstance(data, dict) else None
        return profiles if isinstance(profiles, dict) else {}

    def get(self, address: str) -> dict:
        entry = self.read_all().get(address.lower())
        return entry if isinstance(entry, dict) else {}

    def save(self, address: str, label: str | None = None, password: str | None = None) -> None:
        """label/password None keeps the stored value; password '' removes it."""
        profiles = self.read_all()
        entry = dict(profiles.get(address.lower()) or {})
        if label is not None:
            if label:
                entry["label"] = label
            else:
                entry.pop("label", None)
        if password is not None:
            if password:
                from ai_service import protect
                entry["password_dpapi"] = base64.b64encode(protect(password.encode("utf-8"))).decode("ascii")
            else:
                entry.pop("password_dpapi", None)
        profiles[address.lower()] = entry
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"profiles": profiles}, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path)

    def has_password(self, address: str) -> bool:
        return bool(self.get(address).get("password_dpapi"))

    def password(self, address: str) -> str:
        blob = self.get(address).get("password_dpapi")
        if not blob:
            return ""
        try:
            from ai_service import protect
            return protect(base64.b64decode(blob), decrypt=True).decode("utf-8")
        except (OSError, ValueError, UnicodeError):
            return ""


class ToolTip:
    def __init__(self, widget: tk.Widget, text: str, delay_ms: int = 450, title: str = "", placement: str = "below"):
        self.widget = widget
        self.text = text
        self.title = title
        self.placement = placement
        self.delay_ms = delay_ms
        self.tip_window: tk.Toplevel | None = None
        self.after_id: str | None = None
        widget.bind("<Enter>", self.on_enter, add="+")
        widget.bind("<Leave>", self.on_leave, add="+")
        widget.bind("<ButtonPress>", self.on_leave, add="+")

    def on_enter(self, _event: tk.Event) -> None:
        self.cancel_pending()
        self.after_id = self.widget.after(self.delay_ms, self.show)

    def on_leave(self, _event: tk.Event) -> None:
        self.cancel_pending()
        self.hide()

    def cancel_pending(self) -> None:
        if self.after_id is not None:
            try:
                self.widget.after_cancel(self.after_id)
            except tk.TclError:
                pass
            self.after_id = None

    def show(self) -> None:
        self.after_id = None
        if self.tip_window is not None or not self.widget.winfo_exists():
            return
        self.tip_window = tk.Toplevel(self.widget)
        self.tip_window.wm_overrideredirect(True)
        self.tip_window.wm_attributes("-topmost", True)
        frame = tk.Frame(self.tip_window, background="#2b2e34", highlightthickness=1, highlightbackground="#454952", padx=9, pady=6)
        frame.pack()
        if self.title:
            tk.Label(frame, text=self.title, justify="left", background="#2b2e34", foreground="#ffffff", font=(UI_FONT, 9, "bold")).pack(anchor="w")
        if self.text:
            tk.Label(frame, text=self.text, justify="left", wraplength=260, background="#2b2e34", foreground="#c9ccd1" if self.title else "#f1f2f4", font=(UI_FONT, 8)).pack(anchor="w")
        self.tip_window.update_idletasks()
        left, top, right, bottom = get_primary_screen_area()
        tip_width = self.tip_window.winfo_reqwidth()
        tip_height = self.tip_window.winfo_reqheight()
        if self.placement == "above":
            owner = self.widget.winfo_toplevel()
            x = self.widget.winfo_rootx() + self.widget.winfo_width() // 2 - tip_width // 2
            y = owner.winfo_rooty() - tip_height - 8
            if y < top:
                y = owner.winfo_rooty() + owner.winfo_height() + 8
        else:
            x = self.widget.winfo_rootx() + 12
            below_y = self.widget.winfo_rooty() + self.widget.winfo_height() + 6
            if below_y + tip_height > bottom:
                y = self.widget.winfo_rooty() - tip_height - 6
            else:
                y = below_y
        x = max(left + 4, min(x, right - tip_width - 4))
        y = max(top + 4, y)
        self.tip_window.geometry(f"+{x}+{y}")

    def hide(self) -> None:
        if self.tip_window is not None:
            self.tip_window.destroy()
            self.tip_window = None


def get_taskbar_color() -> str | None:
    """Approximate the Windows taskbar colour so the dock blends in beside or on top of it."""
    if os.name != "nt":
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
            def read(name: str, default: int) -> int:
                try:
                    return int(winreg.QueryValueEx(key, name)[0])
                except OSError:
                    return default
            light = read("SystemUsesLightTheme", 0) == 1
            accent_taskbar = read("ColorPrevalence", 0) == 1
        if accent_taskbar and not light:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent") as key:
                abgr = int(winreg.QueryValueEx(key, "AccentColorMenu")[0])
            return f"#{abgr & 0xFF:02x}{(abgr >> 8) & 0xFF:02x}{(abgr >> 16) & 0xFF:02x}"
    except (OSError, ValueError):
        return None
    windows_11 = sys.getwindowsversion().build >= 22000
    if light:
        return "#eeeeee" if windows_11 else "#dadada"
    return "#1c1c1c" if windows_11 else "#101010"


def get_primary_work_area() -> tuple[int, int, int, int]:
    if os.name == "nt":
        class Rect(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
        rect = Rect()
        try:
            if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
                return rect.left, rect.top, rect.right, rect.bottom
        except (AttributeError, OSError):
            pass
    return 0, 0, 1920, 1080


def get_primary_screen_area() -> tuple[int, int, int, int]:
    if os.name == "nt":
        try:
            user32 = ctypes.windll.user32
            return (
                int(user32.GetSystemMetrics(76)),
                int(user32.GetSystemMetrics(77)),
                int(user32.GetSystemMetrics(76) + user32.GetSystemMetrics(78)),
                int(user32.GetSystemMetrics(77) + user32.GetSystemMetrics(79)),
            )
        except (AttributeError, OSError):
            pass
    return 0, 0, 1920, 1080


class FloatingToolbox:
    POLL_SECONDS = 3
    ICON_SIZE = 30
    ICON_HOVER_SIZE = 34
    ICON_PRESS_SIZE = 27
    ICON_BOX = 38
    STATUS_COLORS = {"error": "#ff5c5c", "recently_stopped": "#ffb020", "active": "#3ddc84"}

    def __init__(self, owner: "WorkToolbox") -> None:
        self.owner = owner
        self.theme = owner.theme
        dock_settings = owner.config.get("app", {}).get("floating_dock", {})
        dock_background = str(dock_settings.get("background", "taskbar")) if isinstance(dock_settings, dict) else "taskbar"
        if re.fullmatch(r"#[0-9a-fA-F]{6}", dock_background):
            self.BACKGROUND = dock_background
        else:
            self.BACKGROUND = get_taskbar_color() or self.theme["dock"]
        self.DOCK_BORDER = self.theme["dock_border"]
        self.MUTED = self.theme["subtle"]
        app_config = owner.config.get("app", {})
        dock_config = app_config.get("floating_dock", {})
        if not isinstance(dock_config, dict):
            dock_config = {}
        self.remember_position = bool(dock_config.get("remember_position", True))
        self.dock_state_path = self.get_dock_state_path()
        saved_state = self.load_dock_state()
        self.locked = bool(saved_state.get("locked", dock_config.get("lock_position", False)))
        saved_position = saved_state.get("position")
        self.saved_position = (
            (int(saved_position[0]), int(saved_position[1]))
            if self.remember_position
            and isinstance(saved_position, list)
            and len(saved_position) == 2
            and all(isinstance(value, (int, float)) for value in saved_position)
            else None
        )
        self.window = tk.Toplevel(owner.root)
        self.window.overrideredirect(True)
        self.window.wm_attributes("-topmost", True)
        self.window.configure(background=self.BACKGROUND)
        self.window.protocol("WM_DELETE_WINDOW", self.hide)
        self._drag_origin: dict | None = None
        self._poll_id: str | None = None
        self._poll_running = False
        self._status_tooltip: ToolTip | None = None
        self._tooltips: list[ToolTip] = []
        self._icon_items: list[dict] = []
        self.pending_summary: PendingSummary | None = None
        self.tool_detail: ToolDetailPanel | None = None
        self.tool_detail_id = ""
        self.tool_detail_anchor: tk.Widget | None = None
        self._status_visible = False
        self.build_ui()
        self.position_at_startup()
        self.bind_drag_events()
        self.create_context_menu()
        self.apply_rounded_corners()
        self.owner.set_floating_button_text("隐藏悬浮框")
        self._win_event_hook = None
        self._win_event_proc = None
        self.install_topmost_guard()
        self.window.after(500, self.ensure_topmost)
        self.poll_status()

    def build_ui(self) -> None:
        shell = tk.Frame(self.window, background=self.BACKGROUND, padx=7, pady=5)
        shell.pack(fill="both", expand=True)
        shell.columnconfigure(2, weight=1)

        self.status_slot = tk.Frame(shell, background=self.BACKGROUND, width=16, height=self.ICON_BOX)
        self.status_slot.grid(row=0, column=0, sticky="ns", padx=(0, 4))
        self.status_slot.grid_propagate(False)
        self.status_canvas = tk.Canvas(self.status_slot, width=16, height=self.ICON_BOX, background=self.BACKGROUND, highlightthickness=0, bd=0)
        self.status_canvas.pack(fill="both", expand=True)
        self._status_tooltip = ToolTip(self.status_canvas, "Codex 空闲")
        self._tooltips.append(self._status_tooltip)
        self.status_separator = tk.Frame(shell, background=self.BACKGROUND, width=1, height=self.ICON_BOX - 14)
        self.status_separator.grid(row=0, column=1, padx=(0, 4))

        quick_bar = tk.Frame(shell, background=self.BACKGROUND)
        quick_bar.grid(row=0, column=2, sticky="nsew")
        self.drag_widgets = [self.window, shell, self.status_slot, self.status_canvas, self.status_separator, quick_bar]
        self.quick_bar = quick_bar
        self.populate_quick_bar()
        self.draw_status(CodexStatus("idle", "Codex 空闲", "状态：空闲"))

    def populate_quick_bar(self) -> None:
        for tool_id in self.owner.floating_tool_ids():
            tool = self.owner.tool_catalog.get(tool_id)
            if tool is not None:
                self.create_icon_item(self.quick_bar, tool, lambda current=tool: self.owner.execute_tool(current))

    def reload_tools(self) -> None:
        """悬浮栏按钮增删或排序后,原地重建图标并保持左下角位置不跳动。"""
        for item in self._icon_items:
            tooltip = item.get("tooltip")
            if tooltip is not None:
                tooltip.hide()
                if tooltip in self._tooltips:
                    self._tooltips.remove(tooltip)
            item["tile"].destroy()
        self._icon_items = []
        self.populate_quick_bar()
        self.window.update_idletasks()
        x, y = self.get_clamped_position(self.window.winfo_x(), self.window.winfo_y())
        self.window.geometry(f"+{x}+{y}")

    def apply_rounded_corners(self) -> None:
        # Windows 11 DWM rounds the borderless dock; DWMWA_COLOR_NONE removes the outline so it blends into the taskbar.
        try:
            hwnd = get_native_hwnd(self.window)
            preference = ctypes.c_int(2)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(preference), ctypes.sizeof(preference))
            border = ctypes.c_uint(0xFFFFFFFE)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 34, ctypes.byref(border), ctypes.sizeof(border))
        except (AttributeError, OSError):
            pass

    def bind_drag_events(self) -> None:
        for widget in self.drag_widgets:
            widget.bind("<ButtonPress-1>", self.begin_drag, add="+")
            widget.bind("<B1-Motion>", self.drag, add="+")
            widget.bind("<ButtonRelease-1>", self.end_drag, add="+")
            widget.bind("<Button-3>", self.show_context_menu, add="+")

    def create_icon_item(self, parent: tk.Widget, tool: dict, command) -> None:
        tile = tk.Canvas(parent, background=self.BACKGROUND, width=self.ICON_BOX, height=self.ICON_BOX, highlightthickness=0, bd=0, cursor="hand2")
        tile.pack(side="left", padx=1)
        tool_id = str(tool.get("id", ""))
        item = {"tile": tile, "tool_id": tool_id, "command": command, "icon_kind": get_icon_kind(tool_id), "abbr": get_tool_abbr(tool), "icon_size": self.ICON_SIZE, "hovered": False, "animation_id": None}
        self._icon_items.append(item)
        self.redraw_icon(item)
        tile.bind("<Enter>", lambda _event, current=item: self.animate_icon(current, True), add="+")
        tile.bind("<Leave>", lambda _event, current=item: self.animate_icon(current, False), add="+")
        tile.bind("<ButtonPress-1>", lambda event, current=item: self.press_icon(current, event), add="+")
        tile.bind("<B1-Motion>", self.drag, add="+")
        tile.bind("<ButtonRelease-1>", lambda event, current=item: self.release_icon(current, event), add="+")
        # "break" stops the toplevel binding so icons never open the dock command menu.
        tile.bind("<Button-3>", lambda _event, current=tile: (self.show_pending_summary(current) if tool_id == "ai-chat" else self.owner.open_todo_panel(current) if tool_id == "todo" else self.show_tool_detail(current, tool_id), "break")[1])
        title = str(tool.get("label", tool.get("id", "工具")))
        description = str(tool.get("description", "")).strip()
        if tool_id == "ai-chat":
            description = (description + "\n" if description else "") + "右键查看待处理汇总"
        elif tool_id != "todo":
            description = (description + "\n" if description else "") + "右键查看详情"
        item["tooltip"] = ToolTip(tile, description, delay_ms=250, title=title, placement="above")
        self._tooltips.append(item["tooltip"])

    def redraw_icon(self, item: dict) -> None:
        canvas = item["tile"]
        canvas.delete("all")
        draw_badge(canvas, self.ICON_BOX / 2, self.ICON_BOX / 2, item["abbr"], item["icon_kind"], int(item["icon_size"]), self.theme["accent"])
        tool_id = item.get("tool_id", "")
        store = self.owner.pending_store
        if tool_id == "ai-chat":
            if store.total() > 0 or self.owner.todo_store.due_count() > 0:
                draw_count_badge(canvas, self.ICON_BOX - 7, 7, 0, self.BACKGROUND)
        elif tool_id == "todo":
            count = self.owner.todo_store.due_count()
            if count > 0:
                draw_count_badge(canvas, self.ICON_BOX - 9, 8, count, self.BACKGROUND)
        elif tool_id in PENDING_SOURCES:
            count = store.count(tool_id)
            if count > 0:
                fill = "#8E8E93" if store.is_stale(tool_id) else "#FF3B30"
                draw_count_badge(canvas, self.ICON_BOX - 9, 8, count, self.BACKGROUND, fill)

    def refresh_badges(self) -> None:
        for item in self._icon_items:
            if item.get("tool_id") in PENDING_SOURCES or item.get("tool_id") in ("ai-chat", "todo"):
                self.redraw_icon(item)
        if self.pending_summary is not None and self.pending_summary.exists():
            anchor = self.pending_summary_anchor
            self.pending_summary.close()
            self.show_pending_summary(anchor)
        if self.tool_detail is not None and self.tool_detail.exists() and self.tool_detail_id in PENDING_SOURCES:
            self.tool_detail.close()
            self.show_tool_detail(self.tool_detail_anchor, self.tool_detail_id, toggle=False)

    def show_pending_summary(self, anchor: tk.Widget) -> None:
        if self.pending_summary is not None and self.pending_summary.exists():
            self.pending_summary.close()
            self.pending_summary = None
            return
        self.pending_summary_anchor = anchor
        self.pending_summary = PendingSummary(
            self.window,
            self.theme,
            self.owner.pending_store,
            lambda canvas, tool_id, size: draw_badge(canvas, size / 2 + 1, size / 2 + 1, get_tool_abbr(self.owner.tool_catalog.get(tool_id, {"id": tool_id})), get_icon_kind(tool_id), size, self.theme["accent"]),
            self.open_pending_tool,
            todo_store=self.owner.todo_store,
            on_open_todos=lambda: self.owner.open_todo_panel(),
        )
        self.pending_summary.show_near(anchor)

    def draw_tool_icon(self, canvas: tk.Canvas, tool_id: str, size: int) -> None:
        tool = self.owner.tool_catalog.get(tool_id, {"id": tool_id})
        draw_badge(canvas, size / 2 + 1, size / 2 + 1, get_tool_abbr(tool), get_icon_kind(tool_id), size, self.theme["accent"])

    def show_tool_detail(self, anchor: tk.Widget, tool_id: str, toggle: bool = True) -> None:
        current = self.tool_detail
        if current is not None and current.exists():
            current.close()
            if toggle and self.tool_detail_id == tool_id:
                self.tool_detail = None
                return
        if self.pending_summary is not None and self.pending_summary.exists():
            self.pending_summary.close()
        tool = self.owner.tool_catalog.get(tool_id)
        if tool is None:
            return
        self.tool_detail_id = tool_id
        self.tool_detail_anchor = anchor
        panel = ToolDetailPanel(self.window, self.theme)
        self.tool_detail = panel
        try:
            self.owner.build_tool_detail(panel, tool, lambda canvas, size: self.draw_tool_icon(canvas, tool_id, size))
        except Exception as error:  # a broken detail page must never break the dock
            panel.note(panel.section("错误"), f"详情加载失败：{error}", "#ffb020")
        panel.show_above(anchor)

    def icon_tile(self, tool_id: str) -> tk.Widget | None:
        for item in self._icon_items:
            if item.get("tool_id") == tool_id:
                return item["tile"]
        return None

    def open_pending_tool(self, tool_id: str) -> None:
        tool = self.owner.tool_catalog.get(tool_id)
        if tool is not None:
            self.owner.execute_tool(tool)
        else:
            webbrowser.open(PENDING_SOURCES[tool_id]["url"])

    def animate_icon(self, item: dict, hovered: bool) -> None:
        item["hovered"] = hovered
        if item["animation_id"] is not None:
            try:
                item["tile"].after_cancel(item["animation_id"])
            except tk.TclError:
                pass
            item["animation_id"] = None
        self.animate_icon_step(item, self.ICON_HOVER_SIZE if hovered else self.ICON_SIZE)

    def animate_icon_step(self, item: dict, target: int) -> None:
        canvas = item["tile"]
        if not canvas.winfo_exists():
            return
        current = int(item["icon_size"])
        if current == target:
            self.redraw_icon(item)
            return
        step = 2 if abs(target - current) > 2 else 1
        item["icon_size"] = current + step if current < target else current - step
        self.redraw_icon(item)
        item["animation_id"] = canvas.after(18, lambda: self.animate_icon_step(item, target))

    def press_icon(self, item: dict, event: tk.Event) -> None:
        self.begin_drag(event)
        if item["animation_id"] is not None:
            try:
                item["tile"].after_cancel(item["animation_id"])
            except tk.TclError:
                pass
            item["animation_id"] = None
        item["icon_size"] = self.ICON_PRESS_SIZE
        self.redraw_icon(item)

    def release_icon(self, item: dict, event: tk.Event) -> None:
        moved = bool(self._drag_origin and self._drag_origin.get("moved"))
        self.end_drag(event)
        if moved:
            self.animate_icon(item, item["hovered"])
        else:
            self.activate_icon(item)

    def activate_icon(self, item: dict) -> None:
        self.animate_icon(item, item["hovered"])
        item["command"]()

    def create_context_menu(self) -> None:
        self.locked_var = tk.BooleanVar(value=self.locked)
        self.context_menu = tk.Menu(self.window, tearoff=False, font=(UI_FONT, 9), background=self.theme["panel"], foreground=self.theme["text"], activebackground=self.theme["accent"], activeforeground="#ffffff", borderwidth=0)
        self.context_menu.add_command(label="打开完整工具箱", command=self.open_main)
        self.context_menu.add_command(label="待处理汇总", command=lambda: self.show_pending_summary(next((item["tile"] for item in self._icon_items if item.get("tool_id") == "ai-chat"), self.window)))
        self.context_menu.add_command(label="刷新 Codex 状态", command=self.refresh_now)
        self.context_menu.add_separator()
        self.context_menu.add_checkbutton(label="锁定位置", variable=self.locked_var, command=self.toggle_lock)
        self.context_menu.add_command(label="恢复默认位置", command=self.reset_position)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="隐藏悬浮框", command=self.hide)
        self.context_menu.add_command(label="退出工具箱", command=self.owner.close)

    def show_context_menu(self, event: tk.Event) -> None:
        try:
            self.context_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.context_menu.grab_release()

    @staticmethod
    def get_dock_state_path() -> Path:
        local_app_data = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        return Path(local_app_data) / "WorkToolbox" / "floating-dock.json"

    def load_dock_state(self) -> dict:
        try:
            data = json.loads(self.dock_state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def save_dock_state(self) -> None:
        state = {"locked": self.locked}
        if self.remember_position:
            state["position"] = [self.window.winfo_x(), self.window.winfo_y()]
        try:
            self.dock_state_path.parent.mkdir(parents=True, exist_ok=True)
            self.dock_state_path.write_text(json.dumps(state, ensure_ascii=True, indent=2), encoding="utf-8")
        except OSError:
            pass

    def get_clamped_position(self, x: int, y: int) -> tuple[int, int]:
        self.window.update_idletasks()
        left, top, right, bottom = get_primary_screen_area()
        width = self.window.winfo_reqwidth()
        height = self.window.winfo_reqheight()
        return (
            max(left, min(int(x), right - width)),
            max(top, min(int(y), bottom - height)),
        )

    def position_at_startup(self) -> None:
        if self.saved_position is not None:
            x, y = self.get_clamped_position(*self.saved_position)
        else:
            self.window.update_idletasks()
            left, _top, _right, bottom = get_primary_work_area()
            x, y = self.get_clamped_position(left + 12, bottom - self.window.winfo_reqheight() - 12)
        self.window.geometry(f"+{x}+{y}")

    def begin_drag(self, event: tk.Event) -> None:
        if self.locked:
            return
        self._drag_origin = {
            "offset": (event.x_root - self.window.winfo_x(), event.y_root - self.window.winfo_y()),
            "start": (event.x_root, event.y_root),
            "moved": False,
        }

    def drag(self, event: tk.Event) -> None:
        if self._drag_origin is not None and not self.locked:
            offset_x, offset_y = self._drag_origin["offset"]
            start_x, start_y = self._drag_origin["start"]
            if abs(event.x_root - start_x) + abs(event.y_root - start_y) >= 4:
                self._drag_origin["moved"] = True
            self.window.geometry(f"+{event.x_root - offset_x}+{event.y_root - offset_y}")

    def end_drag(self, _event: tk.Event) -> None:
        if self._drag_origin is not None and not self.locked:
            x, y = self.get_clamped_position(self.window.winfo_x(), self.window.winfo_y())
            self.window.geometry(f"+{x}+{y}")
            if self._drag_origin["moved"]:
                self.save_dock_state()
        self._drag_origin = None

    def toggle_lock(self) -> None:
        self.locked = bool(self.locked_var.get())
        self.save_dock_state()

    def reset_position(self) -> None:
        self.window.update_idletasks()
        left, _top, _right, bottom = get_primary_work_area()
        x, y = self.get_clamped_position(left + 12, bottom - self.window.winfo_reqheight() - 12)
        self.window.geometry(f"+{x}+{y}")
        self.save_dock_state()

    def keep_on_top(self) -> None:
        # The taskbar is also topmost; clicking it puts it above the dock, so re-assert without stealing focus.
        try:
            if not self.window.winfo_exists() or self.window.state() == "withdrawn":
                return
            windows = [self.window]
            panel = getattr(self.owner, "ai_panel", None)
            if panel is not None and panel.is_visible():
                windows.append(panel.window)
            self._topmost_hwnds = [get_native_hwnd(window) for window in windows]
            self._raise_cached_hwnds()
        except (AttributeError, OSError, tk.TclError):
            pass

    def _raise_cached_hwnds(self) -> None:
        # Pure Win32: safe to call from the WinEvent hook, which runs inside Tk's event loop without the GIL context Tk expects.
        for hwnd in getattr(self, "_topmost_hwnds", []):
            if hwnd:
                # HWND_TOPMOST must be pointer-sized; a plain -1 is passed as a 32-bit int and fails on x64.
                ctypes.windll.user32.SetWindowPos(ctypes.c_void_p(hwnd), ctypes.c_void_p(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200)

    def install_topmost_guard(self) -> None:
        if os.name != "nt":
            return
        try:
            user32 = ctypes.windll.user32
            proc_type = ctypes.WINFUNCTYPE(None, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_long, ctypes.c_long, ctypes.c_uint, ctypes.c_uint)

            def on_foreground(*_args) -> None:
                try:
                    self._raise_cached_hwnds()
                except OSError:
                    pass

            self._win_event_proc = proc_type(on_foreground)
            user32.SetWinEventHook.restype = ctypes.c_void_p
            user32.SetWinEventHook.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, proc_type, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint]
            # EVENT_SYSTEM_FOREGROUND, out-of-context: delivered through Tk's own message loop on this thread.
            self._win_event_hook = user32.SetWinEventHook(0x0003, 0x0003, None, self._win_event_proc, 0, 0, 0)
        except (AttributeError, OSError):
            self._win_event_hook = None

    def ensure_topmost(self) -> None:
        if not self.window.winfo_exists():
            return
        self.keep_on_top()
        self.recover_if_offscreen()
        self.window.after(500, self.ensure_topmost)

    def recover_if_offscreen(self) -> None:
        # An external monitor being unplugged or docked/undocked can leave the dock outside every visible screen.
        try:
            if self.window.state() == "withdrawn" or self._drag_origin is not None:
                return
            left, top, right, bottom = get_primary_screen_area()
            center_x = self.window.winfo_x() + self.window.winfo_width() // 2
            center_y = self.window.winfo_y() + self.window.winfo_height() // 2
            if left <= center_x < right and top <= center_y < bottom:
                return
            self.reset_position()
        except tk.TclError:
            pass

    def poll_status(self) -> None:
        if not self._poll_running:
            self._poll_running = True
            threading.Thread(target=self.read_status_worker, daemon=True).start()
        self._poll_id = self.window.after(self.POLL_SECONDS * 1000, self.poll_status)

    def read_status_worker(self) -> None:
        try:
            self.owner.events.put(("codex_status", self.owner.codex_monitor.read()))
        except Exception as error:
            self.owner.events.put(("codex_status", CodexStatus("error", "Codex 状态读取失败", f"状态：读取异常\n错误：{error}")))
        finally:
            self._poll_running = False

    def refresh_now(self) -> None:
        if not self._poll_running:
            self._poll_running = True
            threading.Thread(target=self.read_status_worker, daemon=True).start()

    def draw_status(self, status: CodexStatus) -> None:
        app_config = self.owner.config.get("app", {})
        hide_when_idle = bool(app_config.get("hide_codex_status_when_idle", True))
        if status.state == "idle" and hide_when_idle:
            self.status_slot.grid_remove()
            self.status_separator.grid_remove()
            self._status_visible = False
            if self._status_tooltip is not None:
                self._status_tooltip.text = status.hover_text
            return
        self.status_slot.grid()
        self.status_separator.grid()
        self._status_visible = True
        self.status_canvas.delete("all")
        color = self.STATUS_COLORS.get(status.state, self.MUTED)
        center_x = 9
        center_y = self.ICON_BOX // 2
        aa_draw.oval(self.status_canvas, center_x - 7, center_y - 7, center_x + 7, center_y + 7, fill=mix_hex(self.BACKGROUND, "#ffffff", 0.08), outline="")
        aa_draw.oval(self.status_canvas, center_x - 4, center_y - 4, center_x + 4, center_y + 4, fill=color, outline="")
        if self._status_tooltip is not None:
            self._status_tooltip.text = status.hover_text

    def open_main(self) -> None:
        self.owner.show_main()

    def hide(self) -> None:
        self.window.withdraw()
        self.owner.set_floating_button_text("显示悬浮框")

    def show(self) -> None:
        self.window.deiconify()
        self.window.wm_attributes("-topmost", True)
        self.window.lift()
        self.keep_on_top()
        self.owner.set_floating_button_text("隐藏悬浮框")

    def destroy(self) -> None:
        if self._win_event_hook:
            try:
                ctypes.windll.user32.UnhookWinEvent(ctypes.c_void_p(self._win_event_hook))
            except (AttributeError, OSError):
                pass
            self._win_event_hook = None
        if self._poll_id is not None:
            try:
                self.window.after_cancel(self._poll_id)
            except tk.TclError:
                pass
            self._poll_id = None
        if self.window.winfo_exists():
            self.window.destroy()


def acquire_single_instance() -> tuple[bool, int | None]:
    if os.name != "nt":
        return True, None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, False, APP_MUTEX_NAME)
    if not handle:
        return True, None
    if ctypes.get_last_error() == 183:
        kernel32.CloseHandle(handle)
        return False, None
    return True, int(handle)


def create_show_event() -> int | None:
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateEventW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateEventW.restype = ctypes.c_void_p
    handle = kernel32.CreateEventW(None, False, False, APP_SHOW_EVENT_NAME)
    return int(handle) if handle else None


def signal_running_instance() -> bool:
    if os.name != "nt":
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenEventW.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.OpenEventW.restype = ctypes.c_void_p
    kernel32.SetEvent.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenEventW(0x0002, False, APP_SHOW_EVENT_NAME)
    if not handle:
        return False
    try:
        return bool(kernel32.SetEvent(handle))
    finally:
        kernel32.CloseHandle(handle)


def release_single_instance(handle: int | None) -> None:
    if handle and os.name == "nt":
        ctypes.WinDLL("kernel32").CloseHandle(handle)


DEFAULT_FLOATING_TOOLS = ["windchill", "ehr", "sfc-login", "ai-chat"]


def load_config() -> tuple[dict, Path]:
    for candidate in get_config_candidates():
        if candidate.is_file():
            with candidate.open("r", encoding="utf-8") as file:
                return json.load(file), candidate
    raise FileNotFoundError("tools.json 未找到。")


def find_powershell() -> str:
    found = shutil.which("pwsh.exe") or shutil.which("pwsh")
    if found:
        return found
    candidate = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    if candidate.is_file():
        return str(candidate)
    raise FileNotFoundError("PowerShell 未找到。")


def read_wifi_state() -> str:
    try:
        result = subprocess.run(["netsh.exe", "wlan", "show", "interfaces"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8, check=False, creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as error:
        return f"Wi-Fi 状态读取失败：{error}"
    for line in result.stdout.splitlines():
        if line.strip().startswith("SSID") and not line.strip().startswith("BSSID"):
            _, _, ssid = line.partition(":")
            if ssid.strip():
                return f"当前 Wi-Fi：{ssid.strip()}"
    return "当前 Wi-Fi：未连接"


class WorkToolbox:
    def __init__(self, root: tk.Tk, config: dict, config_path: Path):
        self.root = root
        self.config = config
        self.config_path = config_path
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.processes: dict[str, subprocess.Popen] = {}
        self.tool_buttons: dict[str, ToolCard] = {}
        self.tool_tips: list[ToolTip] = []
        self.tool_catalog: dict[str, dict] = {}
        self.network_label: tk.Label | None = None
        self.notice_label: tk.Label | None = None
        self.log_text: tk.Text | None = None
        self.action_history: list[tuple[datetime, str, bool]] = []
        self.floating_button: FlatButton | None = None
        self.floating_toolbox: FloatingToolbox | None = None
        self.codex_monitor = CodexSessionMonitor()
        self.process_notice_seen: dict[str, bool] = {}
        self.sfc_login_running = False
        self.sfc_settings_window: tk.Toplevel | None = None
        self.rdp_store = RdpProfileStore()
        self.rdp_dialog: tk.Toplevel | None = None
        self.clipboard_secret: str | None = None
        self.ai_panel = None
        self.pending_store = PendingStore()
        self.pending_server = start_pending_server(lambda report: self.events.put(("pending", report)))
        self.todo_store = TodoStore(settings=config.get("todo", {}))
        self.todo_store.listeners.append(self.refresh_dock_badges)
        self.todo_assistant = TodoAssistant(self.root, self.todo_store, config.get("ai", {}))
        self.todo_panel: TodoPanel | None = None
        self.daily_note = DailyNote(self.todo_store.vault)
        self.title = str(config.get("app", {}).get("title", "工作工具箱"))
        self.theme = build_theme(config.get("app", {}))
        self.root.title(self.title)
        resolve_ui_font(self.root, config.get("app", {}).get("font"))
        self.root.geometry("282x620")
        self.root.minsize(240, 400)
        self.root.option_add("*Font", (UI_FONT, 8))
        icon_path = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "work-toolbox.ico"
        if icon_path.exists():
            try:
                self.root.iconbitmap(default=str(icon_path))
                with Image.open(icon_path) as icon_image:
                    self.window_icons = [ImageTk.PhotoImage(icon_image.convert("RGBA").resize((size, size), Image.LANCZOS)) for size in (256, 48, 32, 16)]
                self.root.iconphoto(True, *self.window_icons)
            except (tk.TclError, OSError):
                pass
        self.root.protocol("WM_DELETE_WINDOW", self.hide_main)
        self.setup_style()
        self.build_ui()
        self.ensure_daily_note()
        self.root.after(100, self.process_events)
        self.refresh_network_status()
        self.ai_hotkey = None
        self.start_ai_hotkey()
        self.root.after(300000, self.tick_badges)
        self.root.after(3000, self.poll_todo_file)

    def poll_todo_file(self) -> None:
        """Pick up todo edits made in Obsidian (00-Inbox/Todo.md)."""
        if self.todo_panel is None or not self.todo_panel.exists() or self.todo_panel.editing is None:
            self.todo_store.reload_if_changed()
        self.root.after(3000, self.poll_todo_file)

    def ensure_daily_note(self, scheduled: bool = False) -> None:
        """Create today's Obsidian daily note at startup, then every 5 minutes from 06:00 on."""
        if scheduled and datetime.now().hour < 6:
            return
        try:
            self.daily_note.ensure()
        except OSError as error:
            self.write_log(f"[Obsidian] 创建今日日志失败：{error}", error=True)

    def refresh_dock_badges(self) -> None:
        if self.floating_toolbox is not None:
            self.floating_toolbox.refresh_badges()

    def tick_badges(self) -> None:
        """Re-evaluate due dates every 5 minutes so badges roll over at midnight."""
        self.refresh_dock_badges()
        self.ensure_daily_note(scheduled=True)
        self.root.after(300000, self.tick_badges)

    def open_todo_panel(self, anchor: tk.Widget | None = None) -> None:
        if self.todo_panel is not None and self.todo_panel.exists():
            self.todo_panel.close()
            self.todo_panel = None
            return
        if anchor is None and self.floating_toolbox is not None and self.floating_toolbox.window.state() != "withdrawn":
            anchor = self.floating_toolbox.icon_tile("todo") or self.floating_toolbox.icon_tile("ai-chat")
        self.todo_panel = TodoPanel(
            self.root,
            self.theme,
            self.todo_store,
            self.todo_assistant,
            lambda: [(source, meta["label"], self.pending_store.count(source)) for source, meta in PENDING_SOURCES.items()],
            lambda tool_id: self.floating_toolbox.open_pending_tool(tool_id) if self.floating_toolbox is not None else webbrowser.open(PENDING_SOURCES[tool_id]["url"]),
            daily=self.daily_note,
        )
        self.todo_panel.show_near(anchor)

    def setup_style(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("TLabel", font=(UI_FONT, 9))
        style.configure("TButton", font=(UI_FONT, 9))
        style.configure("TEntry", font=(UI_FONT, 9))
        style.configure("TSpinbox", font=(UI_FONT, 9))

    def build_ui(self) -> None:
        theme = self.theme
        self.root.configure(background=theme["bg"])
        apply_title_bar_theme(self.root, theme["name"] == "dark")

        tab_bar = tk.Frame(self.root, background=theme["panel"], padx=10, pady=6)
        tab_bar.pack(fill="x")
        self.tabs: dict[str, tuple[tk.Label, tk.Frame]] = {}
        self.pages: dict[str, tk.Frame] = {}
        for name in ("工作台", "运行记录"):
            holder = tk.Frame(tab_bar, background=theme["panel"])
            holder.pack(side="left", padx=(0, 4))
            label = tk.Label(holder, text=name, background=theme["panel"], foreground=theme["muted"], font=(UI_FONT, 8, "bold"), padx=6, pady=3, cursor="hand2")
            label.pack()
            underline = tk.Frame(holder, background=theme["panel"], height=2)
            underline.pack(fill="x", padx=6)
            label.bind("<Button-1>", lambda _event, current=name: self.switch_tab(current))
            self.tabs[name] = (label, underline)
        FlatButton(tab_bar, theme, "\uE713", self.open_config, size=10, font_family="Segoe MDL2 Assets", square=True).pack(side="right")
        FlatButton(tab_bar, theme, "\uE72C", self.refresh_network_status, size=10, font_family="Segoe MDL2 Assets", square=True).pack(side="right", padx=(0, 2))
        tk.Frame(self.root, background=theme["border"], height=1).pack(fill="x")

        footer = tk.Frame(self.root, background=theme["panel"], padx=12, pady=7)
        footer.pack(side="bottom", fill="x")
        tk.Frame(self.root, background=theme["border"], height=1).pack(side="bottom", fill="x")
        footer.columnconfigure(1, weight=1)
        self.notice_dot = tk.Canvas(footer, width=10, height=10, background=theme["panel"], highlightthickness=0, bd=0)
        self.notice_dot.grid(row=0, column=0, padx=(0, 6))
        self.notice_label = tk.Label(footer, text="", background=theme["panel"], foreground=theme["text"], font=(UI_FONT, 7), anchor="w", justify="left")
        self.notice_label.grid(row=0, column=1, sticky="ew", pady=(0, 5))
        self.notice_dot.grid_remove()
        self.notice_label.grid_remove()
        self.notice_hide_id: str | None = None
        footer.bind("<Configure>", lambda event: self.notice_label.configure(wraplength=max(120, event.width - 50)))
        bottom = tk.Frame(footer, background=theme["panel"])
        bottom.grid(row=1, column=0, columnspan=2, sticky="ew")
        tk.Label(bottom, text="\uE701", background=theme["panel"], foreground=theme["subtle"], font=("Segoe MDL2 Assets", 9)).pack(side="left")
        self.network_label = tk.Label(bottom, text="读取中...", background=theme["panel"], foreground=theme["muted"], font=(UI_FONT, 7), anchor="w", cursor="hand2")
        self.network_label.pack(side="left", fill="x", expand=True, padx=(4, 4))
        self.network_label.bind("<Button-1>", lambda _event: self.refresh_network_status())

        body = tk.Frame(self.root, background=theme["bg"])
        body.pack(fill="both", expand=True)
        groups: dict[str, list[dict]] = {}
        for tool in self.config.get("tools", []):
            if not tool.get("enabled", True):
                continue
            group = str(tool.get("group", "其他"))
            tool_type = str(tool.get("type", ""))
            dynamic = self.get_ssh_tools(tool) if tool_type == "ssh-list" else self.get_rdp_tools(tool) if tool_type == "rdp-list" else [tool]
            groups.setdefault(group, []).extend(dynamic)
            self.register_tools(dynamic)

        workbench_page = tk.Frame(body, background=theme["bg"])
        self.pages["工作台"] = workbench_page
        workbench = self.create_scroll_area(workbench_page)
        workbench.columnconfigure(0, weight=1)
        zones = []
        used_groups: set[str] = set()
        drawer_config = self.config.get("app", {}).get("drawers")
        if not isinstance(drawer_config, list) or not drawer_config:
            drawer_config = DEFAULT_DRAWERS
        for drawer in drawer_config:
            if not isinstance(drawer, dict):
                continue
            names = [str(name) for name in drawer.get("groups", [])]
            used_groups.update(names)
            items = [tool for name in names for tool in groups.get(name, [])]
            zones.append([str(drawer.get("title", " / ".join(names))), items, max(1, int(drawer.get("columns", 2)))])
        leftovers = [tool for name, tools in groups.items() if name not in used_groups for tool in tools]
        if leftovers:
            if zones:
                zones[-1][1].extend(leftovers)
            else:
                zones.append(["其他", leftovers, 2])
        self.drawers: dict[str, dict] = {}
        self.current_drawer = ""
        for index, (title, items, columns) in enumerate(zones):
            self.create_tool_zone(workbench, index, 0, title, items, columns)
        self.open_drawer(self.load_open_drawer())

        log_page = tk.Frame(body, background=theme["bg"], padx=12, pady=10)
        self.pages["运行记录"] = log_page
        log_page.columnconfigure(0, weight=1)
        log_page.rowconfigure(0, weight=1)
        self.log_text = tk.Text(log_page, wrap="word", state="disabled", background=theme["card"], foreground=theme["text"], insertbackground=theme["text"], selectbackground=theme["accent"], relief="flat", borderwidth=0, highlightthickness=1, highlightbackground=theme["border"], highlightcolor=theme["border"], padx=8, pady=6, font=(UI_FONT, 8))
        self.log_text.grid(row=0, column=0, sticky="nsew")
        FlatButton(log_page, theme, "清空运行记录", self.clear_log, background=theme["bg"], size=8).grid(row=1, column=0, sticky="e", pady=(6, 0))

        self.root.bind_all("<MouseWheel>", self.on_mousewheel, add="+")
        self.switch_tab("工作台")
        self.set_notice("就绪", "info")
        self.write_log("工具箱已启动。")

    def switch_tab(self, name: str) -> None:
        self.current_tab = name
        for tab_name, (label, underline) in self.tabs.items():
            active = tab_name == name
            label.configure(foreground=self.theme["text"] if active else self.theme["muted"])
            underline.configure(background=self.theme["accent"] if active else self.theme["panel"])
        for page_name, page in self.pages.items():
            if page_name == name:
                page.pack(fill="both", expand=True)
            else:
                page.pack_forget()

    def create_scroll_area(self, parent: tk.Frame) -> tk.Frame:
        canvas = tk.Canvas(parent, background=self.theme["bg"], highlightthickness=0, bd=0)
        canvas.pack(fill="both", expand=True)
        inner = tk.Frame(canvas, background=self.theme["bg"], padx=9, pady=6)
        window_id = canvas.create_window((0, 0), window=inner, anchor="nw")
        inner.bind("<Configure>", lambda _event: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda event: canvas.itemconfigure(window_id, width=event.width))
        self.scroll_canvas = canvas
        self.scroll_inner = inner
        return inner

    def on_mousewheel(self, event: tk.Event) -> None:
        canvas = getattr(self, "scroll_canvas", None)
        if canvas is None or getattr(self, "current_tab", "") != "工作台":
            return
        try:
            if str(event.widget.winfo_toplevel()) != str(self.root):
                return
        except (AttributeError, KeyError, tk.TclError):
            return
        if canvas.winfo_height() < self.scroll_inner.winfo_reqheight():
            canvas.yview_scroll(int(-event.delta / 120), "units")

    def register_tools(self, tools: list[dict]) -> None:
        for tool in tools:
            tool_id = str(tool.get("id", ""))
            if tool_id:
                self.tool_catalog[tool_id] = tool

    def create_tool_zone(self, parent: tk.Frame, row: int, column: int, title: str, tools: list[dict], columns: int = 2) -> None:
        theme = self.theme
        zone = tk.Frame(parent, background=theme["bg"])
        zone.grid(row=row, column=column, sticky="ew", pady=(0, 6))
        zone.columnconfigure(0, weight=1)
        ssh_count = sum(1 for tool in tools if tool.get("kind") == "ssh-host")
        rdp_count = sum(1 for tool in tools if tool.get("kind") == "rdp-profile")
        summary = " · ".join(part for part in (f"SSH {ssh_count}" if ssh_count else "", f"RDP {rdp_count}" if rdp_count else "") if part) or str(len(tools))
        header = DrawerHeader(zone, theme, title, summary, lambda name=title: self.toggle_drawer(name))
        header.grid(row=0, column=0, sticky="ew", padx=3)

        body = tk.Frame(zone, background=theme["bg"], pady=6)
        body.grid(row=1, column=0, sticky="ew")
        for index in range(columns):
            body.columnconfigure(index, weight=1, uniform=f"zone-{row}")
        if not tools:
            tk.Label(body, text="暂无配置", background=theme["bg"], foreground=theme["subtle"], font=(UI_FONT, 8)).grid(row=0, column=0, columnspan=columns, sticky="w", padx=6)
        layout = "stack" if columns >= 4 else "row"
        for index, tool in enumerate(tools):
            self.create_tool_row(body, index // columns, index % columns, tool, layout)
        body.grid_remove()

        self.drawers[title] = {"body": body, "header": header}

    @staticmethod
    def get_ui_state_path() -> Path:
        local_app_data = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        return Path(local_app_data) / "WorkToolbox" / "main-window.json"

    def load_ui_state(self) -> dict:
        try:
            data = json.loads(self.get_ui_state_path().read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            data = {}
        return data if isinstance(data, dict) else {}

    def save_ui_state(self, **values) -> None:
        data = self.load_ui_state()
        data.update(values)
        try:
            path = self.get_ui_state_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def load_open_drawer(self) -> str | None:
        name = self.load_ui_state().get("open_drawer")
        if name in self.drawers or name == "":
            return name
        return next(iter(self.drawers), None)

    def toggle_drawer(self, name: str) -> None:
        self.open_drawer("" if self.current_drawer == name else name)
        self.save_ui_state(open_drawer=self.current_drawer)

    def open_drawer(self, name: str | None) -> None:
        """Accordion: at most one drawer is expanded at a time."""
        self.current_drawer = name or ""
        for title, drawer in self.drawers.items():
            active = title == self.current_drawer
            drawer["header"].set_active(active)
            if active:
                drawer["body"].grid()
            else:
                drawer["body"].grid_remove()
        canvas = getattr(self, "scroll_canvas", None)
        if canvas is not None:
            canvas.after_idle(lambda: (canvas.configure(scrollregion=canvas.bbox("all")), canvas.yview_moveto(0)))

    def get_ssh_tools(self, tool: dict) -> list[dict]:
        config_path = resolve_value(str(tool.get("target", "{USERPROFILE}\\.ssh\\config")))
        settings_path = resolve_value(str(tool.get("extra_hosts_file", "{LOCAL_TOOLKIT}\\remote-hosts.json")))
        settings = load_extra_ssh_settings(Path(settings_path))
        excluded = {str(alias).strip().lower() for alias in settings.get("exclude_aliases", [])}
        overrides = settings.get("overrides", {}) if isinstance(settings.get("overrides", {}), dict) else {}
        hosts = [host for host in parse_ssh_config(Path(config_path)) if not any(alias.lower() in excluded for alias in host.get("aliases", [host["alias"]]))]
        for host in hosts:
            override = next((overrides[alias] for alias in host.get("aliases", [host["alias"]]) if alias in overrides), None)
            if isinstance(override, dict):
                host.update(override)
        for extra in settings.get("hosts", []):
            if not isinstance(extra, dict):
                continue
            alias = str(extra.get("alias", "")).strip()
            hostname = str(extra.get("hostname", "")).strip()
            if not alias or not hostname or alias.lower() in excluded or any(alias.lower() == known.lower() for host in hosts for known in host.get("aliases", [host["alias"]])):
                continue
            hosts.append({"alias": alias, "aliases": [alias], "display_name": str(extra.get("label", alias)), "hostname": hostname, "user": str(extra.get("user", "")), "port": int(extra.get("port", 22)), "identity_file": str(extra.get("identity_file", "")), "config_path": "", "description": str(extra.get("description", "")), "icon": str(extra.get("icon", tool.get("icon", "⌁")))})
        merged: dict[tuple, dict] = {}
        for host in hosts:
            key = (str(host.get("hostname", "")).lower(), str(host.get("user", "")).lower(), int(host.get("port", 22)))
            if key in merged:
                known_aliases = merged[key].setdefault("aliases", [merged[key]["alias"]])
                known_aliases.extend(alias for alias in host.get("aliases", [host["alias"]]) if alias not in known_aliases)
            else:
                merged[key] = host
        hosts = list(merged.values())
        return [{"id": f"ssh:{host['alias']}", "kind": "ssh-host", "label": host.get("display_name", host["alias"]), "icon": host.get("icon", tool.get("icon", "⌁")), "description": host.get("description") or "通过 SSH 配置连接服务器", "host": host} for host in hosts]

    def get_rdp_tools(self, tool: dict) -> list[dict]:
        profiles = find_rdp_profiles([Path(resolve_value(str(path))) for path in tool.get("search_paths", [])])
        tools = []
        for profile in profiles:
            stored = self.rdp_store.get(profile["address"])
            label = str(stored.get("label") or profile["name"])
            tools.append({"id": f"rdp:{profile['path']}", "kind": "rdp-profile", "label": label, "icon": str(tool.get("icon", "▣")), "description": "使用 Windows 远程桌面打开保存的连接配置", "profile": profile})
        return tools

    def create_tool_row(self, parent: tk.Frame, row: int, column: int, tool: dict, layout: str = "row") -> None:
        tool_id = str(tool.get("id", f"tool-{row}"))
        kind = str(tool.get("kind", "tool"))
        label = str(tool.get("label", tool_id))
        subtitle = ""
        tag = ""
        action = None
        action_active = False
        action_glyph = "\uE8D7"
        if kind == "ssh-host":
            host = tool["host"]
            address = str(host.get("hostname", ""))
            port = int(host.get("port", 22))
            user = str(host.get("user", ""))
            tag = "SSH"
            subtitle = (f"{user}@" if user else "") + (address if port == 22 else f"{address}:{port}")
            aliases = host.get("aliases") or [host.get("alias", label)]
            tip = f"SSH · {label}\n地址：{address}\n端口：{port}\n用户：{user or 'SSH 默认用户'}\n别名：{' / '.join(aliases)}\n配置：{host.get('config_path', '')}"
        elif kind == "rdp-profile":
            profile = tool["profile"]
            tag = "RDP"
            subtitle = str(profile.get("address", ""))
            action = lambda current=tool: self.open_rdp_password_dialog(current)
            action_active = self.rdp_store.has_password(str(profile.get("address", "")))
            tip = self.rdp_tip(tool)
        else:
            available = self.tool_is_available(tool)
            if str(tool.get("type", "")) == "sfc-login":
                action = self.open_sfc_settings
                action_glyph = "\uE713"
            elif str(tool.get("type", "")) == "secret-copy":
                action = lambda current=tool: self.open_secret_dialog(current)
                action_active = self.rdp_store.has_password(self.secret_key(tool))
            if not available:
                subtitle = "路径未找到"
            elif str(tool.get("type", "")) == "app":
                subtitle = str(tool.get("secondary", ""))
            tip = self.secret_tip(tool) if str(tool.get("type", "")) == "secret-copy" else "\n".join(item for item in (str(tool.get("description", "")), str(tool.get("secondary", "")), f"状态：{'可用' if available else '路径未找到'}", "右侧齿轮：SFC 设置（程序路径、账号、等待时间）" if action_glyph == "\uE713" else "") if item)
        card = ToolCard(parent, self.theme, get_tool_abbr(tool), get_icon_kind(tool_id), label, lambda current=tool: self.execute_tool(current), subtitle=subtitle if layout == "row" else "", layout=layout, tag=tag, action=action, action_active=action_active, action_glyph=action_glyph)
        card.grid(row=row, column=column, sticky="ew", padx=3, pady=(0, 6))
        if kind == "tool" and tool_id in self.tool_catalog:
            card.bind("<Button-3>", lambda event, current=tool_id: self.show_tool_menu(event, current), add="+")
        self.tool_buttons[tool_id] = card
        tooltip = ToolTip(card, tip)
        self.tool_tips.append(tooltip)
        card.tooltip = tooltip

    def floating_tool_ids(self) -> list[str]:
        configured = self.config.setdefault("app", {}).get("floating_tools", DEFAULT_FLOATING_TOOLS)
        if not isinstance(configured, list):
            configured = []
        return list(dict.fromkeys(str(tool_id) for tool_id in configured if str(tool_id) in self.tool_catalog))

    def set_floating_tools(self, tool_ids: list[str]) -> None:
        tool_ids = list(dict.fromkeys(tool_ids))
        self.config.setdefault("app", {})["floating_tools"] = tool_ids
        try:
            text = self.config_path.read_text(encoding="utf-8")
            block = "[\n" + ",\n".join(f"      {json.dumps(tool_id, ensure_ascii=False)}" for tool_id in tool_ids) + "\n    ]" if tool_ids else "[]"
            updated, count = re.subn(r'("floating_tools"\s*:\s*)\[[^\]]*\]', lambda match: match.group(1) + block, text, count=1)
            if count == 0:
                updated = re.sub(r'("app"\s*:\s*\{)', lambda match: match.group(1) + '\n    "floating_tools": ' + block + ",", text, count=1)
            self.config_path.write_text(updated, encoding="utf-8")
        except OSError as error:
            self.set_notice(f"悬浮栏设置保存失败：{error}", "error")
        if self.floating_toolbox is not None:
            self.floating_toolbox.reload_tools()

    def show_tool_menu(self, event: tk.Event, tool_id: str) -> None:
        pinned = self.floating_tool_ids()
        theme = self.theme
        menu = tk.Menu(self.root, tearoff=False, font=(UI_FONT, 9), background=theme["panel"], foreground=theme["text"], activebackground=theme["accent"], activeforeground="#ffffff", borderwidth=0)
        if tool_id in pinned:
            index = pinned.index(tool_id)

            def move(offset: int) -> None:
                order = self.floating_tool_ids()
                position = order.index(tool_id)
                order.insert(position + offset, order.pop(position))
                self.set_floating_tools(order)

            menu.add_command(label="从悬浮栏移除", command=lambda: self.set_floating_tools([item for item in self.floating_tool_ids() if item != tool_id]))
            menu.add_separator()
            menu.add_command(label="在悬浮栏中左移", command=lambda: move(-1), state="normal" if index > 0 else "disabled")
            menu.add_command(label="在悬浮栏中右移", command=lambda: move(1), state="normal" if index < len(pinned) - 1 else "disabled")
        else:
            menu.add_command(label="添加到悬浮栏", command=lambda: self.set_floating_tools(self.floating_tool_ids() + [tool_id]))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def build_tool_detail(self, panel: ToolDetailPanel, tool: dict, draw_icon) -> None:
        """Fill the dock right-click panel: header, type-specific details, recent log, actions."""
        theme = self.theme
        tool_id = str(tool.get("id", ""))
        label = str(tool.get("label", tool_id))
        tool_type = str(tool.get("type", ""))
        kind = str(tool.get("kind", ""))
        available = self.tool_is_available(tool) if kind not in ("rdp-profile", "ssh-host") else True
        type_name = "远程桌面" if kind == "rdp-profile" else "SSH" if kind == "ssh-host" else TOOL_TYPE_NAMES.get(tool_type, tool_type or "工具")
        status, status_color = (type_name, None) if available else ("找不到目标", "#d9534f")
        running = self.processes.get(tool_id)
        if running is not None and running.poll() is None:
            status, status_color = "运行中", "#34C759"
        panel.set_header(draw_icon, label, str(tool.get("secondary", "")), status, status_color)
        description = str(tool.get("description", "")).strip()
        if description:
            panel.note(panel.body, description, theme["text"])

        if tool_id in PENDING_SOURCES:
            self.build_pending_detail(panel, tool_id)
        elif tool_id == "obsidian":
            self.build_obsidian_detail(panel)
        elif tool_id == "quick-meeting":
            self.build_meeting_detail(panel)
        elif tool_type == "secret-copy":
            info = panel.section("密码")
            saved = self.rdp_store.has_password(self.secret_key(tool))
            panel.field(info, "状态", "已保存（单击图标复制，60 秒后清空剪贴板）" if saved else "未保存", None if saved else "#ffb020")
        elif tool_type == "sfc-login":
            info = panel.section("SFC")
            panel.note(info, "单击图标自动登录；齿轮设置账号与站点。")

        target = self.get_tool_target(tool) if tool.get("target") else ""
        if target and tool_type not in ("url",) and kind not in ("rdp-profile", "ssh-host"):
            info = panel.section("目标")
            path = Path(target)
            panel.field(info, "路径", target, None if path.exists() else "#d9534f", (lambda: os.startfile(str(path.parent if path.is_file() else path))) if path.exists() else None)
            if tool.get("args"):
                panel.field(info, "参数", " ".join(resolve_value(str(argument)) for argument in tool["args"]))
            if path.exists():
                panel.field(info, "修改", datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M"))
        elif tool_type == "url" and target:
            info = panel.section("网址")
            panel.field(info, "地址", target, on_click=lambda: webbrowser.open(target))

        history = [entry for entry in self.action_history if entry[1].startswith(f"[{label}]")][-6:]
        if history:
            recent = panel.section("最近操作")
            for when, message, error in reversed(history):
                panel.item(recent, message[len(label) + 2:].strip(), when.strftime("%H:%M:%S"), meta_color="#d9534f" if error else None)

        panel.button(FlatButton, "打开", lambda: self.execute_tool(tool))
        if tool_type == "secret-copy":
            panel.button(FlatButton, "设置密码", lambda: self.open_secret_dialog(tool))
        elif tool_type == "sfc-login":
            panel.button(FlatButton, "设置", self.open_sfc_settings)
        elif target and tool_type != "url" and Path(target).exists():
            folder = Path(target) if Path(target).is_dir() else Path(target).parent
            panel.button(FlatButton, "所在文件夹", lambda: os.startfile(str(folder)))
        pinned = self.floating_tool_ids()
        if tool_id in pinned:
            index = pinned.index(tool_id)

            def move(offset: int) -> None:
                order = self.floating_tool_ids()
                position = order.index(tool_id)
                order.insert(position + offset, order.pop(position))
                self.set_floating_tools(order)

            panel.button(FlatButton, "\u2715", lambda: self.set_floating_tools([item for item in self.floating_tool_ids() if item != tool_id]), side="right")
            panel.button(FlatButton, "\u25B6", lambda: move(1), side="right", enabled=index < len(pinned) - 1)
            panel.button(FlatButton, "\u25C0", lambda: move(-1), side="right", enabled=index > 0)
            panel.footnote("◀ ▶ 调整悬浮栏顺序，✕ 从悬浮栏移除 · Esc 关闭")

    def build_pending_detail(self, panel: ToolDetailPanel, source: str) -> None:
        theme = self.theme
        store = self.pending_store
        meta = PENDING_SOURCES[source]
        report = store.reports.get(source)
        stale = store.is_stale(source)
        count = store.count(source)
        section = panel.section("未读通知", str(count) if report and "count" in report else "—", (BADGE_GRAY if stale else BADGE_RED) if count else None)
        if report is None:
            panel.note(section, "等待浏览器插件同步（需启用 Medtronic Work Assistant）。")
            return
        panel.field(section, "更新", relative_time(report.get("received", "") or report.get("updated", "")) or "—")
        if report.get("error"):
            panel.note(section, f"⚠ 刷新失败：{report['error']}", "#ffb020")
        elif stale:
            panel.note(section, "⚠ 超过 30 分钟未刷新，Chrome 可能未运行，角标已置灰。", "#ffb020")
        if report.get("note"):
            panel.note(section, str(report["note"]))
        items = report.get("items") or []
        if not items and not report.get("error"):
            panel.note(section, f"{meta['hint']}已全部处理 ✓")
        for item in items[:30]:
            url = str(item.get("url") or meta["url"])
            panel.item(section, str(item.get("title", "")), short_date(item.get("time", "")), str(item.get("subtitle", "")), url=url)
        if len(items) > 30 or count > len(items):
            panel.item(section, f"还有 {max(count, len(items)) - min(len(items), 30)} 条，去网页查看…", url=meta["url"])

    def build_obsidian_detail(self, panel: ToolDetailPanel) -> None:
        vault = self.todo_store.vault
        section = panel.section("Vault")
        panel.field(section, "位置", str(vault) if vault else "未找到 Obsidian 库", None if vault else "#ffb020", (lambda: os.startfile(str(vault))) if vault else None)
        due = self.todo_store.due_count()
        open_items = self.todo_store.open_items()
        panel.field(section, "待办", f"{len(open_items)} 项未完成，{due} 项到期", on_click=lambda: self.open_todo_panel())
        note_path = self.daily_note.path()
        daily = panel.section("今日 Daily", datetime.now().strftime("%m-%d"))
        if note_path is None:
            panel.note(daily, "未配置 Daily 目录。")
            return
        entries: list[str] = []
        if note_path.exists():
            try:
                lines = note_path.read_text(encoding="utf-8-sig").splitlines()
                start = next((index for index, line in enumerate(lines) if line.strip() == LOG_HEADING), None)
                if start is not None:
                    for line in lines[start + 1:]:
                        if line.startswith("#"):
                            break
                        if line.strip().startswith("- ") and len(line.strip()) > 2:
                            entries.append(line.strip()[2:])
            except (OSError, UnicodeError):
                pass
        panel.field(daily, "文件", note_path.name, on_click=lambda: os.startfile(self.daily_note.open_uri()))
        if not entries:
            panel.note(daily, "今天还没有自动记录。")
        for entry in reversed(entries[-30:]):
            when, _, text = entry.partition(" ")
            panel.item(daily, text or when, when if text else "")

    def build_meeting_detail(self, panel: ToolDetailPanel) -> None:
        log_path = Path(os.environ.get("APPDATA", str(Path.home()))) / "MeetingNotes" / "quick-meeting.log"
        section = panel.section("会议记录日志")
        if not log_path.exists():
            panel.note(section, "暂无日志。")
            return
        panel.field(section, "日志", str(log_path), on_click=lambda: os.startfile(str(log_path)))
        try:
            lines = [line.strip() for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
        except OSError:
            lines = []
        for line in reversed(lines[-15:]):
            panel.item(section, line[:120])

    def rdp_tip(self, tool: dict) -> str:
        profile = tool["profile"]
        address = str(profile.get("address", ""))
        saved = "已保存（点击连接时自动复制）" if self.rdp_store.has_password(address) else "未保存（点右侧钥匙图标记录）"
        return f"RDP 远程桌面 · {tool['label']}\n地址：{address}\n用户：{profile.get('username') or '由远程桌面提示'}\n密码：{saved}\n文件：{profile.get('path', '')}"

    def open_rdp_password_dialog(self, tool: dict) -> None:
        if self.rdp_dialog is not None and self.rdp_dialog.winfo_exists():
            self.rdp_dialog.destroy()
        theme = self.theme
        profile = tool["profile"]
        address = str(profile.get("address", ""))
        has_password = self.rdp_store.has_password(address)
        window = tk.Toplevel(self.root)
        self.rdp_dialog = window
        window.title("RDP 连接密码")
        window.configure(background=theme["bg"], padx=14, pady=12)
        window.resizable(False, False)
        window.transient(self.root)
        apply_title_bar_theme(window, theme["name"] == "dark")
        window.columnconfigure(1, weight=1)
        tk.Label(window, text=f"{tool['label']}  ·  {address}", background=theme["bg"], foreground=theme["text"], font=(UI_FONT, 9, "bold")).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))
        entry_style = dict(background=theme["card"], foreground=theme["text"], insertbackground=theme["text"], relief="flat", highlightthickness=1, highlightbackground=theme["border"], highlightcolor=theme["accent"], font=(UI_FONT, 9), width=30)
        label_var = tk.StringVar(value=str(tool["label"]))
        password_var = tk.StringVar()
        show_var = tk.BooleanVar(value=False)
        tk.Label(window, text="显示名称", background=theme["bg"], foreground=theme["muted"], font=(UI_FONT, 8)).grid(row=1, column=0, sticky="w", padx=(0, 10), pady=4)
        tk.Entry(window, textvariable=label_var, **entry_style).grid(row=1, column=1, sticky="ew", pady=4, ipady=3)
        tk.Label(window, text="密码", background=theme["bg"], foreground=theme["muted"], font=(UI_FONT, 8)).grid(row=2, column=0, sticky="w", padx=(0, 10), pady=4)
        password_entry = tk.Entry(window, textvariable=password_var, show="•", **entry_style)
        password_entry.grid(row=2, column=1, sticky="ew", pady=4, ipady=3)
        tk.Checkbutton(window, text="显示密码", variable=show_var, command=lambda: password_entry.configure(show="" if show_var.get() else "•"), background=theme["bg"], foreground=theme["muted"], selectcolor=theme["card"], activebackground=theme["bg"], activeforeground=theme["text"], font=(UI_FONT, 8), bd=0, highlightthickness=0).grid(row=3, column=1, sticky="w")
        hint = "已保存密码；留空则保持不变。" if has_password else "尚未保存密码。"
        tk.Label(window, text=f"{hint}\n密码用 Windows DPAPI 加密，仅当前 Windows 账户可解密；\n点击 RDP 卡片时复制到剪贴板，60 秒后自动清除。", background=theme["bg"], foreground=theme["subtle"], font=(UI_FONT, 7), justify="left").grid(row=4, column=0, columnspan=2, sticky="w", pady=(6, 8))
        buttons = tk.Frame(window, background=theme["bg"])
        buttons.grid(row=5, column=0, columnspan=2, sticky="e")

        def save() -> None:
            password = password_var.get()
            label = label_var.get().strip()
            try:
                self.rdp_store.save(address, label=label if label != profile.get("name") else "", password=password if password else None)
            except OSError as error:
                messagebox.showerror("保存失败", str(error), parent=window)
                return
            self.apply_rdp_changes(tool, label or str(profile.get("name", address)))
            self.set_notice(f"{tool['label']}：连接信息已保存", "ok")
            window.destroy()

        def clear_password() -> None:
            self.rdp_store.save(address, password="")
            self.apply_rdp_changes(tool, str(tool["label"]))
            self.set_notice(f"{tool['label']}：已清除保存的密码", "info")
            window.destroy()

        FlatButton(buttons, theme, "保存", save, background=theme["bg"], size=9).pack(side="left")
        if has_password:
            FlatButton(buttons, theme, "清除密码", clear_password, background=theme["bg"], size=9).pack(side="left", padx=(6, 0))
        FlatButton(buttons, theme, "取消", window.destroy, background=theme["bg"], size=9).pack(side="left", padx=(6, 0))
        window.bind("<Return>", lambda _event: save())
        window.bind("<Escape>", lambda _event: window.destroy())
        window.update_idletasks()
        x = self.root.winfo_rootx() + max(0, (self.root.winfo_width() - window.winfo_width()) // 2)
        y = self.root.winfo_rooty() + 140
        window.geometry(f"+{x}+{y}")
        password_entry.focus_set()

    def secret_key(self, tool: dict) -> str:
        return "secret:" + str(tool.get("id", ""))

    def secret_tip(self, tool: dict) -> str:
        saved = "已保存（点击卡片复制，30 秒后自动清除）" if self.rdp_store.has_password(self.secret_key(tool)) else "未保存（点右侧钥匙图标录入）"
        return f"{tool.get('description', '')}\n密码：{saved}\n复制内容不进入 Win+V 剪贴板历史"

    def open_secret_dialog(self, tool: dict) -> None:
        if self.rdp_dialog is not None and self.rdp_dialog.winfo_exists():
            self.rdp_dialog.destroy()
        theme = self.theme
        key = self.secret_key(tool)
        has_password = self.rdp_store.has_password(key)
        window = tk.Toplevel(self.root)
        self.rdp_dialog = window
        window.title(str(tool.get("label", "密码")))
        window.configure(background=theme["bg"], padx=14, pady=12)
        window.resizable(False, False)
        window.transient(self.root)
        apply_title_bar_theme(window, theme["name"] == "dark")
        window.columnconfigure(1, weight=1)
        tk.Label(window, text=str(tool.get("label", "密码")), background=theme["bg"], foreground=theme["text"], font=(UI_FONT, 9, "bold")).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))
        entry_style = dict(background=theme["card"], foreground=theme["text"], insertbackground=theme["text"], relief="flat", highlightthickness=1, highlightbackground=theme["border"], highlightcolor=theme["accent"], font=(UI_FONT, 9), width=30)
        password_var = tk.StringVar()
        show_var = tk.BooleanVar(value=False)
        tk.Label(window, text="密码", background=theme["bg"], foreground=theme["muted"], font=(UI_FONT, 8)).grid(row=1, column=0, sticky="w", padx=(0, 10), pady=4)
        password_entry = tk.Entry(window, textvariable=password_var, show="•", **entry_style)
        password_entry.grid(row=1, column=1, sticky="ew", pady=4, ipady=3)
        tk.Checkbutton(window, text="显示密码", variable=show_var, command=lambda: password_entry.configure(show="" if show_var.get() else "•"), background=theme["bg"], foreground=theme["muted"], selectcolor=theme["card"], activebackground=theme["bg"], activeforeground=theme["text"], font=(UI_FONT, 8), bd=0, highlightthickness=0).grid(row=2, column=1, sticky="w")
        hint = "已保存密码；输入新密码可覆盖。" if has_password else "尚未保存密码。"
        tk.Label(window, text=f"{hint}\n密码用 Windows DPAPI 加密，仅当前 Windows 账户可解密；\n点击卡片复制，在 UAC 窗口按 Ctrl+V，30 秒后自动清除。", background=theme["bg"], foreground=theme["subtle"], font=(UI_FONT, 7), justify="left").grid(row=3, column=0, columnspan=2, sticky="w", pady=(6, 8))
        buttons = tk.Frame(window, background=theme["bg"])
        buttons.grid(row=4, column=0, columnspan=2, sticky="e")

        def finish(message: str, level: str) -> None:
            self.apply_secret_changes(tool)
            self.set_notice(message, level)
            window.destroy()

        def save(copy: bool = False) -> None:
            password = password_var.get()
            if password:
                try:
                    self.rdp_store.save(key, password=password)
                except OSError as error:
                    messagebox.showerror("保存失败", str(error), parent=window)
                    return
            elif not has_password:
                password_entry.focus_set()
                return
            if copy:
                self.apply_secret_changes(tool)
                window.destroy()
                self.copy_secret(tool)
                return
            finish(f"{tool.get('label', '密码')}：已保存", "ok")

        def clear_password() -> None:
            self.rdp_store.save(key, password="")
            finish(f"{tool.get('label', '密码')}：已清除保存的密码", "info")

        FlatButton(buttons, theme, "保存并复制", lambda: save(True), background=theme["bg"], size=9).pack(side="left")
        FlatButton(buttons, theme, "保存", save, background=theme["bg"], size=9).pack(side="left", padx=(6, 0))
        if has_password:
            FlatButton(buttons, theme, "清除密码", clear_password, background=theme["bg"], size=9).pack(side="left", padx=(6, 0))
        FlatButton(buttons, theme, "取消", window.destroy, background=theme["bg"], size=9).pack(side="left", padx=(6, 0))
        window.bind("<Return>", lambda _event: save(True))
        window.bind("<Escape>", lambda _event: window.destroy())
        window.update_idletasks()
        x = self.root.winfo_rootx() + max(0, (self.root.winfo_width() - window.winfo_width()) // 2)
        y = self.root.winfo_rooty() + 140
        window.geometry(f"+{x}+{y}")
        window.lift()
        password_entry.focus_force()

    def copy_secret(self, tool: dict) -> None:
        password = self.rdp_store.password(self.secret_key(tool))
        if not password:
            self.open_secret_dialog(tool)
            return
        self.copy_secret_to_clipboard(password, 30)
        self.set_notice(f"{tool.get('label', '密码')}已复制，在 UAC 窗口按 Ctrl+V（30 秒后清除）", "ok")

    def apply_secret_changes(self, tool: dict) -> None:
        card = self.tool_buttons.get(str(tool.get("id", "")))
        if card is None:
            return
        card.action_active = self.rdp_store.has_password(self.secret_key(tool))
        card.redraw()
        if getattr(card, "tooltip", None) is not None:
            card.tooltip.text = self.secret_tip(tool)

    def apply_rdp_changes(self, tool: dict, label: str) -> None:
        tool["label"] = label
        card = self.tool_buttons.get(str(tool["id"]))
        if card is None:
            return
        card.title = label
        card.abbr = get_tool_abbr(tool)
        card.action_active = self.rdp_store.has_password(str(tool["profile"].get("address", "")))
        card.redraw()
        if getattr(card, "tooltip", None) is not None:
            card.tooltip.text = self.rdp_tip(tool)

    def get_tool_target(self, tool: dict) -> str:
        return resolve_value(str(tool.get("target", "")))

    def tool_is_available(self, tool: dict) -> bool:
        tool_type = str(tool.get("type", ""))
        if tool_type == "app":
            return bool(tool.get("app_id")) or Path(self.get_tool_target(tool)).exists()
        return tool_type in {"url", "sfc-login", "sfc-settings", "ai-chat", "todo", "secret-copy"} or Path(self.get_tool_target(tool)).exists()

    def set_notice(self, message: str, level: str = "info") -> None:
        if self.notice_label is not None:
            self.notice_label.configure(text=message)
            self.notice_dot.delete("all")
            aa_draw.oval(self.notice_dot, 1, 1, 9, 9, fill=STATUS_TONES.get(level, self.theme["accent"]), outline="")
            self.notice_dot.grid()
            self.notice_label.grid()
            # Notices are transient; the footer normally shows only the Wi-Fi row.
            if self.notice_hide_id is not None:
                self.root.after_cancel(self.notice_hide_id)
            self.notice_hide_id = self.root.after(15000 if level == "error" else 8000, self.clear_notice)

    def clear_notice(self) -> None:
        self.notice_hide_id = None
        if self.notice_label is not None:
            self.notice_label.configure(text="")
            self.notice_dot.grid_remove()
            self.notice_label.grid_remove()

    def set_floating_button_text(self, text: str) -> None:
        if self.floating_button is not None:
            self.floating_button.set_text(text)

    def toggle_floating_toolbox(self) -> None:
        if self.floating_toolbox is None:
            self.floating_toolbox = FloatingToolbox(self)
        elif self.floating_toolbox.window.state() == "withdrawn":
            self.floating_toolbox.show()
        else:
            self.floating_toolbox.hide()

    def execute_tool(self, tool: dict) -> None:
        tool_id = str(tool.get("id", ""))
        label = str(tool.get("label", tool_id))
        kind = str(tool.get("kind", "tool"))
        tool_type = str(tool.get("type", ""))
        if tool_id.startswith("opencode-"):
            self.set_notice({"opencode-start": "OpenCode：正在启动", "opencode-stop": "OpenCode：正在停止", "opencode-restart": "OpenCode：正在重启", "opencode-status": "OpenCode：正在检查状态"}.get(tool_id, "OpenCode：正在处理"), "warn")
            self.process_notice_seen[tool_id] = False
        if kind == "ssh-host":
            self.execute_ssh(tool)
            return
        if kind == "rdp-profile":
            self.execute_rdp(tool)
            return
        if tool_type == "sfc-login":
            self.start_sfc_login()
            return
        if tool_type == "sfc-settings":
            self.open_sfc_settings()
            return
        if tool_type == "ai-chat":
            self.open_ai_chat()
            return
        if tool_type == "todo":
            self.open_todo_panel()
            return
        if tool_type == "secret-copy":
            self.copy_secret(tool)
            return
        if tool_type == "app":
            self.launch_app(tool)
            return
        target = self.get_tool_target(tool)
        if tool_type == "url":
            webbrowser.open(target)
            self.write_log(f"[{label}] 已打开浏览器：{target}")
            return
        if not target or not Path(target).exists():
            self.write_log(f"[{label}] 找不到目标：{target}", error=True)
            self.set_notice(f"{label}：找不到脚本，请检查 tools.json", "error")
            return
        running = self.processes.get(tool_id)
        if running is not None and running.poll() is None:
            self.set_notice(f"{label}：正在运行，请等待完成", "warn")
            return
        try:
            if tool_type == "batch":
                process = subprocess.Popen([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", "call", target], cwd=str(Path(target).parent), creationflags=CREATE_NEW_CONSOLE)
                self.processes[tool_id] = process
                self.write_log(f"[{label}] 已启动。")
            elif tool_type == "powershell":
                command = [find_powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-File", target]
                command.extend(resolve_value(str(argument)) for argument in tool.get("args", []))
                process = subprocess.Popen(command, cwd=str(Path(target).parent), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
                self.processes[tool_id] = process
                threading.Thread(target=self.read_process_output, args=(tool_id, label, process), daemon=True).start()
                self.write_log(f"[{label}] 已启动。")
                if tool_id == "wifi-zscaler":
                    self.set_notice("Wi-Fi / VPN：正在切换到直连 Wi-Fi，网络会短暂中断…", "warn")
            elif tool_type == "exe":
                subprocess.Popen([target, *[resolve_value(str(argument)) for argument in tool.get("args", [])]], cwd=str(Path(target).parent))
                self.write_log(f"[{label}] 已启动。")
            elif tool_type == "folder":
                os.startfile(target)
                self.write_log(f"[{label}] 已打开文件夹。")
            else:
                self.write_log(f"[{label}] 不支持的工具类型：{tool_type}", error=True)
        except (OSError, subprocess.SubprocessError) as error:
            self.write_log(f"[{label}] 启动失败：{error}", error=True)

    def launch_app(self, tool: dict) -> None:
        label = str(tool.get("label", tool.get("id", "应用")))
        target = self.get_tool_target(tool) if tool.get("target") else ""
        app_id = str(tool.get("app_id", "")).strip()
        try:
            if target and Path(target).exists():
                subprocess.Popen([target], cwd=str(Path(target).parent), creationflags=DETACHED_PROCESS)
                self.write_log(f"[{label}] 已启动：{target}")
            elif app_id:
                os.startfile(f"shell:AppsFolder\\{app_id}")
                self.write_log(f"[{label}] 已启动（应用商店应用 {app_id}）。")
            else:
                self.write_log(f"[{label}] 找不到程序：{target}", error=True)
                self.set_notice(f"{label}：路径未找到", "error")
                return
            self.set_notice(f"{label}：已启动", "ok")
        except OSError as error:
            self.write_log(f"[{label}] 启动失败：{error}", error=True)
            self.set_notice(f"{label}：启动失败", "error")

    def execute_ssh(self, tool: dict) -> None:
        host = tool["host"]
        ssh = find_ssh_executable()
        if not ssh:
            self.write_log("[SSH] 找不到 ssh.exe。", error=True)
            return
        config_path = str(host.get("config_path", "")).strip()
        if config_path:
            command = [ssh, "-F", config_path, "-t", str(host["alias"])]
        else:
            target = f"{host.get('user')}@{host.get('hostname')}" if host.get("user") else str(host.get("hostname"))
            command = [ssh]
            port = int(host.get("port", 22))
            if port != 22:
                command.extend(["-p", str(port)])
            if host.get("identity_file"):
                command.extend(["-i", resolve_value(str(host["identity_file"]))])
            command.extend(["-t", target])
        try:
            subprocess.Popen(command, cwd=str(Path.home()), creationflags=CREATE_NEW_CONSOLE)
            self.write_log(f"[SSH {tool['label']}] 已启动，目标 {host.get('hostname', host.get('alias'))}。")
        except OSError as error:
            self.write_log(f"[SSH {tool['label']}] 启动失败：{error}", error=True)

    def execute_rdp(self, tool: dict) -> None:
        profile = tool["profile"]
        mstsc = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "mstsc.exe"
        try:
            subprocess.Popen([str(mstsc), str(profile["path"])], cwd=str(Path(profile["path"]).parent))
            self.write_log(f"[RDP {tool['label']}] 已启动，目标 {profile['address']}。")
        except OSError as error:
            self.write_log(f"[RDP {tool['label']}] 启动失败：{error}", error=True)
            return
        password = self.rdp_store.password(str(profile.get("address", "")))
        if password:
            self.copy_secret_to_clipboard(password)
            self.set_notice(f"{tool['label']}：密码已复制，在登录框按 Ctrl+V（60 秒后清除）", "ok")
            self.write_log(f"[RDP {tool['label']}] 已复制保存的密码到剪贴板，60 秒后自动清除。")

    def copy_secret_to_clipboard(self, secret: str, seconds: int = 60) -> None:
        if not set_clipboard_private(secret):
            self.root.clipboard_clear()
            self.root.clipboard_append(secret)
        self.clipboard_secret = secret

        def clear_if_unchanged() -> None:
            try:
                current = self.root.clipboard_get()
            except tk.TclError:
                current = None
            if current == self.clipboard_secret == secret:
                self.root.clipboard_clear()
                self.root.clipboard_append("")
            if self.clipboard_secret == secret:
                self.clipboard_secret = None

        self.root.after(seconds * 1000, clear_if_unchanged)

    def start_ai_hotkey(self) -> None:
        settings = self.config.get("ai", {}) if isinstance(self.config.get("ai", {}), dict) else {}
        if os.name != "nt" or not settings.get("hotkey_enabled", True):
            return
        try:
            from hotkey import RightCtrl
        except ImportError as error:
            self.write_log(f"[AI] 快捷键模块加载失败：{error}", error=True)
            return
        keys = [int(value) for value in settings.get("hotkey_keys", [0xA2]) if isinstance(value, (int, float))] or [0xA2]
        self.ai_hotkey = RightCtrl(accept=keys)
        self.root.after(80, self.poll_ai_hotkey)
        self.root.after(1500, lambda: self.write_log("[AI] 快捷键：单击左 Ctrl 打开输入框，再按开启微信语音输入，第三次收起。" if self.ai_hotkey and self.ai_hotkey.available else "[AI] 左 Ctrl 快捷键安装失败。", error=not (self.ai_hotkey and self.ai_hotkey.available)))

    def poll_ai_hotkey(self) -> None:
        hotkey = self.ai_hotkey
        if hotkey is None:
            return
        fired = False
        while not hotkey.events.empty():
            hotkey.events.get_nowait()
            fired = True
        if fired:
            if self.ai_panel is None or not self.ai_panel.is_visible():
                self.open_ai_chat(force_show=True)
            else:
                self.ai_panel.hotkey_tap()
        self.root.after(60, self.poll_ai_hotkey)

    def open_ai_chat(self, force_show: bool = False) -> None:
        if self.ai_panel is None:
            try:
                from ai_panel import AIChatPanel
            except ImportError as error:
                self.write_log(f"[AI] 无法加载 AI 对话模块：{error}", error=True)
                return
            self.ai_panel = AIChatPanel(self, {"UI_FONT": UI_FONT, "FlatButton": FlatButton, "draw_badge": draw_badge, "apply_title_bar_theme": apply_title_bar_theme, "get_work_area": get_primary_work_area, "ToolTip": ToolTip})
        if force_show:
            self.ai_panel.show()
        else:
            self.ai_panel.toggle()

    def read_process_output(self, tool_id: str, label: str, process: subprocess.Popen) -> None:
        if process.stdout:
            for line in process.stdout:
                self.events.put(("process_output", (tool_id, label, line.rstrip())))
        self.events.put(("process_done", (tool_id, label, process.wait())))

    def start_sfc_login(self) -> None:
        if self.sfc_login_running:
            self.set_notice("SFC 登录正在进行中", "warn")
            return
        self.sfc_login_running = True
        self.set_notice("SFC 正在启动并等待登录窗口...", "warn")
        self.write_log("[SFC] 开始自动登录。")
        threading.Thread(target=self.run_sfc_login, daemon=True).start()

    def run_sfc_login(self) -> None:
        try:
            sfc = get_sfc_integration()
            sfc.launch_and_login(sfc.load_sfc_config(), lambda message: self.events.put(("sfc_status", message)))
            self.events.put(("sfc_done", (True, "SFC 登录动作已完成")))
        except Exception as error:
            self.events.put(("sfc_done", (False, f"SFC 登录失败：{error}")))

    def open_sfc_settings(self) -> None:
        if self.sfc_settings_window is not None and self.sfc_settings_window.winfo_exists():
            self.sfc_settings_window.lift()
            return
        sfc = get_sfc_integration()
        config = sfc.load_sfc_config()
        window = tk.Toplevel(self.root)
        self.sfc_settings_window = window
        window.title("SFC 设置")
        window.geometry("520x250")
        frame = ttk.Frame(window, padding=16)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(1, weight=1)
        ttk.Label(frame, text="SFC 程序").grid(row=0, column=0, sticky="w", pady=6)
        path_var = tk.StringVar(value=config.sfc_path)
        ttk.Entry(frame, textvariable=path_var).grid(row=0, column=1, sticky="ew", pady=6)
        ttk.Button(frame, text="浏览", command=lambda: self.choose_sfc_path(path_var)).grid(row=0, column=2, padx=(8, 0), pady=6)
        ttk.Label(frame, text="账号").grid(row=1, column=0, sticky="w", pady=6)
        username_var = tk.StringVar(value=config.sfc_username)
        ttk.Entry(frame, textvariable=username_var).grid(row=1, column=1, sticky="ew", pady=6)
        ttk.Label(frame, text="密码").grid(row=2, column=0, sticky="w", pady=6)
        password_var = tk.StringVar(value=config.sfc_password)
        ttk.Entry(frame, textvariable=password_var, show="*").grid(row=2, column=1, sticky="ew", pady=6)
        ttk.Label(frame, text="等待秒数").grid(row=3, column=0, sticky="w", pady=6)
        timeout_var = tk.IntVar(value=config.login_timeout_seconds)
        ttk.Spinbox(frame, from_=5, to=120, textvariable=timeout_var).grid(row=3, column=1, sticky="w", pady=6)
        def save() -> None:
            try:
                sfc.save_sfc_config(sfc.SfcConfig(path_var.get().strip() or sfc.DEFAULT_SFC_PATH, username_var.get().strip(), password_var.get(), max(5, min(120, int(timeout_var.get())))))
                self.set_notice("SFC 设置已保存", "ok")
                self.write_log("[SFC] 设置已保存。")
                window.destroy()
            except Exception as error:
                messagebox.showerror("SFC 设置", str(error), parent=window)
        ttk.Button(frame, text="保存", command=save).grid(row=4, column=1, sticky="w", pady=(14, 0))
        ttk.Button(frame, text="取消", command=window.destroy).grid(row=4, column=1, sticky="w", padx=(80, 0), pady=(14, 0))

    def choose_sfc_path(self, variable: tk.StringVar) -> None:
        selected = filedialog.askopenfilename(title="选择 SFC 程序", filetypes=[("Executable", "*.exe"), ("All files", "*.*")])
        if selected:
            variable.set(selected)

    def process_events(self) -> None:
        try:
            while True:
                event_type, payload = self.events.get_nowait()
                if event_type == "network" and self.network_label is not None:
                    self.network_label.configure(text=str(payload).replace("当前 Wi-Fi：", ""))
                elif event_type == "codex_status":
                    if self.floating_toolbox is not None:
                        self.floating_toolbox.draw_status(payload)
                elif event_type == "process_output":
                    tool_id, label, output = payload
                    self.write_log(f"[{label}] {output}")
                    self.update_notice_from_output(output, tool_id)
                elif event_type == "pending":
                    self.pending_store.update(payload)
                    if self.floating_toolbox is not None:
                        self.floating_toolbox.refresh_badges()
                elif event_type == "sfc_status":
                    self.write_log(f"[SFC] {payload}")
                    self.set_notice(str(payload), "warn")
                elif event_type == "sfc_done":
                    success, message = payload
                    self.sfc_login_running = False
                    self.write_log(f"[SFC] {message}", error=not success)
                    self.set_notice(message, "ok" if success else "error")
                elif event_type == "process_done":
                    tool_id, label, return_code = payload
                    self.processes.pop(tool_id, None)
                    if tool_id.startswith("opencode-") and return_code != 0:
                        self.set_notice("OpenCode：操作失败", "error")
                    elif tool_id == "wifi-zscaler":
                        message, level = WIFI_SWITCH_RESULTS.get(return_code, (f"Wi-Fi / VPN：异常结束（代码 {return_code}），详见运行记录", "error"))
                        self.set_notice(message, level)
                        self.write_log(f"[{label}] {message}", error=level == "error")
                        self.refresh_network_status()
        except queue.Empty:
            pass
        self.root.after(100, self.process_events)

    def update_notice_from_output(self, message: str, tool_id: str) -> None:
        if tool_id == "wifi-zscaler":
            text = re.sub(r"^\[[^\]]*\]\s*(\[(INFO|WARN|ERROR)\]\s*)?", "", message).strip()
            if text:
                self.set_notice(f"Wi-Fi / VPN：{text}", "error" if "[ERROR]" in message else "warn")
            return
        if not tool_id.startswith("opencode-"):
            return
        if "健康检查未通过" in message:
            self.set_notice("OpenCode：进程存在，但健康检查未通过", "error")
        elif "运行中" in message or "已在运行" in message or "已启动" in message:
            self.set_notice("OpenCode：运行中", "ok")
        elif "已停止" in message or "未运行" in message or "已关闭" in message:
            self.set_notice("OpenCode：已停止", "ok")
        elif "失败" in message or "error" in message.lower():
            self.set_notice("OpenCode：操作失败", "error")

    def refresh_network_status(self) -> None:
        threading.Thread(target=lambda: self.events.put(("network", read_wifi_state())), daemon=True).start()

    def write_log(self, message: str, error: bool = False) -> None:
        self.action_history.append((datetime.now(), message, error))
        del self.action_history[:-200]
        if self.log_text is None:
            return
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{datetime.now():%H:%M:%S}] {message}\n")
        if error:
            self.log_text.tag_add("error", "end-2l linestart", "end-1c")
            self.log_text.tag_configure("error", foreground=STATUS_TONES["error"])
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def clear_log(self) -> None:
        if self.log_text is not None:
            self.log_text.configure(state="normal")
            self.log_text.delete("1.0", "end")
            self.log_text.configure(state="disabled")

    def open_config(self) -> None:
        os.startfile(str(self.config_path))

    def open_toolbox_folder(self) -> None:
        os.startfile(str(self.config_path.parent))

    def open_worktoolkit_folder(self) -> None:
        os.startfile(str(get_toolkit_root()))

    def hide_main(self) -> None:
        self.root.withdraw()
        if self.floating_toolbox is None:
            self.floating_toolbox = FloatingToolbox(self)
        elif self.floating_toolbox.window.state() == "withdrawn":
            self.floating_toolbox.show()

    def show_main(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def watch_show_requests(self, handle: int | None) -> None:
        if not handle:
            return
        kernel32 = ctypes.WinDLL("kernel32")
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32

        def poll() -> None:
            if kernel32.WaitForSingleObject(handle, 0) == 0:
                self.show_main()
            self.root.after(400, poll)

        self.root.after(400, poll)

    def close(self) -> None:
        if self.ai_hotkey is not None:
            self.ai_hotkey.close()
            self.ai_hotkey = None
        if self.ai_panel is not None:
            self.ai_panel.destroy()
        if self.floating_toolbox is not None:
            self.floating_toolbox.destroy()
        if self.pending_server is not None:
            self.pending_server.shutdown()
            self.pending_server.server_close()
        self.root.destroy()


def show_startup_error(message: str) -> None:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror("工作工具箱", message)
    root.destroy()


def set_app_user_model_id() -> None:
    # Own taskbar identity so the button shows the Wt icon instead of grouping under python/pythonw.
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(ctypes.c_wchar_p(APP_USER_MODEL_ID))
    except (AttributeError, OSError):
        pass


def main() -> None:
    set_app_user_model_id()
    acquired, mutex_handle = acquire_single_instance()
    if not acquired:
        if not signal_running_instance():
            show_startup_error("工作工具箱已经在运行。")
        return
    show_event = create_show_event()
    try:
        config, config_path = load_config()
        root = tk.Tk()
        toolbox = WorkToolbox(root, config, config_path)
        toolbox.watch_show_requests(show_event)
        if config.get("app", {}).get("show_floating_toolbox", True):
            toolbox.floating_toolbox = FloatingToolbox(toolbox)
        root.mainloop()
    except Exception as error:
        write_startup_error(traceback.format_exc())
        show_startup_error(str(error))
    finally:
        release_single_instance(show_event)
        release_single_instance(mutex_handle)


if __name__ == "__main__":
    main()
