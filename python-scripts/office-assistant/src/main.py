import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import pystray
from PIL import Image, ImageDraw

from config_store import AppConfig, DEFAULT_SFC_PATH, load_config, save_config
from sfc_automation import SfcLoginError, launch_and_login
from startup import set_startup_enabled


class OfficeAssistantApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("办公助手")
        self.root.geometry("460x300")
        self.root.resizable(False, False)
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)

        self.config = load_config()
        self.message_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.icon: pystray.Icon | None = None

        self._build_window()
        self._start_tray()
        self.root.after(200, self._process_messages)
        self.hide_window()

    def _build_window(self) -> None:
        frame = ttk.Frame(self.root, padding=16)
        frame.pack(fill=tk.BOTH, expand=True)

        title = ttk.Label(frame, text="办公助手", font=("Microsoft YaHei UI", 16, "bold"))
        title.grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 12))

        ttk.Label(frame, text="SFC 程序").grid(row=1, column=0, sticky="w", pady=6)
        self.sfc_path_var = tk.StringVar(value=self.config.sfc_path or DEFAULT_SFC_PATH)
        path_entry = ttk.Entry(frame, textvariable=self.sfc_path_var, width=46)
        path_entry.grid(row=1, column=1, sticky="ew", pady=6)
        ttk.Button(frame, text="浏览", command=self._browse_sfc).grid(row=1, column=2, padx=(8, 0), pady=6)

        ttk.Label(frame, text="SFC 账号").grid(row=2, column=0, sticky="w", pady=6)
        self.username_var = tk.StringVar(value=self.config.sfc_username)
        ttk.Entry(frame, textvariable=self.username_var, width=30).grid(row=2, column=1, sticky="ew", pady=6)

        ttk.Label(frame, text="SFC 密码").grid(row=3, column=0, sticky="w", pady=6)
        self.password_var = tk.StringVar(value=self.config.sfc_password)
        ttk.Entry(frame, textvariable=self.password_var, width=30, show="*").grid(row=3, column=1, sticky="ew", pady=6)

        ttk.Label(frame, text="等待窗口").grid(row=4, column=0, sticky="w", pady=6)
        self.timeout_var = tk.IntVar(value=self.config.login_timeout_seconds)
        ttk.Spinbox(frame, from_=5, to=120, textvariable=self.timeout_var, width=8).grid(row=4, column=1, sticky="w", pady=6)
        ttk.Label(frame, text="秒").grid(row=4, column=1, sticky="w", padx=(64, 0), pady=6)

        self.startup_var = tk.BooleanVar(value=self.config.start_with_windows)
        ttk.Checkbutton(frame, text="开机启动并常驻托盘", variable=self.startup_var).grid(row=5, column=1, sticky="w", pady=6)

        buttons = ttk.Frame(frame)
        buttons.grid(row=6, column=0, columnspan=3, sticky="ew", pady=(16, 8))
        ttk.Button(buttons, text="保存设置", command=self.save_settings).pack(side=tk.LEFT)
        ttk.Button(buttons, text="SFC 登录", command=self.start_sfc_login).pack(side=tk.LEFT, padx=(10, 0))
        ttk.Button(buttons, text="收纳到托盘", command=self.hide_window).pack(side=tk.RIGHT)

        self.status_var = tk.StringVar(value="已收纳到系统托盘，右键托盘图标可快速 SFC 登录。")
        status = ttk.Label(frame, textvariable=self.status_var, foreground="#555")
        status.grid(row=7, column=0, columnspan=3, sticky="w", pady=(10, 0))

        frame.columnconfigure(1, weight=1)

    def _browse_sfc(self) -> None:
        selected = filedialog.askopenfilename(
            title="选择 SFC 程序",
            filetypes=[("Executable", "*.exe"), ("All files", "*.*")],
            initialfile="TsSFC.Client.MgmtSys.exe",
        )
        if selected:
            self.sfc_path_var.set(selected)

    def _start_tray(self) -> None:
        image = self._create_tray_image()
        menu = pystray.Menu(
            pystray.MenuItem("打开助手", self.show_window, default=True),
            pystray.MenuItem("SFC 登录", self.start_sfc_login),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", self.quit_app),
        )
        self.icon = pystray.Icon("MedtronicOfficeAssistant", image, "办公助手", menu)
        threading.Thread(target=self.icon.run, daemon=True).start()

    def _create_tray_image(self) -> Image.Image:
        icon_path = Path(__file__).resolve().parents[1] / "assets" / "office-assistant-icon.ico"
        if icon_path.exists():
            return Image.open(icon_path)

        image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((8, 8, 56, 56), radius=14, fill=(0, 112, 192, 255))
        draw.text((21, 18), "OA", fill=(255, 255, 255, 255))
        return image

    def save_settings(self) -> None:
        try:
            self.config = AppConfig(
                sfc_path=self.sfc_path_var.get().strip() or DEFAULT_SFC_PATH,
                sfc_username=self.username_var.get().strip(),
                sfc_password=self.password_var.get(),
                login_timeout_seconds=int(self.timeout_var.get()),
                start_with_windows=bool(self.startup_var.get()),
            )
            save_config(self.config)
            set_startup_enabled(self.config.start_with_windows)
            self.set_status("设置已保存")
        except Exception as exc:
            messagebox.showerror("保存失败", str(exc))

    def start_sfc_login(self, icon=None, item=None) -> None:
        self.save_settings()
        threading.Thread(target=self._run_sfc_login, daemon=True).start()

    def _run_sfc_login(self) -> None:
        try:
            config = load_config()
            launch_and_login(config, self._post_status)
        except SfcLoginError as exc:
            self._post_error(str(exc))
        except Exception as exc:
            self._post_error(f"SFC 登录失败: {exc}")

    def _post_status(self, message: str) -> None:
        self.message_queue.put(("status", message))

    def _post_error(self, message: str) -> None:
        self.message_queue.put(("error", message))

    def _process_messages(self) -> None:
        while not self.message_queue.empty():
            kind, message = self.message_queue.get_nowait()
            self.set_status(message)
            if kind == "error":
                messagebox.showerror("办公助手", message)
        self.root.after(200, self._process_messages)

    def set_status(self, message: str) -> None:
        self.status_var.set(message)

    def show_window(self, icon=None, item=None) -> None:
        self.root.after(0, self._show_window)

    def _show_window(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def hide_window(self) -> None:
        self.root.withdraw()

    def quit_app(self, icon=None, item=None) -> None:
        if self.icon:
            self.icon.stop()
        self.root.after(0, self.root.destroy)

    def run(self) -> None:
        self.root.mainloop()


if __name__ == "__main__":
    OfficeAssistantApp().run()
