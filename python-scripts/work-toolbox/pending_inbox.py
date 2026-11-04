"""Pending approvals inbox: receives Windchill / EHR counts from the browser extension
on 127.0.0.1 and renders the dock summary popup."""
from __future__ import annotations

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import tkinter as tk
import webbrowser

PENDING_PORT = 47821
MAX_BODY = 256 * 1024
SOURCES = {
    "windchill": {"label": "Windchill", "hint": "PLM 审批任务", "tool_id": "windchill", "url": "https://khplm.medtronic.com.cn/Windchill/app/#ptc1/homepage"},
    "ehr": {"label": "EHR", "hint": "考勤审批", "tool_id": "ehr", "url": "http://ehr.medtronic.com.cn/"},
    "fabriq": {"label": "Fabriq", "hint": "未读通知", "tool_id": "fabriq", "url": "https://medtronic.fabriq.tech/tasks"},
}
UI_FONT = "Microsoft YaHei UI"
BADGE_RED = "#FF3B30"
BADGE_GRAY = "#8E8E93"
STALE_SECONDS = 30 * 60


def clean_text(value, limit: int = 120) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def clean_url(value, fallback: str) -> str:
    url = str(value or "").strip()
    return url if re.match(r"^https?://", url, re.I) and len(url) < 1000 else fallback


def sanitize_report(data: object) -> dict | None:
    if not isinstance(data, dict):
        return None
    source = str(data.get("source", ""))
    if source not in SOURCES:
        return None
    fallback = SOURCES[source]["url"]
    report = {
        "source": source,
        "ok": bool(data.get("ok")),
        "updated": clean_text(data.get("updated"), 40) or datetime.now(timezone.utc).isoformat(),
        "received": datetime.now(timezone.utc).isoformat(),
    }
    if report["ok"]:
        try:
            report["count"] = max(0, min(int(data.get("count", 0)), 9999))
        except (TypeError, ValueError):
            report["count"] = 0
        items = data.get("items") if isinstance(data.get("items"), list) else []
        report["items"] = [
            {
                "title": clean_text(item.get("title"), 80) or SOURCES[source]["label"],
                "subtitle": clean_text(item.get("subtitle"), 120),
                "time": clean_text(item.get("time"), 40),
                "url": clean_url(item.get("url"), fallback),
            }
            for item in items[:50]
            if isinstance(item, dict)
        ]
        report["note"] = clean_text(data.get("note"), 160)
    else:
        report["error"] = clean_text(data.get("error"), 160) or "同步失败"
    return report


class PendingStore:
    def __init__(self) -> None:
        local_app_data = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        self.path = Path(local_app_data) / "WorkToolbox" / "pending.json"
        self.reports: dict[str, dict] = {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self.reports = {key: value for key, value in data.items() if key in SOURCES and isinstance(value, dict)}
        except (OSError, UnicodeError, json.JSONDecodeError):
            pass

    def update(self, report: dict) -> None:
        previous = self.reports.get(report["source"], {})
        if not report.get("ok") and previous.get("ok"):
            # Keep the last good count so a temporary login timeout does not wipe the badge.
            report = {**previous, "error": report.get("error"), "error_at": report.get("received")}
        self.reports[report["source"]] = report
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.reports, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def count(self, source: str) -> int:
        report = self.reports.get(source) or {}
        return int(report.get("count", 0) or 0) if "count" in report else 0

    def is_stale(self, source: str) -> bool:
        """Last sync failed, or the extension has been silent for 30+ minutes (Chrome closed)."""
        report = self.reports.get(source)
        if not report:
            return False
        if report.get("error"):
            return True
        stamps = []
        for key in ("received", "error_at"):
            try:
                stamp = datetime.fromisoformat(str(report.get(key, "")))
                stamps.append(stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc))
            except ValueError:
                pass
        return not stamps or (datetime.now(timezone.utc) - max(stamps)).total_seconds() > STALE_SECONDS

    def total(self) -> int:
        return sum(self.count(source) for source in SOURCES)


def start_pending_server(on_report) -> ThreadingHTTPServer | None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:  # windowed exe has no stderr
            pass

        def allowed_origin(self) -> bool:
            origin = self.headers.get("Origin", "")
            return not origin or origin.startswith("chrome-extension://") or origin.startswith("moz-extension://")

        def send(self, status: int, body: dict) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            origin = self.headers.get("Origin", "")
            if origin and self.allowed_origin():
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()
            self.wfile.write(payload)

        def do_OPTIONS(self) -> None:
            self.send(204 if self.allowed_origin() else 403, {})

        def do_GET(self) -> None:
            self.send(200 if self.path.startswith("/pending") else 404, {"app": "WorkToolbox", "ok": True})

        def do_POST(self) -> None:
            if not self.path.startswith("/pending") or not self.allowed_origin():
                self.send(403, {"ok": False})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY:
                self.send(413, {"ok": False})
                return
            try:
                report = sanitize_report(json.loads(self.rfile.read(length).decode("utf-8")))
            except (UnicodeError, json.JSONDecodeError):
                report = None
            if report is None:
                self.send(400, {"ok": False})
                return
            on_report(report)
            self.send(200, {"ok": True})

    try:
        server = ThreadingHTTPServer(("127.0.0.1", PENDING_PORT), Handler)
    except OSError:
        return None
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="pending-inbox", daemon=True).start()
    return server


def parse_time(value: str) -> datetime | None:
    text = str(value or "").strip()
    match = re.search(r"/Date\((\d+)", text)
    if match:
        return datetime.fromtimestamp(int(match.group(1)) / 1000)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone() if parsed.tzinfo else parsed


def relative_time(value: str) -> str:
    moment = parse_time(value)
    if moment is None:
        return ""
    now = datetime.now(moment.tzinfo) if moment.tzinfo else datetime.now()
    minutes = int((now - moment).total_seconds() // 60)
    if minutes < 1:
        return "刚刚"
    if minutes < 60:
        return f"{minutes} 分钟前"
    if minutes < 24 * 60 and moment.date() == now.date():
        return moment.strftime("%H:%M")
    return moment.strftime("%m-%d %H:%M")


def short_date(value: str) -> str:
    moment = parse_time(value)
    return moment.strftime("%m-%d") if moment else ""


class PendingSummary:
    WIDTH = 340
    MAX_ITEMS = 5

    def __init__(self, master: tk.Misc, theme: dict, store: PendingStore, draw_icon, on_open_tool, todo_store=None, on_open_todos=None) -> None:
        self.theme = theme
        self.todo_store = todo_store
        self.on_open_todos = on_open_todos
        self.store = store
        self.draw_icon = draw_icon
        self.on_open_tool = on_open_tool
        self.window = tk.Toplevel(master)
        self.window.withdraw()
        self.window.overrideredirect(True)
        self.window.wm_attributes("-topmost", True)
        self.window.configure(background=theme["border"])
        self.window.bind("<Escape>", lambda _event: self.close())
        self.window.bind("<FocusOut>", self.on_focus_out)
        self.body = tk.Frame(self.window, background=theme["panel"], padx=16, pady=14)
        self.body.pack(fill="both", expand=True, padx=1, pady=1)
        self.build()

    def label(self, parent, text, size=9, color=None, bold=False, **options) -> tk.Label:
        return tk.Label(
            parent, text=text, background=options.pop("background", self.theme["panel"]),
            foreground=color or self.theme["text"], font=(UI_FONT, size, "bold" if bold else "normal"),
            anchor="w", justify="left", **options,
        )

    def build(self) -> None:
        theme = self.theme
        header = tk.Frame(self.body, background=theme["panel"])
        header.pack(fill="x")
        self.label(header, "待处理", 13, bold=True).pack(side="left")
        total = self.store.total() + (self.todo_store.due_count() if self.todo_store is not None else 0)
        pill = tk.Label(header, text=str(total), background=BADGE_RED if total else theme["card"], foreground="#ffffff" if total else theme["muted"], font=("Segoe UI Semibold", 9), padx=7)
        pill.pack(side="left", padx=(8, 0), pady=(3, 0))
        close = self.label(header, "\ue711", 9, theme["subtle"], cursor="hand2")
        close.configure(font=("Segoe MDL2 Assets", 9))
        close.pack(side="right")
        close.bind("<Button-1>", lambda _event: self.close())
        updates = [report.get("received") or report.get("updated") for report in self.store.reports.values()]
        latest = max((value for value in updates if value), default="")
        self.label(header, f"同步于 {relative_time(latest)}" if latest else "尚未同步", 8, theme["subtle"]).pack(side="right", padx=(0, 10), pady=(4, 0))

        if self.todo_store is not None:
            self.build_todo_section()
        for source, meta in SOURCES.items():
            self.build_section(source, meta)

        footer = self.label(self.body, "审批由 Chrome 插件每 10 分钟同步 · 点击条目打开", 8, theme["subtle"])
        footer.pack(fill="x", pady=(12, 0))

    def build_todo_section(self) -> None:
        from todo_panel import RED, due_label

        theme = self.theme
        today = [item for _name, items in self.todo_store.sections() if _name in ("逾期", "今天") for item in items]
        section = tk.Frame(self.body, background=theme["panel"])
        section.pack(fill="x", pady=(14, 0))
        top = tk.Frame(section, background=theme["panel"], cursor="hand2")
        top.pack(fill="x")
        icon = tk.Canvas(top, width=24, height=24, background=theme["panel"], highlightthickness=0, bd=0, cursor="hand2")
        icon.pack(side="left")
        self.draw_icon(icon, "todo", 22)
        name = self.label(top, "今日待办", 10, bold=True, cursor="hand2")
        name.pack(side="left", padx=(9, 0))
        count_label = self.label(top, str(len(today)), 15, BADGE_RED if today else theme["muted"], bold=True, cursor="hand2")
        count_label.pack(side="right")
        widgets = [top, icon, name, count_label]
        if not today:
            done = len(self.todo_store.done_today())
            hint = self.label(section, f"今天的待办已全部完成 ✓（{done} 项）" if done else "今天没有到期的待办 · 点击打开待办", 8, theme["muted"], cursor="hand2")
            hint.pack(fill="x", padx=(33, 0), pady=(4, 0))
            widgets.append(hint)
        else:
            list_frame = tk.Frame(section, background=theme["panel"])
            list_frame.pack(fill="x", padx=(28, 0), pady=(4, 0))
            for item in today[: self.MAX_ITEMS]:
                row = tk.Frame(list_frame, background=theme["panel"], padx=5, pady=3, cursor="hand2")
                row.pack(fill="x")
                text, tone = due_label(item)
                title = self.label(row, ("! " if item.get("priority") == "high" else "") + item["title"], 9, cursor="hand2", wraplength=self.WIDTH - 130)
                title.pack(side="left")
                when = self.label(row, text, 8, RED if tone == "red" else theme["subtle"], cursor="hand2")
                when.pack(side="right")
                widgets.extend((list_frame, row, title, when))
            if len(today) > self.MAX_ITEMS:
                more = self.label(list_frame, f"还有 {len(today) - self.MAX_ITEMS} 条…", 8, theme["accent"], cursor="hand2", padx=5)
                more.pack(fill="x")
                widgets.append(more)
        for widget in widgets:
            widget.bind("<Button-1>", lambda _event: self.open_todos())

    def open_todos(self) -> None:
        self.close()
        if self.on_open_todos is not None:
            self.on_open_todos()

    def build_section(self, source: str, meta: dict) -> None:
        theme = self.theme
        report = self.store.reports.get(source)
        section = tk.Frame(self.body, background=theme["panel"])
        section.pack(fill="x", pady=(14, 0))
        top = tk.Frame(section, background=theme["panel"], cursor="hand2")
        top.pack(fill="x")
        icon = tk.Canvas(top, width=24, height=24, background=theme["panel"], highlightthickness=0, bd=0, cursor="hand2")
        icon.pack(side="left")
        self.draw_icon(icon, meta["tool_id"], 22)
        names = tk.Frame(top, background=theme["panel"], cursor="hand2")
        names.pack(side="left", padx=(9, 0))
        self.label(names, meta["label"], 10, bold=True, cursor="hand2").pack(anchor="w")
        count = self.store.count(source)
        count_text = str(count) if report and "count" in report else "—"
        stale = self.store.is_stale(source)
        count_label = self.label(top, count_text, 15, (BADGE_GRAY if stale else BADGE_RED) if count else theme["muted"], bold=True, cursor="hand2")
        count_label.pack(side="right")
        for widget in (top, icon, names, count_label, *names.winfo_children()):
            widget.bind("<Button-1>", lambda _event, tool_id=meta["tool_id"]: self.open_tool(tool_id))

        if report is None:
            self.label(section, "等待浏览器插件同步（需启用 Medtronic Work Assistant 2.3+）", 8, theme["muted"], wraplength=self.WIDTH - 40).pack(fill="x", padx=(33, 0), pady=(4, 0))
            return
        if report.get("error"):
            self.label(section, f"⚠ 刷新失败：{report['error']}（上次成功 {short_date(report.get('updated', ''))}）", 8, "#ffb020", wraplength=self.WIDTH - 40).pack(fill="x", padx=(33, 0), pady=(4, 0))
        elif stale:
            self.label(section, f"⚠ 超过 30 分钟未刷新（上次 {short_date(report.get('updated', ''))}），Chrome 可能未运行", 8, "#ffb020", wraplength=self.WIDTH - 40).pack(fill="x", padx=(33, 0), pady=(4, 0))
        if report.get("note"):
            self.label(section, report["note"], 8, theme["muted"], wraplength=self.WIDTH - 40).pack(fill="x", padx=(33, 0), pady=(2, 0))
        items = report.get("items") or []
        if report.get("ok") is not False and not items and not report.get("error"):
            self.label(section, f"{meta['hint']}已全部处理 ✓", 8, theme["muted"]).pack(fill="x", padx=(33, 0), pady=(4, 0))
            return
        list_frame = tk.Frame(section, background=theme["panel"])
        list_frame.pack(fill="x", padx=(28, 0), pady=(4, 0))
        for item in items[: self.MAX_ITEMS]:
            self.build_item(list_frame, item)
        remaining = max(0, count - min(len(items), self.MAX_ITEMS))
        if remaining:
            more = self.label(list_frame, f"还有 {remaining} 条…", 8, theme["accent"], cursor="hand2", padx=5)
            more.pack(fill="x", pady=(2, 0))
            more.bind("<Button-1>", lambda _event, url=meta["url"]: self.open_url(url))

    def build_item(self, parent: tk.Frame, item: dict) -> None:
        theme = self.theme
        row = tk.Frame(parent, background=theme["panel"], padx=5, pady=4, cursor="hand2")
        row.pack(fill="x")
        line = tk.Frame(row, background=theme["panel"])
        line.pack(fill="x")
        title = self.label(line, item.get("title", ""), 9, cursor="hand2")
        title.pack(side="left")
        when = self.label(line, short_date(item.get("time", "")), 8, theme["subtle"], cursor="hand2")
        when.pack(side="right")
        widgets = [row, line, title, when]
        if item.get("subtitle"):
            subtitle = self.label(row, item["subtitle"], 8, theme["muted"], cursor="hand2", wraplength=self.WIDTH - 70)
            subtitle.pack(fill="x")
            widgets.append(subtitle)

        def set_bg(color: str) -> None:
            for widget in widgets:
                widget.configure(background=color)

        for widget in widgets:
            widget.bind("<Enter>", lambda _event: set_bg(theme["card_hover"]))
            widget.bind("<Leave>", lambda _event: set_bg(theme["panel"]))
            widget.bind("<Button-1>", lambda _event, url=item.get("url", ""): self.open_url(url))

    def show_near(self, anchor: tk.Widget) -> None:
        self.window.update_idletasks()
        self.window.geometry(f"{self.WIDTH}x{self.window.winfo_reqheight()}")
        self.window.update_idletasks()
        width, height = self.WIDTH, self.window.winfo_reqheight()
        screen_w, screen_h = self.window.winfo_screenwidth(), self.window.winfo_screenheight()
        x = anchor.winfo_rootx() + anchor.winfo_width() // 2 - width // 2
        x = max(8, min(x, screen_w - width - 8))
        y = anchor.winfo_rooty() - height - 10
        if y < 8:
            y = anchor.winfo_rooty() + anchor.winfo_height() + 10
        self.window.geometry(f"{width}x{height}+{x}+{y}")
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

    def open_tool(self, tool_id: str) -> None:
        self.close()
        self.on_open_tool(tool_id)

    def open_url(self, url: str) -> None:
        self.close()
        if url:
            webbrowser.open(url)

    def exists(self) -> bool:
        try:
            return bool(self.window.winfo_exists())
        except tk.TclError:
            return False

    def close(self) -> None:
        if self.exists():
            self.window.destroy()
