from pathlib import Path

import pythoncom
from win32com.client import Dispatch


APP_NAME = "MedtronicOfficeAssistant"


def get_startup_shortcut_path() -> Path:
    startup_dir = Path.home() / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    return startup_dir / f"{APP_NAME}.lnk"


def set_startup_enabled(enabled: bool) -> None:
    shortcut_path = get_startup_shortcut_path()

    if not enabled:
        if shortcut_path.exists():
            shortcut_path.unlink()
        return

    project_dir = Path(__file__).resolve().parents[1]
    run_bat = project_dir / "run.bat"
    icon_path = project_dir / "assets" / "office-assistant-icon.ico"

    shortcut_path.parent.mkdir(parents=True, exist_ok=True)
    pythoncom.CoInitialize()
    try:
        shell = Dispatch("WScript.Shell")
        shortcut = shell.CreateShortcut(str(shortcut_path))
        shortcut.TargetPath = str(run_bat)
        shortcut.WorkingDirectory = str(project_dir)
        if icon_path.exists():
            shortcut.IconLocation = str(icon_path)
        shortcut.Description = "Medtronic Office Assistant"
        shortcut.Save()
    finally:
        pythoncom.CoUninitialize()


def is_startup_enabled() -> bool:
    return get_startup_shortcut_path().exists()
