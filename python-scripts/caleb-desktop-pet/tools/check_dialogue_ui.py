"""Capture only test-owned windows and validate all 200 Chinese dialogue layouts."""
from pathlib import Path
import sys
import tkinter as tk
from PIL import ImageGrab

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))
import main
from dialogue import GROUPS
from scenes import SCENES

main.CalebPet._start_tray_icon = lambda self: None
main.CalebPet._save_profile = lambda self: None
main.MicSampler.sample = lambda self: 0
root = tk.Tk()
app = main.CalebPet(root, welcome=False)
app.paused = True
root.geometry('192x208+500+500')
root.update()
try:
    samples = [('夏以昼 · 小声说', line) for lines in GROUPS.values() for line in lines]
    samples += [(name + ' · 原创 20/20', line) for name, (pose, lines) in SCENES.items() for line in lines]
    for title, line in samples:
        app._open_bubble(title, line, [('继续听', app._close_bubble), ('换个场景', app._close_bubble), ('下次再听', app._close_bubble)])
        root.update()
        canvas = app.bubble.winfo_children()[0]
        width, height = canvas.winfo_width(), canvas.winfo_height()
        for item in canvas.find_all():
            if canvas.type(item) == 'text':
                left, top, right, bottom = canvas.bbox(item)
                assert 5 <= left < right <= width - 5, (title, line, (left, right), width)
                assert 5 <= top < bottom <= height - 5
    root.update()
    root.after(350, root.quit)
    root.mainloop()
    bubble = app.bubble
    x, y = bubble.winfo_rootx(), bubble.winfo_rooty()
    ImageGrab.grab(bbox=(x, y, x + bubble.winfo_width(), y + bubble.winfo_height())).save(BASE / 'qa-restored' / 'dialogue-runtime.png')
    app._close_bubble()
    app._show_action_panel(500, 500)
    root.update()
    root.after(350, root.quit)
    root.mainloop()
    panel = app.menu_window
    x, y = panel.winfo_rootx(), panel.winfo_rooty()
    print('panel bounds', x, y, panel.winfo_width(), panel.winfo_height(), 'screen', root.winfo_screenwidth(), root.winfo_screenheight())
    ImageGrab.grab(bbox=(x, y, x + panel.winfo_width(), y + panel.winfo_height())).save(BASE / 'qa-restored' / 'menu-runtime.png')
    print('PASS: 200 dialogue layouts; text within bounds; real bubble/menu screenshots saved')
finally:
    app.quit()
