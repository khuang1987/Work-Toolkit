"""Reachability check for AI endpoints from this machine's network.

Only reports whether the network lets a request out, and whether the corporate
web filter redirected it. It never sends a key and never calls a paid path
beyond listing models.

Notes learned the hard way:
  * this network has no working IPv6 route, so lookups are pinned to IPv4;
  * single attempts are noisy (intermittent TLS resets), so every endpoint is
    retried and classified across attempts.

Reachable is NOT the same as approved: check with IT before pointing the pet at
any external service.
"""
from __future__ import annotations

import socket
import ssl
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

_real_getaddrinfo = socket.getaddrinfo


def ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
    return _real_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = ipv4_only

TIMEOUT = 10
ATTEMPTS = 3
GOOD_CODES = (200, 400, 401, 403, 404, 405, 422)

CANDIDATES = [
    ("DeepSeek", "https://api.deepseek.com/v1/models"),
    ("OpenAI", "https://api.openai.com/v1/models"),
    ("Anthropic", "https://api.anthropic.com/v1/models"),
    ("Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai/models"),
    ("xAI Grok", "https://api.x.ai/v1/models"),
    ("Mistral", "https://api.mistral.ai/v1/models"),
    ("Groq", "https://api.groq.com/openai/v1/models"),
    ("Together", "https://api.together.xyz/v1/models"),
    ("Cohere", "https://api.cohere.com/v1/models"),
    ("OpenRouter", "https://openrouter.ai/api/v1/models"),
    ("Perplexity", "https://api.perplexity.ai/models"),
    ("智谱 GLM", "https://open.bigmodel.cn/api/paas/v4/models"),
    ("阿里通义 DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1/models"),
    ("月之暗面 Kimi", "https://api.moonshot.cn/v1/models"),
    ("硅基流动 SiliconFlow", "https://api.siliconflow.cn/v1/models"),
    ("火山方舟 豆包", "https://ark.cn-beijing.volces.com/api/v3/models"),
    ("MiniMax", "https://api.minimax.chat/v1/models"),
    ("阶跃星辰 StepFun", "https://api.stepfun.com/v1/models"),
    ("腾讯混元", "https://api.hunyuan.cloud.tencent.com/v1/models"),
    ("百度千帆", "https://qianfan.baidubce.com/v2/models"),
]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(NoRedirect)


def attempt(url: str) -> tuple[str, str]:
    """Return (kind, detail): kind in blocked / ok / flaky-transport."""
    request = Request(url, headers={"User-Agent": "caleb-desktop-pet/1.7.0-reachability",
                                    "Accept": "application/json"})
    try:
        with OPENER.open(request, timeout=TIMEOUT) as response:
            body = response.read(2048).decode("utf-8", "replace").lower()
            if "medtronic" in body or "web-filter-block" in body:
                return "blocked", "重定向到公司拦截页"
            return "ok", f"HTTP {response.status}"
    except HTTPError as exc:
        body = exc.read(2048).decode("utf-8", "replace").lower()
        location = (exc.headers.get("Location") or "").lower()
        if any(mark in body + location for mark in ("medtronic", "web-filter-block", "category_denied", "csirt")):
            return "blocked", "重定向到公司拦截页"
        if exc.code in GOOD_CODES:
            return "ok", f"HTTP {exc.code}（请求已到服务端）"
        if 300 <= exc.code < 400:
            return "flaky", f"HTTP {exc.code} 重定向"
        return "flaky", f"HTTP {exc.code}"
    except (ssl.SSLError, URLError, OSError) as exc:
        return "flaky", type(exc).__name__
    except Exception as exc:  # pragma: no cover - defensive
        return "flaky", repr(exc)[:40]


rows = []
for name, url in CANDIDATES:
    results = [attempt(url) for _ in range(ATTEMPTS)]
    kinds = [kind for kind, _ in results]
    if all(kind == "blocked" for kind in kinds):
        verdict, detail = "被公司拦截", "每次都被重定向到拦截页"
    elif "blocked" in kinds:
        verdict, detail = "部分被拦截", "同一域名结果不一致"
    elif all(kind == "ok" for kind in kinds):
        verdict, detail = "稳定可达", results[0][1]
    else:
        verdict, detail = "可达但不稳定", "连接被中断 " + str(kinds.count("flaky")) + f"/{ATTEMPTS} 次"
    rows.append((name, verdict, detail))

width = max(len(row[0]) for row in rows)
order = {"稳定可达": 0, "可达但不稳定": 1, "部分被拦截": 2, "被公司拦截": 3}
for name, verdict, detail in sorted(rows, key=lambda row: (order[row[1]], row[0])):
    print(f"{name:<{width}}  {verdict:<8}  {detail}")

stable = [name for name, verdict, _ in rows if verdict == "稳定可达"]
flaky = [name for name, verdict, _ in rows if verdict == "可达但不稳定"]
blocked = [name for name, verdict, _ in rows if verdict == "被公司拦截"]
print("\n稳定可达：", "、".join(stable) or "无")
print("可达但不稳定：", "、".join(flaky) or "无")
print("被公司拦截：", "、".join(blocked) or "无")
