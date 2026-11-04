"""Today's Obsidian daily note: create it from the vault's template and append log lines.

Tasks stay in 00-Inbox/Todo.md; the daily note is only a log. The toolbox (quick notes) and
the quick-meeting script append timestamped lines under the "工作记录" heading.
"""
from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import re
import threading

LOG_HEADING = "## 工作记录"
DEFAULT_SETTINGS = {"folder": "01-Daily", "format": "YYYY-MM-DD", "template": ""}
MOMENT_TOKENS = (("YYYY", "%Y"), ("MM", "%m"), ("DD", "%d"), ("HH", "%H"), ("mm", "%M"), ("ss", "%S"))
TEMPLATE_VAR_RE = re.compile(r"\{\{\s*(date|time|title)(?::([^}]+))?\s*\}\}")
_lock = threading.Lock()


def moment_format(when: datetime, pattern: str) -> str:
    for token, code in MOMENT_TOKENS:
        pattern = pattern.replace(token, code)
    return when.strftime(pattern)


def default_vault() -> Path | None:
    from todo_panel import find_obsidian_vault
    return find_obsidian_vault()


class DailyNote:
    def __init__(self, vault: Path | None) -> None:
        self.vault = vault
        settings = dict(DEFAULT_SETTINGS)
        if vault is not None:
            try:
                data = json.loads((vault / ".obsidian" / "daily-notes.json").read_text(encoding="utf-8"))
                settings.update({key: value for key, value in data.items() if isinstance(value, str) and value})
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass
        self.settings = settings

    def path(self, when: datetime | None = None) -> Path | None:
        if self.vault is None:
            return None
        name = moment_format(when or datetime.now(), self.settings["format"]) + ".md"
        return self.vault / self.settings["folder"].strip("/") / name

    def render_template(self, when: datetime) -> str:
        text = ""
        template = self.settings.get("template", "").strip()
        if template and self.vault is not None:
            file = self.vault / (template if template.endswith(".md") else template + ".md")
            try:
                text = file.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError):
                text = ""
        if not text:
            text = f"# {{{{date}}}}\n\n{LOG_HEADING}\n- \n"

        def substitute(match: re.Match) -> str:
            kind, pattern = match.group(1), match.group(2)
            if kind == "title":
                return moment_format(when, self.settings["format"])
            return moment_format(when, pattern or ("YYYY-MM-DD" if kind == "date" else "HH:mm"))

        return TEMPLATE_VAR_RE.sub(substitute, text)

    def ensure(self, when: datetime | None = None) -> Path | None:
        """Create today's note from the template if it does not exist yet."""
        when = when or datetime.now()
        path = self.path(when)
        if path is None or path.exists():
            return path
        with _lock:
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(self.render_template(when), encoding="utf-8")
        return path

    def log(self, text: str, when: datetime | None = None) -> bool:
        """Append "- HH:MM text" to the 工作记录 section of today's note."""
        text = " ".join(str(text).split())
        if not text:
            return False
        when = when or datetime.now()
        path = self.ensure(when)
        if path is None:
            return False
        entry = f"- {when:%H:%M} {text}"
        with _lock:
            try:
                lines = path.read_text(encoding="utf-8-sig").splitlines()
            except (OSError, UnicodeError):
                return False
            start = next((index for index, line in enumerate(lines) if line.strip() == LOG_HEADING), None)
            if start is None:
                while lines and not lines[-1].strip():
                    lines.pop()
                lines += ["", LOG_HEADING, entry]
            else:
                end = next((index for index in range(start + 1, len(lines)) if lines[index].startswith("#")), len(lines))
                body = lines[start + 1:end]
                body = [line for line in body if line.strip() not in ("-", "- [ ]")]
                while body and not body[-1].strip():
                    body.pop()
                body.append(entry)
                lines[start + 1:end] = body + ([""] if end < len(lines) else [])
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return True

    def open_uri(self) -> str:
        from urllib.parse import quote
        path = self.ensure()
        return "obsidian://open?path=" + quote(str(path), safe="") if path else ""
