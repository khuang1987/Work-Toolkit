"""Real window movement with controlled, synthetic geometry; no external apps moved."""
from pathlib import Path
import sys
import time
import tkinter as tk
from types import SimpleNamespace
BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))
import main
from desktop_world import Rect
main.CalebPet._start_tray_icon = lambda self: None
main.CalebPet._save_profile = lambda self: None
main.MicSampler.sample = lambda self: 0
root = tk.Tk()
app = main.CalebPet(root, welcome=False)
app.paused = True
root.geometry('192x208+300+400')
root.update()
try:
    assert 'lean' in app.frames
    app._update_world = lambda now: None
    app.fullscreen = False
    app.work_area = Rect(0, 0, 1920, 1040)
    app.world = SimpleNamespace(window_rect=Rect(478, 200, 1000, 850), window_id=123)
    app.cpu_busy = False
    assert app.start_edge_action('lean')
    now = time.monotonic()
    app._update_edge_action(now + 1)
    root.update()
    assert app.state == 'lean'
    app.world.window_id = None  # Support closed/minimized/changed.
    app._update_edge_action(now + 2)
    assert app.edge_motion is None and app.state == 'idle'
    app.world.window_id = 123
    assert app.start_edge_action('lean')
    app._update_edge_action(time.monotonic() + 7)
    assert app.edge_motion is None  # Rest cannot loop forever.
    if 'climb' in app.frames:
        assert app.start_edge_action('climb')
        started = time.monotonic()
        for i in range(1, 40):
            app._update_edge_action(started + i * .09)
            root.update()
        assert root.winfo_rooty() < 350
        app.cpu_busy = True
        app._update_edge_action(started + 4)
        assert app.edge_motion is None
    print('PASS: dedicated edge-rest asset, valid support, support invalidation, finite rest; climb checked if installed')
finally:
    app.quit()
