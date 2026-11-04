"""Opt-in frozen-build self-test. Never reads/writes the user's profile."""
import json
from pathlib import Path
import tkinter as tk
import traceback


def run(app_class, output):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    app_class._load_profile = lambda self: {}
    app_class._save_profile = lambda self: True
    root = tk.Tk()
    app = None
    report = {'ok': False}
    try:
        app = app_class(root, welcome=False)
        app.paused = True
        root.unbind('<Escape>')
        root.update()
        from dialogue import GROUPS
        from scenes import SCENES
        assert sum(map(len, GROUPS.values())) == 100
        assert sum(len(lines) for _, lines in SCENES.values()) == 100
        assert 'lean' in app.frames and 'climb' not in app.frames
        for frames in app.frames.values():
            for frame in frames:
                app.alpha_window.render(frame)
                root.update_idletasks()
        for frame in app.look_frames:
            app.alpha_window.render(frame)
        app.nickname = '测试称呼'
        app.show_reminder('water', force=True)
        root.update()
        canvas = app.bubble.winfo_children()[0]
        texts = [canvas.itemcget(i, 'text') for i in canvas.find_all() if canvas.type(i) == 'text']
        assert any('测试称呼' in text for text in texts)
        app._close_bubble()
        app.show_configuration()
        root.update()
        assert app.menu_window.winfo_ismapped()
        app._close_action_panel()
        app.manual_until = 0
        app.state, app.frame = 'idle', 0
        app._render()
        root.update()
        root.after(1800, root.quit)
        root.mainloop()
        from PIL import ImageGrab
        x, y = root.winfo_rootx(), root.winfo_rooty()
        ImageGrab.grab(bbox=(x, y, x + 192, y + 208), all_screens=True).save(output.with_suffix('.png'))
        report = {'ok': True, 'animation_frames': sum(map(len, app.frames.values())),
                  'look_frames': len(app.look_frames), 'dialogue_lines': 200,
                  'native_alpha': True, 'nickname_bubble': True, 'configuration': True,
                  'tray_created': app.tray_icon is not None,
                  'tray_visible': bool(app.tray_icon and app.tray_icon.visible),
                  'user_profile_touched': False}
    except Exception:
        report['error'] = traceback.format_exc()
    finally:
        if app:
            app.quit()
        else:
            root.destroy()
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if report['ok'] else 1
