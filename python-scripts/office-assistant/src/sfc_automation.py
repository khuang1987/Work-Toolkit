import subprocess
import time
from pathlib import Path

from pywinauto import Application, Desktop, keyboard
from pywinauto.timings import TimeoutError as PywinautoTimeoutError
import win32clipboard
import win32gui
import win32con

from config_store import APP_DIR, AppConfig


LOGIN_BUTTON_TEXTS = ("登录", "登陆", "Login", "Sign in", "确定", "OK")
USERNAME_HINTS = ("user", "username", "工号", "账号", "帳號", "用户")
PASSWORD_HINTS = ("password", "密码", "密碼")


LOG_PATH = APP_DIR / "office-assistant.log"


class SfcLoginError(RuntimeError):
    pass


def launch_and_login(config: AppConfig, status=None) -> None:
    exe_path = Path(config.sfc_path)
    if not exe_path.exists():
        raise SfcLoginError(f"SFC 程序不存在: {exe_path}")
    if not config.sfc_username or not config.sfc_password:
        raise SfcLoginError("请先在办公助手窗口保存 SFC 账号和密码")

    _status(status, "正在启动 SFC...")
    subprocess.Popen([str(exe_path)], cwd=str(exe_path.parent))

    _status(status, "等待 SFC 登录窗口...")
    window = _wait_for_sfc_window(exe_path.name, max(config.login_timeout_seconds, 60))
    window.set_focus()
    time.sleep(0.8)

    _status(status, "正在输入账号密码...")
    if not _login_by_controls(window, config):
        _login_by_keyboard(window, config)

    _status(status, "SFC 登录动作已完成")


def _status(callback, message: str) -> None:
    if callback:
        callback(message)


def _debug(message: str) -> None:
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except Exception:
        pass


def _find_ready_sfc_login_window():
    try:
        for win in Desktop(backend="uia").windows():
            if _is_ready_sfc_login_window(win):
                return win
    except Exception as exc:
        _debug(f"desktop scan failed: {type(exc).__name__}: {exc}")
    return None


def _wait_for_sfc_window(exe_name: str, timeout: int):
    deadline = time.time() + timeout
    last_error = None

    while time.time() < deadline:
        try:
            app = Application(backend="uia").connect(path=exe_name)
            windows = app.windows()
            for win in windows:
                if _is_ready_sfc_login_window(win):
                    return win
        except Exception as exc:
            last_error = exc

        try:
            desktop_windows = Desktop(backend="uia").windows()
            for win in desktop_windows:
                if _is_ready_sfc_login_window(win):
                    return win
        except Exception as exc:
            last_error = exc

        time.sleep(0.5)

    raise SfcLoginError(f"等待 SFC 窗口超时: {last_error}")


def _is_ready_sfc_login_window(win) -> bool:
    try:
        if not win.is_visible():
            return False
        title = win.window_text() or ""
        title_lower = title.lower()
        class_name = win.element_info.class_name or ""
        rect = win.rectangle()
        looks_like_sfc_login = (
            title in ("系统登陆", "系统登录")
            or "sfc" in title_lower
            or "tssfc" in title_lower
            or (
                class_name.startswith("WindowsForms10.Window.8")
                and 350 <= rect.width() <= 700
                and 350 <= rect.height() <= 700
            )
        )
        if not looks_like_sfc_login:
            return False
        return bool(_find_by_auto_id(win, "bTxtUserCode") and _find_by_auto_id(win, "bTxtPassword"))
    except Exception:
        return False


def _login_by_controls(window, config: AppConfig) -> bool:
    try:
        username_edit = _find_by_auto_id(window, "bTxtUserCode")
        password_edit = _find_by_auto_id(window, "bTxtPassword")
        login_btn = _find_by_auto_id(window, "bBtnLogin")

        if username_edit and password_edit:
            _set_text_control(username_edit, config.sfc_username, "账号")
            _set_text_control(password_edit, config.sfc_password, "密码")
            _verify_text_control(username_edit, config.sfc_username, "账号")
            _verify_text_control(password_edit, config.sfc_password, "密码")
            _activate_login_button(login_btn, password_edit)
            return True

        edits = [ctrl for ctrl in window.descendants(control_type="Edit") if ctrl.is_visible()]
        if len(edits) < 2:
            return False

        username_edit = _pick_edit(edits, USERNAME_HINTS) or edits[0]
        password_edit = _pick_edit(edits, PASSWORD_HINTS) or edits[1]

        _set_text_control(username_edit, config.sfc_username, "账号")
        _set_text_control(password_edit, config.sfc_password, "密码")
        _verify_text_control(username_edit, config.sfc_username, "账号")
        _verify_text_control(password_edit, config.sfc_password, "密码")

        login_btn = _find_login_button(window)
        _activate_login_button(login_btn, password_edit)
        return True
    except SfcLoginError:
        raise
    except Exception:
        return False


def _find_by_auto_id(window, automation_id: str):
    for ctrl in window.descendants():
        try:
            if ctrl.element_info.automation_id == automation_id and ctrl.is_visible():
                return ctrl
        except Exception:
            continue
    return None


def _activate_login_button(login_btn, password_edit=None) -> None:
    if login_btn:
        try:
            hwnd = login_btn.handle
            if hwnd:
                _message_click(hwnd)
                return
        except Exception:
            pass

        try:
            login_btn.set_focus()
            time.sleep(0.15)
            keyboard.send_keys("{SPACE}")
            return
        except Exception:
            pass

    keyboard.send_keys("{ENTER}")


def _set_text_control(control, text: str, label: str) -> None:
    hwnd = _find_native_edit_handle(control)
    if hwnd:
        win32gui.SendMessage(hwnd, win32con.WM_SETTEXT, 0, text)
        win32gui.SendMessage(hwnd, win32con.WM_KILLFOCUS, 0, 0)
        time.sleep(0.2)
        return

    control.set_focus()
    time.sleep(0.15)
    keyboard.send_keys("^a{BACKSPACE}")
    _paste_text(text)


def _verify_text_control(control, expected: str, label: str) -> None:
    hwnd = _find_native_edit_handle(control)
    actual = _get_window_text(hwnd) if hwnd else ""
    if actual != expected:
        raise SfcLoginError(f"SFC {label}写入校验失败，期望长度 {len(expected)}，实际长度 {len(actual)}")


def _get_window_text(hwnd: int) -> str:
    if not hwnd:
        return ""
    length = win32gui.SendMessage(hwnd, win32con.WM_GETTEXTLENGTH, 0, 0)
    buffer = win32gui.PyMakeBuffer((length + 1) * 2)
    win32gui.SendMessage(hwnd, win32con.WM_GETTEXT, length + 1, buffer)
    return buffer.tobytes().decode("utf-16le", errors="ignore").rstrip("\x00")


def _find_native_edit_handle(control):
    try:
        if "EDIT" in (control.element_info.class_name or "").upper():
            return control.handle
    except Exception:
        pass

    try:
        children = control.descendants(control_type="Edit")
    except Exception:
        children = []

    for child in reversed(children):
        try:
            class_name = child.element_info.class_name or ""
            if "EDIT" in class_name.upper() and child.handle:
                return child.handle
        except Exception:
            continue
    return None


def _message_click(hwnd: int) -> None:
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    x = max(1, (right - left) // 2)
    y = max(1, (bottom - top) // 2)
    lparam = (y << 16) | x
    win32gui.PostMessage(hwnd, win32con.WM_LBUTTONDOWN, win32con.MK_LBUTTON, lparam)
    time.sleep(0.08)
    win32gui.PostMessage(hwnd, win32con.WM_LBUTTONUP, 0, lparam)


def _pick_edit(edits, hints):
    for edit in edits:
        text = " ".join(
            part.lower()
            for part in (
                edit.window_text(),
                edit.element_info.name,
                edit.element_info.automation_id,
            )
            if part
        )
        if any(hint.lower() in text for hint in hints):
            return edit
    return None


def _find_login_button(window):
    try:
        buttons = [ctrl for ctrl in window.descendants(control_type="Button") if ctrl.is_visible()]
    except PywinautoTimeoutError:
        return None

    for button in buttons:
        text = (button.window_text() or button.element_info.name or "").strip()
        if any(label.lower() in text.lower() for label in LOGIN_BUTTON_TEXTS):
            return button
    return None


def _login_by_keyboard(window, config: AppConfig) -> None:
    window.set_focus()
    time.sleep(0.5)
    keyboard.send_keys("^a{BACKSPACE}")
    _paste_text(config.sfc_username)
    keyboard.send_keys("{TAB}")
    _paste_text(config.sfc_password)
    keyboard.send_keys("{ENTER}")


def _paste_text(text: str) -> None:
    win32clipboard.OpenClipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
    finally:
        win32clipboard.CloseClipboard()
    keyboard.send_keys("^v")


def _fill_sfc_fields(window, config: AppConfig) -> tuple[object, object, object]:
    username_edit = _find_by_auto_id(window, "bTxtUserCode")
    password_edit = _find_by_auto_id(window, "bTxtPassword")
    login_btn = _find_by_auto_id(window, "bBtnLogin")
    if not username_edit or not password_edit:
        raise SfcLoginError("SFC login controls are not ready")

    _set_text_control(username_edit, config.sfc_username, "username")
    _set_text_control(password_edit, config.sfc_password, "password")
    _verify_text_control(username_edit, config.sfc_username, "username")
    _verify_text_control(password_edit, config.sfc_password, "password")
    return username_edit, password_edit, login_btn


def launch_and_login(config: AppConfig, status=None) -> None:
    exe_path = Path(config.sfc_path)
    if not exe_path.exists():
        raise SfcLoginError(f"SFC program not found: {exe_path}")
    if not config.sfc_username or not config.sfc_password:
        raise SfcLoginError("Please save the SFC username and password first")

    _status(status, "Starting SFC...")
    _debug("launch SFC login requested")
    subprocess.Popen([str(exe_path)], cwd=str(exe_path.parent))

    deadline = time.time() + max(config.login_timeout_seconds, 60)
    detect_count = 0
    last_error = None

    while time.time() < deadline:
        detect_count += 1
        _status(status, f"Detecting SFC login window... {detect_count}")
        _debug(f"detect attempt {detect_count}")
        window = _find_ready_sfc_login_window()

        if not window:
            time.sleep(1)
            continue

        try:
            _debug(f"ready window found: handle={window.handle}, title={window.window_text()!r}")
            try:
                window.set_focus()
            except Exception as exc:
                _debug(f"set focus ignored: {type(exc).__name__}: {exc}")
            time.sleep(0.5)

            login_btn = None
            for fill_count in range(1, 11):
                _status(status, f"Filling SFC credentials... {fill_count}/10")
                _debug(f"fill attempt {fill_count}")
                try:
                    _, password_edit, login_btn = _fill_sfc_fields(window, config)
                    _debug("SFC fields verified")
                    _status(status, "SFC fields verified, logging in...")
                    _activate_login_button(login_btn, password_edit)
                    _debug("SFC login action completed")
                    _status(status, "SFC login action completed")
                    return
                except Exception as exc:
                    last_error = exc
                    _debug(f"fill attempt failed: {type(exc).__name__}: {exc}")
                    time.sleep(1)
        except Exception as exc:
            last_error = exc
            _debug(f"window attempt failed: {type(exc).__name__}: {exc}")
            time.sleep(1)

    raise SfcLoginError(f"SFC login timed out: {last_error}")
