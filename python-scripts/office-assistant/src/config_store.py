import base64
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import win32crypt


APP_DIR = Path.home() / "AppData" / "Roaming" / "MedtronicOfficeAssistant"
CONFIG_PATH = APP_DIR / "config.json"
DEFAULT_SFC_PATH = r"C:\1_SFC软件安装包\SFC正式\TsSFC.Client.MgmtSys.exe"


@dataclass
class AppConfig:
    sfc_path: str = DEFAULT_SFC_PATH
    sfc_username: str = ""
    sfc_password: str = ""
    login_timeout_seconds: int = 25
    start_with_windows: bool = False


def _protect(value: str) -> str:
    if not value:
        return ""
    encrypted = win32crypt.CryptProtectData(value.encode("utf-8"), None, None, None, None, 0)
    return base64.b64encode(encrypted).decode("ascii")


def _unprotect(value: str) -> str:
    if not value:
        return ""
    try:
      raw = base64.b64decode(value.encode("ascii"))
      return win32crypt.CryptUnprotectData(raw, None, None, None, 0)[1].decode("utf-8")
    except Exception:
      return ""


def load_config() -> AppConfig:
    if not CONFIG_PATH.exists():
        return AppConfig()

    try:
        data: dict[str, Any] = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return AppConfig()

    return AppConfig(
        sfc_path=data.get("sfc_path") or DEFAULT_SFC_PATH,
        sfc_username=data.get("sfc_username") or "",
        sfc_password=_unprotect(data.get("sfc_password") or ""),
        login_timeout_seconds=int(data.get("login_timeout_seconds") or 25),
        start_with_windows=bool(data.get("start_with_windows") or False),
    )


def save_config(config: AppConfig) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    data = {
        "sfc_path": config.sfc_path,
        "sfc_username": config.sfc_username,
        "sfc_password": _protect(config.sfc_password),
        "login_timeout_seconds": config.login_timeout_seconds,
        "start_with_windows": config.start_with_windows,
    }
    CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
