"""Floating AI chat panel for the Work Toolbox dock.

The request/key layer is ai_service.py (copied from Caleb Desktop Pet), so the
panel reuses the pet's endpoint, model and DPAPI-encrypted API key by default.
Only messages the user explicitly sends are transmitted; the persona is a
neutral work assistant instead of the pet's roleplay character.
"""
from __future__ import annotations

from datetime import datetime
import json
import os
from pathlib import Path
import re
import threading
import tkinter as tk
import tkinter.font as tkfont

from ai_service import AIService, KeyStore, load_config, probe, save_config
import aa_draw

try:
    from PIL import Image, ImageDraw, ImageTk
except ImportError:  # icons fall back to plain canvas shapes
    Image = None

DEFAULT_SYSTEM_PROMPT = (
    "你是 Windows 工作工具箱里的中性工作助手。用简洁、专业的简体中文回答，"
    "优先给出可直接执行的步骤、命令或结论；不确定时直接说明。"
    "用户是制造业/IT 相关工作者，常见话题包括 Windows、网络、Python、Excel、SSH、RDP 和办公写作。"
    "不要扮演角色，不要寒暄堆砌。"
)
HISTORY_LIMIT = 200
WEEKDAYS = "一二三四五六日"
ACTION_PROMPT = """
你还能直接替用户记录事情（工具箱会执行，不需要用户再复制）：
- 用户要你记待办、提醒、加到 todo、安排某天做某事时 → 写入待办清单（Obsidian Todo.md）。
- 用户要你记一下、记到日志/日记/daily、备忘刚发生的事、会议结论时 → 写入 Obsidian 今日日记的“工作记录”。
这时先用一两句话确认你记了什么，然后在回复最末尾输出一个代码块（只在需要记录时输出，普通问答不要输出）：
```toolbox
{"todo":[{"title":"动词开头的简洁标题","due":"YYYY-MM-DD 或空","time":"HH:MM 或空","priority":"high|normal|low","notes":"","subtasks":[]}],"daily":["一行日志内容"]}
```
规则：没有的字段给空数组；due 按当前日期换算“今天/明天/周三/下周一”等，没有时间要求留空；提到紧急、尽快、今天必须 → high；
一段话里的多件独立事情拆成多条 todo；不要编造用户没说的人名、日期、数字；用户说“刚才的/上面的”时，根据对话内容整理。"""
ACTION_RE = re.compile(r"```toolbox\s*(\{.*?\})\s*```", re.S)


def expand(value: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(value)))


class ChatHistory:
    """Small local JSONL log so the panel reopens with recent context."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> list[dict]:
        records = []
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            return []
        for line in lines[-HISTORY_LIMIT:]:
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict) and item.get("role") in {"user", "assistant"} and isinstance(item.get("text"), str):
                records.append(item)
        return records

    def append(self, role: str, text: str) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"time": datetime.now().isoformat(timespec="seconds"), "role": role, "text": text}, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def clear(self) -> None:
        try:
            self.path.unlink()
        except OSError:
            pass


BUBBLE_COLORS = {
    # WhatsApp-like palettes: chat wallpaper, outgoing (user), incoming (assistant), text, timestamp.
    "dark": {"wall": "#0b141a", "user": "#005c4b", "ai": "#202c33", "text": "#e9edef", "time": "#8696a0", "error": "#ff7b72", "hint": "#8696a0"},
    "light": {"wall": "#efeae2", "user": "#d9fdd3", "ai": "#ffffff", "text": "#111b21", "time": "#667781", "error": "#d93025", "hint": "#667781"},
}


def rounded_rect(canvas: tk.Canvas, x1: float, y1: float, x2: float, y2: float, radius: float, **options) -> int:
    radius = max(1.0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
    points = [
        x1 + radius, y1, x2 - radius, y1, x2, y1, x2, y1 + radius,
        x2, y2 - radius, x2, y2, x2 - radius, y2, x1 + radius, y2,
        x1, y2, x1, y2 - radius, x1, y1 + radius, x1, y1,
    ]
    return aa_draw.round_rect(canvas, x1, y1, x2, y2, radius, **options)


TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_@#$%&+=/\\.:\-]+|\s|.", re.S)


def wrap_text(font: tkfont.Font, text: str, max_width: int) -> str:
    """Wrap like a chat app: CJK can break anywhere, Latin words stay whole.

    Tk only breaks at spaces, which pushes a whole Chinese run onto the next line
    after any English word.
    """
    lines: list[str] = []
    for paragraph in text.split("\n"):
        line, width = "", 0
        for token in TOKEN_PATTERN.findall(paragraph):
            token_width = font.measure(token)
            if width + token_width > max_width and line:
                lines.append(line.rstrip())
                line, width = "", 0
                if token.isspace():
                    continue
            if token_width > max_width:
                for char in token:
                    char_width = font.measure(char)
                    if width + char_width > max_width and line:
                        lines.append(line)
                        line, width = "", 0
                    line += char
                    width += char_width
            else:
                line += token
                width += token_width
        lines.append(line.rstrip())
    return "\n".join(lines)


def force_foreground(window: tk.Misc) -> None:
    """Bring the popup to the foreground even when opened from a global hotkey.

    Windows refuses SetForegroundWindow for background processes, so briefly attach
    to the current foreground thread's input queue first.
    """
    if os.name != "nt":
        return
    try:
        import ctypes
        user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
        hwnd = user32.GetParent(window.winfo_id()) or window.winfo_id()
        foreground = user32.GetForegroundWindow()
        if foreground == hwnd:
            return
        target_thread = user32.GetWindowThreadProcessId(foreground, None)
        own_thread = kernel32.GetCurrentThreadId()
        attached = bool(target_thread and target_thread != own_thread and user32.AttachThreadInput(own_thread, target_thread, True))
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(own_thread, target_thread, False)
    except (AttributeError, OSError, tk.TclError):
        pass


def _rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    color = color.lstrip("#")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16), alpha


def render_button_icon(kind: str, size: int, background: str, fill: str | None, glyph: str, halo: str | None = None) -> "ImageTk.PhotoImage":
    """Anti-aliased round button (4x supersampled). kind: send / stop / mic."""
    scale = 4
    s = size * scale
    image = Image.new("RGBA", (s, s), _rgba(background))
    draw = ImageDraw.Draw(image)
    if halo:
        draw.ellipse((0, 0, s - 1, s - 1), fill=_rgba(halo, 70))
    inset = 2 * scale if halo else scale // 2
    if fill:
        draw.ellipse((inset, inset, s - 1 - inset, s - 1 - inset), fill=_rgba(fill))
    c = s / 2
    line = round(1.9 * scale)
    ink = _rgba(glyph)

    def stroke(points: list[tuple[float, float]]) -> None:
        draw.line(points, fill=ink, width=line, joint="curve")
        radius = line / 2
        for x, y in (points[0], points[-1]):
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=ink)

    u = s / 30
    if kind == "send":
        stroke([(c, c + 7 * u), (c, c - 7 * u)])
        stroke([(c - 5.5 * u, c - 1.5 * u), (c, c - 7 * u), (c + 5.5 * u, c - 1.5 * u)])
    elif kind == "stop":
        half = 4.8 * u
        draw.rounded_rectangle((c - half, c - half, c + half, c + half), radius=1.8 * u, fill=ink)
    elif kind == "mic":
        body_w, top, bottom = 3.4 * u, c - 8 * u, c + 2.2 * u
        draw.rounded_rectangle((c - body_w, top, c + body_w, bottom), radius=body_w, fill=ink)
        arc_r = 6.2 * u
        draw.arc((c - arc_r, c - 5.5 * u, c + arc_r, c + 5.2 * u + arc_r * 0.2), start=15, end=165, fill=ink, width=line)
        stroke([(c, c + 6.4 * u), (c, c + 9 * u)])
        stroke([(c - 3.6 * u, c + 9 * u), (c + 3.6 * u, c + 9 * u)])
    return ImageTk.PhotoImage(image.resize((size, size), Image.LANCZOS))


def set_window_frame(window: tk.Misc) -> None:
    """Rounded corners without an outline for the borderless popup (Windows 11 DWM)."""
    if os.name != "nt":
        return
    try:
        import ctypes
        hwnd = ctypes.windll.user32.GetParent(window.winfo_id()) or window.winfo_id()
        corner = ctypes.c_int(2)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(corner), ctypes.sizeof(corner))
        border = ctypes.c_uint(0xFFFFFFFE)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 34, ctypes.byref(border), ctypes.sizeof(border))
    except (AttributeError, OSError):
        pass


class AIChatPanel:
    """Borderless popup anchored to the floating dock.

    Starts as a single input bar right above (or below) the dock. When the first
    reply arrives the chat area unfolds away from the dock, so the dock never
    covers it.
    """

    WIDTH = 380
    CHAT_HEIGHT = 380
    GAP = 8
    MAX_INPUT_LINES = 5

    def __init__(self, owner, ui: dict) -> None:
        self.owner = owner
        self.ui = ui
        self.theme = owner.theme
        self.colors = BUBBLE_COLORS["light" if self.theme.get("name") == "light" else "dark"]
        settings = owner.config.get("ai", {}) if isinstance(owner.config.get("ai", {}), dict) else {}
        self.config_path = expand(str(settings.get("config_file", r"%LOCALAPPDATA%\WorkToolbox\ai-config.json")))
        seed_path = expand(str(settings.get("seed_config_file", r"%APPDATA%\CalebDesktopPet\ai-config.json")))
        if not self.config_path.exists() and seed_path.is_file():
            seeded = load_config(seed_path)
            if settings.get("model"):
                seeded["model"] = str(settings["model"])
            try:
                save_config(self.config_path, seeded)
            except OSError:
                pass
        self.key_store = KeyStore(expand(str(settings.get("key_file", r"%APPDATA%\CalebDesktopPet\ai-key.bin"))))
        local_app_data = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        self.history = ChatHistory(Path(local_app_data) / "WorkToolbox" / "ai-history.jsonl")
        self.system_prompt = str(settings.get("system_prompt") or DEFAULT_SYSTEM_PROMPT)
        self.context_messages = max(2, int(settings.get("context_messages", 12)))
        self.service = AIService(load_config(self.config_path))
        self.records = self.history.load()
        self.request_id: int | None = None
        self.poll_id: str | None = None
        self.settings_window: tk.Toplevel | None = None
        self.window: tk.Toplevel | None = None
        self.expanded = False
        self.direction = "up"
        self.anchor_x = 0
        self.anchor_y = 0
        self.pending: dict | None = None
        self.bubble_tops: list[float] = []
        self.voice_enabled = bool(settings.get("voice_alt", True))
        self.voice_key = int(settings.get("voice_key", 0xA5))
        self.voice_on = False
        self.focus_after_id: str | None = None
        self.icon_cache: dict = {}
        self.hover: set[str] = set()

    # ---------- window ----------
    def toggle(self) -> None:
        if self.is_visible():
            self.hide()
        else:
            self.show()

    def is_visible(self) -> bool:
        return self.window is not None and self.window.winfo_exists() and self.window.state() != "withdrawn"

    def show(self) -> None:
        if self.window is None or not self.window.winfo_exists():
            self.build()
        self.set_expanded(False, relayout=False)
        self.compute_anchor()
        self.window.deiconify()
        self.relayout_window()
        self.window.lift()
        self.voice_on = False
        self.draw_mic_button()
        self.window.after(20, lambda: set_window_frame(self.window))
        self.window.after(40, self.focus_input)

    def focus_input(self, then=None, attempt: int = 0) -> None:
        """Put the caret in the input box, retrying until Windows really made the popup foreground.

        A background process often loses the first SetForegroundWindow; voice input from the
        IME goes to whatever holds focus, so `then` (e.g. the voice trigger) only runs once
        the input box is confirmed focused.
        """
        if not self.is_visible():
            return
        if self.focus_after_id:
            try:
                self.window.after_cancel(self.focus_after_id)
            except tk.TclError:
                pass
            self.focus_after_id = None
        force_foreground(self.window)
        self.window.focus_force()
        self.input.focus_force()
        self.input.mark_set("insert", "end-1c")
        self.input.see("insert")
        if self.input_has_focus():
            if then is not None:
                then()
            return
        if attempt in (3, 6):
            self.synthetic_click_input()
        if attempt < 10:
            delay = (40, 60, 80, 100, 120, 150, 180, 220, 260, 320)[attempt]
            self.focus_after_id = self.window.after(delay, lambda: self.focus_input(then, attempt + 1))
        elif then is not None:
            self.set_status("没能把焦点切到输入框，请先点一下输入框再开语音。", error=True)

    def input_has_focus(self) -> bool:
        if os.name != "nt":
            return True
        try:
            import ctypes
            foreground = ctypes.windll.user32.GetForegroundWindow()
            return foreground == int(self.window.frame(), 16) and self.window.focus_get() is self.input
        except (AttributeError, OSError, ValueError, tk.TclError, KeyError):
            return False

    def synthetic_click_input(self) -> None:
        # Same fallback as the pet: a posted click makes the widget take the caret like a real click.
        if os.name != "nt":
            return
        try:
            import ctypes
            hwnd = self.input.winfo_id()
            x = max(1, self.input.winfo_width() - 4)
            y = max(1, self.input.winfo_height() // 2)
            ctypes.windll.user32.PostMessageW(ctypes.c_void_p(hwnd), 0x0201, 1, (y << 16) | x)
            ctypes.windll.user32.PostMessageW(ctypes.c_void_p(hwnd), 0x0202, 0, (y << 16) | x)
        except (AttributeError, OSError, tk.TclError):
            pass

    def hide(self) -> None:
        if self.window is not None and self.window.winfo_exists():
            if self.voice_on:
                self.toggle_voice()
            self.window.withdraw()

    def hotkey_tap(self) -> None:
        """Left Ctrl, like Caleb Desktop Pet: 1st opens the bar, 2nd starts WeChat voice input, 3rd closes."""
        if not self.is_visible():
            self.show()
        elif self.voice_enabled and not self.voice_on:
            self.toggle_voice()
        else:
            self.hide()

    def toggle_voice(self) -> None:
        """Press the IME voice hotkey (Right Alt for WeChat input) into our own input box."""
        if not self.voice_enabled or not self.is_visible():
            return
        if self.voice_on:
            self._press_voice_key()
        else:
            # Select the input box first so the dictated text lands here, then trigger the IME.
            self.focus_input(then=lambda: self.window.after(80, self._press_voice_key))

    def _press_voice_key(self) -> None:
        if not self.is_visible():
            return
        from hotkey import press_key
        press_key(self.voice_key)
        self.voice_on = not self.voice_on
        self.draw_mic_button()
        if self.voice_on:
            self.set_status("")

    def destroy(self) -> None:
        self.service.cancel()
        if self.window is not None and self.window.winfo_exists():
            self.window.destroy()
        self.window = None

    def build(self) -> None:
        theme = self.theme
        font = self.ui["UI_FONT"]
        FlatButton = self.ui["FlatButton"]
        panel = theme["panel"]
        window = tk.Toplevel(self.owner.root)
        self.window = window
        window.title("AI 助手")
        window.overrideredirect(True)
        window.configure(background=panel)
        window.wm_attributes("-topmost", True)
        window.bind("<Escape>", lambda _event: self.hide())

        # Chat area (header + bubbles); only packed while expanded.
        self.chat = tk.Frame(window, background=panel)
        header = tk.Frame(self.chat, background=panel, padx=12, pady=7)
        header.pack(fill="x")
        header.columnconfigure(0, weight=1)
        tk.Label(header, text="AI 工作助手", background=panel, foreground=theme["text"], font=(font, 9, "bold")).grid(row=0, column=0, sticky="w")
        self.model_label = tk.Label(header, text="", background=panel, foreground=theme["subtle"], font=(font, 7))
        self.model_label.grid(row=1, column=0, sticky="w")
        for column, (text, command) in enumerate((("复制", self.copy_last_reply), ("清空", self.clear), ("⚙", self.open_settings), ("⌄", lambda: self.set_expanded(False)), ("✕", self.hide)), start=1):
            FlatButton(header, theme, text, command, size=8 if len(text) > 1 else 9).grid(row=0, column=column, rowspan=2, padx=(2, 0))
        self.canvas = tk.Canvas(self.chat, width=self.WIDTH, height=self.CHAT_HEIGHT, background=self.colors["wall"], highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _event: self.render_all())
        self.canvas.bind("<MouseWheel>", self.on_wheel)
        self.status_label = tk.Label(self.chat, text="", background=self.colors["wall"], foreground=self.colors["hint"], font=(font, 7), anchor="w", padx=12)
        self.status_label.pack(fill="x")

        # Input bar: always visible, sits next to the dock.
        self.bar = tk.Frame(window, background=panel, padx=10, pady=9)
        self.bar.columnconfigure(1, weight=1)
        badge = tk.Canvas(self.bar, width=28, height=28, background=panel, highlightthickness=0, bd=0, cursor="hand2")
        badge.grid(row=0, column=0, sticky="s", padx=(0, 8))
        self.ui["draw_badge"](badge, 14, 14, "Ai", "ai", 28, theme["accent"])
        badge.bind("<Button-1>", lambda _event: self.set_expanded(not self.expanded))
        if "ToolTip" in self.ui:
            self.ui["ToolTip"](badge, "展开 / 收起对话记录", delay_ms=300)
        field = tk.Frame(self.bar, background=theme["card"], highlightthickness=1, highlightbackground=theme["border"], highlightcolor=theme["accent"])
        field.grid(row=0, column=1, sticky="ew")
        field.columnconfigure(0, weight=1)
        self.input = tk.Text(field, height=1, wrap="word", background=theme["card"], foreground=theme["text"], insertbackground=theme["text"], selectbackground=theme["accent"], relief="flat", borderwidth=0, highlightthickness=0, padx=10, pady=6, font=(font, 9), undo=True)
        self.input.grid(row=0, column=0, sticky="ew")
        self.placeholder = tk.Label(field, text="问点什么…  Enter 发送 · Shift+Enter 换行", background=theme["card"], foreground=theme["subtle"], font=(font, 9), cursor="xterm")
        self.placeholder.place(x=11, rely=0.5, anchor="w")
        self.placeholder.bind("<Button-1>", lambda _event: self.input.focus_set())
        self.input.bind("<Return>", self.on_return)
        self.input.bind("<KeyRelease>", lambda _event: self.on_input_changed(), add="+")
        self.input.bind("<<Paste>>", lambda _event: self.window.after(1, self.on_input_changed), add="+")
        # IME / voice dictation commits text without key events; <<Modified>> catches every insert.
        self.input.bind("<<Modified>>", self.on_input_modified, add="+")
        self.mic_canvas = tk.Canvas(self.bar, width=30, height=30, background=panel, highlightthickness=0, bd=0, cursor="hand2")
        if self.voice_enabled:
            self.mic_canvas.grid(row=0, column=2, sticky="s", padx=(6, 0))
            self.mic_canvas.bind("<Button-1>", lambda _event: self.toggle_voice())
            self.bind_hover(self.mic_canvas, "mic", self.draw_mic_button)
            if "ToolTip" in self.ui:
                self.ui["ToolTip"](self.mic_canvas, "微信语音输入（自动选中输入框后按一次右 Alt）\n快捷键：左 Ctrl 打开 → 再按开语音 → 第三次收起", delay_ms=300)
        self.draw_mic_button()
        self.send_canvas = tk.Canvas(self.bar, width=30, height=30, background=panel, highlightthickness=0, bd=0, cursor="hand2")
        self.send_canvas.grid(row=0, column=3, sticky="s", padx=(6, 0))
        self.send_canvas.bind("<Button-1>", lambda _event: self.send_or_stop())
        self.bind_hover(self.send_canvas, "send", self.draw_send_button)
        self.draw_send_button()
        self.bar.pack(side="bottom", fill="x")
        self.refresh_model_label()

    def bind_hover(self, widget: tk.Widget, name: str, redraw) -> None:
        def enter(_event) -> None:
            self.hover.add(name)
            redraw()

        def leave(_event) -> None:
            self.hover.discard(name)
            redraw()

        widget.bind("<Enter>", enter, add="+")
        widget.bind("<Leave>", leave, add="+")

    def icon(self, kind: str, fill: str | None, glyph: str, halo: str | None = None):
        key = (kind, fill, glyph, halo)
        if key not in self.icon_cache:
            self.icon_cache[key] = render_button_icon(kind, 30, self.theme["panel"], fill, glyph, halo)
        return self.icon_cache[key]

    def draw_mic_button(self) -> None:
        canvas = getattr(self, "mic_canvas", None)
        if canvas is None:
            return
        canvas.delete("all")
        hovered = "mic" in self.hover
        if self.voice_on:
            fill, glyph, halo = ("#2fe07a" if hovered else "#25d366"), "#ffffff", "#25d366"
        else:
            fill, glyph, halo = (self.theme["card_hover"] if hovered else None), (self.theme["text"] if hovered else self.theme["muted"]), None
        if Image is not None:
            canvas.create_image(15, 15, image=self.icon("mic", fill, glyph, halo))
            return
        if fill:
            canvas.create_oval(2, 2, 28, 28, fill=fill, outline="")
        canvas.create_text(15, 15, text="\uE720", fill=glyph, font=("Segoe MDL2 Assets", 11))

    def draw_send_button(self) -> None:
        canvas = getattr(self, "send_canvas", None)
        if canvas is None:
            return
        canvas.delete("all")
        busy = self.request_id is not None
        hovered = "send" in self.hover
        has_text = bool(self.input.get("1.0", "end-1c").strip()) if hasattr(self, "input") else False
        if busy:
            kind, fill, glyph = "stop", ("#ffffff" if hovered else self.theme["text"]), self.theme["panel"]
        elif has_text:
            kind, fill, glyph = "send", (self.lighten(self.theme["accent"]) if hovered else self.theme["accent"]), "#ffffff"
        else:
            kind, fill, glyph = "send", self.theme["card_hover"] if hovered else self.theme["card"], self.theme["subtle"]
        if Image is not None:
            canvas.create_image(15, 15, image=self.icon(kind, fill, glyph))
            return
        canvas.create_oval(1, 1, 29, 29, fill=fill, outline="")
        if busy:
            canvas.create_rectangle(10, 10, 20, 20, fill=glyph, outline="")
        else:
            canvas.create_line(15, 21, 15, 9, fill=glyph, width=2, capstyle="round")
            canvas.create_line(10, 14, 15, 9, 20, 14, fill=glyph, width=2, capstyle="round", joinstyle="round")

    @staticmethod
    def lighten(color: str, ratio: float = 0.18) -> str:
        r, g, b, _ = _rgba(color)
        return "#" + "".join(f"{round(v + (255 - v) * ratio):02x}" for v in (r, g, b))

    def on_input_modified(self, _event=None) -> None:
        if self.input.edit_modified():
            self.input.edit_modified(False)
            self.on_input_changed()

    # ---------- placement ----------
    def compute_anchor(self) -> None:
        """Pick the dock edge to grow from, so the popup never overlaps the dock."""
        left, top, right, bottom = self.ui["get_work_area"]()
        dock = getattr(self.owner, "floating_toolbox", None)
        width = self.WIDTH
        full_height = self.CHAT_HEIGHT + 120
        if dock is not None and dock.window.winfo_exists() and dock.window.state() != "withdrawn":
            dock.window.update_idletasks()
            dock_x, dock_y = dock.window.winfo_rootx(), dock.window.winfo_rooty()
            dock_h = dock.window.winfo_height()
            self.anchor_x = max(left, min(dock_x, right - width))
            room_above = dock_y - self.GAP - top
            room_below = bottom - (dock_y + dock_h + self.GAP)
            if room_above >= full_height or room_above >= room_below:
                self.direction, self.anchor_y = "up", dock_y - self.GAP
            else:
                self.direction, self.anchor_y = "down", dock_y + dock_h + self.GAP
        else:
            self.anchor_x = right - width - 24
            self.direction, self.anchor_y = "up", bottom - 24

    def relayout_window(self) -> None:
        window = self.window
        if window is None or not window.winfo_exists():
            return
        window.update_idletasks()
        left, top, right, bottom = self.ui["get_work_area"]()
        height = window.winfo_reqheight()
        if self.direction == "up":
            y = max(top, self.anchor_y - height)
        else:
            y = min(self.anchor_y, bottom - height)
        window.geometry(f"{self.WIDTH}x{height}+{self.anchor_x}+{y}")

    def set_expanded(self, expanded: bool, relayout: bool = True) -> None:
        if self.window is None:
            return
        self.expanded = expanded
        self.chat.pack_forget()
        self.bar.pack_forget()
        if self.direction == "up":
            self.bar.pack(side="bottom", fill="x")
            if expanded:
                self.chat.pack(side="top", fill="both", expand=True)
        else:
            self.bar.pack(side="top", fill="x")
            if expanded:
                self.chat.pack(side="top", fill="both", expand=True)
        if relayout:
            self.relayout_window()
        if expanded:
            self.render_all()

    def on_input_changed(self) -> None:
        content = self.input.get("1.0", "end-1c")
        if content:
            self.placeholder.place_forget()
        elif self.request_id is None:
            self.placeholder.configure(text="问点什么…  Enter 发送 · Shift+Enter 换行")
            self.placeholder.place(x=11, rely=0.5, anchor="w")
        try:
            lines = int(self.input.count("1.0", "end-1c", "displaylines")[0]) + 1
        except (tk.TclError, TypeError, IndexError):
            lines = content.count("\n") + 1
        lines = max(1, min(self.MAX_INPUT_LINES, lines))
        self.draw_send_button()
        if int(self.input.cget("height")) != lines:
            self.input.configure(height=lines)
            self.relayout_window()

    # ---------- bubbles ----------
    def on_wheel(self, event: tk.Event) -> str:
        self.canvas.yview_scroll(int(-event.delta / 120) * 2, "units")
        return "break"

    def visible_messages(self) -> list[dict]:
        messages = [dict(record) for record in self.records[-40:]]
        if self.pending is not None:
            messages.append(self.pending)
        return messages

    def render_all(self) -> None:
        if self.window is None or not self.expanded:
            return
        canvas = self.canvas
        canvas.delete("all")
        self.bubble_tops = []
        messages = self.visible_messages()
        width = max(200, canvas.winfo_width())
        if not messages:
            canvas.create_text(width / 2, 40, text="有问题直接问。只有点击发送时才会把问题和最近几轮对话\n发给已配置的 AI 服务，请勿发送密码或公司机密。", fill=self.colors["hint"], font=(self.ui["UI_FONT"], 8), justify="center", width=width - 40)
            canvas.configure(scrollregion=(0, 0, width, self.CHAT_HEIGHT))
            return
        y = 12.0
        for index, message in enumerate(messages):
            self.bubble_tops.append(y)
            y += self.draw_bubble(index, message, y, width) + 6
        self.finish_scroll(y)

    def finish_scroll(self, content_bottom: float) -> None:
        width = max(200, self.canvas.winfo_width())
        self.canvas.configure(scrollregion=(0, 0, width, max(content_bottom + 8, self.canvas.winfo_height())))
        self.canvas.yview_moveto(1.0)

    def rerender_last(self) -> None:
        if self.window is None or not self.expanded or not self.bubble_tops:
            self.render_all()
            return
        messages = self.visible_messages()
        if len(messages) != len(self.bubble_tops):
            self.render_all()
            return
        index = len(messages) - 1
        self.canvas.delete(f"bubble{index}")
        width = max(200, self.canvas.winfo_width())
        height = self.draw_bubble(index, messages[index], self.bubble_tops[index], width)
        self.finish_scroll(self.bubble_tops[index] + height + 6)

    def draw_bubble(self, index: int, message: dict, top: float, width: int) -> float:
        canvas = self.canvas
        colors = self.colors
        font = self.ui["UI_FONT"]
        user = message.get("role") == "user"
        tag = f"bubble{index}"
        text = str(message.get("text", "")).strip() or "…"
        pad_x, pad_y, margin, tail = 10, 7, 12, 7
        max_text = int(width * 0.74) - pad_x * 2
        stamp = self.format_time(message.get("time"))
        text_color = colors["error"] if message.get("error") else colors["text"]
        if getattr(self, "bubble_font", None) is None:
            self.bubble_font = tkfont.Font(root=canvas, family=font, size=9)
        text_id = canvas.create_text(0, 0, text=wrap_text(self.bubble_font, text, max_text), anchor="nw", fill=text_color, font=self.bubble_font, tags=(tag,))
        x1, y1, x2, y2 = canvas.bbox(text_id)
        text_w, text_h = x2 - x1, y2 - y1
        stamp_id = canvas.create_text(0, 0, text=stamp, anchor="se", fill=colors["time"], font=(font, 7), tags=(tag,))
        sx1, sy1, sx2, sy2 = canvas.bbox(stamp_id)
        stamp_w, stamp_h = sx2 - sx1, sy2 - sy1
        bubble_w = max(text_w, stamp_w + 4, 40) + pad_x * 2
        bubble_h = text_h + stamp_h + pad_y * 2
        if user:
            right = width - margin
            left = right - bubble_w
        else:
            left = margin
            right = left + bubble_w
        bottom = top + bubble_h
        fill = colors["user"] if user else colors["ai"]
        body = rounded_rect(canvas, left, top, right, bottom, 9, fill=fill, outline="", tags=(tag,))
        if user:
            tail_id = canvas.create_polygon(right - 6, top, right + tail, top, right, top + 9, fill=fill, outline="", tags=(tag,))
        else:
            tail_id = canvas.create_polygon(left + 6, top, left - tail, top, left, top + 9, fill=fill, outline="", tags=(tag,))
        canvas.tag_lower(tail_id, text_id)
        canvas.tag_lower(body, text_id)
        canvas.coords(text_id, left + pad_x, top + pad_y)
        canvas.coords(stamp_id, right - pad_x + 2, bottom - pad_y + 3)
        canvas.tag_bind(tag, "<Button-3>", lambda event, value=text: self.bubble_menu(event, value))
        canvas.tag_bind(tag, "<Double-Button-1>", lambda _event, value=text: self.copy_message(value))
        return bubble_h

    @staticmethod
    def format_time(value: object) -> str:
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value).strftime("%H:%M")
            except ValueError:
                pass
        return datetime.now().strftime("%H:%M")

    # ---------- todo / daily ----------
    def can_record(self) -> bool:
        return getattr(self.owner, "todo_store", None) is not None

    def apply_actions(self, reply: str) -> str:
        """Execute the ```toolbox block from a reply and replace it with a short receipt."""
        match = ACTION_RE.search(reply)
        if match is None or not self.can_record():
            return reply
        text = (reply[:match.start()] + reply[match.end():]).strip()
        try:
            data = json.loads(match.group(1))
        except ValueError:
            return text + "\n\n⚠ 记录内容解析失败，未写入。"
        from todo_panel import normalize_task
        receipts = []
        tasks = [task for task in (normalize_task(raw, "ai") for raw in data.get("todo") or [] if isinstance(raw, dict)) if task]
        if tasks:
            try:
                self.owner.todo_store.add(tasks)
                receipts += [f"✓ 待办：{task['title']}" + (f"（{task['due'][5:]}{' ' + task['time'] if task['time'] else ''}）" if task["due"] else "") for task in tasks]
            except OSError as error:
                receipts.append(f"⚠ 写入待办失败：{error}")
        daily = getattr(self.owner, "daily_note", None)
        for line in data.get("daily") or []:
            if not isinstance(line, str) or not line.strip():
                continue
            try:
                ok = daily is not None and daily.log(line)
            except OSError:
                ok = False
            receipts.append(f"✓ 今日日志：{line.strip()}" if ok else "⚠ 写入今日日志失败")
        return (text + "\n\n" + "\n".join(receipts)).strip() if receipts else text

    def bubble_menu(self, event, text: str) -> str:
        theme = self.theme
        menu = tk.Menu(self.window, tearoff=False, background=theme["card"], foreground=theme["text"], activebackground=theme["accent"], activeforeground="#ffffff", font=(self.ui["UI_FONT"], 9))
        menu.add_command(label="复制", command=lambda: self.copy_message(text))
        if self.can_record():
            menu.add_separator()
            menu.add_command(label="✦ AI 整理为待办", command=lambda: self.record_todo(text))
            if getattr(self.owner, "daily_note", None) is not None and self.owner.daily_note.vault is not None:
                menu.add_command(label="记入今日日志", command=lambda: self.record_daily(text))
        menu.tk_popup(event.x_root, event.y_root)
        return "break"

    def record_todo(self, text: str) -> None:
        assistant = getattr(self.owner, "todo_assistant", None)
        if assistant is None:
            return
        assistant.organize(text)
        self.set_status("正在整理为待办，完成后出现在 Td 面板。")

    def record_daily(self, text: str) -> None:
        try:
            ok = self.owner.daily_note.log(text)
        except OSError:
            ok = False
        self.set_status("已记入今日日志。" if ok else "写入今日日志失败。", error=not ok)

    def copy_message(self, text: str) -> None:
        self.copy_text(text)
        self.set_status("已复制这条消息。")

    def render_history(self) -> None:
        self.render_all()

    # ---------- sending ----------
    def on_return(self, event: tk.Event) -> str | None:
        if event.state & 0x0001:
            self.window.after(1, self.on_input_changed)
            return None
        self.send_or_stop()
        return "break"

    def send_or_stop(self) -> None:
        if self.request_id is not None:
            self.stop()
        else:
            self.send()

    def send(self) -> None:
        question = self.input.get("1.0", "end").strip()
        if not question:
            return
        key = self.key_store.load()
        if not key:
            self.set_status("还没有 API Key，请在设置里填写。", error=True)
            self.open_settings()
            return
        self.service.config = load_config(self.config_path)
        self.refresh_model_label()
        context = [{"role": record["role"], "content": record["text"]} for record in self.records[-self.context_messages:]]
        now_dt = datetime.now()
        system = self.system_prompt + (ACTION_PROMPT if self.can_record() else "") + f"\n当前时间：{now_dt:%Y-%m-%d %H:%M} 星期{WEEKDAYS[now_dt.weekday()]}"
        messages = [{"role": "system", "content": system}] + context + [{"role": "user", "content": question}]
        request_id = self.service.send(key, messages)
        if request_id is None:
            self.set_status("上一条回复还没结束。", error=True)
            return
        self.request_id = request_id
        now = datetime.now().isoformat(timespec="seconds")
        self.records.append({"role": "user", "text": question, "time": now})
        self.history.append("user", question)
        self.pending = {"role": "assistant", "text": "…", "time": now}
        self.input.delete("1.0", "end")
        self.input.configure(height=1)
        self.placeholder.configure(text="正在思考…")
        self.placeholder.place(x=11, rely=0.5, anchor="w")
        self.draw_send_button()
        self.set_status("正在回复…")
        if self.expanded:
            self.render_all()
        else:
            self.relayout_window()
        self.poll()

    def stop(self) -> None:
        self.service.cancel()
        if self.pending is not None:
            text = self.pending.get("text", "").strip()
            if text and text != "…":
                self.records.append({"role": "assistant", "text": text, "time": self.pending.get("time")})
                self.history.append("assistant", text)
        self.pending = None
        self.finish()
        self.render_all()
        self.set_status("已停止。")

    def reveal_reply(self) -> None:
        if not self.expanded:
            self.set_expanded(True)
        else:
            self.rerender_last()

    def poll(self) -> None:
        self.poll_id = None
        latest = None
        while not self.service.events.empty():
            request_id, kind, payload = self.service.events.get_nowait()
            if request_id != self.request_id:
                continue
            latest = (kind, payload)
            if kind in {"done", "error"}:
                break
        if latest is not None and self.pending is not None:
            kind, payload = latest
            if kind == "text":
                self.pending["text"] = payload.split("```toolbox")[0].rstrip() or "…"
                self.reveal_reply()
            elif kind == "done":
                payload = self.apply_actions(payload)
                record = {"role": "assistant", "text": payload, "time": datetime.now().isoformat(timespec="seconds")}
                self.records.append(record)
                self.history.append("assistant", payload)
                self.pending = None
                self.finish()
                self.reveal_reply()
                self.render_all()
                self.set_status("完成 · 双击或右键气泡可复制")
                return
            elif kind == "error":
                self.pending.update({"text": payload, "error": True})
                self.finish()
                self.reveal_reply()
                self.render_all()
                self.pending = None
                self.set_status("请求失败，可修改后重试。", error=True)
                return
        if self.request_id is not None and self.window is not None and self.window.winfo_exists():
            self.poll_id = self.window.after(60, self.poll)

    def finish(self) -> None:
        self.request_id = None
        if self.poll_id is not None and self.window is not None:
            try:
                self.window.after_cancel(self.poll_id)
            except tk.TclError:
                pass
            self.poll_id = None
        self.draw_send_button()
        self.on_input_changed()

    def set_status(self, text: str, error: bool = False) -> None:
        if self.window is not None and self.window.winfo_exists():
            self.status_label.configure(text=text, foreground=self.colors["error"] if error else self.colors["hint"])
            if error and not self.expanded:
                self.set_expanded(True)

    def refresh_model_label(self) -> None:
        config = self.service.config
        host = str(config.get("base_url", "")).split("//")[-1].split("/")[0]
        state = "" if self.key_store.load() else " · 未设置 Key"
        self.model_label.configure(text=f"{config.get('model', '')} · {host}{state}")

    # ---------- actions ----------
    def clear(self) -> None:
        if self.request_id is not None:
            self.stop()
        self.records = []
        self.history.clear()
        self.render_history()
        self.set_status("对话已清空。")

    def copy_text(self, text: str) -> None:
        root = self.owner.root
        root.clipboard_clear()
        root.clipboard_append(text)

    def copy_last_reply(self) -> None:
        reply = next((record["text"] for record in reversed(self.records) if record["role"] == "assistant"), "")
        if reply:
            self.copy_text(reply)
            self.set_status("已复制最后一条回复。")
        else:
            self.set_status("还没有回复可复制。", error=True)

    # ---------- settings ----------
    def open_settings(self) -> None:
        if self.settings_window is not None and self.settings_window.winfo_exists():
            self.settings_window.lift()
            return
        theme = self.theme
        font = self.ui["UI_FONT"]
        FlatButton = self.ui["FlatButton"]
        config = load_config(self.config_path)
        window = tk.Toplevel(self.window or self.owner.root)
        self.settings_window = window
        window.title("AI 设置")
        window.configure(background=theme["bg"], padx=14, pady=12)
        window.resizable(False, False)
        window.wm_attributes("-topmost", True)
        self.ui["apply_title_bar_theme"](window, theme["name"] == "dark")
        window.columnconfigure(1, weight=1)
        variables = {name: tk.StringVar(value=str(config.get(name, ""))) for name in ("base_url", "path", "model")}
        key_var = tk.StringVar()
        rows = [("接口地址", variables["base_url"], ""), ("接口路径", variables["path"], ""), ("模型", variables["model"], ""), ("API Key", key_var, "•")]
        entry_style = dict(background=theme["card"], foreground=theme["text"], insertbackground=theme["text"], relief="flat", highlightthickness=1, highlightbackground=theme["border"], highlightcolor=theme["accent"], font=(font, 9), width=34)
        for row, (label, variable, show) in enumerate(rows):
            tk.Label(window, text=label, background=theme["bg"], foreground=theme["muted"], font=(font, 8)).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 10))
            tk.Entry(window, textvariable=variable, show=show, **entry_style).grid(row=row, column=1, sticky="ew", pady=4, ipady=3)
        key_hint = "已保存（留空则保持不变）" if self.key_store.load() else "尚未保存"
        tk.Label(window, text=f"Key 状态：{key_hint}。API Key 与夏以昼桌宠共用（DPAPI 加密）；\n接口和模型只保存在工具箱：{self.config_path}", background=theme["bg"], foreground=theme["subtle"], font=(font, 7), justify="left").grid(row=4, column=0, columnspan=2, sticky="w", pady=(4, 8))
        result = tk.Label(window, text="", background=theme["bg"], foreground=theme["muted"], font=(font, 8), wraplength=320, justify="left")
        result.grid(row=6, column=0, columnspan=2, sticky="w", pady=(6, 0))
        buttons = tk.Frame(window, background=theme["bg"])
        buttons.grid(row=5, column=0, columnspan=2, sticky="e")

        def collect() -> dict:
            updated = dict(config)
            for name, variable in variables.items():
                value = variable.get().strip()
                if value:
                    updated[name] = value
            return updated

        def current_key() -> str:
            return key_var.get().strip() or self.key_store.load()

        def test() -> None:
            key = current_key()
            if not key:
                result.configure(text="请先填写 API Key。", foreground="#ff5c5c")
                return
            result.configure(text="正在测试…", foreground=theme["muted"])
            candidate = collect()

            def worker() -> None:
                message = probe(key, candidate)
                window.after(0, lambda: result.winfo_exists() and result.configure(text=message or "连接成功。", foreground="#ff5c5c" if message else "#3ddc84"))

            threading.Thread(target=worker, daemon=True).start()

        def save() -> None:
            updated = collect()
            try:
                save_config(self.config_path, updated)
                if key_var.get().strip():
                    self.key_store.save(key_var.get().strip())
            except OSError as error:
                result.configure(text=f"保存失败：{error}", foreground="#ff5c5c")
                return
            self.service.config = load_config(self.config_path)
            if self.window is not None and self.window.winfo_exists():
                self.refresh_model_label()
                self.set_status("AI 设置已保存。")
            window.destroy()

        FlatButton(buttons, theme, "测试连接", test, background=theme["bg"], size=9).pack(side="left")
        FlatButton(buttons, theme, "保存", save, background=theme["bg"], size=9).pack(side="left", padx=(6, 0))
        FlatButton(buttons, theme, "取消", window.destroy, background=theme["bg"], size=9).pack(side="left", padx=(6, 0))
