"""Live integration test: the real app talking to a local stub over real HTTP.

Unlike check_ai.py (which replaces urlopen), this drives the chain the way it
runs on the user's desk: a real HTTP request, real SSE parsing, real threads,
real files. The stub speaks the OpenAI chat-completions protocol and answers the
distillation / reminder-parsing calls too, so no external service and no key are
needed and nothing costs money.

Run it whenever "聊聊" feels wrong and the unit tests are green anyway.
"""
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import tkinter as tk

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))

import main  # noqa: E402
import ai_chat as ai_chat_module  # noqa: E402

REPLY = "我在。先把这一段走稳，剩下的等缓过来再说。"
FACTS = ["用户正在做一个桌面宠物项目", "用户偏好简短直接的回复"]
REMINDER = {"intent": "create", "at": "2030-01-01 09:00", "text": "去开会"}
DISTILL_MARK = '关于用户的长期记忆'
PARSE_MARK = '判断用户这句话里有没有'
seen = {"chat": 0, "distill": 0, "reminder": 0, "stream": 0}


class Stub(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _payload(self):
        length = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def _json(self, body):
        raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._json({"data": [{"id": "stub-model"}, {"id": "stub-model-free"}]})

    def do_POST(self):
        payload = self._payload()
        system = payload['messages'][0]['content']
        if DISTILL_MARK in system:
            seen['distill'] += 1
            body = json.dumps({"facts": FACTS}, ensure_ascii=False)
            return self._json({"choices": [{"message": {"content": body}}]})
        if PARSE_MARK in system:
            seen['reminder'] += 1
            return self._json({"choices": [{"message": {"content": json.dumps(REMINDER, ensure_ascii=False)}}]})
        seen['chat'] += 1
        if not payload.get('stream'):
            return self._json({"choices": [{"message": {"content": REPLY}}]})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        for piece in (REPLY[:6], REPLY[6:14], REPLY[14:]):
            seen['stream'] += 1
            line = ('data: ' + json.dumps({'choices': [{'delta': {'content': piece}}]},
                                          ensure_ascii=False) + '\n').encode('utf-8')
            self.wfile.write(b'%x\r\n%s\r\n' % (len(line), line))
            self.wfile.flush()
            time.sleep(.05)
        tail = b'data: [DONE]\n'
        self.wfile.write(b'%x\r\n%s\r\n' % (len(tail), tail))
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()


server = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True, name='caleb-stub').start()

sandbox = Path(tempfile.mkdtemp())
(sandbox / 'ai-config.json').write_text(json.dumps({
    "base_url": f"http://127.0.0.1:{port}/v1", "path": "/chat/completions",
    "model": "stub-model", "max_tokens": 200, "temperature": 0.7,
    "request_timeout": 10, "reply_timeout": 30, "thinking": "disabled",
    "extra_headers": {}, "history_days": 30, "distill_every": 2, "reminders": True,
}, ensure_ascii=False), encoding='utf-8')
main.profile_path = lambda: sandbox / 'profile.json'
main.CalebPet._start_tray_icon = lambda self: None

root = tk.Tk()
app = main.CalebPet(root, welcome=False)
app._save_profile = lambda: True


def bubble_texts():
    canvas = app.bubble.winfo_children()[0]
    return [canvas.itemcget(item, 'text') for item in canvas.find_all() if canvas.type(item) == 'text']


def wait_for(predicate, timeout=15.0):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        root.update()
        time.sleep(.02)
    return predicate()


def say(question, timeout=15.0):
    app.open_ai_chat()
    chat = app.ai_chat
    root.update()
    chat.entry.insert(0, question)
    chat.send()
    assert chat.window is None, '输入条应在发送后收起'
    assert wait_for(lambda: not chat.waiting, timeout), f'没有收到回复：{question}'
    return chat


try:
    chat = app._ai()
    chat.keys.save('stub-key')  # 本地桩不校验 key，但程序要求得有一把

    # ---- 一轮真实问答（真 HTTP + SSE）----
    chat = say('今天有点累')
    assert seen['chat'] == 1 and seen['stream'] >= 3, seen
    texts = bubble_texts()
    assert any('你：今天有点累' in t for t in texts), texts
    assert any(REPLY[:6] in t for t in texts), texts
    assert any('继续提问' in t for t in texts), texts
    assert [item['text'] for item in chat.log.load()] == ['今天有点累', REPLY], chat.log.load()

    # ---- 第二轮触发自动蒸馏（distill_every=2）----
    chat = say('我在做桌面宠物')
    assert wait_for(lambda: seen['distill'] >= 1), '没有触发自动蒸馏'
    assert wait_for(lambda: chat.memory.load()['facts'] == FACTS), chat.memory.load()
    assert chat.memory.block().count('- ') == len(FACTS)
    assert len(chat.log.load()) == 4

    # ---- 自然语言提醒：解析 → 入库 → 到点弹气泡 ----
    chat = say('2030年1月1日九点提醒我去开会')
    assert wait_for(lambda: seen['reminder'] >= 1), '没有触发提醒解析'
    assert wait_for(lambda: chat.reminders.pending()), '提醒没有入库'
    record = chat.reminders.pending()[0]
    assert record['at'] == '2030-01-01 09:00' and record['text'] == '去开会', record

    chat.reminders.add(datetime.now() - timedelta(seconds=30), '测试用的提醒')
    chat._poll_reminders()
    texts = bubble_texts()
    assert any('你交代过的事' in t for t in texts), texts
    assert any('十分钟后再提醒' in t for t in texts), texts
    app._close_bubble()

    # ---- 重启后还记得：新实例从同一批文件恢复 ----
    chat.close()
    again = ai_chat_module.AIChat(app, main.resource_path('assets', 'personality.json'),
                                  sandbox / 'ai-key.bin', sandbox / 'ai-config.json',
                                  sandbox / 'ai-history.jsonl', sandbox / 'ai-memory.json',
                                  sandbox / 'ai-reminders.json')
    assert len(again.history) == 6, again.history
    assert again.memory.block().count('- ') == len(FACTS)
    assert [item['text'] for item in again.reminders.pending()] == ['去开会']
    app.ai_chat = again

    print(f'live stub 127.0.0.1:{port} · chat={seen["chat"]} stream={seen["stream"]} '
          f'distill={seen["distill"]} reminder={seen["reminder"]}')
    print('PASS: real HTTP chat with SSE, chat log on disk, auto-distilled long-term memory, '
          'natural-language reminder that fires a bubble, state survives a restart')
finally:
    try:
        app.quit()
    except Exception:
        pass
    server.shutdown()
