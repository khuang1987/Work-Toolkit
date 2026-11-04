import sys
from pathlib import Path
import tempfile
import time
import json
import tkinter as tk
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from right_ctrl import TapDetector, RightCtrl
import ai_service
import ai_chat
import main
from main import CalebPet

persona = json.loads((Path(__file__).resolve().parents[1] / 'assets' / 'personality.json').read_text(encoding='utf-8'))
assert persona['version'] >= 2
assert '普通回答里主动提到AI' in persona['system']
assert any(item['content'] == '你是谁？' for item in persona['examples'] if item['role'] == 'user')
assert any(item['content'] == '你会记得我的习惯吗？' for item in persona['examples'] if item['role'] == 'user')

d = TapDetector()
assert not d.feed(0xA3, True)
assert d.feed(0xA3, False)
d.feed(0xA3, True)
d.feed(67, True)
d.feed(67, False)
assert not d.feed(0xA3, False)
d.feed(0xA2, True)
assert d.feed(0xA2, False)  # 左 Ctrl 单击同样算触发

with tempfile.TemporaryDirectory() as folder:
    vault = ai_service.KeyStore(Path(folder) / 'key.bin')
    vault.save('synthetic-test-secret')
    assert vault.load() == 'synthetic-test-secret'
    assert b'synthetic-test-secret' not in vault.path.read_bytes()
    vault.save('')
    assert vault.load() == ''

    # Endpoint and model live in ai-config.json: default must be the official
    # DeepSeek V4.1 Flash name, and a custom gateway must survive a round trip.
    config_file = Path(folder) / 'ai-config.json'
    config = ai_service.load_config(config_file)
    assert config['model'] == 'deepseek-flash', config['model']
    assert ai_service.endpoint(config) == 'https://api.deepseek.com/chat/completions'
    ai_service.save_config(config_file, dict(config, base_url='http://10.0.0.9:8000/v1', model='local-gateway'))
    stored = ai_service.load_config(config_file)
    assert stored['model'] == 'local-gateway'
    assert stored['path'] == '/chat/completions'
    assert ai_service.endpoint(stored) == 'http://10.0.0.9:8000/v1/chat/completions'
    config_file.write_text('{ not json', encoding='utf-8')
    assert ai_service.load_config(config_file)['model'] == 'deepseek-flash'
    assert ai_service.describe_failure(ai_service.HTTPError('u', 307, 'redirect', {}, None)).startswith('请求被网络重定向')
    # An endpoint that does not expose /models (or is unreachable) must degrade to
    # an empty list instead of raising: the settings window relies on that.
    assert ai_service.list_models('not-a-real-key', ai_service.load_config(config_file)) == []
    assert ai_service.request_headers('k', {'extra_headers': {'x-a': '1'}})['x-a'] == '1'
    assert ai_service.request_headers('k', {'extra_headers': 'broken'})['Authorization'] == 'Bearer k'
    # Cloudflare-protected gateways reject clients that send no User-Agent.
    assert ai_service.request_headers('k', {})['User-Agent'] == ai_service.USER_AGENT

    # 聊聊记录：时间戳、7 天滚动、损坏行不拖垮整份记录、可导出。
    from datetime import datetime, timedelta
    from ai_history import ChatLog
    log_file = Path(folder) / 'ai-history.jsonl'
    log = ChatLog(log_file, retention_days=7)
    now = datetime(2026, 9, 15, 12, 0, 0)
    log.append('user', '今天天气不错', now=now - timedelta(days=8))
    log.append('assistant', '过期的话', now=now - timedelta(days=8))
    log.append('user', '三天前说的', now=now - timedelta(days=3))
    log.append('assistant', '我还记得', now=now - timedelta(days=3, minutes=-1))
    kept = log.load(now)
    assert [item['text'] for item in kept] == ['三天前说的', '我还记得'], kept
    assert kept[0]['at'].startswith('2026-09-12'), kept
    log_file.write_text(log_file.read_text(encoding='utf-8') + '{ broken line\n', encoding='utf-8')
    assert len(log.load(now)) == 2
    text = log.transcript(now)
    assert '夏以昼 · AI 聊聊记录' in text and '[2026-09-12' in text and '你：三天前说的' in text, text
    assert json.loads(log.as_json(now))['count'] == 2
    assert json.loads(log.as_json(now))['retention_days'] == 7
    log.clear()
    assert log.load(now) == []

# Keep every test local: profile and config must not touch the real user folder.
sandbox = Path(tempfile.mkdtemp())
main.profile_path = lambda: sandbox / 'profile.json'
main.CalebPet._start_tray_icon = lambda self: None


class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def __iter__(self):
        yield ('data: ' + json.dumps({'choices': [{'delta': {'content': '模拟回复：我在。'}}]}) + '\n').encode()
        yield b'data: [DONE]\n'


seen = {}


def fake_open(request, timeout):
    payload = json.loads(request.data)
    seen['url'] = request.full_url
    seen['payload'] = payload
    seen['headers'] = dict(request.headers)
    return Response()


class SlowResponse:
    """先给一个分片，再停一会儿才结束——用来稳定地观察“等待中”的界面状态。"""
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def __iter__(self):
        yield ('data: ' + json.dumps({'choices': [{'delta': {'content': '半句话'}}]},
                                     ensure_ascii=False) + '\n').encode()
        time.sleep(1.5)
        yield b'data: [DONE]\n'

ai_service.urlopen = fake_open
root = tk.Tk()
app = CalebPet(root, welcome=False)
app._save_profile = lambda: True

# 中转站的常见毛病：忽略 stream 参数，直接回一整段 JSON。也要能读出来。
assert ai_service.read_completion_text(
    '{"choices":[{"message":{"content":"普通补全"}}]}') == '普通补全'
assert ai_service.read_completion_text(
    '{"choices":[{"message":{"content":"","reasoning_content":"思考里给的答案"}}]}') == '思考里给的答案'
assert ai_service.read_completion_text('not json') == ''
assert ai_service.read_completion_text('{"error":"nope"}') == ''
# 公司网络会间歇重置长连接：只对传输层故障重试，HTTP 状态码不重试
assert ai_service.expects_retry(ai_service.URLError('reset')) is True
assert ai_service.expects_retry(TimeoutError()) is True
assert ai_service.expects_retry(ai_service.HTTPError('u', 401, 'no', {}, None)) is False
assert ai_service.expects_retry(ValueError('bad json')) is False


def bubble_texts():
    canvas = app.bubble.winfo_children()[0]
    return [canvas.itemcget(i, 'text') for i in canvas.find_all() if canvas.type(i) == 'text']


def wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        root.update()
        time.sleep(.02)
    return predicate()


try:
    app.open_ai_chat()
    chat = app.ai_chat
    root.update()
    bar = chat.window
    # The bar must stay a small strip: one entry, one button, nothing else.
    assert bar.winfo_width() <= 420 and bar.winfo_height() <= 80, (bar.winfo_width(), bar.winfo_height())
    inner = bar.winfo_children()[0].winfo_children()
    assert len([w for w in inner if isinstance(w, tk.Entry)]) == 1, inner
    buttons = [w for w in inner if isinstance(w, tk.Button)]
    assert len(buttons) == 2, buttons
    assert {b.cget('text') for b in buttons} == {'发送', '🎤'}, buttons
    assert set(w.winfo_class() for w in inner) == {'Entry', 'Button'}, inner
    # The pet keeps its own dedicated key file, separate from anything else on
    # the machine that happens to hold credentials.
    assert chat.keys.path.name == 'ai-key.bin', chat.keys.path

    # Missing key: hint through the pet bubble, keep the bar so nothing is lost.
    chat.keys.load = lambda: ''
    chat.entry.insert(0, '你好')
    chat.send()
    root.update()
    assert app.bubble is not None and app.ai_bubble
    assert any('AI 设置' in t for t in bubble_texts())
    assert chat.window is bar and not chat.history and not chat.waiting

    # Empty input sends nothing at all.
    app._close_bubble()
    chat.entry.delete(0, 'end')
    chat.send()
    assert app.bubble is None

    chat.keys.load = lambda: 'synthetic-test-secret'
    chat.entry.insert(0, '你好')
    chat.send()
    # 发送后输入条立刻消失，宠物摆思考姿态，头顶挂一个只跳“。”的小气泡；
    # 首字到达后才换成问答内容。
    assert chat.window is None, 'input bar must close right after sending'
    assert chat.waiting
    assert app.thinking is True and app.state == 'waiting', (app.thinking, app.state)
    texts = bubble_texts()
    assert any(set(t) <= {'。', '你', '：', ' ', '夏', '以', '昼', '·', 'A', 'I'} for t in texts), texts
    assert any('。' in t for t in texts), texts
    assert not any('模拟回复' in t for t in texts), '首字到达前不该有答案'
    assert wait_for(lambda: any('模拟回复' in t for t in bubble_texts())), '首字到达后应弹出回答框'
    texts = bubble_texts()
    assert any('你：你好' in t for t in texts), texts
    assert any('不聊了' in t for t in texts), texts
    assert wait_for(lambda: not chat.waiting), 'reply never arrived'
    assert app.thinking is False and app.state == 'idle', (app.thinking, app.state)
    assert seen['url'] == 'https://api.deepseek.com/chat/completions', seen['url']
    assert seen['payload']['model'] == 'deepseek-flash'
    assert seen['payload']['thinking']['type'] == 'disabled'
    assert seen['payload']['stream'] is True
    assert len(chat.history) == 2
    texts = bubble_texts()
    assert any('模拟回复' in t for t in texts), texts
    assert any('你：你好' in t for t in texts), texts
    assert any('继续提问' in t for t in texts) and any('不聊了' in t for t in texts), texts
    persona_system = seen['payload']['messages'][0]['content']
    assert '普通回答里主动提到AI' in persona_system
    assert '用户询问身份时如实说明是AI驱动' not in persona_system

    # 继续提问 brings the input bar back; 不聊了 just closes the bubble.
    again = app.bubble_button_targets[0][4]
    again()
    root.update()
    assert chat.window is not None and chat.entry.winfo_exists()
    chat.dismiss()

    # While an answer is on its way the only bubble button is 不聊了, and it cancels.
    app.open_ai_chat()
    ai_service.urlopen = lambda request, timeout: SlowResponse()
    chat.entry.insert(0, '再问一句')
    chat.send()
    assert chat.waiting and chat.window is None and app.thinking is True
    assert any('。' in t for t in bubble_texts()), bubble_texts()
    assert wait_for(lambda: any('半句话' in t for t in bubble_texts())), '首字到达后应换成回答'
    texts = bubble_texts()
    assert any('不聊了' in t for t in texts) and not any('继续提问' in t for t in texts), texts
    assert app.thinking is False, '首字到了就该收起思考姿态'
    cancel = app.bubble_button_targets[0][4]
    cancel()
    root.update()
    assert not chat.waiting and chat.request is None
    assert app.thinking is False
    ai_service.urlopen = fake_open

    # Providers that need their own extra header (Anthropic-style) go through the
    # same config instead of a code change.
    chat.service.config = dict(chat.config, extra_headers={'X-Test-Header': 'ok'})
    app.open_ai_chat()
    chat.entry.insert(0, '带头再问一次')
    chat.send()
    assert wait_for(lambda: not chat.waiting), 'header turn never finished'
    assert seen['headers'].get('X-test-header') == 'ok', seen['headers']
    app._close_bubble()

    # Settings window: provider list, endpoint autofill, model fetch, save.
    chat.configure()
    root.update()
    settings = chat.settings
    assert settings is not None and settings.winfo_exists()
    # The current endpoint is matched back to its provider entry in the list.
    assert chat.provider_var.get() == 'DeepSeek', chat.provider_var.get()
    chat.provider_var.set('硅基流动 SiliconFlow')
    chat._provider_picked()
    assert chat.url_var.get() == 'https://api.siliconflow.cn/v1'
    ai_chat.list_models = lambda key, config: ['synthetic-model-b', 'synthetic-model-a']
    chat.key_var.set('synthetic-test-secret')
    chat.free_only.set(False)
    chat._fetch_models()
    assert wait_for(lambda: 'synthetic-model-a' in chat.model_box.cget('values')), chat.model_box.cget('values')
    assert chat.model_var.get() == 'synthetic-model-a'
    # 只看免费模型：非免费的必须被筛掉
    ai_chat.list_models = lambda key, config: ['paid-model', 'glm-5-free', 'kimi-k2-free']
    chat.free_only.set(True)
    chat._fetch_models()
    assert wait_for(lambda: tuple(chat.model_box.cget('values')) == ('glm-5-free', 'kimi-k2-free')), \
        chat.model_box.cget('values')
    assert chat.model_var.get() == 'glm-5-free'
    ai_chat.probe = lambda key, config: ''
    chat._test_settings()
    assert wait_for(lambda: '测试通过' in chat.settings_status.cget('text')), chat.settings_status.cget('text')
    chat.model_var.set('synthetic-model-a')
    chat._save_settings()
    kept = ai_service.load_config(sandbox / 'ai-config.json')
    assert kept['base_url'] == 'https://api.siliconflow.cn/v1' and kept['model'] == 'synthetic-model-a', kept
    assert chat.service.config['model'] == 'synthetic-model-a'
    assert chat.key_var.get() == '' and chat.keys.load() == 'synthetic-test-secret'
    chat.close_settings()
    assert chat.settings is None

    # 记录落地 + 跨重启记得 + 导出成文件。
    # 只有跑完的问答才入库：中途点「不聊了」取消的那一轮不该留下记录。
    assert chat.log.path.name == 'ai-history.jsonl'
    stored = chat.log.load()
    assert [item['text'] for item in stored] == ['你好', '模拟回复：我在。', '带头再问一次', '模拟回复：我在。'], stored
    assert all(item['role'] in ('user', 'assistant') for item in stored)
    assert all(item['at'].startswith(str(main.date.today())) for item in stored), stored
    fresh = ai_chat.AIChat(app, main.resource_path('assets', 'personality.json'),
                           sandbox / 'ai-key.bin', sandbox / 'ai-config.json',
                           sandbox / 'ai-history.jsonl')
    assert [item['content'] for item in fresh.history][-2:] == ['带头再问一次', '模拟回复：我在。'], fresh.history
    fresh.close()  # this test instance owns its own reminder poller

    chat.configure()
    root.update()
    assert '4 条' in chat.log_label.cget('text'), chat.log_label.cget('text')
    export_target = sandbox / 'export.txt'
    ai_chat.filedialog.asksaveasfilename = lambda **kwargs: str(export_target)
    chat.export_log()
    exported = export_target.read_text(encoding='utf-8')
    assert '你：你好' in exported and '模拟回复' in exported and '保留范围' in exported, exported

    # 中转站忽略 stream 参数、直接回一整段 JSON 时，也必须能正常出答案。
    class PlainResponse:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def __iter__(self):
            yield json.dumps({"choices": [{"message": {"content": "普通补全回复"}}]},
                             ensure_ascii=False).encode()

    ai_service.urlopen = lambda request, timeout: PlainResponse()
    app.open_ai_chat()
    chat.entry.insert(0, '中转站测试')
    chat.send()
    assert wait_for(lambda: not chat.waiting), '非流式回复没被读出来'
    assert any('普通补全回复' in t for t in bubble_texts()), bubble_texts()
    assert chat.log.load()[-1]['text'] == '普通补全回复'
    ai_service.urlopen = fake_open

    # 回车即发送；空输入时什么都不做、输入条留着
    app.open_ai_chat()
    chat.entry.delete(0, 'end')
    assert chat._on_return() == 'break'
    assert chat.window is not None, '空输入不该收起输入条'
    chat.entry.insert(0, '回车发送')
    chat._on_return()
    assert chat.window is None, '回车应把输入条收起来'
    assert wait_for(lambda: not chat.waiting), '回车发送后没收到回复'
    assert chat.log.load()[-2]['text'] == '回车发送'

    # ---- 长期记忆：蒸馏入库、并真的进上下文 ----
    ai_chat.complete = lambda key, config, messages, max_tokens=None: \
        '{"facts":["用户在做桌面宠物项目","用户偏好简短回复"]}'
    chat.distill_now()
    assert wait_for(lambda: '长期记忆已更新' in chat.settings_status.cget('text')), \
        chat.settings_status.cget('text')
    assert chat.memory.load()['facts'] == ['用户在做桌面宠物项目', '用户偏好简短回复']
    assert '用户在做桌面宠物项目' in chat.memory.block()
    memory_prompt = chat.memory.request_messages([{'role': 'user', 'text': '我每天晚上工作，喜欢短回复'}])[0]['content']
    assert '作息和工作节奏' in memory_prompt and '用户明确要求你记住' in memory_prompt
    # 模型偶尔会把 JSON 包在代码块或说明文字里，也要能解析
    assert chat.memory.apply('```json\n{"facts":["只有这一条"]}\n```') == ['只有这一条']
    assert chat.memory.apply('完全不是 JSON') == ['只有这一条']
    chat.memory.apply('{"facts":["用户在做桌面宠物项目"]}')
    assert chat.memory.load()['updated_at']
    app.open_ai_chat()
    chat.entry.insert(0, '还记得我在做什么吗')
    chat.send()
    assert wait_for(lambda: not chat.waiting), 'memory turn never finished'
    system = seen['payload']['messages'][0]['content']
    assert '用户在做桌面宠物项目' in system, system
    assert '长期记忆' in system and '只作数据' in system, system
    assert '当前时间' in system and '（周' in system, system[:200]
    app._close_bubble()

    # ---- 提醒：句子 → 结构化 → 存盘 → 到点弹气泡 ----
    from ai_reminders import looks_like_reminder, parse_prompt
    assert looks_like_reminder('十点提醒我开会')
    assert not looks_like_reminder('今天天气不错')
    assert '现在的时间是' in parse_prompt(datetime.now())
    ai_chat.complete = lambda key, config, messages, max_tokens=None: \
        '{"intent":"create","at":"2030-01-01 09:00","text":"去开会"}'
    chat._parse_reminder('2030年1月1日九点提醒我开会')
    chat._drain_intents()
    pending = chat.reminders.pending()
    assert [item['text'] for item in pending] == ['去开会'], pending
    assert any('提醒已记下' in t for t in bubble_texts()), bubble_texts()
    ai_chat.complete = lambda key, config, messages, max_tokens=None: '{"intent":"list"}'
    chat._parse_reminder('我有哪些提醒')
    chat._drain_intents()
    assert any('待提醒 1 条' in t for t in bubble_texts()), bubble_texts()
    ai_chat.complete = lambda key, config, messages, max_tokens=None: '{"intent":"cancel","text":"开会"}'
    chat._parse_reminder('取消开会的提醒')
    chat._drain_intents()
    assert chat.reminders.load() == [] or all(item['fired'] for item in chat.reminders.load())
    assert any('已取消' in t for t in bubble_texts()), bubble_texts()
    ai_chat.complete = lambda key, config, messages, max_tokens=None: '{"intent":"create","at":"2020-01-01 09:00","text":"过去的事"}'
    chat._parse_reminder('2020年提醒我过去的事')
    chat._drain_intents()
    assert chat.reminders.pending() == []
    assert any('已经过去了' in t for t in bubble_texts()), bubble_texts()

    # 到点：气泡带上时间与内容，并给“十分钟后再提醒”
    chat.reminders.add(datetime.now() - timedelta(minutes=1), '去开会')
    chat._poll_reminders()
    texts = bubble_texts()
    assert any('你交代过的事' in t for t in texts), texts
    assert any('要 去开会' in t or '去开会' in t for t in texts), texts
    assert any('十分钟后再提醒' in t for t in texts), texts
    assert chat.reminders.pending() == [], chat.reminders.pending()
    # 过点太久的不再打扰
    chat.reminders.add(datetime.now() - timedelta(hours=20), '很久以前的')
    assert chat.reminders.due() == []
    assert chat.reminders.pending() == []
    app._close_bubble()

    ai_chat.messagebox.askyesno = lambda *args, **kwargs: True
    chat.clear_log()
    assert chat.log.load() == [] and not chat.history
    assert '0 条' in chat.log_label.cget('text')
    chat.clear_memory()
    assert chat.memory.load()['facts'] == []
    assert '还没整理过' in chat.memory_label.cget('text')
    chat.close_settings()

    # 退出路径回归：输入条已销毁时 quit 不能再碰幽灵控件（曾抛 TclError 把宠物卡成僵尸）
    app.open_ai_chat()
    root.update()
    chat.dismiss()
    app.quit()
    root.update()
finally:
    try:
        root.destroy()
    except tk.TclError:
        pass

hook = RightCtrl()
time.sleep(.2)
assert hook.available
hook.close()
print('PASS: Ctrl tap/combination, DPAPI, config round trip, small single-field bar, '
      'send closes the bar, question+answer bubble with 继续提问/不聊了, streaming model payload, '
      'non-SSE relay bodies, provider picker + model fetch + save, '
      'chat log with export and cross-restart memory, '
      'distilled long-term memory in context, reminder create/list/cancel/fire/snooze/expiry, '
      'native hook installation')
