"""Point the pet at an AI endpoint: choose provider, paste a key, verify it.

The key is encrypted with Windows DPAPI (current user only) into the pet's own
store and is never printed, logged, or written in clear text. It is intentionally
separate from any other tool's credentials: nothing here reads or reuses keys
configured elsewhere on this machine.

Run it via tools\\set-ai-key.cmd so it uses the project's Python and the real
desktop-network path (not a sandbox proxy).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'app'))

from ai_service import KeyStore, endpoint, list_models, load_config, probe, save_config  # noqa: E402

PRESETS = [
    ("OpenCode Zen（按量付费）", "https://opencode.ai/zen/v1"),
    ("OpenCode Go（订阅制，可支付宝）", "https://opencode.ai/zen/go/v1"),
    ("硅基流动 SiliconFlow", "https://api.siliconflow.cn/v1"),
    ("火山方舟（豆包）", "https://ark.cn-beijing.volces.com/api/v3"),
    ("阶跃星辰 StepFun", "https://api.stepfun.com/v1"),
    ("MiniMax", "https://api.minimax.chat/v1"),
    ("OpenAI", "https://api.openai.com/v1"),
    ("Groq", "https://api.groq.com/openai/v1"),
    ("Anthropic（OpenAI 兼容层）", "https://api.anthropic.com/v1"),
    ("其他 / 自定义（包含公司内部网关）", ""),
]


def ask(prompt: str, default: str = "") -> str:
    suffix = f"（直接回车用 {default}）" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or default


def read_secret(prompt: str) -> str:
    """Read a secret without echo when a real console is attached.

    msvcrt.getwch reads single keys and never echoes, and unlike getpass it does
    not touch the console mode (some locked-down images kill getpass outright).
    Pasted keys arrive as a stream of key events, so paste works. With piped
    input there is no console, so fall back to reading the line.
    """
    sys.stdout.write(prompt)
    sys.stdout.flush()
    if not sys.stdin.isatty():
        return sys.stdin.readline().strip()
    try:
        import msvcrt
    except ImportError:
        return input()
    chars: list[str] = []
    while True:
        char = msvcrt.getwch()
        if char in ("\r", "\n"):
            break
        if char == "\x03":
            raise KeyboardInterrupt
        if char == "\x08":
            if chars:
                chars.pop()
                sys.stdout.write("\b \b")
                sys.stdout.flush()
            continue
        if char in ("\x00", "\xe0"):  # arrow / function key: swallow the extra byte
            msvcrt.getwch()
            continue
        chars.append(char)
        sys.stdout.write("*")
        sys.stdout.flush()
    sys.stdout.write("\n")
    return "".join(chars).strip()


def main() -> int:
    app_data = os.environ.get('APPDATA') or str(Path.home() / 'AppData' / 'Roaming')
    folder = Path(app_data) / 'CalebDesktopPet'
    key_file = folder / 'ai-key.bin'
    config_file = folder / 'ai-config.json'
    config = load_config(config_file)

    print("给桌宠单独配一把 key —— 不会读取或复用机器上任何其他工具已配置的密钥。\n")
    print(f"密钥将加密保存到：{key_file}")
    print(f"接口与模型写到　：{config_file}\n")

    print("选一个服务商：")
    for index, (name, url) in enumerate(PRESETS, 1):
        print(f"  {index}. {name}" + (f"  {url}" if url else ""))
    while True:
        raw = input(f"序号（回车 = {len(PRESETS)}）：").strip() or str(len(PRESETS))
        if raw.isdigit() and 1 <= int(raw) <= len(PRESETS):
            selected, default_url = PRESETS[int(raw) - 1]
            break
        print("  输入列表里的序号。")

    base_url = ask("接口地址 base_url", default_url or config['base_url']).rstrip('/')
    config['base_url'] = base_url

    key = read_secret("把 key 粘贴到这里（输入不回显，粘贴后回车）：")
    if not key:
        print("没有输入内容，什么也没改。")
        return 1

    try:
        KeyStore(key_file).save(key)
    except OSError as exc:
        print(f"保存失败：{exc}\n请检查用户目录权限。")
        return 1
    print(f"已加密保存（{len(key)} 字符）。")

    models = list_models(key, config)
    if models:
        models = sorted(models)
        shown = models[:40]
        print(f"\n该接口可用模型（{len(models)} 个，显示前 {len(shown)} 个）：")
        for index, name in enumerate(shown, 1):
            print(f"  {index}. {name}")
        while True:
            raw = input(f"选择模型序号，或直接输入模型名（回车 = {config['model']}）：").strip()
            if not raw:
                break
            if raw.isdigit() and 1 <= int(raw) <= len(shown):
                config['model'] = shown[int(raw) - 1]
                break
            config['model'] = raw
            break
    else:
        print("\n这个接口没有返回模型列表（部分网关不支持）。")
        config['model'] = ask("模型名（在服务商控制台能看到）", config['model'])

    save_config(config_file, config)
    print(f"\n配置已写入：{config['model']} @ {endpoint(config)}")

    print("\n正在用这把 key 真实请求一次……")
    problem = probe(key, config)
    if problem:
        print(f"没通过：{problem}")
        print("\n配置和密钥都已保存，问题解决后重跑 tools/check_ai_connection.py 即可复核。")
        return 1
    print("通过：网络、密钥和模型都能用。现在右键宠物 → 聊聊 就能说话了。")
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n已取消，没有改动。")
        raise SystemExit(1)
