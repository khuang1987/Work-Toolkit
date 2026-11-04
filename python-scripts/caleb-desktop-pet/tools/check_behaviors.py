"""Deterministic scheduler tests plus real Tk/Win32 smoke. No personal profile writes."""
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import tkinter as tk
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))
import main
from dialogue import GROUPS, DialogueBook
from desktop_world import Rect
from scenes import SCENES

assert sum(map(len, GROUPS.values())) == 100
assert len({s for group in GROUPS.values() for s in group}) == 100
assert sum(len(lines) for pose, lines in SCENES.values()) == 100
assert len({s for pose, lines in SCENES.values() for s in lines}) == 100
book = DialogueBook()
assert book.choose('close', 0) in GROUPS['idle']
assert book.choose('close', 40) in GROUPS['warm']
assert book.choose('close', 80) in GROUPS['close']
assert len({book.choose('story', 0) for _ in range(10)}) == 10
assert Rect(-1920, 0, 0, 1040).clamp(100, 2000) == (-192, 832)

main.CalebPet._start_tray_icon = lambda self: None
main.CalebPet._save_profile = lambda self: None
main.MicSampler.sample = lambda self: 0
root = tk.Tk()
app = main.CalebPet(root, welcome=False)
# Esc 现在只收气泡/菜单，不再退出程序，所以这里的 Esc 测试可以正常分发。
app.paused = True
root.geometry('192x208+300+300')
root.update()
try:
    now = time.monotonic()
    app.state = 'idle'
    app.manual_until = 0
    app.next_walk_at = now + 999
    app.next_pose_at = now + 999
    app.next_gaze_at = now - 1
    app._update_calm_motion(now)
    assert now + 4 <= app.gaze_until <= now + 8
    assert now + 35 <= app.next_gaze_at <= now + 65
    app._update_calm_motion(now + 9)
    assert app.gaze_until < now + 9

    app.work_area = Rect(0, 0, 1920, 1040)
    app.walk_target = (420, 300, False)
    app.walk_last_tick = now
    for i in range(1, 50):
        app._update_calm_motion(now + i * .09)
        root.update()
    assert root.winfo_rootx() >= 416, root.winfo_rootx()
    assert app.walk_target is None
    assert app.state == 'idle'

    app.window_edge = None
    app.walk_target = (600, 300, True)
    app._update_calm_motion(now + 5)
    assert app.walk_target is None

    # Expiring any manual state returns to idle; typing cannot start running.
    app._update_world = lambda now: None
    app.fullscreen = False
    app.next_idle_chat_at = now + 9999
    app.next_walk_at = now + 9999
    app.next_pose_at = now + 9999
    app.next_gaze_at = now + 9999
    for state in main.FRAME_MS:
        app.demo(state, seconds=-1)
        app._update_automatic_state()
        assert app.state == 'idle', (state, app.state)

    # A new popup cancels its predecessor; click awards once per popup.
    app.show_reminder('break', force=True)
    old_timer = app.bubble_timeout_id
    app.show_message('计时测试', '这条气泡应在七秒后消失。')
    timers = root.tk.call('after', 'info')
    assert old_timer not in timers
    before = app.total_interactions
    app._bubble_click(SimpleNamespace(x=25, y=25))
    app._bubble_click(SimpleNamespace(x=25, y=25))
    assert app.total_interactions == before + 1
    # 鼠标停在气泡上时不倒计时，移开才重新计时
    app._bubble_hover_in()
    assert app.bubble_timeout_id is None
    app._bubble_hover_out()
    assert app.bubble_timeout_id is not None
    assert app.bubble_lifetime_ms == main.BUBBLE_MS == 7000, app.bubble_lifetime_ms
    root.after(7300, root.quit)
    root.mainloop()
    assert app.bubble is None
    assert app.bubble_timeout_id is None

    # Esc 只收气泡，不再退出程序（原来会把宠物一起关掉）。
    # 合成键（event_generate）的派发在 Tk 里不稳定，所以直接调处理器 + 断言绑定存在。
    assert root.bind('<Escape>'), 'Esc 应该绑定在主窗口上'
    app.show_message('Esc 测试', 'Esc 应该只关掉这个气泡。')
    root.update()
    bubble_under_test = app.bubble
    assert bubble_under_test is not None
    app._escape()
    root.update()
    assert not bubble_under_test.winfo_exists() or app.bubble is not bubble_under_test, \
        'Esc 应该关掉那个气泡'
    app._escape()
    assert root.winfo_exists(), 'Esc 不该退出程序'
    app.show_message('占位', '继续'); root.update(); app._close_bubble()

    # AI 回答气泡活得久一点（15s），而且点空白处就能收起；普通气泡不吃这一套。
    app.show_ai_reply('AI 气泡点击测试')
    root.update()
    assert app.ai_bubble is True
    assert app.bubble_lifetime_ms == main.AI_BUBBLE_MS == 15000, app.bubble_lifetime_ms
    app._bubble_click(SimpleNamespace(x=4, y=4))
    assert app.bubble is None, '点 AI 气泡空白处应收起'
    app.show_message('普通气泡', '点空白处不该收起这条。')
    root.update()
    app._bubble_click(SimpleNamespace(x=4, y=4))
    assert app.bubble is not None, '普通气泡点空白处不该收起'
    app._close_bubble()

    # Build real action panel (regression: Canvas.lower() raised TclError).
    app._show_action_panel(500, 400)
    root.update()
    assert app.menu_window.winfo_ismapped()
    app._close_action_panel()
    app.start_scene()
    assert app.scene_index == 1
    app.next_scene_line()
    assert app.scene_index == 2
    app._close_bubble()
    app.show_reminder('break', force=True)
    app._answer_reminder('ack')
    root.update()
    canvas = app.bubble.winfo_children()[0]
    texts = [canvas.itemcget(i, 'text') for i in canvas.find_all() if canvas.type(i) == 'text']
    assert any('去吧' in t for t in texts)
    print('PASS: 200 unique original lines, intimacy gates, no-repeat, bounded gaze, actual movement, edge invalidation, state expiry, popup replacement, one click reward, real 7s expiry + hover pause + Esc keeps pet alive + AI bubble 15s/click, action panel, scene progression, break response')
finally:
    app.quit()
