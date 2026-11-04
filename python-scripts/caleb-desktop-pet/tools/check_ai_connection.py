"""Real end-to-end probe: the saved key + ai-config.json against the live endpoint.

Never prints the key or the request body. Run this whenever "聊聊" answers with a
network or credential error, so the cause is one line instead of a guess.
"""
import os
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))

from ai_service import KeyStore, endpoint, load_config, probe  # noqa: E402

APP_DATA = os.environ.get('APPDATA') or str(Path.home() / 'AppData' / 'Roaming')
FOLDER = Path(APP_DATA) / 'CalebDesktopPet'
KEY_FILE = FOLDER / 'ai-key.bin'
LEGACY_KEY_FILE = FOLDER / 'deepseek-key.bin'
CONFIG_FILE = FOLDER / 'ai-config.json'

key = KeyStore(KEY_FILE).load()
config = load_config(CONFIG_FILE)
print('config   :', CONFIG_FILE, '(存在)' if CONFIG_FILE.exists() else '(缺失，用默认值)')
print('key file :', KEY_FILE, '(存在)' if KEY_FILE.exists() else '(缺失)')
if LEGACY_KEY_FILE.exists():
    print('          注：旧的 deepseek-key.bin 还在，但程序已不再读取它')
print('endpoint :', endpoint(config))
print('model    :', config['model'], '· thinking =', config['thinking'])
print('key      :', f'已保存，{len(key)} 字符' if key else '缺失')
if not key:
    print('RESULT   : 没有可用密钥。托盘 → 配置 → AI 设置 里填写。')
    raise SystemExit(1)

problem = probe(key, config)
if problem:
    print('RESULT   : 失败 —', problem)
    raise SystemExit(1)
print('RESULT   : 成功，网络、密钥与模型都可用。')
