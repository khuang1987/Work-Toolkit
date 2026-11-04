"""User reminders spoken in plain language, parsed by the model, kept on disk.

The pet never fires a reminder it was not told about: the model only turns a
sentence into {intent, at, text}, and this module owns storage, due-time maths
and the fired flag. Everything stays local.
"""
from datetime import datetime, timedelta
import json
from pathlib import Path

STAMP = "%Y-%m-%d %H:%M"
OVERDUE_GRACE = timedelta(hours=12)
WEEKDAY = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")

# 只有句子里出现这些词才值得多花一次解析请求，省下没必要的调用。
TRIGGER_WORDS = ("提醒", "别忘", "记得", "叫我", "通知我", "到点", "几点", "该去",
                 "开会", "会议", "交作业", "交报告", "吃药", "喝水", "打卡", "提醒我")


def looks_like_reminder(text: str) -> bool:
    return any(word in text for word in TRIGGER_WORDS)


def parse_prompt(now: datetime) -> str:
    return (
        f"现在的时间是 {now.strftime('%Y-%m-%d %H:%M')}（{WEEKDAY[now.weekday()]}）。\n"
        "判断用户这句话里有没有关于“提醒”的要求，只输出一个 JSON 对象，不要解释、不要代码块。\n"
        "字段：\n"
        '  "intent": "create" 新建提醒 / "list" 查看已有提醒 / "cancel" 取消提醒 / "none" 都不是\n'
        '  "at": create 时的触发时间，格式 "YYYY-MM-DD HH:MM"（24 小时制），依据上面的当前时间换算\n'
        '  "text": create 时要提醒的内容，8 到 30 字的短语，不要写成一句话；cancel 时填要取消的关键词\n'
        "规则：时间说不清楚就用 null；已经过去的时间不要用；不要编造用户没说的内容。\n"
        '示例：用户说“十点得去开会”→ {"intent":"create","at":"' + now.strftime('%Y-%m-%d') + ' 10:00","text":"去开会"}\n'
        '示例：用户说“今天天气不错”→ {"intent":"none"}'
    )


class ReminderStore:
    def __init__(self, path):
        self.path = Path(path)

    def load(self) -> list[dict]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(data, list):
            return []
        items = []
        for item in data:
            if not isinstance(item, dict):
                continue
            try:
                datetime.strptime(item["at"], STAMP)
            except (KeyError, ValueError):
                continue
            if not isinstance(item.get("text"), str) or not item["text"]:
                continue
            items.append({
                "at": item["at"],
                "text": item["text"],
                "fired": bool(item.get("fired", False)),
                "created": str(item.get("created", "")),
            })
        return items

    def save(self, items: list[dict]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")
            temporary.replace(self.path)
        except OSError:
            pass

    def add(self, at: datetime, text: str, now: datetime | None = None) -> dict:
        items = self.load()
        record = {"at": at.strftime(STAMP), "text": text,
                  "fired": False, "created": (now or datetime.now()).strftime(STAMP)}
        items.append(record)
        items.sort(key=lambda item: item["at"])
        self.save(items)
        return record

    def remove(self, keyword: str) -> list[dict]:
        """Drop reminders whose text contains the keyword; returns what was dropped."""
        items = self.load()
        dropped = [item for item in items if keyword and keyword in item["text"]]
        if dropped:
            self.save([item for item in items if item not in dropped])
        return dropped

    def clear(self) -> None:
        self.save([])

    def pending(self, now: datetime | None = None) -> list[dict]:
        now = now or datetime.now()
        now_stamp = now.strftime(STAMP)
        return sorted((item for item in self.load() if not item["fired"] and item["at"] >= now_stamp),
                      key=lambda item: item["at"])

    def due(self, now: datetime | None = None) -> list[dict]:
        """Reminders whose time has come and that were never shown.

        Anything older than the grace window is dropped instead: a reminder from
        last week is noise, not help.
        """
        now = now or datetime.now()
        now_stamp = now.strftime(STAMP)
        due, keep, changed = [], [], False
        for item in self.load():
            if item["fired"] or item["at"] > now_stamp:
                keep.append(item)
                continue
            changed = True
            if now - datetime.strptime(item["at"], STAMP) <= OVERDUE_GRACE:
                item["fired"] = True
                due.append(dict(item))
                keep.append(item)
        if changed:
            self.save(keep)
        return due

    def summary(self, now: datetime | None = None) -> tuple[int, str]:
        pending = self.pending(now)
        if not pending:
            return 0, ""
        return len(pending), f'{pending[0]["at"]} {pending[0]["text"]}'


def describe_due(record: dict, now: datetime | None = None) -> str:
    """Bubble text for a firing reminder."""
    now = now or datetime.now()
    at = datetime.strptime(record["at"], STAMP)
    if at.date() == now.date():
        when = ""
    elif at.date() == (now.date() + timedelta(days=1)):
        when = "（明天）"
    else:
        when = f'（{at.strftime("%m-%d")}）'
    late = ""
    if now - at > timedelta(minutes=2):
        late = "，已经过点了"
    return f'你说过 {at.strftime("%H:%M")} 要 {record["text"]}{when}{late}。'
