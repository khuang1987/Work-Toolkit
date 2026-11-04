"""Small "聊聊" input bar, its settings window, and the AI reply flow.

All Tk work stays on the main thread. The bar is deliberately tiny: one input
field plus one button. Sending closes the bar and the answer comes back as the
pet's own speech bubble, which carries the question, the reply, and the two
things a person wants next: 继续提问 or 不聊了.
"""
import ctypes
import json
import queue
import threading
import time
import tkinter as tk
from datetime import datetime, timedelta
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from ai_history import ChatLog, RETENTION_DAYS
from ai_memory import UserMemory
from ai_reminders import (WEEKDAY, ReminderStore, describe_due, looks_like_reminder,
                          parse_prompt)
from ai_service import (AIService, KeyStore, complete, endpoint, extract_json, list_models,
                        load_config, probe, save_config)

BAR_KEY = '#17131C'          # same transparency key as the pet bubble
BAR_FILL = '#FFF9F1'
BAR_EDGE = '#D9B39C'
BAR_W, BAR_H = 402, 56
ENTRY_W = 282
BUTTON_W = 46
MIC_W = 34
MIC_FILL = '#F4E7DE'
MIC_ON_FILL = '#E6BDA3'
BUTTON_FILL = '#E6BDA3'
BUTTON_BUSY = '#F0E4DA'
BUTTON_TEXT = '#3E2A25'
POLL_MS = 80
REMINDER_POLL_MS = 5000
STREAM_REFRESH_SECONDS = 0.4
MAX_QUESTION = 2000
RESERVED_BUBBLE_LINES = 8
DOTS_MS = 380                      # 思考气泡里点数跳动的间隔
MAX_TITLE_CHARS = 60

# (显示名, base_url)。顺序按“国内好开通 → 海外 → 自定义”排。
PROVIDERS = [
    ("OpenCode Zen（按量付费）", "https://opencode.ai/zen/v1"),
    ("OpenCode Go（订阅制，可支付宝）", "https://opencode.ai/zen/go/v1"),
    ("硅基流动 SiliconFlow", "https://api.siliconflow.cn/v1"),
    ("火山方舟（豆包）", "https://ark.cn-beijing.volces.com/api/v3"),
    ("阶跃星辰 StepFun", "https://api.stepfun.com/v1"),
    ("MiniMax", "https://api.minimax.chat/v1"),
    ("智谱 GLM", "https://open.bigmodel.cn/api/paas/v4"),
    ("阿里通义 DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ("DeepSeek", "https://api.deepseek.com"),
    ("OpenAI", "https://api.openai.com/v1"),
    ("Anthropic（兼容层）", "https://api.anthropic.com/v1"),
    ("Groq", "https://api.groq.com/openai/v1"),
    ("xAI Grok", "https://api.x.ai/v1"),
    ("Cohere", "https://api.cohere.com/compatibility/v1"),
    ("自定义 / 公司内部网关", ""),
]

# opencode zen 把 GPT/Grok 系走 /responses、Claude/Qwen/Gemini 系走 /messages，
# 这两类都不认 chat/completions，列出来只会让人挑到一个必然失败的模型。
# 下面这份前缀白名单来自官方端点表里 /chat/completions 那一组。
ZEN_HOST = 'opencode.ai/zen'
ZEN_CHAT_PREFIXES = ('deepseek', 'minimax', 'glm', 'kimi', 'big-pickle', 'mimo',
                     'laguna', 'ling', 'longcat', 'north', 'nemotron',
                     'hy', 'omen', 'muse-spark')


class AIChat:
    def __init__(self, app, personality, key_path, config_path, log_path,
                 memory_path=None, reminder_path=None):
        self.app = app
        self.personality = json.loads(personality.read_text(encoding='utf-8'))
        self.keys = KeyStore(key_path)
        self.config_path = config_path
        self.config = load_config(config_path)
        self.service = AIService(self.config)
        # 两层记忆：原始记录按天滚动；蒸馏出的长期记忆不过期。
        self.log = ChatLog(log_path, int(self.config.get('history_days') or RETENTION_DAYS))
        self.memory = UserMemory(memory_path or Path(log_path).with_name('ai-memory.json'))
        self.reminders = ReminderStore(reminder_path or Path(log_path).with_name('ai-reminders.json'))
        self.history = [{'role': item['role'], 'content': item['text']} for item in self.log.load()][-12:]
        self.window = None
        self.canvas = None
        self.entry = None
        self.button = None
        self.timer = None
        self.settings = None
        self.settings_timer = None
        self.settings_events = queue.Queue()
        self.reminder_timer = None
        self.reminder_events = queue.Queue()
        self.notice = ''
        self.voice_on = False
        self.grab_after_id = None
        self.request = None
        self.pending = ''
        self.waiting = False
        self.stream_started = True
        self.dots = 1
        self.dots_at = 0.0
        self.last_paint = 0.0
        self.drag_offset = None
        self.reminder_timer = self.app.root.after(REMINDER_POLL_MS, self._poll_reminders)

    # ---------- 输入条 ----------

    def configure(self):
        """Open the settings window (provider, endpoint, model, key in one place)."""
        if self.settings and self.settings.winfo_exists():
            self.settings.lift()
            self.settings.focus_force()
            return
        win = self.settings = tk.Toplevel(self.app.root)
        win.title('AI 对话设置')
        win.attributes('-topmost', True)
        win.configure(bg='#FFF9F1')
        win.resizable(False, False)
        win.protocol('WM_DELETE_WINDOW', self.close_settings)
        pad = {'padx': 12, 'pady': 4}
        tk.Label(win, text='选服务商、挑模型、填自己的 key。改完点保存。', bg='#FFF9F1',
                 fg='#8A746B', font=('Microsoft YaHei UI', 9)).grid(row=0, column=0, columnspan=3,
                                                                   sticky='w', **pad)
        self.provider_var = tk.StringVar(value=self._provider_label())
        self.model_var = tk.StringVar(value=self.config['model'])
        self.url_var = tk.StringVar(value=self.config['base_url'])

        tk.Label(win, text='服务商', bg='#FFF9F1', fg='#624940', font=('Microsoft YaHei UI', 9)).grid(row=1, column=0, sticky='w', **pad)
        provider_box = ttk.Combobox(win, textvariable=self.provider_var, state='readonly', width=26,
                                    values=[name for name, _ in PROVIDERS])
        provider_box.grid(row=1, column=1, columnspan=2, sticky='we', **pad)
        provider_box.bind('<<ComboboxSelected>>', self._provider_picked)

        tk.Label(win, text='接口地址', bg='#FFF9F1', fg='#624940', font=('Microsoft YaHei UI', 9)).grid(row=2, column=0, sticky='w', **pad)
        tk.Entry(win, textvariable=self.url_var, width=40, font=('Microsoft YaHei UI', 9)).grid(
            row=2, column=1, columnspan=2, sticky='we', **pad)

        tk.Label(win, text='模型', bg='#FFF9F1', fg='#624940', font=('Microsoft YaHei UI', 9)).grid(row=3, column=0, sticky='w', **pad)
        self.model_box = ttk.Combobox(win, textvariable=self.model_var, width=24,
                                      values=[self.config['model']])
        self.model_box.grid(row=3, column=1, sticky='we', **pad)
        fetch_bar = tk.Frame(win, bg='#FFF9F1')
        fetch_bar.grid(row=3, column=2, sticky='we', **pad)
        self.fetch_button = tk.Button(fetch_bar, text='拉取模型列表', command=self._fetch_models,
                                      relief='flat', bg='#F4E7DE', fg='#624940',
                                      font=('Microsoft YaHei UI', 9), cursor='hand2')
        self.fetch_button.pack(fill='x')
        self.free_only = tk.BooleanVar(value=False)
        tk.Checkbutton(fetch_bar, text='只看免费模型', variable=self.free_only, bg='#FFF9F1',
                       fg='#78645C', activebackground='#FFF9F1', font=('Microsoft YaHei UI', 8),
                       selectcolor='#FFF9F1', bd=0, highlightthickness=0).pack(anchor='w')

        tk.Label(win, text='API Key', bg='#FFF9F1', fg='#624940', font=('Microsoft YaHei UI', 9)).grid(row=4, column=0, sticky='w', **pad)
        self.key_var = tk.StringVar(value='')
        tk.Entry(win, textvariable=self.key_var, show='*', width=40,
                 font=('Microsoft YaHei UI', 9)).grid(row=4, column=1, columnspan=2, sticky='we', **pad)
        self.key_state = tk.Label(win, text=self._key_state(), bg='#FFF9F1', fg='#8A746B',
                                  font=('Microsoft YaHei UI', 8))
        self.key_state.grid(row=5, column=1, columnspan=2, sticky='w', padx=12)

        bar = tk.Frame(win, bg='#FFF9F1')
        bar.grid(row=6, column=0, columnspan=3, sticky='we', pady=(8, 4))
        for label, callback in [('保存', self._save_settings), ('测试连接', self._test_settings),
                                ('清除密钥', self._clear_key), ('关闭', self.close_settings)]:
            tk.Button(bar, text=label, command=callback, relief='flat', bg='#F4E7DE', fg='#624940',
                      font=('Microsoft YaHei UI', 9), cursor='hand2', padx=10).pack(side='left', padx=6)

        ttk.Separator(win, orient='horizontal').grid(row=7, column=0, columnspan=3, sticky='we',
                                                     padx=12, pady=(6, 4))
        self.log_label, _ = self._memory_row(win, 8, '聊聊记录', [
            ('导出', self.export_log), ('清空', self.clear_log)])
        self.memory_label, _ = self._memory_row(win, 9, '长期记忆', [
            ('整理', self.distill_now), ('重置', self.clear_memory)])
        self.reminder_label, _ = self._memory_row(win, 10, '待提醒', [
            ('全部取消', self.clear_reminders)])

        self.settings_status = tk.Label(win, text='', bg='#FFF9F1', fg='#78645C',
                                        font=('Microsoft YaHei UI', 8), wraplength=420, justify='left')
        self.settings_status.grid(row=11, column=0, columnspan=3, sticky='w', padx=12, pady=(4, 10))
        self._refresh_memory_rows()
        win.update_idletasks()
        x = max(0, self.app.root.winfo_rootx() - 220)
        y = max(0, self.app.root.winfo_rooty() - win.winfo_height() - 20)
        win.geometry(f'+{x}+{y}')
        self.settings_timer = win.after(POLL_MS, self._poll_settings)

    def _provider_label(self) -> str:
        for name, url in PROVIDERS:
            if url and url == self.config['base_url']:
                return name
        return PROVIDERS[-1][0]

    def _key_state(self) -> str:
        key = self.keys.load()
        return f'当前已保存 {len(key)} 字符，留空表示不改。' if key else '尚未保存，粘贴后点保存。'

    def _provider_picked(self, _event=None) -> None:
        for name, url in PROVIDERS:
            if name == self.provider_var.get():
                if url:
                    self.url_var.set(url)
                self.settings_status.configure(text=f'已选 {name}，记得挑一个模型再保存。')
                return

    def _current_key(self) -> str:
        return self.key_var.get().strip() or self.keys.load()

    def _fetch_models(self) -> None:
        key = self._current_key()
        if not key:
            self.settings_status.configure(text='先填 API Key，再拉模型列表。')
            return
        config = dict(self.config, base_url=self.url_var.get().strip() or self.config['base_url'])
        self.fetch_button.configure(state='disabled', text='拉取中…')
        self.settings_status.configure(text='正在向接口要模型列表……')

        def work():
            return list_models(key, config)

        self._run_async(work, self._models_arrived)

    def _models_arrived(self, result) -> None:
        self.fetch_button.configure(state='normal', text='拉取模型列表')
        if 'error' in result:
            self.settings_status.configure(text=f'拉取失败：{result["error"]}')
            return
        models = sorted(result.get('value') or [])
        notes = []
        if ZEN_HOST in self.url_var.get():
            usable = [name for name in models if name.startswith(ZEN_CHAT_PREFIXES)]
            if len(usable) != len(models):
                notes.append(f'隐去了 {len(models) - len(usable)} 个 GPT/Claude/Gemini 模型'
                             '（它们走 /responses、/messages，本程序用不了）')
            models = usable
        if self.free_only.get():
            free = [name for name in models if 'free' in name.lower()]
            notes.append(f'只看免费模型，列出了 {len(free)} 个')
            models = free
        if not models:
            self.settings_status.configure(
                text='这组条件下没有可用模型。可以取消勾选“只看免费模型”，或手动填模型名。')
            return
        self.model_box.configure(values=models)
        if self.model_var.get() not in models:
            self.model_var.set(models[0])
        status = f'拿到 {len(models)} 个模型，已填第一个，可在下拉里换。'
        if notes:
            status += '（' + '；'.join(notes) + '）'
        if ZEN_HOST in self.url_var.get() and self.free_only.get():
            status += '\n注意：OpenCode 官方说明免费档只能在 OpenCode 客户端里使用，' \
                      '第三方程序调用会被拒（本机实测如此）。要走这条路，' \
                      '请先在 opencode console 绑定付款方式，再取消勾选“只看免费模型”。'
        self.settings_status.configure(text=status)

    def _memory_row(self, win, row: int, label: str, buttons: list) -> tuple:
        tk.Label(win, text=label, bg='#FFF9F1', fg='#624940',
                 font=('Microsoft YaHei UI', 9)).grid(row=row, column=0, sticky='w', padx=12, pady=3)
        info = tk.Label(win, text='', bg='#FFF9F1', fg='#8A746B', font=('Microsoft YaHei UI', 8),
                        anchor='w', justify='left', wraplength=210)
        info.grid(row=row, column=1, sticky='w', padx=4, pady=3)
        bar = tk.Frame(win, bg='#FFF9F1')
        bar.grid(row=row, column=2, sticky='e', padx=12, pady=3)
        for text, callback in buttons:
            tk.Button(bar, text=text, command=callback, relief='flat', bg='#F4E7DE', fg='#624940',
                      font=('Microsoft YaHei UI', 8), cursor='hand2', padx=8).pack(side='left', padx=3)
        return info, bar

    def _refresh_memory_rows(self) -> None:
        if not (self.settings and self.settings.winfo_exists()):
            return
        count, oldest, newest = self.log.summary()
        self.log_label.configure(
            text=f'最近 {self.log.retention_days} 天共 {count} 条'
                 + (f'（{oldest[5:16]} → {newest[5:16]}）' if count else ''))
        memory = self.memory.load()
        self.memory_label.configure(
            text=f'{len(memory["facts"])} 条'
                 + (f' · 更新于 {memory["updated_at"][5:16]}' if memory['updated_at'] else ' · 还没整理过'))
        pending, nearest = self.reminders.summary()
        self.reminder_label.configure(text=f'{pending} 条' + (f' · {nearest}' if nearest else ''))

    # ---------- 长期记忆 ----------

    def distill_now(self) -> None:
        if not self.keys.load():
            self.settings_status.configure(text='没有 key，整理不了记忆。')
            return
        if not self.log.load():
            self.settings_status.configure(text='还没有聊过，没什么可整理的。')
            return
        self.settings_status.configure(text='正在整理长期记忆……')
        self._run_async(self._distill, self._distill_arrived)

    def _distill(self) -> list:
        records = self.log.load()[-40:]
        reply = complete(self.keys.load(), self.config, self.memory.request_messages(records),
                         max_tokens=600)
        return self.memory.apply(reply)

    def _distill_arrived(self, result) -> None:
        if 'error' in result:
            self.settings_status.configure(text=f'整理失败：{result["error"]}')
            return
        self._refresh_memory_rows()
        self.settings_status.configure(text=f'长期记忆已更新，共 {len(result["value"])} 条。')

    def _auto_distill(self) -> None:
        """Background consolidation. Never touches Tk, never interrupts chatting."""
        try:
            self._distill()
        except Exception:
            pass

    def clear_memory(self) -> None:
        if not messagebox.askyesno('重置长期记忆', '会清掉桌宠对你的长期印象，之后重新积累。继续吗？',
                                   parent=self.settings):
            return
        self.memory.clear()
        self._refresh_memory_rows()
        self.settings_status.configure(text='长期记忆已重置。')

    # ---------- 提醒 ----------

    def clear_reminders(self) -> None:
        if not messagebox.askyesno('取消全部提醒', '会清掉所有还没到点的提醒。继续吗？',
                                   parent=self.settings):
            return
        self.reminders.clear()
        self._refresh_memory_rows()
        self.settings_status.configure(text='待办提醒已清空。')

    def snooze(self, text: str, minutes: int = 10) -> None:
        self.reminders.add(datetime.now() + timedelta(minutes=minutes), text)
        self._refresh_memory_rows()

    def _parse_reminder(self, question: str) -> None:
        """Turn a sentence into a reminder. Runs off the UI thread."""
        try:
            key = self.keys.load()
            if not key:
                return
            reply = complete(key, self.config,
                             [{'role': 'system', 'content': parse_prompt(datetime.now())},
                              {'role': 'user', 'content': question}], max_tokens=200)
            data = extract_json(reply)
        except Exception:
            return
        self.reminder_events.put(data)

    def _handle_intent(self, data: dict) -> None:
        intent = data.get('intent') if isinstance(data, dict) else None
        if intent == 'create':
            raw, text = data.get('at'), str(data.get('text') or '').strip()
            when = None
            if isinstance(raw, str):
                try:
                    when = datetime.strptime(raw, '%Y-%m-%d %H:%M')
                except ValueError:
                    when = None
            if when is None or not text:
                self._notice('没听清时间。可以说“明天九点提醒我开会”。')
                return
            if when <= datetime.now():
                self._notice('那个时间已经过去了，换一个将来的时间吧。')
                return
            self.reminders.add(when, text)
            self._refresh_memory_rows()
            self._notice(f'（提醒已记下：{when.strftime("%m-%d %H:%M")} {text}）')
        elif intent == 'list':
            pending = self.reminders.pending()
            if not pending:
                self._notice('（现在还没有待办的提醒）')
            else:
                body = '　'.join(f'{item["at"][5:]} {item["text"]}' for item in pending[:5])
                self._notice(f'（待提醒 {len(pending)} 条：{body}）')
        elif intent == 'cancel':
            keyword = str(data.get('text') or '').strip()
            dropped = self.reminders.remove(keyword)
            self._refresh_memory_rows()
            if dropped:
                self._notice('（已取消：' + '、'.join(item['text'] for item in dropped) + '）')
            else:
                self._notice('（没找到要取消的提醒）')

    def _notice(self, text: str) -> None:
        """A one-line aside. If an answer is on its way it rides along with it."""
        if self.waiting:
            self.notice = (self.notice + '\n' + text) if self.notice else text
            return
        if self.app.ai_bubble and self.history and self.history[-1]['role'] == 'assistant':
            # 答案还在气泡里：把提示并进去，别把答案顶掉
            self.app.show_ai_reply(self._bubble_body(self.history[-1]['content']) + '\n\n' + text,
                                   buttons=[('继续提问', self.open),
                                            ('不聊了', self.app._close_bubble)])
            return
        self.app.show_ai_reply(text, '提醒')

    def _drain_intents(self) -> None:
        while not self.reminder_events.empty():
            self._handle_intent(self.reminder_events.get_nowait())

    def _poll_reminders(self) -> None:
        self._drain_intents()
        if self.config.get('reminders', True):
            for record in self.reminders.due():
                self.app.show_user_reminder(describe_due(record))
                self._refresh_memory_rows()
        self.reminder_timer = self.app.root.after(REMINDER_POLL_MS, self._poll_reminders)

    def export_log(self) -> None:
        records = self.log.load()
        if not records:
            self.settings_status.configure(text='还没有记录可导出。')
            return
        stamp = datetime.now().strftime('%Y%m%d')
        target = filedialog.asksaveasfilename(
            parent=self.settings, title='导出聊聊记录', defaultextension='.txt',
            initialfile=f'夏以昼聊聊记录-{stamp}.txt',
            filetypes=[('文本记录', '*.txt'), ('JSON', '*.json')])
        if not target:
            return
        try:
            if str(target).lower().endswith('.json'):
                Path(target).write_text(self.log.as_json(), encoding='utf-8')
            else:
                Path(target).write_text(self.log.transcript(), encoding='utf-8')
        except OSError as exc:
            self.settings_status.configure(text=f'导出失败：{exc}')
            return
        self.settings_status.configure(text=f'已导出 {len(records)} 条到 {target}')

    def clear_log(self) -> None:
        if not messagebox.askyesno('清空聊聊记录', '会删掉最近 7 天的聊天记录，且不可恢复。继续吗？',
                                   parent=self.settings):
            return
        self.log.clear()
        self.history.clear()
        self.log_label.configure(text=f'最近 {RETENTION_DAYS} 天共 0 条')
        self.settings_status.configure(text='记录已清空。')

    def _save_settings(self) -> None:
        key = self.key_var.get().strip()
        if key:
            try:
                self.keys.save(key)
            except OSError as exc:
                messagebox.showerror('未能保存', f'密钥保存失败：{exc}', parent=self.settings)
                return
            self.key_var.set('')
            self.key_state.configure(text=self._key_state())
        config = dict(self.config,
                      base_url=self.url_var.get().strip() or self.config['base_url'],
                      model=self.model_var.get().strip() or self.config['model'])
        try:
            save_config(self.config_path, config)
        except OSError as exc:
            self.settings_status.configure(text=f'配置写入失败：{exc}')
            return
        self.config = load_config(self.config_path)
        self.service.config = dict(self.config)
        self.settings_status.configure(
            text=f'已保存：{self.config["model"]} @ {endpoint(self.config)}')

    def _test_settings(self) -> None:
        key = self._current_key()
        if not key:
            self.settings_status.configure(text='没有 key 可测。先粘贴一把再点。')
            return
        config = dict(self.config,
                      base_url=self.url_var.get().strip() or self.config['base_url'],
                      model=self.model_var.get().strip() or self.config['model'])
        self.settings_status.configure(text='正在真实请求一次，最多等 20 秒……')

        def work():
            return probe(key, config)

        self._run_async(work, self._test_arrived)

    def _test_arrived(self, result) -> None:
        if 'error' in result:
            self.settings_status.configure(text=f'测试出错：{result["error"]}')
            return
        problem = result.get('value', '')
        if not problem:
            self.settings_status.configure(text='测试通过：网络、密钥、模型都能用。')
            return
        text = f'没通过：{problem}'
        if ZEN_HOST in self.url_var.get():
            text += ('\nzen 的免费档官方限定只能在 OpenCode 客户端里调用（第三方程序一律被拒），'
                     '付费档需要先在 opencode console 绑定付款方式。想今天就能聊，'
                     '建议换一家服务商，或在家里用 DeepSeek。')
        self.settings_status.configure(text=text)

    def _clear_key(self) -> None:
        try:
            self.keys.save('')
        except OSError as exc:
            self.settings_status.configure(text=f'清除失败：{exc}')
            return
        self.key_var.set('')
        self.key_state.configure(text=self._key_state())
        self.settings_status.configure(text='密钥已清除。')

    def _run_async(self, work, done) -> None:
        """Run network work off the UI thread; deliver the result on the UI thread."""
        def worker():
            try:
                self.settings_events.put((done, {'value': work()}))
            except Exception as exc:
                self.settings_events.put((done, {'error': exc}))
        threading.Thread(target=worker, daemon=True, name='caleb-ai-settings').start()

    def _poll_settings(self) -> None:
        while not self.settings_events.empty():
            done, result = self.settings_events.get_nowait()
            done(result)
        if self.settings and self.settings.winfo_exists():
            self.settings_timer = self.settings.after(POLL_MS, self._poll_settings)

    def close_settings(self) -> None:
        if self.settings_timer and self.settings:
            self.settings.after_cancel(self.settings_timer)
            self.settings_timer = None
        if self.settings and self.settings.winfo_exists():
            self.settings.destroy()
        self.settings = None

    def close_bar_and_voice(self) -> None:
        """触发键在输入框开着时再按一次：语音开着就先关语音，再收起输入框。"""
        if self.voice_on:
            self.send_voice_trigger()
        self.dismiss()

    def send_voice_trigger(self) -> None:
        """按一次右 Alt 切换语音输入，并记住状态（输入法不会告诉我们现在是开是关）。

        输入框活着才发；ai-config.json 里 "voice_alt": false 可整体关掉语音联动。
        """
        if not self.config.get('voice_alt', True):
            return
        if not (self.window and self.window.winfo_exists()):
            return
        from right_ctrl import press_key
        press_key(0xA5)   # VK_RMENU：用户的语音热键是右 Alt（左 Alt 没绑功能）
        self.voice_on = not self.voice_on
        if self.mic_button:
            try:
                self.mic_button.configure(bg=MIC_ON_FILL if self.voice_on else MIC_FILL)
            except tk.TclError:
                pass

    def open(self):
        if self.window and self.window.winfo_exists():
            self.window.lift()
            self.entry.focus_force()
            return
        self.app._close_action_panel()
        self.app._close_bubble()
        win = self.window = tk.Toplevel(self.app.root)
        win.overrideredirect(True)
        win.attributes('-topmost', True)
        win.withdraw()
        win.attributes('-transparentcolor', BAR_KEY)
        win.configure(bg=BAR_KEY)
        canvas = self.canvas = tk.Canvas(win, width=BAR_W, height=BAR_H, bg=BAR_KEY, highlightthickness=0)
        canvas.pack()
        self.app._draw_round_rect(canvas, BAR_W, BAR_H, BAR_FILL, BAR_EDGE)
        self.entry = tk.Entry(canvas, font=('Microsoft YaHei UI', 10), relief='flat', bd=0,
                              bg='#FFFFFF', fg='#4A3833', insertbackground='#4A3833', highlightthickness=0)
        canvas.create_window(16, BAR_H // 2, window=self.entry, width=ENTRY_W, height=26, anchor='w')
        self.button = tk.Button(canvas, text='发送', command=self.send, relief='flat', bd=0,
                                bg=BUTTON_FILL, fg=BUTTON_TEXT, activebackground=BAR_EDGE,
                                activeforeground=BUTTON_TEXT, highlightthickness=0, cursor='hand2',
                                font=('Microsoft YaHei UI', 9))
        canvas.create_window(BAR_W - 12, BAR_H // 2, window=self.button, width=BUTTON_W, height=26, anchor='e')
        # 🎤：点一下 = 右 Alt（切换语音）。voice_alt 关掉时整颗不放。
        self.mic_button = None
        if self.config.get('voice_alt', True):
            self.mic_button = tk.Button(canvas, text='🎤', command=self.send_voice_trigger,
                                        relief='flat', bd=0, bg=MIC_FILL, fg='#624940',
                                        activebackground=MIC_ON_FILL, highlightthickness=0,
                                        cursor='hand2', font=('Segoe UI Emoji', 9))
            canvas.create_window(BAR_W - 12 - BUTTON_W - 6, BAR_H // 2, window=self.mic_button,
                                 width=MIC_W, height=26, anchor='e')
        # 回车直接发送；Esc 收起输入条。中文输入法选词时如果被回车误发，说一声再加保护。
        self.entry.bind('<Return>', self._on_return)
        self.entry.bind('<KP_Enter>', self._on_return)
        self.entry.bind('<Escape>', lambda _e: self.dismiss())
        win.bind('<Escape>', lambda _e: self.dismiss())
        canvas.bind('<Button-1>', self._drag_start)
        canvas.bind('<B1-Motion>', self._drag_move)
        self._place()
        win.deiconify()
        win.lift()
        self._grab_focus()
        self.voice_on = False   # 每次打开都是干净的打字状态；语音由 Ctrl/🎤 显式开启
        self.timer = win.after(POLL_MS, self.poll)

    def _grab_focus(self, attempt: int = 0) -> None:
        """把键盘焦点按进输入框，直到系统前台窗口真的是它。

        无边框窗口 + Windows 前台窗口锁，**第一次**打开时经常抢不到（之后就
        一直没问题）。所以这里不看次数差不多就行，而是以“GetForegroundWindow
        就是输入条”为准，没达成就换姿势重试：focus_force → 显式
        SetForegroundWindow → AttachThreadInput 借前台线程的输入队列。
        """
        if not (self.window and self.window.winfo_exists() and self.entry):
            return
        u, k = ctypes.windll.user32, ctypes.windll.kernel32
        try:
            hwnd = int(self.window.frame(), 16)
        except Exception:
            hwnd = self.window.winfo_id()
        if u.GetForegroundWindow() == hwnd:
            self.entry.focus_force()
            return
        self.window.focus_force()
        self.entry.focus_force()
        fg = u.GetForegroundWindow()
        this_thread = k.GetCurrentThreadId()
        fg_thread = u.GetWindowThreadProcessId(fg, None) if fg else 0
        attached = bool(fg and fg_thread and u.AttachThreadInput(this_thread, fg_thread, True))
        try:
            u.SetForegroundWindow(hwnd)
        except Exception:
            pass
        if attached:
            u.AttachThreadInput(this_thread, fg_thread, False)
        if attempt in (4, 8):
            # 兜底：往输入框控件投递一次合成点击，等效于用户亲手点它，光标必定落进去。
            self._synthetic_click_entry()
        if attempt < 11:
            delay = (60, 80, 100, 120, 150, 180, 200, 260, 320, 400, 480)[min(attempt, 10)]
            self.grab_after_id = self.window.after(delay, lambda: self._grab_focus(attempt + 1))

    def _synthetic_click_entry(self) -> None:
        """往输入框投递一次“按下-抬起”的合成点击，让它像被点过一样拿到光标。"""
        try:
            u = ctypes.windll.user32
            hwnd = self.entry.winfo_id()
            width = self.entry.winfo_width() or 80
            height = self.entry.winfo_height() or 26
            lParam = (max(1, height // 2) << 16) | max(1, width // 2)
            u.PostMessageW(hwnd, 0x0201, 1, lParam)   # WM_LBUTTONDOWN
            u.PostMessageW(hwnd, 0x0202, 0, lParam)   # WM_LBUTTONUP
        except Exception:
            pass

    def _check_outside_click(self) -> None:
        """点击输入框以外的任何地方＝直接收起输入条。

        用鼠标按键状态 + 光标位置判断（而不是前台窗口切换），这样语音输入法
        的悬浮窗抢走前台时不会误伤。输入框里已经有文字时也不收起——那多半是
        语音刚转完，等用户回车发送。
        """
        u = ctypes.windll.user32
        for button in (0x01, 0x02):   # VK_LBUTTON, VK_RBUTTON
            if u.GetAsyncKeyState(button) & 0x8000:
                point = ctypes.c_longlong()
                u.GetCursorPos(ctypes.byref(point))
                x = (point.value >> 0) & 0xFFFF
                y = (point.value >> 16) & 0xFFFF
                if x >= 32768: x -= 65536
                if y >= 32768: y -= 65536
                bx, by = self.window.winfo_rootx(), self.window.winfo_rooty()
                bw, bh = self.window.winfo_width(), self.window.winfo_height()
                inside = bx - 4 <= x <= bx + bw + 4 and by - 4 <= y <= by + bh + 4
                has_text = bool(self.entry.get().strip())
                if not inside and not has_text:
                    self.dismiss()
                break

    def _on_return(self, _event=None) -> str:
        """回车即发送（返回 'break' 阻止默认换行/其它绑定）。"""
        self.send()
        return 'break'

    def _place(self):
        win = self.window
        if not (win and win.winfo_exists()):
            return
        win.update_idletasks()
        x = self.app.root.winfo_rootx() + 28
        y = self.app.root.winfo_rooty() + self.app.root.winfo_height() + 6
        area = getattr(self.app, 'work_area', None)
        if area:
            left, top, right, bottom = area.left, area.top, area.right, area.bottom
        else:
            left = top = 0
            right, bottom = win.winfo_screenwidth(), win.winfo_screenheight()
        x = min(max(left + 8, x), max(left + 8, right - BAR_W - 8))
        if y + BAR_H > bottom - 8:
            y = max(top + 8, self.app.root.winfo_rooty() - BAR_H - 8)
        win.geometry(f'{BAR_W}x{BAR_H}+{int(x)}+{int(y)}')

    def _drag_start(self, event):
        self.drag_offset = (event.x_root - self.window.winfo_x(), event.y_root - self.window.winfo_y())

    def _drag_move(self, event):
        if not self.drag_offset:
            return
        x = event.x_root - self.drag_offset[0]
        y = event.y_root - self.drag_offset[1]
        self.window.geometry(f'+{int(x)}+{int(y)}')

    def _idle_button(self):
        # 输入条可能已经销毁（比如退出时），此时不能再碰这些控件。
        if not (self.window and self.window.winfo_exists() and self.button):
            return
        self.button.configure(text='发送', bg=BUTTON_FILL)

    # ---------- 问答 ----------

    def _bubble_body(self, answer: str) -> str:
        question = ' '.join(self.pending.split())
        if len(question) > MAX_TITLE_CHARS:
            question = question[:MAX_TITLE_CHARS] + '……'
        return f'你：{question}\n\n{answer}'

    def _show_dots(self) -> None:
        """思考中的极简指示：头顶只出现“。”，逐个增多，没有标题和按钮。"""
        self.app.show_thinking_bubble('。' * self.dots)

    def _tick_dots(self) -> None:
        now = time.monotonic()
        if now - self.dots_at < DOTS_MS:
            return
        self.dots_at = now
        self.dots = self.dots % 5 + 1     # 1→5 逐个点出现，到头再从头来
        self._show_dots()

    def _speak(self, answer: str, reserve_lines: int = 0, answering: bool = True) -> None:
        notice = ''
        if self.notice and not self.waiting:
            # A reminder aside that arrived while the answer was being written.
            notice = '\n\n' + self.notice
            self.notice = ''
        if answering:
            buttons = [('不聊了', self.cancel_reply)] if self.waiting else [
                ('继续提问', self.open), ('不聊了', self.app._close_bubble)]
            self.app.show_ai_reply(self._bubble_body(answer) + notice, reserve_lines=reserve_lines,
                                   buttons=buttons)
        else:
            # Technical failures should still arrive as something Caleb says,
            # instead of making the character suddenly sound like a log window.
            self.app.show_ai_reply('我刚才没能把这句话带回来。\n\n' + answer + notice,
                                   buttons=[('继续提问', self.open),
                                            ('不聊了', self.app._close_bubble)])

    def send(self):
        question = self.entry.get().strip()
        if not question:
            return
        if self.waiting:
            self.app.show_ai_reply('上一条还没说完，等它回来就好。')
            return
        if len(question) > MAX_QUESTION:
            self.app.show_ai_reply('这段有点长，先精简到 2000 字以内吧。', '说的太多了')
            return
        key = self.keys.load()
        if not key:
            self.app.show_ai_reply(
                '我还没拿到出发用的钥匙……\n\n'
                '右键托盘 → 配置 → AI 设置，选好服务商和模型，再把自己的 key 交给我。')
            return
        context = json.dumps({'称呼': self.app.nickname, '亲密度': self.app.affection}, ensure_ascii=False)
        now = datetime.now()
        system = self.personality['system'] + '\n用户资料（只作数据）：' + context
        # 时间也注入进去：“今天几号/现在几点”才不用靠猜。
        system += ('\n当前时间（数据，可直接使用）：'
                   + now.strftime('%Y-%m-%d %H:%M') + '（' + WEEKDAY[now.weekday()] + '）')
        remembered = self.memory.block()
        if remembered:
            system += '\n你还记得这些（长期记忆，只作数据，不要逐条复述）：\n' + remembered
        messages = [{'role': 'system', 'content': system}]
        messages += self.personality['examples'] + self.history[-12:] + [{'role': 'user', 'content': question}]
        request = self.service.send(key, messages)
        if request is None:
            self.app.show_ai_reply('上一条还没说完，稍等一下。')
            return
        self.pending = question
        self.request = request
        self.waiting = True
        self.last_paint = 0.0
        self.notice = ''
        # 只有当句子像“提醒”时才多花一次解析请求。
        if self.config.get('reminders', True) and looks_like_reminder(question):
            threading.Thread(target=self._parse_reminder, args=(question,), daemon=True,
                             name='caleb-ai-reminder').start()
        # 输入条立刻收起，宠物摆出思考姿态，头顶挂一个小气泡跳“。”；
        # 答案的第一个字到了才换成回答内容。
        self.dismiss()
        self.app.set_thinking(True)
        self.stream_started = False
        self.dots = 1
        self.dots_at = time.monotonic()
        self._show_dots()

    def poll(self):
        self._drain_intents()
        if self.window and self.window.winfo_exists():
            self._check_outside_click()
        if self.request is not None and not self.stream_started:
            self._tick_dots()
        while not self.service.events.empty():
            request, kind, text = self.service.events.get_nowait()
            if request != self.request:
                continue
            if kind == 'text':
                self.stream_started = True
                now = time.monotonic()
                if now - self.last_paint >= STREAM_REFRESH_SECONDS:
                    self.last_paint = now
                    self.app.set_thinking(False)
                    self._speak(text, reserve_lines=RESERVED_BUBBLE_LINES)
            elif kind == 'done':
                self.history.extend([{'role': 'user', 'content': self.pending}, {'role': 'assistant', 'content': text}])
                self.history = self.history[-12:]
                self.log.append('user', self.pending)
                self.log.append('assistant', text)
                self.request = None
                self.waiting = False
                self._idle_button()
                self.app.set_thinking(False)
                self._speak(text)
                self._consolidate()
            elif kind == 'error':
                self.request = None
                self.waiting = False
                self._idle_button()
                self.app.set_thinking(False)
                self._speak(text, answering=False)
        if self.window and self.window.winfo_exists():
            self.timer = self.window.after(POLL_MS, self.poll)
        elif self.request is not None:
            # The bar is already gone but an answer is still coming: keep polling
            # on the root window so the reply can reach the bubble.
            self.timer = self.app.root.after(POLL_MS, self.poll)
        else:
            self.timer = None

    def _consolidate(self) -> None:
        """Count the finished turn and, every so often, re-distil the long-term memory."""
        self._refresh_memory_rows()
        if not self.keys.load():
            return
        turns = self.memory.bump_turn()
        every = int(self.config.get('distill_every') or 0)
        if every > 0 and turns % every == 0:
            threading.Thread(target=self._auto_distill, daemon=True,
                             name='caleb-ai-memory').start()

    def cancel_reply(self):
        """Bubble button 不聊了 while an answer is still on its way."""
        self.stream_started = True
        self.service.cancel()
        self.request = None
        self.waiting = False
        self._idle_button()
        self.app.set_thinking(False)
        self.app._close_bubble()

    def stop(self, silent=False):
        self.stream_started = True
        self.service.cancel()
        self.request = None
        self.waiting = False
        self._idle_button()
        self.app.set_thinking(False)
        if not silent and self.window and self.window.winfo_exists():
            self.app.show_ai_reply('好，先停在这儿。想继续就直接打字。')

    def _refresh_log_label(self) -> None:
        self._refresh_memory_rows()

    def clear(self):
        self.stop(silent=True)
        self.history.clear()
        self.log.clear()
        self._refresh_log_label()

    def dismiss(self):
        """Close the input bar, leaving any in-flight request alone."""
        if self.timer:
            # The timer belongs to whichever widget registered it: cancelling it
            # through another one leaves a dangling Tcl command behind.
            owner = self.window if (self.window and self.window.winfo_exists()) else self.app.root
            try:
                owner.after_cancel(self.timer)
            except tk.TclError:
                pass
            self.timer = None
        if self.grab_after_id:
            owner = self.window if (self.window and self.window.winfo_exists()) else self.app.root
            try:
                owner.after_cancel(self.grab_after_id)
            except tk.TclError:
                pass
            self.grab_after_id = None
        if self.window and self.window.winfo_exists():
            self.window.destroy()
        self.window = None
        self.canvas = None
        self.entry = None
        self.button = None
        if self.request is not None:
            self.timer = self.app.root.after(POLL_MS, self.poll)

    def close(self):
        """Shut everything down (used when the pet quits)."""
        self.stop(silent=True)
        if self.reminder_timer:
            try:
                self.app.root.after_cancel(self.reminder_timer)
            except tk.TclError:
                pass
            self.reminder_timer = None
        self.dismiss()
        self.close_settings()
