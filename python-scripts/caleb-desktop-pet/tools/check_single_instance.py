"""单实例锁测试：第二个进程必须立刻退出，并说明宠物已经在运行。

会真的启动一次 app\\main.py（子进程），测完关掉。跑之前请先退出正在运行的宠物。
"""
from pathlib import Path
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parents[1]
PY = BASE / '.venv' / 'Scripts' / 'python.exe'
APP = BASE / 'app' / 'main.py'
ENVS = {k: v for k, v in __import__('os').environ.items()
        if not k.lower().startswith(('https_proxy', 'http_proxy')) and k != 'CODEBUDDY_MCP_CONFIG'}

first = subprocess.Popen([str(PY), str(APP)], env=ENVS,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    # 等第一只宠物把窗口摆出来
    import ctypes as c
    from ctypes import wintypes as w
    u = c.windll.user32
    deadline = time.monotonic() + 15
    found = []
    while time.monotonic() < deadline and not found:
        rows = []
        @c.WINFUNCTYPE(c.c_bool, w.HWND, w.LPARAM)
        def cb(hwnd, _l):
            t = c.create_unicode_buffer(80)
            u.GetWindowTextW(hwnd, t, 80)
            cls = c.create_unicode_buffer(80)
            u.GetClassNameW(hwnd, cls, 80)
            if t.value == 'Caleb Desktop Pet' and cls.value == 'TkTopLevel':
                rows.append(hwnd)
            return True
        u.EnumWindows(cb, 0)
        found = rows
        time.sleep(0.2)
    assert found, '第一只宠物没有起来'

    # 第二个进程：必须很快退出，并说明原因
    started = time.monotonic()
    second = subprocess.run([str(PY), str(APP)], env=ENVS, capture_output=True, text=True,
                            timeout=20)
    elapsed = time.monotonic() - started
    assert second.returncode == 0, (second.returncode, second.stderr[:200])
    assert elapsed < 10, f'第二个进程居然跑了 {elapsed:.1f}s'
    assert '已经在运行' in (second.stdout or ''), second.stdout
    print('PASS: 单实例锁生效——第二只宠物启动即退出并说明原因')
finally:
    first.terminate()
    try:
        first.wait(timeout=5)
    except subprocess.TimeoutExpired:
        first.kill()
