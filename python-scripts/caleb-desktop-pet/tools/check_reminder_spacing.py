"""Virtual-clock reminder priority, countdown and cross-kind separation."""
from pathlib import Path
import sys
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from main import CalebPet

app = CalebPet.__new__(CalebPet)
app.nickname = ''
app.next_water_at = app.next_break_at = 1000
app.last_reminder_kind = None
app.last_reminder_at = 0
app.quiet_until = 0
app.focus_until = None
app.last_input_event = 1000
app.bubble = None
events = []
app.demo = lambda *a, **k: None
app._open_bubble = lambda title, *a: events.append(title)
app.show_message = lambda *a: None
with patch('main.time.monotonic', return_value=1000):
    app._update_reminders()
assert app.last_reminder_kind == 'break' and len(events) == 1
assert app._reminder_countdown('water', 1000) == '20:00'
with patch('main.time.monotonic', return_value=2199):
    app.last_input_event = 2199
    app._update_reminders()
    app.show_reminder('water', force=True)
assert len(events) == 1
with patch('main.time.monotonic', return_value=2200):
    app.last_input_event = 2200
    app._update_reminders()
assert app.last_reminder_kind == 'water' and len(events) == 2
app.next_break_at = 2250
assert app._reminder_due('break') == 3400
assert app._reminder_countdown('break', 2200) == '20:00'
app.quiet_until = 5000
assert app._reminder_due('break') == 5000
print('PASS: one reminder at a time, oldest due first, 20-minute cross-kind gap including forced buttons, effective countdown and quiet deferral')
