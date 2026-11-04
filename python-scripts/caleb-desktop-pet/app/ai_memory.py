"""Long-term user memory, distilled from chat records and kept indefinitely.

Two layers, on purpose:
  * the raw chat log (ai-history.jsonl) rolls over after history_days;
  * this distilled profile does not expire, so the pet still knows the durable
    things about the user months later without carrying whole transcripts.

Distillation is one extra short request every `distill_every` finished turns; a
manual button in the settings window does the same thing on demand.
"""
from datetime import datetime
import json
from pathlib import Path

STAMP = "%Y-%m-%d %H:%M:%S"
MAX_FACTS = 12

DISTILL_PROMPT = (
    "你在帮夏以昼整理一份“关于用户的长期记忆”，供之后的角色化对话自然使用。\n"
    "下面会给你【现有记忆】和【最近的对话】。请输出更新后的记忆，只输出 JSON，不要解释：\n"
    '{"facts": ["...", "..."]}\n'
    "要求：\n"
    f"1. 最多 {MAX_FACTS} 条，每条一句话，20 到 40 字，用第三人称“用户”。\n"
    "2. 优先记住这些稳定信息：用户希望被怎样称呼、作息和工作节奏、常用工具、长期项目、兴趣偏好、饮食或休息习惯、反复出现的困扰，以及用户明确要求你记住的内容。\n"
    "3. 一次性内容（今天累、这次聊天聊了什么）不要写进去；正在推进但可能持续一段时间的事情可以保留，并在后来发生变化时更新。\n"
    "4. 与现有记忆冲突时以新对话为准；重复的合并，不要罗列同义句；不确定的信息不要写成确定事实。\n"
    "5. 不要编造，对话里没出现过的信息一律不写。只输出对用户有帮助、能让夏以昼下次更自然陪伴的内容。"
)


class UserMemory:
    def __init__(self, path):
        self.path = Path(path)

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"facts": [], "updated_at": "", "turns": 0}
        if not isinstance(data, dict):
            return {"facts": [], "updated_at": "", "turns": 0}
        facts = [str(item).strip() for item in data.get("facts", [])
                 if isinstance(item, str) and item.strip()][:MAX_FACTS]
        return {
            "facts": facts,
            "updated_at": str(data.get("updated_at", "")),
            "turns": int(data.get("turns", 0) or 0),
        }

    def save(self, memory: dict) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(memory, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")
            temporary.replace(self.path)
        except OSError:
            pass

    def bump_turn(self) -> int:
        """Count finished turns; returns the new total."""
        memory = self.load()
        memory["turns"] = int(memory.get("turns", 0)) + 1
        self.save(memory)
        return memory["turns"]

    def clear(self) -> None:
        self.save({"facts": [], "updated_at": "", "turns": 0})

    def block(self) -> str:
        """The text injected into the system message, or '' when empty."""
        facts = self.load()["facts"]
        if not facts:
            return ""
        return "".join(f"- {fact}\n" for fact in facts)

    def request_messages(self, records: list[dict]) -> list:
        """Messages for one distillation call."""
        existing = self.block() or "（还没有）"
        transcript = "\n".join(
            f'{"用户" if item["role"] == "user" else "夏以昼"}：{item["text"]}' for item in records)
        return [
            {"role": "system", "content": DISTILL_PROMPT},
            {"role": "user", "content": f"【现有记忆】\n{existing}\n\n【最近的对话】\n{transcript}"},
        ]

    def apply(self, reply: str, now: datetime | None = None) -> list[str]:
        """Store the facts from a distillation reply; returns the new list."""
        from ai_service import extract_json
        data = extract_json(reply)
        facts = data.get("facts")
        if not isinstance(facts, list):
            return self.load()["facts"]
        cleaned = []
        for item in facts:
            if not isinstance(item, str):
                continue
            text = " ".join(item.split()).strip()
            if text and text not in cleaned:
                cleaned.append(text)
        memory = self.load()
        memory["facts"] = cleaned[:MAX_FACTS]
        memory["updated_at"] = (now or datetime.now()).strftime(STAMP)
        self.save(memory)
        return memory["facts"]
