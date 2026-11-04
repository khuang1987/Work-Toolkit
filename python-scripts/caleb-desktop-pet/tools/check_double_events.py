"""Exercise the real Tk event bindings, not just calling double-click handlers."""
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
root.unbind('<Escape>')
app.paused = True
root.geometry('192x208+500+400')
root.update()
calls = []
original_action, original_chat = app.random_action, app.show_chat
def action():
    calls.append('action')
    original_action()
def chat():
    calls.append('dialogue')
    original_chat()
app.random_action, app.show_chat = action, chat
original_touch = app.pet_touch
def touch(*args, **kwargs):
    calls.append('touch')
    original_touch(*args, **kwargs)
app.pet_touch = touch
def click(timestamp, x=90):
    app.label.event_generate('<ButtonPress-1>', x=x, y=85, time=timestamp)
    root.update()
    app.label.event_generate('<ButtonRelease-1>', x=x, y=85, time=timestamp + 20)
    root.update()
def flush():
    root.after(max(500, int(main.ctypes.windll.user32.GetDoubleClickTime())) + 100, root.quit)
    root.mainloop()
try:
    app.last_double_response = 'dialogue'
    click(1000)
    assert app.click_timer_id and not calls
    click(1150, 92)
    assert calls == ['touch'], calls
    assert app.drag_origin is None and app.click_timer_id is None
    selected = app.state
    app._update_world = lambda now: None
    app.fullscreen = True
    app._update_automatic_state()
    assert app.state == selected  # Manual response cannot be replaced by idle.
    flush()
    assert calls == ['touch']
    click(3000)
    click(3150)
    assert calls == ['touch', 'touch'], calls
    assert app.bubble is not None
    flush()
    assert 'action' not in calls and 'dialogue' not in calls
    click(5000)
    flush()
    assert calls == ['touch', 'touch', 'action']
    print('PASS: actual Tk events, double touch only, single random action, slight pointer jitter and manual-state priority')
finally:
    app.quit()
