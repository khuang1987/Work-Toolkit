"""First-run welcome and nickname persistence using an isolated temp profile."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import json
import sys
import tkinter as tk
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import main
main.CalebPet._start_tray_icon = lambda self: None
main.MicSampler.sample = lambda self: 0

with TemporaryDirectory(prefix='caleb-nickname-test-') as folder, patch('main.profile_path', return_value=Path(folder) / 'profile.json'):
    root = tk.Tk()
    app = main.CalebPet(root, welcome=False)
    app.paused = True
    root.unbind('<Escape>')
    root.update()
    try:
        app.fullscreen = False
        app._first_run_greeting()
        assert app.greeting_seen and app.bubble
        root.update()
        canvas = app.bubble.winfo_children()[0]
        assert any('我可以怎么称呼你' in canvas.itemcget(i, 'text') for i in canvas.find_all() if canvas.type(i) == 'text')
        with patch('main.simpledialog.askstring', return_value='  小星  '):
            app.edit_nickname()
        assert app.nickname == '小星'
        assert app._addressed('喝口水吧。') == '小星，喝口水吧。'
        assert json.loads(main.profile_path().read_text(encoding='utf-8'))['nickname'] == '小星'
        with patch('main.simpledialog.askstring', return_value='星星'):
            app.edit_nickname()
        assert app.nickname == '星星'
        with patch('main.simpledialog.askstring', return_value=None):
            app.edit_nickname()
        assert app.nickname == '星星'
        with patch('main.simpledialog.askstring', return_value=' '):
            app.edit_nickname()
        assert app.nickname == '星星'
        app._record_interaction()
        assert json.loads(main.profile_path().read_text(encoding='utf-8'))['nickname'] == '星星'
    finally:
        app.quit()
    root = tk.Tk()
    app = main.CalebPet(root)
    app.paused = True
    try:
        assert app.nickname == '星星' and app.greeting_seen
        assert app.greeting_timer_id is None
        app._first_run_greeting()
        assert app.bubble is None
        with patch('main.simpledialog.askstring', return_value='新称呼'), patch.object(app, '_save_profile', return_value=False):
            app.edit_nickname()
        assert json.loads(main.profile_path().read_text(encoding='utf-8'))['nickname'] == '星星'
        print('PASS: greeting, nickname save, restart recall, config rename, cancel/empty input, interaction preserves name, save failure')
    finally:
        app.quit()
