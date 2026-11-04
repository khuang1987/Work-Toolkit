"""聊聊 history: timestamped, kept for a rolling window, exportable.

Stored as one JSON object per line next to the pet's other local data. Plain
text on purpose: it is the user's own conversation on their own machine, and
they asked to be able to read and export it. Nothing is sent anywhere.
"""
from datetime import datetime, timedelta
import json
from pathlib import Path

RETENTION_DAYS = 7
STAMP = "%Y-%m-%d %H:%M:%S"
ROLE_LABEL = {"user": "你", "assistant": "夏以昼"}


class ChatLog:
    def __init__(self, path, retention_days: int = RETENTION_DAYS):
        self.path = Path(path)
        self.retention_days = retention_days

    def _cutoff(self, now: datetime) -> datetime:
        return now - timedelta(days=self.retention_days)

    def _read(self) -> list[dict]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        records = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                datetime.strptime(record["at"], STAMP)
                if record.get("role") not in ROLE_LABEL or not isinstance(record.get("text"), str):
                    continue
                records.append({"at": record["at"], "role": record["role"], "text": record["text"]})
            except (ValueError, KeyError, TypeError):
                continue  # a damaged line must not take the whole log down
        return records

    def _write(self, records: list[dict]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in records)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(payload, encoding="utf-8")
            temporary.replace(self.path)
        except OSError:
            pass  # a read-only folder must not break chatting

    def load(self, now: datetime | None = None) -> list[dict]:
        """Records inside the retention window, oldest first; expired ones are dropped."""
        now = now or datetime.now()
        cutoff = self._cutoff(now)
        records = self._read()
        kept = [item for item in records if datetime.strptime(item["at"], STAMP) >= cutoff]
        if len(kept) != len(records):
            self._write(kept)
        return kept

    def append(self, role: str, text: str, now: datetime | None = None) -> None:
        now = now or datetime.now()
        if role not in ROLE_LABEL or not text:
            return
        records = self.load(now)
        records.append({"at": now.strftime(STAMP), "role": role, "text": text})
        self._write(records)

    def clear(self) -> None:
        self._write([])

    def summary(self) -> tuple[int, str, str]:
        """(count, oldest stamp, newest stamp) for the settings window."""
        records = self.load()
        if not records:
            return 0, "", ""
        return len(records), records[0]["at"], records[-1]["at"]

    def transcript(self, now: datetime | None = None) -> str:
        records = self.load(now)
        now = now or datetime.now()
        lines = [
            "夏以昼 · AI 聊聊记录",
            f"导出时间：{now.strftime(STAMP)}",
            f"保留范围：最近 {self.retention_days} 天，共 {len(records)} 条",
            "",
        ]
        for item in records:
            label = ROLE_LABEL[item["role"]]
            body = item["text"].replace("\r\n", "\n").strip().replace("\n", "\n" + " " * 24)
            lines.append(f'[{item["at"]}] {label}：{body}')
        return "\n".join(lines) + "\n"

    def as_json(self, now: datetime | None = None) -> str:
        records = self.load(now)
        now = now or datetime.now()
        return json.dumps({
            "exported_at": now.strftime(STAMP),
            "retention_days": self.retention_days,
            "count": len(records),
            "records": records,
        }, ensure_ascii=False, indent=2) + "\n"
