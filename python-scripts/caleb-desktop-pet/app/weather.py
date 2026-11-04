"""Opt-in, manually selected city. No IP geolocation; no worker Tk calls."""
import json
import queue
import threading
from urllib.parse import urlencode
from urllib.request import urlopen


def get_json(url):
    with urlopen(url, timeout=8) as response:
        return json.load(response)


class Weather:
    def __init__(self):
        self.results = queue.Queue()
        self.busy = False

    def request(self, city):
        if self.busy:
            return False
        self.busy = True
        def worker():
            try:
                data = get_json('https://geocoding-api.open-meteo.com/v1/search?' + urlencode({'name': city, 'count': 1, 'language': 'zh'}))
                places = data.get('results', [])
                if not places:
                    raise ValueError('没有找到城市，请尝试城市拼音或英文名。')
                place = places[0]
                data = get_json('https://api.open-meteo.com/v1/forecast?' + urlencode({
                    'latitude': place['latitude'], 'longitude': place['longitude'],
                    'current': 'temperature_2m,weather_code', 'timezone': 'auto'}))
                current = data['current']
                code = int(current['weather_code'])
                message = ('天气晴朗，有空看看窗外。' if code == 0 else
                           '天空有云，出门前看看天气。' if code <= 3 else
                           '可能有雾，出门留意能见度。' if code <= 48 else
                           '有降水天气，出门前记得看看伞。')
                label = ' / '.join(str(place[k]) for k in ('name', 'admin1', 'country') if place.get(k))
                self.results.put((city, f"{label}\n{current['temperature_2m']}°C · {current['time']}\n{message}\n数据：Open-Meteo", None))
            except Exception as exc:
                self.results.put((city, None, str(exc)))
            finally:
                self.busy = False
        threading.Thread(target=worker, daemon=True, name='caleb-weather').start()
        return True
