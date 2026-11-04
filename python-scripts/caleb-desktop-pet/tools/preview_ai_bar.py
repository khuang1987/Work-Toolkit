"""Open the "聊聊" bar and grab a real screenshot of it for visual review."""
import sys
import tempfile
import time
import tkinter as tk
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))
import main  # noqa: E402
from main import CalebPet  # noqa: E402
from PIL import ImageGrab  # noqa: E402

sandbox = Path(tempfile.mkdtemp())
main.profile_path = lambda: sandbox / 'profile.json'
main.CalebPet._start_tray_icon = lambda self: None
root = tk.Tk()
app = CalebPet(root, welcome=False)
app._save_profile = lambda: True
app.root.geometry('192x208+120+120')
try:
    app.open_ai_chat()
    chat = app.ai_chat
    # A stand-in key so the reply path is exercised without touching the network.
    import ai_service

    ai_service.urlopen = lambda request, timeout: None
    chat.entry.insert(0, '今天有点累')
    root.update()
    for _ in range(30):
        root.update()
        time.sleep(.02)
    bar = chat.window
    x, y = bar.winfo_rootx(), bar.winfo_rooty()
    w, h = bar.winfo_width(), bar.winfo_height()
    shot = ImageGrab.grab()
    shot.crop((max(0, x - 40), max(0, y - 40), x + w + 40, y + h + 40)).save(BASE / 'qa-ai-bar.png')
    shot.save(BASE / 'qa-ai-screen.png')
    print('bar geometry', w, h, 'at', x, y, '-> qa-ai-bar.png', shot.size)
    print('bar mapped', bar.winfo_ismapped(), 'viewable', bar.winfo_viewable(), 'state', bar.state())
finally:
    app.quit()
