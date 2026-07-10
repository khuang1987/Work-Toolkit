# Office Assistant

Windows tray assistant for daily office automation.

## Features

- Runs in the system tray.
- Left click the tray icon to open the settings window.
- Right click the tray icon and choose `SFC 登录` to open and log in to SFC.
- Saves credentials under `%APPDATA%\MedtronicOfficeAssistant\config.json`.
- Password is protected with Windows DPAPI for the current Windows user.

## Setup

```powershell
cd python-scripts\office-assistant
.\setup.bat
```

Run with console logs:

```powershell
.\run_console.bat
```

Run normally:

```powershell
.\run.bat
```

## Start With Windows

Open the assistant window from the tray icon, check `开机启动并常驻托盘`, then click `保存设置`.

This creates a shortcut in the current user's Windows Startup folder:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MedtronicOfficeAssistant.lnk
```

The assistant starts hidden and stays resident in the system tray.

Default SFC path:

```text
C:\1_SFC软件安装包\SFC正式\TsSFC.Client.MgmtSys.exe
```

Open the tray window once and save your SFC username/password before using `SFC 登录`.
