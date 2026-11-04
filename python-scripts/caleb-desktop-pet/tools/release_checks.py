from pathlib import Path
import json
import subprocess
import sys
BASE = Path(__file__).resolve().parents[1]
VERSION = '1.8.1'
tests = ['check_idle_timing.py', 'check_weather.py', 'check_reminder_spacing.py', 'check_nickname.py',
         'check_double_events.py', 'check_menu_dismiss.py', 'check_compact_menu.py', 'check_edges.py',
         'check_behaviors.py', 'check_ai.py', 'check_clicks.py', 'check_ai_live.py',
         'check_hotkey.py', 'check_single_instance.py']
results = []
for test in tests:
    run = subprocess.run([sys.executable, str(BASE / 'tools' / test)], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    results.append({'test': test, 'passed': run.returncode == 0, 'output': run.stdout + run.stderr})
    print(test, 'PASS' if run.returncode == 0 else 'FAIL', flush=True)
target = BASE / f'qa-release-{VERSION}'
target.mkdir(exist_ok=True)
(target / 'source-tests.json').write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding='utf-8')
raise SystemExit(0 if all(item['passed'] for item in results) else 1)
