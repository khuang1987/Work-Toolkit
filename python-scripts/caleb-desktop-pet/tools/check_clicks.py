"""Real Tk timers, controlled gestures and mocked tray integration."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import sys
import tkinter as tk
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import main
start_tray = main.CalebPet._start_tray_icon
main.CalebPet._start_tray_icon = lambda self: None
main.CalebPet._save_profile = lambda self: None
main.MicSampler.sample = lambda self: 0
root = tk.Tk()
app = main.CalebPet(root, welcome=False)
app.paused = True
root.unbind('<Escape>')
root.update()
calls = []
app.pet_touch = lambda *a, **k: calls.append('touch')
app.random_action = lambda: calls.append('random')
app.last_double_response = 'dialogue'
event = SimpleNamespace(x_root=500, y_root=400)
def flush():
    root.after(max(500, int(main.ctypes.windll.user32.GetDoubleClickTime())) + 100, root.quit)
    root.mainloop()
try:
    app._drag_start(event)
    app._drag_end(event)
    assert calls == []
    flush()
    assert calls == ['random']
    calls.clear()
    app._drag_start(event)
    app._drag_end(event)
    app._double_click(event)
    app._drag_end(event)
    flush()
    assert calls == ['touch'], calls
    calls.clear()
    app._drag_start(event)
    app._drag_move(SimpleNamespace(x_root=520, y_root=400))
    app._drag_move(event)
    app._drag_end(event)
    flush()
    assert calls == []
    fake_tray = MagicMock()
    fake_tray.MenuItem.side_effect = lambda label, cb: (label, cb)
    fake_tray.Menu.side_effect = lambda *items: items
    with patch.object(main, 'pystray', fake_tray), patch.object(main.threading, 'Thread'):
        start_tray(app)
        menu = fake_tray.Icon.call_args.args[3]
        labels = [label for label, _ in menu]
        assert len(menu) == 5, labels
        assert labels[1:] == ['配置…', '暂停 / 继续互动', '安静模式 1 小时', '退出'], labels
        assert not any('演示' in str(label) for label in labels), labels
        # The first entry is a live 显示/隐藏 switch, not a fixed "显示夏以昼".
        first = labels[0]
        assert callable(first), first
        assert first(None) == '隐藏夏以昼'
        config = next(callback for label, callback in menu if label == '配置…')
        config(None, None)
        root.update()
        assert app.menu_window and app.menu_window.winfo_ismapped()
    app._close_action_panel()

    # Tray toggle hides a visible pet and brings a hidden one back.
    assert app.pet_hidden is False
    app.toggle_pet_visibility()
    root.update()
    assert app.pet_hidden is True and root.state() == 'withdrawn'
    assert first(None) == '显示夏以昼'
    app.toggle_pet_visibility()
    root.update()
    assert app.pet_hidden is False and root.state() == 'normal'
    assert first(None) == '隐藏夏以昼'
    app.hide_temporarily()
    root.update()
    assert app.pet_hidden is True
    app.show_pet()
    root.update()
    assert app.pet_hidden is False
    app._drag_start(event)
    app._drag_end(event)
    app._cancel_single_click()
    assert app.click_timer_id is None
    print("PASS: single random action, double touch only, drag out-and-back ignored, lean tray menu with live show/hide toggle, tray configuration callback, timer cancellation")
finally:
    app.quit()
