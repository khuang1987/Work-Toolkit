from pathlib import Path
import sys
import tkinter as tk
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import main
main.CalebPet._start_tray_icon = lambda self: None
main.CalebPet._save_profile = lambda self: None
main.MicSampler.sample = lambda self: 0
root = tk.Tk()
app = main.CalebPet(root, welcome=False)
app.paused = True
root.unbind('<Escape>')
def buttons(widget):
    result = []
    for child in widget.winfo_children():
        if isinstance(child, tk.Button):
            result.append(child)
        result.extend(buttons(child))
    return result
try:
    app._show_action_panel(500, 500)
    root.update()
    labels = [b.cget('text') for b in buttons(app.menu_window)]
    assert labels == ['随机动作', '专注 25 分钟', '猜拳', '小剧场', '聊聊', '隐藏夏以昼'], labels
    hide = next(b for b in buttons(app.menu_window) if b.cget('text') == '隐藏夏以昼')
    hide.invoke()
    root.update()
    assert app.pet_hidden is True and root.state() == 'withdrawn'
    app.toggle_pet_visibility()
    root.update()
    assert app.pet_hidden is False and root.state() == 'normal'
    app._show_action_panel(500, 500)
    root.update()
    timer = app.menu_timer_id
    app.show_configuration()
    root.update()
    assert timer not in root.tk.call('after', 'info')
    labels = [b.cget('text') for b in buttons(app.menu_window)]
    assert '返回互动' in labels and any('巡游' in l for l in labels)
    next(b for b in buttons(app.menu_window) if b.cget('text') == '返回互动').invoke()
    root.update()
    assert len(buttons(app.menu_window)) == 6
    app._close_action_panel()
    assert app.menu_timer_id is None
    app.show_chat = lambda *a: (_ for _ in ()).throw(AssertionError('ambient must not launch manual chat'))
    app.state, app.next_idle_chat_at = 'idle', 0
    app._update_idle_social(main.time.monotonic())
    assert app.bubble is not None
    print('PASS: compact 6-action menu with hide/show, config/back navigation, countdown cleanup, independent ambient dialogue')
finally:
    app.quit()
