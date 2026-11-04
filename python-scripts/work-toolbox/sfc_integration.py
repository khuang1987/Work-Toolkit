from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path
import subprocess
import time


APP_DIR = Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))) / "MedtronicOfficeAssistant"
CONFIG_PATH = APP_DIR / "config.json"
DEFAULT_SFC_PATH = r"C:\1_SFC软件安装包\SFC正式\TsSFC.Client.MgmtSys.exe"


@dataclass
class SfcConfig:
    sfc_path: str = DEFAULT_SFC_PATH
    sfc_username: str = ""
    sfc_password: str = ""
    login_timeout_seconds: int = 25


class SfcLoginError(RuntimeError):
    pass


def _protect(value: str) -> str:
    if not value:
        return ""
    import win32crypt

    encrypted = win32crypt.CryptProtectData(value.encode("utf-8"), None, None, None, None, 0)
    return base64.b64encode(encrypted).decode("ascii")


def _unprotect(value: str) -> str:
    if not value:
        return ""
    try:
        import win32crypt

        raw = base64.b64decode(value.encode("ascii"))
        return win32crypt.CryptUnprotectData(raw, None, None, None, 0)[1].decode("utf-8")
    except Exception:
        return ""


def load_sfc_config() -> SfcConfig:
    if not CONFIG_PATH.is_file():
        return SfcConfig()

    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return SfcConfig()

    return SfcConfig(
        sfc_path=str(data.get("sfc_path") or DEFAULT_SFC_PATH),
        sfc_username=str(data.get("sfc_username") or ""),
        sfc_password=_unprotect(str(data.get("sfc_password") or "")),
        login_timeout_seconds=max(5, min(120, int(data.get("login_timeout_seconds") or 25))),
    )


def save_sfc_config(config: SfcConfig) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    data = {
        "sfc_path": config.sfc_path,
        "sfc_username": config.sfc_username,
        "sfc_password": _protect(config.sfc_password),
        "login_timeout_seconds": config.login_timeout_seconds,
        # Startup is owned by Work Toolbox now, not by the retired standalone assistant.
        "start_with_windows": False,
    }
    CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_automation_modules() -> tuple[object, object, object, object, object, object]:
    try:
        from pywinauto import Application, Desktop, keyboard
        import win32clipboard
        import win32con
        import win32gui
    except ImportError as error:
        raise SfcLoginError(
            "SFC 自动登录依赖未安装，请运行 Work Toolbox 的依赖安装或联系管理员。"
        ) from error

    return Application, Desktop, keyboard, win32clipboard, win32con, win32gui


def launch_and_login(config: SfcConfig, status=None) -> None:
    if not Path(config.sfc_path).is_file():
        raise SfcLoginError(f"SFC 程序不存在：{config.sfc_path}")
    if not config.sfc_username or not config.sfc_password:
        raise SfcLoginError("请先在工作工具箱中保存 SFC 账号和密码。")

    modules = _load_automation_modules()
    _automation = {
        "Application": modules[0],
        "Desktop": modules[1],
        "keyboard": modules[2],
        "win32clipboard": modules[3],
        "win32con": modules[4],
        "win32gui": modules[5],
    }

    _status(status, "SFC：正在启动")
    subprocess.Popen([config.sfc_path], cwd=str(Path(config.sfc_path).parent))
    _status(status, "SFC：正在等待登录窗口")

    deadline = time.time() + max(config.login_timeout_seconds, 60)
    last_error: Exception | None = None
    while time.time() < deadline:
        window = _find_ready_sfc_login_window(_automation)
        if window is None:
            time.sleep(1)
            continue

        try:
            window.set_focus()
            time.sleep(0.5)
            for fill_count in range(1, 11):
                _status(status, f"SFC：正在填写登录信息（{fill_count}/10）")
                try:
                    _, password_edit, login_button = _fill_sfc_fields(window, config, _automation)
                    _activate_login_button(login_button, password_edit, _automation)
                    _status(status, "SFC：登录动作已完成")
                    return
                except Exception as error:
                    last_error = error
                    time.sleep(1)
        except Exception as error:
            last_error = error
            time.sleep(1)

    raise SfcLoginError(f"SFC 登录超时：{last_error}")


def _status(callback, message: str) -> None:
    if callback:
        callback(message)


def _find_ready_sfc_login_window(automation):
    try:
        for window in automation["Desktop"](backend="uia").windows():
            if _is_ready_sfc_login_window(window, automation):
                return window
    except Exception:
        return None
    return None


def _is_ready_sfc_login_window(window, automation) -> bool:
    try:
        if not window.is_visible():
            return False
        title = window.window_text() or ""
        title_lower = title.lower()
        class_name = window.element_info.class_name or ""
        rect = window.rectangle()
        looks_like_sfc = (
            title in ("系统登陆", "系统登录")
            or "sfc" in title_lower
            or "tssfc" in title_lower
            or (
                class_name.startswith("WindowsForms10.Window.8")
                and 350 <= rect.width() <= 700
                and 350 <= rect.height() <= 700
            )
        )
        return looks_like_sfc and bool(
            _find_by_auto_id(window, "bTxtUserCode")
            and _find_by_auto_id(window, "bTxtPassword")
        )
    except Exception:
        return False


def _find_by_auto_id(window, automation_id):
    for control in window.descendants():
        try:
            if control.element_info.automation_id == automation_id and control.is_visible():
                return control
        except Exception:
            continue
    return None


def _fill_sfc_fields(window, config: SfcConfig, automation):
    username_edit = _find_by_auto_id(window, "bTxtUserCode")
    password_edit = _find_by_auto_id(window, "bTxtPassword")
    login_button = _find_by_auto_id(window, "bBtnLogin")
    if not username_edit or not password_edit:
        raise SfcLoginError("SFC 登录控件尚未准备好。")

    _set_text_control(username_edit, config.sfc_username, automation)
    _set_text_control(password_edit, config.sfc_password, automation)
    _verify_text_control(username_edit, config.sfc_username, "账号", automation)
    _verify_text_control(password_edit, config.sfc_password, "密码", automation)
    return username_edit, password_edit, login_button


def _set_text_control(control, text: str, automation) -> None:
    hwnd = _find_native_edit_handle(control)
    if hwnd:
        automation["win32gui"].SendMessage(hwnd, automation["win32con"].WM_SETTEXT, 0, text)
        automation["win32gui"].SendMessage(hwnd, automation["win32con"].WM_KILLFOCUS, 0, 0)
        time.sleep(0.2)
        return

    control.set_focus()
    time.sleep(0.15)
    automation["keyboard"].send_keys("^a{BACKSPACE}")
    _paste_text(text, automation)


def _verify_text_control(control, expected: str, label: str, automation) -> None:
    hwnd = _find_native_edit_handle(control)
    actual = _get_window_text(hwnd, automation) if hwnd else ""
    if actual != expected:
        raise SfcLoginError(f"SFC {label}写入校验失败。")


def _get_window_text(hwnd: int, automation) -> str:
    length = automation["win32gui"].SendMessage(hwnd, automation["win32con"].WM_GETTEXTLENGTH, 0, 0)
    buffer = automation["win32gui"].PyMakeBuffer((length + 1) * 2)
    automation["win32gui"].SendMessage(hwnd, automation["win32con"].WM_GETTEXT, length + 1, buffer)
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
            if "EDIT" in (child.element_info.class_name or "").upper() and child.handle:
                return child.handle
        except Exception:
            continue
    return None


def _activate_login_button(login_button, password_edit, automation) -> None:
    if login_button:
        try:
            hwnd = login_button.handle
            if hwnd:
                left, top, right, bottom = automation["win32gui"].GetWindowRect(hwnd)
                x = max(1, (right - left) // 2)
                y = max(1, (bottom - top) // 2)
                lparam = (y << 16) | x
                automation["win32gui"].PostMessage(hwnd, automation["win32con"].WM_LBUTTONDOWN, automation["win32con"].MK_LBUTTON, lparam)
                time.sleep(0.08)
                automation["win32gui"].PostMessage(hwnd, automation["win32con"].WM_LBUTTONUP, 0, lparam)
                return
        except Exception:
            pass

        try:
            login_button.set_focus()
            time.sleep(0.15)
            automation["keyboard"].send_keys("{SPACE}")
            return
        except Exception:
            pass

    automation["keyboard"].send_keys("{ENTER}")


def _paste_text(text: str, automation) -> None:
    automation["win32clipboard"].OpenClipboard()
    try:
        automation["win32clipboard"].EmptyClipboard()
        automation["win32clipboard"].SetClipboardText(text, automation["win32clipboard"].CF_UNICODETEXT)
    finally:
        automation["win32clipboard"].CloseClipboard()
    automation["keyboard"].send_keys("^v")
