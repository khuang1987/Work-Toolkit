"""Explicit-send-only DeepSeek client; request data and keys are never logged.

Endpoint and model come from ai-config.json so a different gateway or model can
be swapped without touching code. The default target is DeepSeek's own API:
base_url https://api.deepseek.com, model name ``deepseek-flash``, which the
official docs map to the DeepSeek-V4.1-Flash model (the legacy alias
``deepseek-v4-flash`` is served by the same weights).
"""
import ctypes as c
from ctypes import wintypes as w
import json
import queue
import ssl
from pathlib import Path
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


DEFAULT_CONFIG = {
    "base_url": "https://api.deepseek.com",
    "path": "/chat/completions",
    "model": "deepseek-flash",
    "max_tokens": 480,
    "temperature": 0.7,
    "request_timeout": 20,
    "reply_timeout": 60,
    "thinking": "disabled",
    "extra_headers": {},
    "history_days": 30,
    "distill_every": 8,
    "reminders": True,
    "voice_alt": True,
    "hotkey_vk": 0,
    "_readme": "base_url/path 指向兼容 OpenAI 的接口；model 用 deepseek-flash 即 V4.1 Flash。"
               "max_tokens/temperature 控制回复长度与风格；request_timeout 是首包等待秒数，"
               "reply_timeout 是整段回复的上限秒数；thinking 设为 enabled 会先思考再回答（更慢更贵）。"
               "extra_headers 用于个别服务商要求的额外请求头，例如 "
               '{"anthropic-version": "2023-06-01"}。history_days 是原始聊天记录的保留天数'
               "（长期记忆不随它过期）；distill_every 是每多少轮问答整理一次长期记忆；"
               "reminders 为 false 时关闭“让 AI 记提醒”。voice_alt 为 false 时，"
               "打开聊天输入框后不再自动按一次 Alt（唤起微信语音转文字）；"
               "hotkey_vk 是额外的触发键键码（0 表示只用左右 Ctrl），"
               "在配置面板里点“添加触发键”会自动写入。",
}


USER_AGENT = "caleb-desktop-pet/1.8.1"
TRANSIENT_ATTEMPTS = 2


def expects_retry(exc: Exception) -> bool:
    """Transport-level hiccups are worth another try; HTTP statuses are not.

    This network (corporate proxy in front of everything) resets long-lived
    connections now and then, so a plain retry turns a visible failure into a
    slightly slower answer.
    """
    if isinstance(exc, HTTPError):
        return False
    return isinstance(exc, (ssl.SSLError, URLError, OSError, TimeoutError))


def open_with_retry(request: Request, timeout: float, attempts: int = 3):
    """urlopen, retrying transport failures. HTTP errors pass straight through."""
    last = None
    for index in range(attempts):
        try:
            return urlopen(request, timeout=timeout)
        except HTTPError:
            raise
        except Exception as exc:
            if not expects_retry(exc):
                raise
            last = exc
            if index < attempts - 1:
                time.sleep(0.7 * (index + 1))
    raise last


def build_payload(config: dict, messages: list, stream: bool, max_tokens: int | None = None,
                  temperature: float | None = None) -> dict:
    """Shared request body. ``thinking`` is only sent when configured, because
    not every OpenAI-compatible gateway tolerates unknown fields."""
    payload = {
        "model": config["model"],
        "messages": messages,
        "stream": bool(stream),
        "max_tokens": int(max_tokens or config["max_tokens"]),
        "temperature": float(config["temperature"] if temperature is None else temperature),
    }
    thinking = config.get("thinking")
    if thinking:
        payload["thinking"] = {"type": thinking}
    return payload


def request_headers(key: str, config: dict) -> dict:
    headers = {"Content-Type": "application/json",
               "Authorization": "Bearer " + key,
               # Cloudflare-protected gateways (opencode zen is one) answer 403
               # "Error 1010" to clients that send no User-Agent at all.
               "User-Agent": USER_AGENT,
               "Accept": "application/json"}
    extra = config.get("extra_headers")
    if isinstance(extra, dict):
        headers.update({str(name): str(value) for name, value in extra.items()})
    return headers


def load_config(path) -> dict:
    """Read ai-config.json; missing or invalid entries fall back to defaults."""
    config = dict(DEFAULT_CONFIG)
    try:
        stored = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return config
    if isinstance(stored, dict):
        for key in DEFAULT_CONFIG:
            if key in stored and key != "_readme":
                config[key] = stored[key]
    return config


def save_config(path, config: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {key: config[key] for key in DEFAULT_CONFIG if key in config}
    # The help text always comes from this file, never from a stale copy on disk.
    payload["_readme"] = DEFAULT_CONFIG["_readme"]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def endpoint(config: dict) -> str:
    return config["base_url"].rstrip("/") + "/" + str(config["path"]).lstrip("/")


class Blob(c.Structure):
    _fields_ = [('size', w.DWORD), ('data', c.POINTER(c.c_ubyte))]


def protect(data, decrypt=False):
    buffer = c.create_string_buffer(data)
    source = Blob(len(data), c.cast(buffer, c.POINTER(c.c_ubyte)))
    target = Blob()
    function = c.windll.crypt32.CryptUnprotectData if decrypt else c.windll.crypt32.CryptProtectData
    function.argtypes = [c.POINTER(Blob), c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, w.DWORD, c.POINTER(Blob)]
    if not function(c.byref(source), None, None, None, None, 1, c.byref(target)):
        raise OSError('Windows credential protection unavailable')
    try:
        return c.string_at(target.data, target.size)
    finally:
        c.windll.kernel32.LocalFree.argtypes = [c.c_void_p]
        c.windll.kernel32.LocalFree(c.cast(target.data, c.c_void_p))


class KeyStore:
    def __init__(self, path):
        self.path = path

    def load(self):
        try:
            return protect(self.path.read_bytes(), decrypt=True).decode('utf-8')
        except (OSError, UnicodeError):
            return ''

    def save(self, key):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        encrypted = protect(key.encode('utf-8'))
        temporary = self.path.with_suffix('.tmp')
        temporary.write_bytes(encrypted)
        temporary.replace(self.path)


def provider_message(exc: HTTPError) -> str:
    """The provider's own one-line explanation, when it sends one."""
    try:
        data = json.loads(exc.read(4000).decode("utf-8", "replace"))
    except Exception:
        return ""
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            text = error.get("message") or error.get("type") or ""
            return str(text).replace("\n", " ").strip()[:160]
        if isinstance(error, str):
            return error[:160]
        for field in ("detail", "message", "title"):
            if isinstance(data.get(field), str):
                return data[field][:160]
    return ""


def describe_failure(exc: Exception) -> str:
    """User-facing text for a failed request. Never includes the key or body."""
    if isinstance(exc, HTTPError):
        if 300 <= exc.code < 400:
            return '请求被网络重定向，域名可能被网络策略拦截。'
        detail = provider_message(exc)
        lowered = detail.lower()
        if any(word in lowered for word in ('credit', 'payment', 'balance', 'quota', 'insufficient')):
            return f'账户没有可用额度：{detail}' if detail else '账户余额不足，请检查服务商账户。'
        if 'session' in lowered:
            return (f'该模型不接受第三方程序调用：{detail}\n'
                    '（OpenCode 的免费档官方限定只能在 OpenCode 客户端里使用，换一个模型或换一家服务商）')
        if 'not supported' in lowered or 'unavailable' in lowered:
            return f'这个模型当前不可用：{detail}'
        if 'internal server error' in lowered:
            return (f'服务商内部错误（{exc.code}）：{detail}\n'
                    '（这是服务端的问题，换一个模型通常就能绕过）')
        if exc.code == 401:
            return f'鉴权失败：{detail}' if detail else 'API Key 无效，请在 AI 设置里重新填写。'
        if exc.code == 403:
            return f'服务端拒绝了这次请求：{detail}' if detail else '服务端拒绝了这次请求（403）。'
        if exc.code == 404:
            return '接口地址不存在（404），请检查 AI 设置里的接口地址。'
        if exc.code == 429:
            return '请求过于频繁，请稍后再手动重试。'
        if exc.code in (400, 422):
            return f'请求被拒绝：{detail}' if detail else f'请求被拒绝（{exc.code}），请检查模型名。'
        return f'服务返回 {exc.code}：{detail}' if detail else f'服务返回 {exc.code}，请稍后手动重试。'
    if isinstance(exc, (ssl.SSLError, URLError, OSError)):
        return '连不上 AI 服务。请检查网络，或确认当前网络是否放行了该域名。'
    if isinstance(exc, TimeoutError):
        return '回复超时中断。请检查网络后手动重试。'
    return '网络超时或回复中断。请检查网络后手动重试。'


def probe(key: str, config: dict) -> str:
    """One tiny real request. Returns '' on success, otherwise the error text."""
    payload = build_payload(config, [{"role": "user", "content": "回复两个字：在的"}],
                            stream=False, max_tokens=8)
    try:
        request = Request(endpoint(config),
                          data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                          headers=request_headers(key, config), method="POST")
        with open_with_retry(request, config["request_timeout"]) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not body.get("choices"):
            return '接口有响应，但返回里没有回复内容。'
        return ''
    except Exception as exc:  # the message is intentionally coarse: no key, no body
        return describe_failure(exc)


def complete(key: str, config: dict, messages: list, max_tokens: int | None = None) -> str:
    """One short non-streaming request (used by memory distillation and the
    reminder parser). Raises on failure - callers decide how loud to be.

    Uses the whole-reply budget rather than the first-byte one: these calls ask
    for a few hundred tokens, and a slow relay can easily need more than 20s.
    """
    payload = build_payload(config, messages, stream=False, max_tokens=max_tokens, temperature=0.2)
    request = Request(endpoint(config),
                      data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      headers=request_headers(key, config), method="POST")
    with open_with_retry(request, config.get("reply_timeout", 60)) as response:
        body = response.read().decode("utf-8")
    text = read_completion_text(body)
    if not text:
        raise ValueError("empty completion")
    return text


def read_completion_text(body: str) -> str:
    """Pull the answer text out of a non-streaming reply body.

    Tolerates gateways that wrap the answer differently, and falls back to
    reasoning_content for models that put the visible answer there.
    """
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return ""
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    reasoning = message.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning
    return ""


def extract_json(text: str) -> dict:
    """Pull the first JSON object out of a reply that may be wrapped in prose
    or ```json fences. Returns {} when there is nothing usable."""
    if not text:
        return {}
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def list_models(key: str, config: dict) -> list:
    """Model ids advertised by the endpoint, or [] when it does not expose them.

    Used by tools/set_ai_key.py so the model name never has to be guessed.
    """
    url = config["base_url"].rstrip("/") + "/models"
    try:
        headers = request_headers(key, config)
        headers.pop("Content-Type", None)
        request = Request(url, headers=headers)
        with open_with_retry(request, config["request_timeout"]) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return []
    entries = body.get("data") if isinstance(body, dict) else None
    if not isinstance(entries, list):
        return []
    return [item["id"] for item in entries
            if isinstance(item, dict) and isinstance(item.get("id"), str)]


class AIService:
    def __init__(self, config=None):
        self.events = queue.Queue()
        self.busy = False
        self.cancelled = threading.Event()
        self.serial = 0
        self.config = config or dict(DEFAULT_CONFIG)

    def cancel(self):
        """停下手上的请求，并立刻放开通道——否则用户取消后马上再发会被“还在忙”吞掉。"""
        self.cancelled.set()
        self.busy = False

    def send(self, key, messages):
        if self.busy:
            return None
        self.busy = True
        self.cancelled = threading.Event()
        self.serial += 1
        request_id = self.serial
        cancel = self.cancelled
        config = dict(self.config)
        url = endpoint(config)
        payload = build_payload(config, messages, stream=True)

        def worker():
            state = {'text': '', 'chunks': 0}
            attempts = 0
            while True:
                state['text'] = ''
                state['chunks'] = 0
                try:
                    text = self._exchange(url, payload, key, config, cancel, request_id, state)
                except HTTPError as exc:
                    if not cancel.is_set():
                        self.events.put((request_id, 'error', describe_failure(exc)))
                    break
                except Exception as exc:
                    if cancel.is_set():
                        break
                    # 公司网络会间歇性重置长连接。只在“一个字都还没吐出来”时重试，
                    # 半截断流不重试，免得同一段回复被重复计费。
                    if expects_retry(exc) and attempts < TRANSIENT_ATTEMPTS and not state['chunks']:
                        attempts += 1
                        time.sleep(0.8 * attempts)
                        continue
                    self.events.put((request_id, 'error', describe_failure(exc)))
                    break
                else:
                    self.events.put((request_id, 'done', text))
                    break
            self.busy = False

        threading.Thread(target=worker, daemon=True, name='caleb-ai').start()
        return request_id

    def _exchange(self, url, payload, key, config, cancel, request_id, state) -> str:
        """One attempt. Raises on failure; partial text lands in ``state``."""
        text = ''
        request = Request(url,
                          data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                          headers=request_headers(key, config), method='POST')
        started = time.monotonic()
        complete = False
        # 有些中转站会忽略 stream 参数，直接回一整段 JSON。这里把非 SSE 的
        # 正文也攒着，循环结束后按普通补全解析，免得白跑一趟。
        plain = []
        saw_stream = False
        with urlopen(request, timeout=config['request_timeout']) as response:
            for raw in response:
                if cancel.is_set():
                    return ''
                if time.monotonic() - started > config['reply_timeout']:
                    raise TimeoutError()
                line = raw.decode('utf-8').strip()
                if not line.startswith('data:'):
                    plain.append(line)
                    continue
                saw_stream = True
                data = line[5:].strip()
                if data == '[DONE]':
                    complete = True
                    break
                event = json.loads(data)
                for choice in event.get('choices', []):
                    chunk = choice.get('delta', {}).get('content') or ''
                    text += chunk
                    state['text'] = text
                    if chunk:
                        state['chunks'] += 1
                        self.events.put((request_id, 'text', text))
        if not saw_stream and ''.join(plain).strip():
            text = text or read_completion_text(''.join(plain))
            state['text'] = text
            state['chunks'] = state['chunks'] or (1 if text else 0)
            complete = bool(text)
        if not complete or not text:
            raise ValueError('incomplete response')
        return text
