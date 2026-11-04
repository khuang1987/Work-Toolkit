"""Right-click detail panel for dock icons: opens upward, fixed header/footer, scrolling body."""
from __future__ import annotations

import tkinter as tk
import webbrowser

from pending_inbox import UI_FONT


class ToolDetailPanel:
    WIDTH = 340
    MAX_HEIGHT = 460

    def __init__(self, master: tk.Misc, theme: dict) -> None:
        self.theme = theme
        self.window = tk.Toplevel(master)
        self.window.withdraw()
        self.window.overrideredirect(True)
        self.window.wm_attributes("-topmost", True)
        self.window.configure(background=theme["border"])
        self.window.bind("<Escape>", lambda _event: self.close())
        self.window.bind("<FocusOut>", self.on_focus_out)
        frame = tk.Frame(self.window, background=theme["panel"])
        frame.pack(fill="both", expand=True, padx=1, pady=1)
        self.header = tk.Frame(frame, background=theme["panel"], padx=16, pady=12)
        self.header.pack(side="top", fill="x")
        self.footer = tk.Frame(frame, background=theme["panel"], padx=14, pady=10)
        self.footer.pack(side="bottom", fill="x")
        tk.Frame(frame, background=theme["border"], height=1).pack(side="bottom", fill="x")
        tk.Frame(frame, background=theme["border"], height=1).pack(side="top", fill="x")
        viewport = tk.Frame(frame, background=theme["panel"])
        viewport.pack(side="top", fill="both", expand=True)
        self.canvas = tk.Canvas(viewport, background=theme["panel"], highlightthickness=0, bd=0, width=self.WIDTH - 2)
        self.scrollbar = tk.Scrollbar(viewport, orient="vertical", command=self.canvas.yview, width=8)
        self.canvas.configure(yscrollcommand=self.scrollbar.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.body = tk.Frame(self.canvas, background=theme["panel"], padx=16, pady=6)
        self.body_id = self.canvas.create_window(0, 0, window=self.body, anchor="nw")
        self.body.bind("<Configure>", lambda _event: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda event: self.canvas.itemconfigure(self.body_id, width=event.width))
        self.footer_buttons: tk.Frame | None = None

    # ---- building blocks -------------------------------------------------
    def label(self, parent, text, size=9, color=None, bold=False, **options) -> tk.Label:
        return tk.Label(
            parent, text=text, background=options.pop("background", self.theme["panel"]),
            foreground=color or self.theme["text"], font=(UI_FONT, size, "bold" if bold else "normal"),
            anchor="w", justify="left", **options,
        )

    def set_header(self, draw_icon, title: str, subtitle: str = "", status: str = "", status_color: str | None = None) -> None:
        theme = self.theme
        icon = tk.Canvas(self.header, width=34, height=34, background=theme["panel"], highlightthickness=0, bd=0)
        icon.pack(side="left")
        draw_icon(icon, 32)
        names = tk.Frame(self.header, background=theme["panel"])
        names.pack(side="left", fill="x", expand=True, padx=(10, 0))
        top = tk.Frame(names, background=theme["panel"])
        top.pack(fill="x")
        self.label(top, title, 12, bold=True).pack(side="left")
        if status:
            tk.Label(top, text=status, background=status_color or theme["card"], foreground="#ffffff" if status_color else theme["muted"], font=(UI_FONT, 8), padx=6).pack(side="left", padx=(8, 0), pady=(2, 0))
        close = self.label(top, "\ue711", 9, theme["subtle"], cursor="hand2")
        close.configure(font=("Segoe MDL2 Assets", 9))
        close.pack(side="right")
        close.bind("<Button-1>", lambda _event: self.close())
        if subtitle:
            self.label(names, subtitle, 8, theme["muted"], wraplength=self.WIDTH - 90).pack(fill="x", pady=(2, 0))

    def section(self, title: str, extra: str = "", extra_color: str | None = None) -> tk.Frame:
        theme = self.theme
        frame = tk.Frame(self.body, background=theme["panel"])
        frame.pack(fill="x", pady=(10, 0))
        top = tk.Frame(frame, background=theme["panel"])
        top.pack(fill="x", pady=(0, 3))
        self.label(top, title, 9, theme["subtle"], bold=True).pack(side="left")
        if extra:
            self.label(top, extra, 9, extra_color or theme["muted"], bold=True).pack(side="right")
        return frame

    def field(self, parent, name: str, value: str, color: str | None = None, on_click=None) -> None:
        theme = self.theme
        row = tk.Frame(parent, background=theme["panel"])
        row.pack(fill="x", pady=1)
        self.label(row, name, 8, theme["muted"], width=7).pack(side="left", anchor="n")
        value_label = self.label(row, value or "—", 8, color or (theme["accent"] if on_click else theme["text"]), wraplength=self.WIDTH - 110, cursor="hand2" if on_click else "")
        value_label.pack(side="left", fill="x", expand=True)
        if on_click:
            value_label.bind("<Button-1>", lambda _event: self.run(on_click))

    def note(self, parent, text: str, color: str | None = None) -> None:
        self.label(parent, text, 8, color or self.theme["muted"], wraplength=self.WIDTH - 40).pack(fill="x", pady=(2, 0))

    def item(self, parent, title: str, meta: str = "", subtitle: str = "", url: str = "", on_click=None, meta_color: str | None = None) -> None:
        theme = self.theme
        row = tk.Frame(parent, background=theme["panel"], padx=5, pady=4)
        row.pack(fill="x")
        line = tk.Frame(row, background=theme["panel"])
        line.pack(fill="x")
        clickable = bool(url or on_click)
        cursor = "hand2" if clickable else ""
        widgets = [row, line]
        title_label = self.label(line, title, 9, cursor=cursor, wraplength=self.WIDTH - 110)
        title_label.pack(side="left")
        widgets.append(title_label)
        if meta:
            meta_label = self.label(line, meta, 8, meta_color or theme["subtle"], cursor=cursor)
            meta_label.pack(side="right", anchor="n")
            widgets.append(meta_label)
        if subtitle:
            sub = self.label(row, subtitle, 8, theme["muted"], cursor=cursor, wraplength=self.WIDTH - 70)
            sub.pack(fill="x")
            widgets.append(sub)
        if not clickable:
            return

        def set_bg(color: str) -> None:
            for widget in widgets:
                widget.configure(background=color)

        action = on_click or (lambda: webbrowser.open(url))
        for widget in widgets:
            widget.configure(cursor="hand2")
            widget.bind("<Enter>", lambda _event: set_bg(theme["card_hover"]))
            widget.bind("<Leave>", lambda _event: set_bg(theme["panel"]))
            widget.bind("<Button-1>", lambda _event: self.run(action))

    def button(self, button_class, text: str, command, side: str = "left", keep_open: bool = False, enabled: bool = True) -> None:
        if self.footer_buttons is None:
            self.footer_buttons = tk.Frame(self.footer, background=self.theme["panel"])
            self.footer_buttons.pack(fill="x")
        if not enabled:
            self.label(self.footer_buttons, text, 9, self.theme["subtle"], padx=6).pack(side=side, padx=(0, 2))
            return
        widget = button_class(self.footer_buttons, self.theme, text, (command if keep_open else lambda: self.run(command)), background=self.theme["panel"], size=9)
        widget.pack(side=side, padx=(0, 2))

    def footnote(self, text: str) -> None:
        self.label(self.footer, text, 8, self.theme["subtle"], wraplength=self.WIDTH - 30).pack(fill="x", pady=(6, 0))

    # ---- behaviour -------------------------------------------------------
    def run(self, command) -> None:
        self.close()
        command()

    def bind_wheel(self, widget: tk.Misc) -> None:
        widget.bind("<MouseWheel>", self.on_wheel, add="+")
        for child in widget.winfo_children():
            self.bind_wheel(child)

    def on_wheel(self, event) -> str:
        if self.canvas.yview() != (0.0, 1.0):
            self.canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
        return "break"

    def show_above(self, anchor: tk.Widget) -> None:
        """Bottom edge sits just above the anchor; height is capped and the body scrolls."""
        self.window.update_idletasks()
        chrome = self.header.winfo_reqheight() + self.footer.winfo_reqheight() + 4
        body_height = self.body.winfo_reqheight()
        room = anchor.winfo_rooty() - 18
        limit = max(220, min(self.MAX_HEIGHT, room))
        visible = max(60, min(body_height, limit - chrome))
        self.canvas.configure(height=visible, yscrollincrement=20)
        if body_height > visible:
            self.scrollbar.pack(side="right", fill="y")
        height = chrome + visible
        screen_w = self.window.winfo_screenwidth()
        x = anchor.winfo_rootx() + anchor.winfo_width() // 2 - self.WIDTH // 2
        x = max(8, min(x, screen_w - self.WIDTH - 8))
        y = max(8, anchor.winfo_rooty() - height - 10)
        self.window.geometry(f"{self.WIDTH}x{height}+{x}+{y}")
        self.bind_wheel(self.window)
        self.window.deiconify()
        self.round_corners()
        self.window.lift()
        self.window.focus_force()

    def round_corners(self) -> None:
        try:
            import ctypes

            self.window.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.window.winfo_id()) or self.window.winfo_id()
            preference = ctypes.c_int(2)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(preference), ctypes.sizeof(preference))
        except (AttributeError, OSError):
            pass

    def on_focus_out(self, _event) -> None:
        self.window.after(120, self.close_if_unfocused)

    def close_if_unfocused(self) -> None:
        try:
            focused = self.window.focus_get()
        except (tk.TclError, KeyError):
            focused = None
        if focused is None or not str(focused).startswith(str(self.window)):
            self.close()

    def exists(self) -> bool:
        try:
            return bool(self.window.winfo_exists())
        except tk.TclError:
            return False

    def close(self) -> None:
        if self.exists():
            self.window.destroy()
