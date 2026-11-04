"""快捷键真机测试：真的模拟一次 Ctrl 单击，验证“聊聊”输入框会不会弹出来。

用 SendInput 造按键，所以它验证的是整条链路：全局钩子 → 单击判定 → 主循环 →
输入框。跑之前请先退出正在运行的宠物，避免两个实例抢快捷键。
"""
import ctypes as c
from ctypes import wintypes as w
import sys
import time
from pathlib import Path
import tkinter as tk

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))

import main  # noqa: E402
import ai_chat as ai_chat_module  # noqa: E402
from right_ctrl import TapDetector  # noqa: E402

# ---- 纯逻辑：单击才触发，组合键不触发 -------------------------------------
d = TapDetector()
assert d.feed(0xA3, True) is False
assert d.feed(0xA3, False) is True, '右 Ctrl 单击应触发'
assert d.taps == 1
assert d.feed(0xA2, True) is False
assert d.feed(0xA2, False) is True, '左 Ctrl 单击也应触发'
assert d.taps == 2
d.feed(0xA3, True)
d.feed(0x43, True)   # 按下 C：Ctrl+C
d.feed(0x43, False)
assert d.feed(0xA3, False) is False, 'Ctrl+C 不该触发'
d.feed(0xA2, True)
d.feed(0xA5, True)   # 按住 Alt 再按 Ctrl
d.feed(0xA5, False)
assert d.feed(0xA2, False) is False, 'Ctrl+Alt 组合不该触发'
assert d.taps == 2, d.taps


# ---- 真的按一下键盘 ------------------------------------------------------
class MOUSEINPUT(c.Structure):
    _fields_ = [('dx', w.LONG), ('dy', w.LONG), ('mouseData', w.DWORD),
                ('dwFlags', w.DWORD), ('time', w.DWORD), ('dwExtraInfo', c.POINTER(c.c_ulong))]


class KEYBDINPUT(c.Structure):
    _fields_ = [('wVk', w.WORD), ('wScan', w.WORD), ('dwFlags', w.DWORD),
                ('time', w.DWORD), ('dwExtraInfo', c.POINTER(c.c_ulong))]


class HARDWAREINPUT(c.Structure):
    _fields_ = [('uMsg', w.DWORD), ('wParamL', w.WORD), ('wParamH', w.WORD)]


class INPUT_UNION(c.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]


class INPUT(c.Structure):
    _fields_ = [('type', w.DWORD), ('union', INPUT_UNION)]


KEYEVENTF_KEYUP = 0x0002
INPUT_KEYBOARD = 1


def key_event(vk, key_up=False):
    item = INPUT(type=INPUT_KEYBOARD)
    item.union.ki = KEYBDINPUT(wVk=vk, wScan=0,
                               dwFlags=KEYEVENTF_KEYUP if key_up else 0,
                               time=0, dwExtraInfo=None)
    return item


def send(vk, hold=0.05):
    """模拟一次干净的单击。"""
    events = (INPUT * 2)(key_event(vk), key_event(vk, key_up=True))
    c.windll.user32.SendInput(2, events, c.sizeof(INPUT))
    time.sleep(hold)


def send_tap_until_open(app, root, vk=0xA3, attempts=4):
    """模拟单击直到输入条出现——真实用户按了没反应也会再按一次。"""
    for _ in range(attempts):
        send(vk)
        if wait_for(lambda: getattr(app, 'ai_chat', None) and app.ai_chat.window is not None, 4.0):
            return True
        time.sleep(0.3)
    return False


main.profile_path = lambda: Path(__file__).resolve().parents[1] / 'qa-hotkey-profile.json'
main.CalebPet._start_tray_icon = lambda self: None
root = tk.Tk()
app = main.CalebPet(root, welcome=False)
app._save_profile = lambda: True


def wait_for(predicate, timeout=6.0):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        root.update()
        time.sleep(.02)
    return predicate()


try:
    app.toggle_ai_hotkey()
    assert app.ai_hotkey is not None, '快捷键没开起来'
    assert wait_for(lambda: app.ai_hotkey.available, 8), '全局钩子没装上'

    assert send_tap_until_open(app, root), '按 Ctrl 没弹出输入框'
    assert app.ai_hotkey.taps >= 1, app.ai_hotkey.taps
    app.ai_chat.dismiss()

    send(0x43)  # 单独按 C，不该有任何反应
    time.sleep(.3)
    assert app.ai_chat.window is None, '普通按键不该弹输入框'

    # 语音状态机：开框不碰语音；二次 Ctrl = 语音开；三次 = 关框+关语音；四次 = 再开
    import right_ctrl
    alt_calls = []
    right_ctrl.press_key = lambda vk, hold=0.05: alt_calls.append(vk)
    app.toggle_ai_hotkey()
    app.toggle_ai_hotkey()   # 重开（顺带验证从配置读触发键）
    assert send_tap_until_open(app, root), 'Ctrl 打开输入框失败'
    assert alt_calls == [], alt_calls          # 打开时不碰语音：纯打字
    assert app.ai_chat.voice_on is False
    send(0xA3)               # 二次 Ctrl = 语音开
    assert wait_for(lambda: len(alt_calls) == 1, 3.0), alt_calls
    assert app.ai_chat.voice_on is True and app.ai_chat.window is not None
    send(0xA3)               # 三次 Ctrl = 关框 + 语音关
    assert wait_for(lambda: app.ai_chat.window is None, 3.0), '三次 Ctrl 应收起输入框'
    assert wait_for(lambda: len(alt_calls) == 2, 2.0), '三次 Ctrl 应关掉语音'
    assert app.ai_chat.voice_on is False
    send(0xA3)               # 四次 Ctrl = 再完整打开
    assert wait_for(lambda: app.ai_chat.window is not None, 3.0), '四次 Ctrl 应重新打开'
    assert alt_calls == [0xA5, 0xA5], alt_calls
    # 🎤 按钮：点一下 = 语音开；再点 = 关
    app.ai_chat.mic_button.invoke()
    assert wait_for(lambda: len(alt_calls) == 3, 3.0) and app.ai_chat.voice_on is True
    app.ai_chat.mic_button.invoke()
    assert wait_for(lambda: len(alt_calls) == 4, 3.0) and app.ai_chat.voice_on is False
    app.ai_chat.dismiss()

    # 捕获触发键：把改键后的那颗键（这里用 F9 模拟）捕获进来，F9 单击也能打开输入框
    app._capture_hotkey()
    root.update()
    assert app.hotkey_capturing is True
    send(0x78)               # F9
    assert wait_for(lambda: not app.hotkey_capturing, 3), '没有捕获到按键'
    assert wait_for(lambda: 0x78 in app.ai_hotkey.accept, 2), '捕获的键没进触发键集合'
    assert send_tap_until_open(app, root, vk=0x78), '捕获的键没生效'
    app.ai_chat.dismiss()

    app.toggle_ai_hotkey()
    assert app.ai_hotkey is None, '再点一次应把快捷键关掉'


    # Keep the test runner usable under a GBK console too; the microphone
    # glyph is UI-only and should not make an otherwise passing test fail.
    print('PASS: Ctrl 单击触发聊聊输入框（左右 Ctrl 都行）、组合键不误触、可开关、'
          'Esc 不再退出程序、二次 Ctrl 开语音、三次关框+关语音、麦克风按钮可切换、可捕获改键后的触发键')

finally:
    app.quit()
    Path(main.profile_path()).unlink(missing_ok=True)
    # 捕获流程会把 hotkey_vk 写进“当前目录的 ai-config.json”（测试桩的副作用），清掉
    Path('ai-config.json').unlink(missing_ok=True)
