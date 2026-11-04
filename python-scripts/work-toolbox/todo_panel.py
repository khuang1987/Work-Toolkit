"""Daily todo assistant: local store, AI tidy-up / planning and the dock popup panel.

Todos live in the Obsidian vault as 00-Inbox/Todo.md (Obsidian Tasks syntax), so the
toolbox is only a quick entry point and Obsidian stays the real home. Typed text is sent to the
configured AI endpoint (same key/config as the AI chat panel) which turns it into
structured tasks: title, due date, priority, notes and sub-steps.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import queue
import re
import threading
import tkinter as tk
import uuid

from ai_service import KeyStore, complete, extract_json, load_config
import aa_draw

UI_FONT = "Microsoft YaHei UI"
RED = "#FF3B30"
ORANGE = "#FF9F0A"
GREEN = "#34C759"
WEEKDAYS = "一二三四五六日"
PRIORITIES = ("high", "normal", "low")
KEEP_DONE_DAYS = 30


def _expand(value: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(value)))


def _today() -> date:
    return date.today()


def _parse_day(value: str) -> date | None:
    try:
        return date.fromisoformat(str(value or "")[:10])
    except ValueError:
        return None


def _clean(value, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _clean_time(value) -> str:
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(value or "").strip())
    if not match or int(match.group(1)) > 23 or int(match.group(2)) > 59:
        return ""
    return f"{int(match.group(1)):02d}:{match.group(2)}"


def normalize_task(raw: dict, source: str = "manual") -> dict | None:
    if not isinstance(raw, dict):
        return None
    title = _clean(raw.get("title"), 80)
    if not title:
        return None
    due = _parse_day(raw.get("due"))
    priority = str(raw.get("priority", "normal")).lower()
    subtasks = raw.get("subtasks") if isinstance(raw.get("subtasks"), list) else []
    return {
        "id": uuid.uuid4().hex[:12],
        "title": title,
        "notes": _clean(raw.get("notes"), 400),
        "due": due.isoformat() if due else "",
        "time": _clean_time(raw.get("time")) if due else "",
        "priority": priority if priority in PRIORITIES else "normal",
        "subtasks": [
            {"title": _clean(step.get("title") if isinstance(step, dict) else step, 80), "done": bool(step.get("done")) if isinstance(step, dict) else False}
            for step in subtasks[:8]
            if _clean(step.get("title") if isinstance(step, dict) else step, 80)
        ],
        "done": False,
        "created": datetime.now().isoformat(timespec="seconds"),
        "done_at": "",
        "source": source,
        "order": 0,
    }


DEFAULT_TODO_FILE = "00-Inbox/Todo.md"
INBOX = "收件箱"
DONE = "已完成"
TASK_RE = re.compile(r"^(\s*)[-*+] \[([ xX])\] ?(.*)$")
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
PRIORITY_MARKS = {"🔺": "high", "⏫": "high", "🔼": "normal", "🔽": "low", "⏬": "low"}
FIELD_RES = {
    "id": re.compile(r"\s*🆔\s*([\w-]+)"),
    "due": re.compile(r"\s*📅\s*(\d{4}-\d{2}-\d{2})"),
    "done_at": re.compile(r"\s*✅\s*(\d{4}-\d{2}-\d{2})"),
    "created": re.compile(r"\s*➕\s*(\d{4}-\d{2}-\d{2})"),
    "time": re.compile(r"\s*⏰\s*(\d{1,2}:\d{2})"),
}
KEPT_FIELD_RE = re.compile(r"\s*([⏳🛫❌]\s*\d{4}-\d{2}-\d{2}|🔁\s*[\w ,]+?(?=\s*(?:[📅⏳🛫✅➕🆔⏫🔼🔽🔺⏬⏰❌]|$)))")
FILE_HEADER = [
    "# 待办",
    "",
    "> 由「工作工具箱」同步维护：可直接在此勾选、编辑或新增 `- [ ]` 任务，工具箱会自动读取。",
    "> 格式兼容 Obsidian Tasks：📅 截止 · ⏫ 高优先级 · 🔽 低优先级 · ✅ 完成日期 · 🆔 任务编号。",
    "",
]


def find_obsidian_vault() -> Path | None:
    """The vault Obsidian last had open, from %APPDATA%\\obsidian\\obsidian.json."""
    try:
        data = json.loads((Path(os.environ.get("APPDATA", "")) / "obsidian" / "obsidian.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    vaults = [value for value in (data.get("vaults") or {}).values() if isinstance(value, dict) and value.get("path")]
    vaults.sort(key=lambda value: (bool(value.get("open")), value.get("ts", 0)), reverse=True)
    for vault in vaults:
        if Path(vault["path"]).is_dir():
            return Path(vault["path"])
    return None


def parse_task_text(text: str) -> dict:
    fields: dict = {}
    for key, pattern in FIELD_RES.items():
        match = pattern.search(text)
        if match:
            fields[key] = match.group(1)
            text = pattern.sub("", text, count=1)
    fields["priority"] = "normal"
    for mark, value in PRIORITY_MARKS.items():
        if mark in text:
            fields["priority"] = value
            text = text.replace(mark, "")
    kept = KEPT_FIELD_RE.findall(text)
    fields["extra"] = " ".join(re.sub(r"\s+", " ", value) for value in kept)
    text = KEPT_FIELD_RE.sub("", text)
    fields["title"] = re.sub(r"\s+", " ", text).strip()
    return fields


def render_task(item: dict, indent: str = "") -> list[str]:
    parts = [f"{indent}- [{'x' if item.get('done') else ' '}] {item['title']}"]
    if item.get("time") and item.get("due"):
        parts.append(f"⏰ {item['time']}")
    if item.get("priority") == "high":
        parts.append("⏫")
    elif item.get("priority") == "low":
        parts.append("🔽")
    if item.get("extra"):
        parts.append(item["extra"])
    if item.get("due"):
        parts.append(f"📅 {item['due']}")
    created = str(item.get("created", ""))[:10]
    if created:
        parts.append(f"➕ {created}")
    if item.get("done") and item.get("done_at"):
        parts.append(f"✅ {str(item['done_at'])[:10]}")
    parts.append(f"🆔 {item['id']}")
    lines = [" ".join(parts)]
    child = indent + "    "
    if item.get("notes"):
        lines.append(f"{child}- {item['notes']}")
    for step in item.get("subtasks", []):
        lines.append(f"{child}- [{'x' if step.get('done') else ' '}] {step['title']}")
    lines.extend(item.get("children_raw", []))
    return lines


class TodoStore:
    """Todos stored as an Obsidian Markdown file (Tasks-plugin syntax).

    The file is the single source of truth: edits made in Obsidian are picked up by
    reload_if_changed(), and every change from the toolbox re-reads the file first so
    nothing typed in Obsidian is overwritten.
    """

    def __init__(self, path: Path | None = None, settings: dict | None = None) -> None:
        migrate = path is None
        settings = settings or {}
        local_app_data = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "WorkToolbox"
        self.legacy_path = local_app_data / "todos.json"
        self.plan_path = local_app_data / "todo-plan.json"
        if path is None:
            vault = _expand(settings["obsidian_vault"]) if settings.get("obsidian_vault") else find_obsidian_vault()
            self.vault = vault if vault and vault.is_dir() else None
            relative = str(settings.get("file") or DEFAULT_TODO_FILE)
            path = (self.vault / relative) if self.vault else local_app_data / "Todo.md"
        else:
            self.vault = None
        self.path = path
        self.migrate_from = self.legacy_path if migrate else None
        self.items: list[dict] = []
        self.plan: dict = {}
        self.preamble: list[str] = []
        self.sections_raw: list[list] = []  # [heading, [("raw", line) | ("task", id)]]
        self.mtime = 0.0
        self.listeners: list = []
        try:
            self.plan = json.loads(self.plan_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            self.plan = {}
        if not isinstance(self.plan, dict):
            self.plan = {}
        if not self.path.exists():
            self.migrate_legacy()
        self.load()

    # ---------- file I/O ----------
    def migrate_legacy(self) -> None:
        try:
            data = json.loads(self.migrate_from.read_text(encoding="utf-8")) if self.migrate_from else {}
        except (OSError, UnicodeError, json.JSONDecodeError):
            data = {}
        if isinstance(data, dict) and isinstance(data.get("plan"), dict) and not self.plan:
            self.plan = data["plan"]
        items = [item for item in data.get("items", []) if isinstance(item, dict) and item.get("id") and item.get("title")] if isinstance(data, dict) else []
        self.preamble = list(FILE_HEADER)
        self.sections_raw = [[INBOX, []], [DONE, []]]
        self.items = []
        for item in items:
            self.items.append(item)
            item["created"] = str(item.get("created", ""))[:10]
            self.append_task(DONE if item.get("done") else INBOX, item["id"])
        self.save()
        if items and self.migrate_from:
            try:
                self.migrate_from.replace(self.migrate_from.with_suffix(".json.migrated"))
            except OSError:
                pass

    def current_mtime(self) -> float:
        try:
            return self.path.stat().st_mtime
        except OSError:
            return 0.0

    def load(self) -> None:
        try:
            lines = self.path.read_text(encoding="utf-8-sig").splitlines()
        except (OSError, UnicodeError):
            lines = []
        self.mtime = self.current_mtime()
        old = {item["id"]: item for item in self.items}
        self.preamble, self.sections_raw, self.items = [], [], []
        seen: dict[str, int] = {}
        current: list | None = None
        task: dict | None = None
        task_indent = ""
        for line in lines:
            heading = HEADING_RE.match(line)
            if heading:
                current, task = [heading.group(1), []], None
                self.sections_raw.append(current)
                continue
            match = TASK_RE.match(line)
            if task is not None and line.strip() and len(line) - len(line.lstrip()) > len(task_indent):
                if match and len(match.group(1)) - len(task_indent) <= 4 and len(task["subtasks"]) < 20:
                    task["subtasks"].append({"title": parse_task_text(match.group(3))["title"], "done": match.group(2) != " "})
                elif not match and re.match(r"^\s*[-*+] ", line) and not task["notes"] and len(line) - len(line.lstrip()) - len(task_indent) <= 4:
                    task["notes"] = re.sub(r"^\s*[-*+] ", "", line).strip()
                else:
                    task["children_raw"].append(line)
                continue
            task = None
            if current is None and not match:
                self.preamble.append(line)
                continue
            if current is None:
                current = [INBOX, []]
                self.sections_raw.append(current)
            if not match:
                current[1].append(("raw", line))
                continue
            fields = parse_task_text(match.group(3))
            if not fields["title"]:
                current[1].append(("raw", line))
                continue
            task_id = fields.get("id")
            if not task_id or task_id in seen:
                base = f"{current[0]}|{fields['title']}"
                count = seen.get(base, 0)
                seen[base] = count + 1
                task_id = "md" + uuid.uuid5(uuid.NAMESPACE_URL, f"{base}|{count}").hex[:10]
            seen[task_id] = 1
            done = match.group(2) != " "
            task = {
                "id": task_id,
                "title": fields["title"][:120],
                "notes": "",
                "due": fields.get("due", ""),
                "time": _clean_time(fields.get("time")) if fields.get("due") else "",
                "priority": fields["priority"],
                "extra": fields["extra"],
                "subtasks": [],
                "children_raw": [],
                "done": done,
                "created": fields.get("created") or old.get(task_id, {}).get("created", ""),
                "done_at": (fields.get("done_at") or old.get(task_id, {}).get("done_at") or (_today().isoformat() if task_id in old else "")) if done else "",
                "source": "obsidian",
                "order": 0,
            }
            task_indent = match.group(1)
            self.items.append(task)
            current[1].append(("task", task_id))
        if not self.sections_raw:
            self.sections_raw.append([INBOX, []])

    def write(self) -> None:
        by_id = {item["id"]: item for item in self.items}
        lines = list(self.preamble)
        if lines and lines[-1].strip():
            lines.append("")
        for heading, entries in self.sections_raw:
            lines.append(f"## {heading}")
            body: list[str] = []
            for kind, value in entries:
                if kind == "raw":
                    body.append(value)
                elif value in by_id:
                    body.extend(render_task(by_id[value]))
            while body and not body[0].strip():
                body.pop(0)
            while body and not body[-1].strip():
                body.pop()
            lines.append("")
            lines.extend(body)
            if body:
                lines.append("")
        text = "\n".join(lines).rstrip() + "\n"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(self.path.name + ".tmp")
            temporary.write_text(text, encoding="utf-8")
            temporary.replace(self.path)
        except OSError:
            try:
                self.path.write_text(text, encoding="utf-8")
            except OSError:
                pass
        self.mtime = self.current_mtime()

    def reload_if_changed(self) -> bool:
        """Pick up edits made in Obsidian; returns True and notifies listeners if the file changed."""
        if self.current_mtime() == self.mtime:
            return False
        self.load()
        self.notify()
        return True

    def notify(self) -> None:
        for listener in list(self.listeners):
            try:
                listener()
            except Exception:
                pass

    def save(self) -> None:
        self.write()
        try:
            self.plan_path.parent.mkdir(parents=True, exist_ok=True)
            self.plan_path.write_text(json.dumps(self.plan, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
        self.notify()

    def section(self, name: str) -> list:
        for section in self.sections_raw:
            if section[0] == name:
                return section
        section = [name, []]
        done_index = next((index for index, value in enumerate(self.sections_raw) if value[0] == DONE), None)
        if name != DONE and done_index is not None:
            self.sections_raw.insert(done_index, section)
        else:
            self.sections_raw.append(section)
        return section

    def append_task(self, name: str, task_id: str) -> None:
        entries = self.section(name)[1]
        while entries and entries[-1][0] == "raw" and not entries[-1][1].strip():
            entries.pop()
        entries.append(("task", task_id))

    def move(self, task_id: str, name: str) -> None:
        for _heading, entries in self.sections_raw:
            entries[:] = [entry for entry in entries if entry != ("task", task_id)]
        self.append_task(name, task_id)

    def open_uri(self) -> str:
        """Open the Tasks dashboard next to Todo.md when it exists, else Todo.md itself."""
        from urllib.parse import quote
        dashboard = self.path.with_name("待办看板.md")
        return "obsidian://open?path=" + quote(str(dashboard if dashboard.exists() else self.path), safe="")

    def get(self, task_id: str) -> dict | None:
        return next((item for item in self.items if item["id"] == task_id), None)

    def add(self, tasks: list[dict]) -> None:
        self.reload_if_changed()
        for task in tasks:
            task["created"] = str(task.get("created", ""))[:10] or _today().isoformat()
            self.items.append(task)
            self.append_task(INBOX, task["id"])
        self.save()

    def update(self, task_id: str, **changes) -> None:
        self.reload_if_changed()
        item = self.get(task_id)
        if item is not None:
            item.update(changes)
            self.save()

    def toggle(self, task_id: str) -> None:
        self.reload_if_changed()
        item = self.get(task_id)
        if item is not None:
            item["done"] = not item.get("done")
            item["done_at"] = _today().isoformat() if item["done"] else ""
            self.move(task_id, DONE if item["done"] else INBOX)
            self.save()

    def toggle_step(self, task_id: str, index: int) -> None:
        self.reload_if_changed()
        item = self.get(task_id)
        if item is not None and 0 <= index < len(item.get("subtasks", [])):
            step = item["subtasks"][index]
            step["done"] = not step.get("done")
            self.save()

    def delete(self, task_id: str) -> None:
        self.reload_if_changed()
        self.items = [item for item in self.items if item["id"] != task_id]
        for _heading, entries in self.sections_raw:
            entries[:] = [entry for entry in entries if entry != ("task", task_id)]
        self.save()

    def open_items(self) -> list[dict]:
        return [item for item in self.items if not item.get("done")]

    def due_count(self) -> int:
        """Open todos due today or overdue: the dock badge number."""
        today = _today()
        return sum(1 for item in self.open_items() if (_parse_day(item.get("due")) or date.max) <= today)

    def today_plan(self) -> dict:
        return self.plan if self.plan.get("date") == _today().isoformat() else {}

    @staticmethod
    def sort_key(item: dict):
        rank = {"high": 0, "normal": 1, "low": 2}.get(item.get("priority"), 1)
        return (_parse_day(item.get("due")) or date.max, item.get("order", 0) or 99, rank, item.get("time") or "99", item.get("created", ""))

    def sections(self) -> list[tuple[str, list[dict]]]:
        today = _today()
        groups: dict[str, list[dict]] = {"逾期": [], "今天": [], "即将": [], "未安排": []}
        for item in self.open_items():
            due = _parse_day(item.get("due"))
            key = "未安排" if due is None else "逾期" if due < today else "今天" if due == today else "即将"
            groups[key].append(item)
        plan_order = {task_id: index + 1 for index, task_id in enumerate(self.today_plan().get("order", []))}
        for key, items in groups.items():
            items.sort(key=lambda item: (plan_order.get(item["id"], 99),) + self.sort_key(item))
        return [(key, items) for key, items in groups.items() if items]

    def done_today(self) -> list[dict]:
        today = _today().isoformat()
        return [item for item in self.items if item.get("done") and str(item.get("done_at", "")).startswith(today)]


def due_label(item: dict) -> tuple[str, str]:
    """(text, tone) for the right-hand date tag. tone: red / orange / muted."""
    due = _parse_day(item.get("due"))
    if due is None:
        return "", "muted"
    today = _today()
    days = (due - today).days
    clock = (" " + item["time"]) if item.get("time") else ""
    if days < 0:
        return f"逾期 {-days} 天", "red"
    if days == 0:
        return "今天" + clock, "orange"
    if days == 1:
        return "明天" + clock, "muted"
    if days < 7 and due.isocalendar()[1] == today.isocalendar()[1]:
        return "周" + WEEKDAYS[due.weekday()] + clock, "muted"
    return due.strftime("%m-%d") + clock, "muted"


ORGANIZE_PROMPT = """你是用户的个人待办助理。把用户随手写的内容整理成结构化待办，只输出 JSON，不要解释。
今天是 {today}（星期{weekday}），本周一是 {monday}。
输出格式：{{"tasks":[{{"title":"","due":"","time":"","priority":"normal","notes":"","subtasks":[]}}]}}
规则：
1. title：动词开头、简洁明确，不超过 30 字；保留人名、系统名、单号等关键信息。
2. 一段话包含多件独立的事时拆成多条；同一件事的步骤放进 subtasks。
3. due：换算成 YYYY-MM-DD。“今天/明天/后天/周三/下周一/月底”等按今天推算；“周三前”指本周三，若已过则下周三；没有时间要求则留空。time：明确提到具体时刻才填 HH:MM。
4. priority：提到紧急、尽快、老板/客户催、今天必须 → high；随手记录、有空再做 → low；其余 normal。
5. 扩充：对需要多步完成的事，在 subtasks 给出 2~5 个具体可执行的步骤；简单的事 subtasks 留空。notes 写对完成有帮助的提醒（相关人、需要准备的材料、注意事项），一两句话，没有就留空。
6. 不要编造用户没提到的事实（人名、数字、日期）。"""

EXPAND_PROMPT = """你是用户的个人待办助理。为下面这条待办补充可执行的拆解，只输出 JSON。
今天是 {today}。输出：{{"title":"","notes":"","subtasks":[]}}
title 可以改写得更清晰（保留关键信息）；subtasks 给出 2~6 个具体步骤；notes 一两句完成要点。不要编造事实。"""

PLAN_PROMPT = """你是用户的个人待办助理。根据未完成待办和待审批数量，给出今天的处理顺序，只输出 JSON。
今天是 {today}（星期{weekday}）。
输出：{{"order":["任务id", ...],"focus":"一句话今日建议，不超过 40 字"}}
order 只包含今天值得做的任务（逾期、今天到期、高优先级、明后天到期需要提前准备的），按建议处理顺序排列，最多 8 个。"""


class TodoAssistant:
    """Runs AI requests off the Tk thread and applies results to the store."""

    def __init__(self, root: tk.Misc, store: TodoStore, ai_settings: dict) -> None:
        self.root = root
        self.store = store
        self.settings = ai_settings if isinstance(ai_settings, dict) else {}
        self.results: queue.Queue = queue.Queue()
        self.busy = 0
        self.status = ""
        self.status_listeners: list = []
        self.poll()

    def credentials(self) -> tuple[str, dict]:
        config_path = _expand(str(self.settings.get("config_file", r"%LOCALAPPDATA%\WorkToolbox\ai-config.json")))
        key_path = _expand(str(self.settings.get("key_file", r"%APPDATA%\CalebDesktopPet\ai-key.bin")))
        return KeyStore(key_path).load(), load_config(config_path)

    def set_status(self, text: str) -> None:
        self.status = text
        if text and not self.busy:
            self.root.after(6000, lambda: self.status == text and not self.busy and self.set_status(""))
        for listener in list(self.status_listeners):
            try:
                listener()
            except Exception:
                pass

    def ask(self, system: str, user: str) -> dict:
        key, config = self.credentials()
        if not key:
            raise RuntimeError("未设置 AI Key")
        return extract_json(complete(key, config, [{"role": "system", "content": system}, {"role": "user", "content": user}], max_tokens=1200))

    def context(self) -> dict:
        today = _today()
        return {"today": today.isoformat(), "weekday": WEEKDAYS[today.weekday()], "monday": (today - timedelta(days=today.weekday())).isoformat()}

    def run(self, label: str, work, apply) -> None:
        self.busy += 1
        self.set_status(label)

        def worker() -> None:
            try:
                result, error = work(), None
            except Exception as exc:  # network, key or parsing problems
                result, error = None, exc
            self.results.put((apply, result, error))

        threading.Thread(target=worker, daemon=True).start()

    def poll(self) -> None:
        try:
            while True:
                apply, result, error = self.results.get_nowait()
                self.busy = max(0, self.busy - 1)
                try:
                    message = apply(result, error)
                except Exception as exc:
                    message = f"处理失败：{exc}"
                self.set_status(message or "")
        except queue.Empty:
            pass
        try:
            self.root.after(200, self.poll)
        except tk.TclError:
            pass

    def organize(self, text: str) -> None:
        text = text.strip()
        if not text:
            return

        def work():
            return self.ask(ORGANIZE_PROMPT.format(**self.context()), text)

        def apply(result, error):
            tasks = [task for task in (normalize_task(raw, "ai") for raw in (result or {}).get("tasks", [])) if task] if not error else []
            if not tasks:
                fallback = normalize_task({"title": text}, "manual")
                if fallback:
                    self.store.add([fallback])
                return f"AI 不可用（{error}），已按原文添加" if error else "AI 未识别出待办，已按原文添加"
            self.store.add(tasks)
            return f"已添加 {len(tasks)} 条待办" if len(tasks) > 1 else f"已添加：{tasks[0]['title']}"

        self.run("AI 正在整理…", work, apply)

    def expand(self, task_id: str) -> None:
        item = self.store.get(task_id)
        if item is None:
            return
        text = json.dumps({key: item.get(key) for key in ("title", "notes", "due", "subtasks")}, ensure_ascii=False)

        def work():
            return self.ask(EXPAND_PROMPT.format(**self.context()), text)

        def apply(result, error):
            if error or not result:
                return f"AI 拆解失败：{error or '无结果'}"
            cleaned = normalize_task({**result, "due": item.get("due")}) or {}
            changes = {"subtasks": cleaned.get("subtasks") or item.get("subtasks", [])}
            if cleaned.get("title"):
                changes["title"] = cleaned["title"]
            if cleaned.get("notes"):
                changes["notes"] = cleaned["notes"]
            self.store.update(task_id, **changes)
            return "已补充拆解步骤"

        self.run("AI 正在拆解…", work, apply)

    def plan_today(self, approvals: dict) -> None:
        tasks = [
            {"id": item["id"], "title": item["title"], "due": item.get("due"), "time": item.get("time"), "priority": item.get("priority")}
            for item in self.store.open_items()
        ]
        if not tasks:
            self.set_status("没有未完成的待办")
            return
        payload = json.dumps({"tasks": tasks, "approvals": approvals}, ensure_ascii=False)

        def work():
            return self.ask(PLAN_PROMPT.format(**self.context()), payload)

        def apply(result, error):
            if error or not result:
                return f"AI 规划失败：{error or '无结果'}"
            known = {item["id"] for item in self.store.open_items()}
            order = [task_id for task_id in result.get("order", []) if task_id in known][:8]
            self.store.plan = {"date": _today().isoformat(), "order": order, "focus": _clean(result.get("focus"), 80)}
            self.store.save()
            return "已生成今日规划"

        self.run("AI 正在规划今天…", work, apply)


class TodoPanel:
    WIDTH = 360
    MAX_LIST_HEIGHT = 440

    def __init__(self, master: tk.Misc, theme: dict, store: TodoStore, assistant: TodoAssistant, approvals, on_open_tool, daily=None) -> None:
        self.daily = daily
        self.theme = theme
        self.store = store
        self.assistant = assistant
        self.approvals = approvals  # callable -> list of (tool_id, label, count)
        self.on_open_tool = on_open_tool
        self.expanded: set[str] = set()
        self.show_done = False
        self.editing: str | None = None
        self.anchor: tk.Widget | None = None
        self.menu: tk.Menu | None = None
        self.window = tk.Toplevel(master)
        self.window.withdraw()
        self.window.overrideredirect(True)
        self.window.wm_attributes("-topmost", True)
        self.window.configure(background=theme["border"])
        self.window.bind("<Escape>", lambda _event: self.close())
        self.window.bind("<FocusOut>", self.on_focus_out)
        self.body = tk.Frame(self.window, background=theme["panel"], padx=14, pady=12)
        self.body.pack(fill="both", expand=True, padx=1, pady=1)
        self.draft = tk.StringVar()
        self.store.listeners.append(self.refresh)
        self.assistant.status_listeners.append(self.update_status)
        self.build()

    # ---------- helpers ----------
    def label(self, parent, text, size=9, color=None, bold=False, **options) -> tk.Label:
        return tk.Label(
            parent, text=text, background=options.pop("background", self.theme["panel"]),
            foreground=color or self.theme["text"], font=(UI_FONT, size, "bold" if bold else "normal"),
            anchor="w", justify="left", **options,
        )

    def tone(self, name: str) -> str:
        return {"red": RED, "orange": ORANGE, "green": GREEN}.get(name, self.theme["subtle"])

    # ---------- layout ----------
    def build(self) -> None:
        theme = self.theme
        for child in self.body.winfo_children():
            child.destroy()
        header = tk.Frame(self.body, background=theme["panel"])
        header.pack(fill="x")
        self.label(header, "待办", 13, bold=True).pack(side="left")
        count = self.store.due_count()
        tk.Label(header, text=str(count), background=RED if count else theme["card"], foreground="#ffffff" if count else theme["muted"], font=("Segoe UI Semibold", 9), padx=7).pack(side="left", padx=(8, 0), pady=(3, 0))
        close = self.label(header, "\ue711", 9, theme["subtle"], cursor="hand2")
        close.configure(font=("Segoe MDL2 Assets", 9))
        close.pack(side="right")
        close.bind("<Button-1>", lambda _event: self.close())
        plan = self.label(header, "✦ 规划今天", 9, theme["accent"], cursor="hand2")
        plan.pack(side="right", padx=(0, 12), pady=(3, 0))
        plan.bind("<Button-1>", lambda _event: self.plan_today())
        today = _today()
        sub = tk.Frame(self.body, background=theme["panel"])
        sub.pack(fill="x", pady=(1, 8))
        self.label(sub, f"{today.month} 月 {today.day} 日 星期{WEEKDAYS[today.weekday()]}", 8, theme["subtle"]).pack(side="left")
        obsidian = self.label(sub, ("Obsidian ↗" if self.store.vault else "Todo.md ↗"), 8, theme["subtle"], cursor="hand2")
        obsidian.pack(side="right")
        obsidian.bind("<Button-1>", lambda _event: self.open_in_obsidian())
        obsidian.bind("<Enter>", lambda _event: obsidian.configure(foreground=theme["accent"]))
        obsidian.bind("<Leave>", lambda _event: obsidian.configure(foreground=theme["subtle"]))
        if self.daily is not None and self.daily.vault is not None:
            daily = self.label(sub, "今日 ↗", 8, theme["subtle"], cursor="hand2")
            daily.pack(side="right", padx=(0, 10))
            daily.bind("<Button-1>", lambda _event: self.open_daily())
            daily.bind("<Enter>", lambda _event: daily.configure(foreground=theme["accent"]))
            daily.bind("<Leave>", lambda _event: daily.configure(foreground=theme["subtle"]))

        self.entry_box = entry_box = tk.Frame(self.body, background=theme["card"], highlightthickness=1, highlightbackground=theme["border"], highlightcolor=theme["accent"])
        entry_box.pack(fill="x")
        self.entry = tk.Entry(entry_box, textvariable=self.draft, background=theme["card"], foreground=theme["text"], insertbackground=theme["text"], relief="flat", font=(UI_FONT, 10), bd=0)
        self.entry.pack(fill="x", padx=10, pady=7)
        self.entry.bind("<Return>", lambda _event: self.submit())
        self.entry.bind("<Shift-Return>", lambda _event: self.submit_log() or "break")
        hint = "回车 AI 整理待办 · Shift+回车 记入今日日志" if self.daily is not None and self.daily.vault is not None else "写下要做的事，回车由 AI 整理…"
        self.placeholder = self.label(entry_box, hint, 9, theme["subtle"], background=theme["card"])
        self.placeholder.place(x=10, y=7)
        self.placeholder.bind("<Button-1>", lambda _event: self.entry.focus_set())
        self.draft.trace_add("write", lambda *_args: self.sync_placeholder())
        self.sync_placeholder()
        self.status = self.label(self.body, "", 8, theme["accent"])
        self.status.pack(fill="x", pady=(4, 0))
        self.update_status()

        focus = self.store.today_plan().get("focus")
        if focus:
            banner = tk.Frame(self.body, background=theme["card"], padx=10, pady=6)
            banner.pack(fill="x", pady=(4, 2))
            self.label(banner, "✦ " + focus, 9, theme["text"], background=theme["card"], wraplength=self.WIDTH - 56).pack(fill="x")

        self.build_list()
        self.build_footer()

    def build_list(self) -> None:
        theme = self.theme
        holder = tk.Frame(self.body, background=theme["panel"])
        holder.pack(fill="both", expand=True, pady=(6, 0))
        canvas = tk.Canvas(holder, background=theme["panel"], highlightthickness=0, bd=0, width=self.WIDTH - 30)
        inner = tk.Frame(canvas, background=theme["panel"])
        canvas.create_window(0, 0, window=inner, anchor="nw", width=self.WIDTH - 30)
        canvas.pack(fill="both", expand=True)
        self.list_canvas = canvas

        sections = self.store.sections()
        if not sections:
            self.label(inner, "今天没有待办 ✓  在上面输入一句话就能添加", 9, theme["muted"]).pack(fill="x", pady=(10, 6))
        plan_ids = set(self.store.today_plan().get("order", []))
        for name, items in sections:
            color = RED if name == "逾期" else theme["subtle"]
            self.label(inner, f"{name}  {len(items)}", 8, color, bold=True).pack(fill="x", pady=(8, 2))
            for item in items:
                self.build_item(inner, item, item["id"] in plan_ids)
        done = self.store.done_today()
        if done:
            toggle = self.label(inner, f"{'▾' if self.show_done else '▸'} 今天已完成 {len(done)}", 8, theme["subtle"], cursor="hand2")
            toggle.pack(fill="x", pady=(10, 2))
            toggle.bind("<Button-1>", lambda _event: self.toggle_done_section())
            if self.show_done:
                for item in done:
                    self.build_item(inner, item, False)

        inner.update_idletasks()
        height = min(inner.winfo_reqheight(), self.MAX_LIST_HEIGHT)
        canvas.configure(height=height, scrollregion=(0, 0, self.WIDTH - 30, inner.winfo_reqheight()))
        if inner.winfo_reqheight() > self.MAX_LIST_HEIGHT:
            def wheel(event):
                canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
                return "break"
            for widget in self.walk(inner) + [canvas]:
                widget.bind("<MouseWheel>", wheel, add="+")

    def walk(self, widget: tk.Widget) -> list:
        result = [widget]
        for child in widget.winfo_children():
            result.extend(self.walk(child))
        return result

    def build_item(self, parent: tk.Frame, item: dict, planned: bool) -> None:
        theme = self.theme
        task_id = item["id"]
        done = bool(item.get("done"))
        row = tk.Frame(parent, background=theme["panel"], padx=4, pady=3)
        row.pack(fill="x")
        line = tk.Frame(row, background=theme["panel"])
        line.pack(fill="x")
        check = tk.Canvas(line, width=18, height=18, background=theme["panel"], highlightthickness=0, bd=0, cursor="hand2")
        check.pack(side="left", anchor="n", pady=(1, 0))
        ring = GREEN if done else (RED if item.get("priority") == "high" else theme["subtle"])
        if done:
            aa_draw.check_circle(check, 1.5, 1.5, 16.5, 16.5, GREEN)
        else:
            aa_draw.oval(check, 1.5, 1.5, 16.5, 16.5, outline=ring, width=1.5)
        check.bind("<Button-1>", lambda _event: self.store.toggle(task_id))

        text, tone = due_label(item)
        if text and not done:
            self.label(line, text, 8, self.tone(tone)).pack(side="right", anchor="n", pady=(2, 0))
        prefix = ("✦ " if planned else "") + ("! " if item.get("priority") == "high" and not done else "")
        steps = item.get("subtasks") or []
        suffix = f"  {sum(1 for step in steps if step.get('done'))}/{len(steps)}" if steps and not done else ""
        if self.editing == task_id:
            editor = tk.Entry(line, background=theme["card"], foreground=theme["text"], insertbackground=theme["text"], relief="flat", font=(UI_FONT, 9))
            editor.insert(0, item["title"])
            editor.pack(side="left", fill="x", expand=True, padx=(6, 0))
            editor.bind("<Return>", lambda _event: self.finish_edit(task_id, editor.get()))
            editor.bind("<Escape>", lambda _event: self.finish_edit(task_id, None))
            editor.after(30, lambda: (editor.focus_set(), editor.select_range(0, "end")))
            title = editor
        else:
            title = self.label(line, prefix + item["title"] + suffix, 9, theme["subtle"] if done else theme["text"], wraplength=self.WIDTH - 140, cursor="hand2")
            if done:
                title.configure(font=(UI_FONT, 9, "overstrike"))
            title.pack(side="left", fill="x", expand=True, padx=(6, 0))
            title.bind("<Button-1>", lambda _event: self.toggle_expand(task_id))
            title.bind("<Double-Button-1>", lambda _event: self.start_edit(task_id))
        for widget in (row, line, title, check):
            widget.bind("<Button-3>", lambda event: self.show_menu(event, task_id), add="+")

        if task_id in self.expanded and not done:
            detail = tk.Frame(row, background=theme["panel"])
            detail.pack(fill="x", padx=(24, 0), pady=(2, 2))
            if item.get("notes"):
                self.label(detail, item["notes"], 8, theme["muted"], wraplength=self.WIDTH - 80).pack(fill="x")
            for index, step in enumerate(steps):
                step_label = self.label(detail, ("☑ " if step.get("done") else "☐ ") + step["title"], 8, theme["subtle"] if step.get("done") else theme["text"], wraplength=self.WIDTH - 80, cursor="hand2")
                step_label.pack(fill="x", pady=(1, 0))
                step_label.bind("<Button-1>", lambda _event, index=index: self.store.toggle_step(task_id, index))
            if not item.get("notes") and not steps:
                link = self.label(detail, "✦ 让 AI 拆解步骤", 8, theme["accent"], cursor="hand2")
                link.pack(fill="x")
                link.bind("<Button-1>", lambda _event: self.assistant.expand(task_id))

    def build_footer(self) -> None:
        theme = self.theme
        rows = [entry for entry in self.approvals() if entry[2]]
        footer = tk.Frame(self.body, background=theme["panel"])
        footer.pack(fill="x", pady=(10, 0))
        if rows:
            self.label(footer, "审批", 8, theme["subtle"]).pack(side="left")
            for tool_id, label, count in rows:
                link = self.label(footer, f"{label} {count}", 8, RED, cursor="hand2")
                link.pack(side="left", padx=(8, 0))
                link.bind("<Button-1>", lambda _event, tool_id=tool_id: self.open_tool(tool_id))
        self.label(footer, "单击展开 · 双击改名 · 右键更多", 8, theme["subtle"]).pack(side="right")

    # ---------- actions ----------
    def sync_placeholder(self) -> None:
        if self.draft.get():
            self.placeholder.place_forget()
        else:
            self.placeholder.place(x=10, y=7)

    def update_status(self) -> None:
        try:
            if self.status.winfo_exists():
                self.status.configure(text=self.assistant.status)
                if not self.assistant.status:
                    self.status.pack_forget()
                else:
                    self.status.pack(fill="x", pady=(4, 0), after=self.entry_box)
                self.place()
        except (tk.TclError, AttributeError):
            pass

    def submit(self) -> None:
        text = self.draft.get().strip()
        if text:
            self.draft.set("")
            self.assistant.organize(text)

    def submit_log(self) -> None:
        text = self.draft.get().strip()
        if not text or self.daily is None:
            return
        try:
            ok = self.daily.log(text)
        except OSError:
            ok = False
        if ok:
            self.draft.set("")
        self.assistant.set_status("✓ 已记入今日日志" if ok else "写入今日日志失败")

    def open_daily(self) -> None:
        self.close()
        try:
            uri = self.daily.open_uri()
            if uri:
                os.startfile(uri)
        except OSError:
            pass

    def plan_today(self) -> None:
        approvals = {label: count for _tool_id, label, count in self.approvals()}
        self.assistant.plan_today(approvals)

    def toggle_expand(self, task_id: str) -> None:
        self.expanded.symmetric_difference_update({task_id})
        self.refresh()

    def toggle_done_section(self) -> None:
        self.show_done = not self.show_done
        self.refresh()

    def start_edit(self, task_id: str) -> None:
        self.editing = task_id
        self.refresh()

    def finish_edit(self, task_id: str, text: str | None) -> None:
        self.editing = None
        if text is not None and _clean(text, 80):
            self.store.update(task_id, title=_clean(text, 80))
        else:
            self.refresh()

    def set_due(self, task_id: str, day: date | None) -> None:
        self.store.update(task_id, due=day.isoformat() if day else "", time="" if day is None else (self.store.get(task_id) or {}).get("time", ""))

    def show_menu(self, event, task_id: str) -> str:
        item = self.store.get(task_id)
        if item is None:
            return "break"
        theme = self.theme
        today = _today()
        if self.menu is not None:
            self.menu.destroy()
        menu = tk.Menu(self.window, tearoff=False, background=theme["card"], foreground=theme["text"], activebackground=theme["accent"], activeforeground="#ffffff", font=(UI_FONT, 9))
        menu.add_command(label="完成" if not item.get("done") else "标记为未完成", command=lambda: self.store.toggle(task_id))
        menu.add_separator()
        menu.add_command(label="今天", command=lambda: self.set_due(task_id, today))
        menu.add_command(label="明天", command=lambda: self.set_due(task_id, today + timedelta(days=1)))
        menu.add_command(label="下周一", command=lambda: self.set_due(task_id, today + timedelta(days=7 - today.weekday())))
        menu.add_command(label="清除日期", command=lambda: self.set_due(task_id, None))
        menu.add_separator()
        for value, text in (("high", "优先级：高"), ("normal", "优先级：普通"), ("low", "优先级：低")):
            menu.add_command(label=("● " if item.get("priority") == value else "   ") + text, command=lambda value=value: self.store.update(task_id, priority=value))
        menu.add_separator()
        menu.add_command(label="✦ AI 拆解步骤", command=lambda: (self.expanded.add(task_id), self.assistant.expand(task_id)))
        menu.add_command(label="重命名", command=lambda: self.start_edit(task_id))
        menu.add_command(label="删除", command=lambda: self.store.delete(task_id))
        menu.add_separator()
        menu.add_command(label="在 Obsidian 中打开", command=self.open_in_obsidian)
        self.menu = menu
        menu.tk_popup(event.x_root, event.y_root)
        return "break"

    def open_in_obsidian(self) -> None:
        self.close()
        try:
            os.startfile(self.store.open_uri() if self.store.vault else str(self.store.path))
        except OSError:
            try:
                os.startfile(str(self.store.path))
            except OSError:
                pass

    def open_tool(self, tool_id: str) -> None:
        self.close()
        self.on_open_tool(tool_id)

    # ---------- window ----------
    def refresh(self) -> None:
        if not self.exists():
            return
        self.build()
        self.place()

    def show_near(self, anchor: tk.Widget | None) -> None:
        self.anchor = anchor
        self.place()
        self.window.deiconify()
        self.round_corners()
        self.window.lift()
        self.window.focus_force()
        self.window.after(60, self.entry.focus_set)

    def place(self) -> None:
        self.window.update_idletasks()
        width, height = self.WIDTH, self.window.winfo_reqheight()
        screen_w, screen_h = self.window.winfo_screenwidth(), self.window.winfo_screenheight()
        anchor = self.anchor
        try:
            if anchor is not None and anchor.winfo_ismapped():
                x = anchor.winfo_rootx() + anchor.winfo_width() // 2 - width // 2
                y = anchor.winfo_rooty() - height - 10
                if y < 8:
                    y = anchor.winfo_rooty() + anchor.winfo_height() + 10
            else:
                raise tk.TclError
        except tk.TclError:
            x, y = screen_w - width - 24, screen_h - height - 80
        x = max(8, min(x, screen_w - width - 8))
        y = max(8, min(y, screen_h - height - 8))
        self.window.geometry(f"{width}x{height}+{x}+{y}")

    def round_corners(self) -> None:
        try:
            import ctypes

            hwnd = ctypes.windll.user32.GetParent(self.window.winfo_id()) or self.window.winfo_id()
            preference = ctypes.c_int(2)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(preference), ctypes.sizeof(preference))
        except (AttributeError, OSError):
            pass

    def on_focus_out(self, _event) -> None:
        self.window.after(150, self.close_if_unfocused)

    def close_if_unfocused(self) -> None:
        if self.editing or (self.menu is not None and self.menu.winfo_exists() and self.menu.winfo_ismapped()):
            return
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
        if self.refresh in self.store.listeners:
            self.store.listeners.remove(self.refresh)
        if self.update_status in self.assistant.status_listeners:
            self.assistant.status_listeners.remove(self.update_status)
        if self.exists():
            self.window.destroy()
