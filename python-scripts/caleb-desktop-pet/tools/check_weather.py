"""Offline API contract tests; no real city or user data is sent."""
from pathlib import Path
import sys
from unittest.mock import patch
BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))
from weather import Weather

geo = {'results': [{'name': 'Test city', 'admin1': 'Test region', 'country': 'Test country', 'latitude': 1, 'longitude': 2}]}
current = {'current': {'temperature_2m': 18.2, 'weather_code': 61, 'time': '2026-09-15T06:30'}}
with patch('weather.get_json', side_effect=[geo, current]):
    service = Weather()
    assert service.request('test fixture')
    city, text, error = service.results.get(timeout=2)
    assert error is None and '18.2' in text and 'Open-Meteo' in text and 'Test country' in text
with patch('weather.get_json', return_value={'results': []}):
    service = Weather()
    service.request('test fixture')
    _, text, error = service.results.get(timeout=2)
    assert text is None and error
with patch('weather.get_json', side_effect=TimeoutError('offline fixture')):
    service = Weather()
    service.request('test fixture')
    _, text, error = service.results.get(timeout=2)
    assert text is None and error
print('PASS: weather result formatting, attribution, missing city and timeout; no network used')
