"""Controlled Win32 button-state edges against real Tk popup geometry."""
from pathlib import Path
from unittest.mock import patch
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
state = {1: 0, 2: 0, 4: 0}
def pump():
    root.after(80, root.quit)
    root.mainloop()
try:
    with patch.object(main.ctypes.windll.user32, 'GetAsyncKeyState', side_effect=lambda key: state[key]), patch('main.cursor_position', return_value=(500, 500)) as cursor:
        app._show_action_panel(500, 500)
        root.update()
        window = app.menu_window
        cursor.return_value = (window.winfo_rootx() + 40, window.winfo_rooty() + 40)
        state[1] = 0x8000
        pump()
        assert app.menu_window is window  # A button inside is left to Tk.
        state[1] = 0
        pump()
        cursor.return_value = (-10000, -10000)
        state[1] = 0x8000
        pump()
        assert app.menu_window is None
        assert app.menu_dismiss_id is None and app.menu_timer_id is None
    print('PASS: outside click dismisses menu; inside clicks preserved; all popup timers cancelled')
finally:
    app.quit()
