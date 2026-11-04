"""真机测速：用当前配置里的 key/接口，逐个模型量「首字延迟」和「出字速度」。

用法：
    .venv\\Scripts\\python.exe tools\\bench_models.py                  # 只测当前配置的模型
    .venv\\Scripts\\python.exe tools\\bench_models.py --list           # 先列出接口给的模型
    .venv\\Scripts\\python.exe tools\\bench_models.py doubao-seed-2.0-mini doubao-seed-2.0-lite

每个模型默认跑 3 轮取平均，只发一条很短的问句，费用可以忽略。写任何文件都不写，
用的就是桌宠正在用的那把 key。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sys
import time
from urllib.error import HTTPError

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))

from ai_service import (KeyStore, build_payload, endpoint, list_models, load_config,  # noqa: E402
                        open_with_retry, request_headers)
from urllib.request import Request  # noqa: E402

_real_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda h, p, f=0, t=0, pr=0, fl=0: _real_getaddrinfo(h, p, socket.AF_INET, t, pr, fl)

PROMPT = '今天有点累，随便说两句'
RUNS = 3

FOLDER = Path(os.environ.get('APPDATA') or Path.home() / 'AppData' / 'Roaming') / 'CalebDesktopPet'
key = KeyStore(FOLDER / 'ai-key.bin').load()
config = load_config(FOLDER / 'ai-config.json')

args = [a for a in sys.argv[1:]]
models = [a for a in args if not a.startswith('--')]

print('endpoint :', endpoint(config))
print('key      :', f'{len(key)} 字符' if key else '缺失')
if not key:
    raise SystemExit('没有 key，先在 AI 设置里填一把。')

if '--list' in args:
    names = sorted(list_models(key, config))
    print(f'\n该接口返回 {len(names)} 个模型：')
    for name in names:
        print('  -', name)
    if not models:
        raise SystemExit(0)

if not models:
    models = [config['model']]
    print('（没指定模型，就测当前配置的这个。想比别的：把模型名当参数传进来）')
print()


def measure(model: str):
    """返回 (首字秒, 总秒, 出字数)；失败抛异常。"""
    payload = build_payload(dict(config, model=model), [{'role': 'user', 'content': PROMPT}],
                            stream=True, max_tokens=150)
    request = Request(endpoint(config), data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                      headers=request_headers(key, config), method='POST')
    started = time.monotonic()
    first = None
    chars = 0
    with open_with_retry(request, config.get('reply_timeout', 60)) as response:
        for raw in response:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data:'):
                continue
            body = line[5:].strip()
            if not body or body == '[DONE]':
                continue
            try:
                event = json.loads(body)
            except ValueError:
                continue
            for choice in (event.get('choices') or []):
                delta = choice.get('delta')
                text = delta.get('content') if isinstance(delta, dict) else None
                if text:
                    if first is None:
                        first = time.monotonic() - started
                    chars += len(text)
    return first, time.monotonic() - started, chars


print(f'{"模型":<26}{"首字":>8}{"总时长":>10}{"出字":>8}{"字/秒":>10}')
print('-' * 64)
for model in models:
    rows = []
    error = ''
    for _ in range(RUNS):
        try:
            rows.append(measure(model))
        except HTTPError as exc:
            error = f'HTTP {exc.code} ' + exc.read(200).decode('utf-8', 'replace').strip()[:80]
            break
        except Exception as exc:
            error = f'{type(exc).__name__}: {str(exc)[:70]}'
            break
    rows = [row for row in rows if row[0] is not None and row[2] > 0]
    if error and not rows:
        print(f'{model:<26}{error}')
        continue
    if not rows:
        print(f'{model:<26}没有拿到任何内容（模型可能只回了空回复）')
        continue
    first = sum(r[0] for r in rows) / len(rows)
    total = sum(r[1] for r in rows) / len(rows)
    chars = sum(r[2] for r in rows) / len(rows)
    speed = chars / total if total else 0
    print(f'{model:<26}{first:>7.1f}s{total:>9.1f}s{chars:>8.0f}{speed:>9.0f}'
          + (f'   （{len(rows)}/{RUNS} 次成功）' if len(rows) < RUNS else ''))
print()
print('首字 = 从发请求到屏幕上出现第一个字；字/秒 = 出字速度。这两个才是“快不快”的真实体感。')
