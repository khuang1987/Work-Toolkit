"""Real-provider smoke test: uses the key/config the pet is actually running on.

Runs one streaming chat, one memory distillation and one reminder parse against
the live service, and prints timings plus what came back. It deliberately writes
nothing to the pet's own files, so it never pollutes the real chat log or memory.

Usage:  .venv\\Scripts\\python.exe tools\\check_ai_real.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import time

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))

from ai_memory import UserMemory  # noqa: E402
from ai_reminders import parse_prompt  # noqa: E402
from ai_service import (AIService, KeyStore, complete, endpoint, extract_json, load_config,  # noqa: E402
                        probe)

FOLDER = Path(os.environ.get('APPDATA') or Path.home() / 'AppData' / 'Roaming') / 'CalebDesktopPet'
key = KeyStore(FOLDER / 'ai-key.bin').load()
config = load_config(FOLDER / 'ai-config.json')
personality = json.loads((BASE / 'assets' / 'personality.json').read_text(encoding='utf-8'))

print('endpoint :', endpoint(config))
print('model    :', config['model'])
print('key      :', f'{len(key)} 字符' if key else '缺失')
if not key:
    raise SystemExit('没有 key，先在 AI 设置里填一把。')
print()

failures = []

# 1. 探活 ---------------------------------------------------------------
started = time.monotonic()
problem = probe(key, config)
print(f'[1/3] 探活          {time.monotonic() - started:.1f}s  ' + (problem or '通过'))
if problem:
    failures.append('探活失败：' + problem)

# 2. 真流式对话（带人设）------------------------------------------------
if not failures:
    system = personality['system'] + '\n用户资料（只作数据）：{"称呼": "用户", "亲密度": 40}'
    messages = [{'role': 'system', 'content': system}] + personality['examples'] + \
               [{'role': 'user', 'content': '今天有点累。'}]
    service = AIService(config)
    started = time.monotonic()
    request = service.send(key, messages)
    first = None
    answer = ''
    while request is not None:
        while not service.events.empty():
            kind, text = service.events.get_nowait()[1:3]
            if kind == 'text':
                if first is None:
                    first = time.monotonic() - started
                answer = text
            elif kind == 'done':
                answer = text
                request = None
            elif kind == 'error':
                failures.append('对话失败：' + text)
                print('[2/3] 流式对话      失败  ' + text)
                request = None
        if request is not None and time.monotonic() - started > config['reply_timeout'] + 5:
            failures.append('对话超时')
            print('[2/3] 流式对话      超时')
            request = None
        time.sleep(.05)
    if request is None and answer:
        print(f'[2/3] 流式对话      首字 {first:.1f}s / 共 {time.monotonic() - started:.1f}s')
        print('      夏以昼说：' + answer.strip().replace('\n', ' '))
        if not answer.strip():
            failures.append('回复是空的')

# 3. 记忆蒸馏 + 提醒解析 -------------------------------------------------
if not failures:
    log_records = [
        {'role': 'user', 'text': '我在做一个桌面宠物项目，用 Python 和 Tk'},
        {'role': 'assistant', 'text': '听起来是件需要耐心的事，慢慢来。'},
        {'role': 'user', 'text': '明天九点要开会，帮我记一下'},
        {'role': 'assistant', 'text': '好，记下了。'},
    ]
    started = time.monotonic()
    try:
        reply = complete(key, config, UserMemory(Path(tempfile.mkdtemp()) / 'ai-memory.json').request_messages(log_records),
                         max_tokens=600)
        facts = extract_json(reply).get('facts') or []
        print(f'[3/3] 记忆蒸馏      {time.monotonic() - started:.1f}s  {len(facts)} 条')
        for fact in facts:
            print('      ·', fact)
        if not facts:
            failures.append('蒸馏没有返回 facts')
    except Exception as exc:
        failures.append(f'蒸馏失败：{exc}')
        print('[3/3] 记忆蒸馏      失败  ' + str(exc))

    from datetime import datetime
    started = time.monotonic()
    try:
        reply = complete(key, config,
                         [{'role': 'system', 'content': parse_prompt(datetime.now())},
                          {'role': 'user', 'content': '明天上午九点提醒我去开会'}], max_tokens=200)
        intent = extract_json(reply)
        print(f'      提醒解析      {time.monotonic() - started:.1f}s  {json.dumps(intent, ensure_ascii=False)}')
        if intent.get('intent') != 'create' or not intent.get('at'):
            failures.append('提醒解析结果不对')
    except Exception as exc:
        failures.append(f'提醒解析失败：{exc}')

print()
if failures:
    print('结果：有问题')
    for item in failures:
        print('  -', item)
    raise SystemExit(1)
print('结果：三项全通过。桌宠这条链路是通的，可以打开「聊聊」真聊了。')
