using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

class Program {
    enum State { Unknown, Running, Completed, Error }

    class Settings {
        public string[] Targets { get; set; } = new[] { "copilot", "codex" };
        public int PollIntervalMs { get; set; } = 2000;
        public bool StartMonitoringOnLaunch { get; set; } = true;
    }
n    static NotifyIcon tray;
    static string[] targets = new[] { "copilot", "codex" };
    static System.Threading.Timer? checkTimer;
    static Icon? iconGreen, iconYellow, iconRed, iconGray;
    static State lastState = State.Unknown;
    static Settings settings = new Settings();
    static string settingsPath;
    static ToolStripMenuItem? startStopMenuItem;
n    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern bool DestroyIcon(IntPtr handle);
n    [STAThread]
    static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // settings file in %APPDATA%\TrayLight\settings.json
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var appDir = Path.Combine(appData, "TrayLight");
        Directory.CreateDirectory(appDir);
        settingsPath = Path.Combine(appDir, "settings.json");
        LoadSettings();
        targets = settings.Targets;
n        // create runtime icons (colored circles)
        iconGreen = CreateCircleIcon(Color.FromArgb(76, 217, 100), 16);
        iconYellow = CreateCircleIcon(Color.FromArgb(255,204,0), 16);
        iconRed = CreateCircleIcon(Color.FromArgb(255,59,48), 16);
        iconGray = CreateCircleIcon(Color.Gray, 16);
n        tray = new NotifyIcon();
        tray.Text = "Tray Light";
        tray.Icon = iconGray;
n        var menu = new ContextMenuStrip();
n        startStopMenuItem = new ToolStripMenuItem(settings.StartMonitoringOnLaunch ? "Stop Monitoring" : "Start Monitoring");
        startStopMenuItem.Click += (_, __) => { ToggleMonitoring(); };

        var targetsMenu = new ToolStripMenuItem("Targets");
        var tCopilot = new ToolStripMenuItem("Copilot") { Checked = settings.Targets.Contains("copilot", StringComparer.OrdinalIgnoreCase), CheckOnClick = true };
        var tCodex = new ToolStripMenuItem("Codex") { Checked = settings.Targets.Contains("codex", StringComparer.OrdinalIgnoreCase), CheckOnClick = true };
        var tCustom = new ToolStripMenuItem("Custom...");
        tCopilot.Click += (_,__) => UpdateTargetsFromMenu(tCopilot, tCodex);
        tCodex.Click += (_,__) => UpdateTargetsFromMenu(tCopilot, tCodex);
        tCustom.Click += (_,__) => ShowCustomDialog();
        targetsMenu.DropDownItems.Add(tCopilot);
        targetsMenu.DropDownItems.Add(tCodex);
        targetsMenu.DropDownItems.Add(new ToolStripSeparator());
        targetsMenu.DropDownItems.Add(tCustom);
n        var settingsMenu = new ToolStripMenuItem("Settings", null, (s,e) => { ShowSettingsDialog(); });
        var publishItem = new ToolStripMenuItem("Publish (single file)", null, (s,e) => { RunPublish(); });
        var exit = new ToolStripMenuItem("Exit", null, (s,e) => { tray.Visible = false; CleanupAndExit(); });
n        menu.Items.Add(startStopMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(targetsMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(settingsMenu);
        menu.Items.Add(publishItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exit);
n        tray.ContextMenuStrip = menu;
        tray.Visible = true;
n        Application.ApplicationExit += (_,__) => { Cleanup(); };
n        if (settings.StartMonitoringOnLaunch) StartMonitoring();

        Application.Run();
    }
n    static void LoadSettings() {
        try {
            if (File.Exists(settingsPath)) {
                var txt = File.ReadAllText(settingsPath);
                settings = JsonSerializer.Deserialize<Settings>(txt) ?? new Settings();
            }
        } catch { settings = new Settings(); }
    }
n    static void SaveSettings() {
        try {
            var txt = JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(settingsPath, txt);
        } catch { }
    }

    static void StartMonitoring() {
        StopMonitoring();
        targets = settings.Targets;
        checkTimer = new System.Threading.Timer(_ => UpdateStatus(), null, 0, Math.Max(500, settings.PollIntervalMs));
        SetState(State.Unknown);
        startStopMenuItem.Text = "Stop Monitoring";
    }
n    static void StopMonitoring() {
        try { checkTimer?.Dispose(); checkTimer = null; } catch {}
        SetState(State.Unknown);
        if (startStopMenuItem!=null) startStopMenuItem.Text = "Start Monitoring";
    }

    static void ToggleMonitoring() {
        if (checkTimer == null) {
            StartMonitoring();
            settings.StartMonitoringOnLaunch = true;
            SaveSettings();
        } else {
            StopMonitoring();
            settings.StartMonitoringOnLaunch = false;
            SaveSettings();
        }
    }

    static void UpdateTargetsFromMenu(ToolStripMenuItem copilotItem, ToolStripMenuItem codexItem) {
        var list = new System.Collections.Generic.List<string>();
        if (copilotItem.Checked) list.Add("copilot");
        if (codexItem.Checked) list.Add("codex");
        if (list.Count == 0) list.AddRange(new[] { "copilot", "codex" });
        settings.Targets = list.ToArray();
        targets = settings.Targets;
        SaveSettings();
    }
n    static void ShowCustomDialog() {
        var f = new Form() { Width = 420, Height = 160, Text = "Custom targets", StartPosition = FormStartPosition.CenterScreen };
        var lbl = new Label() { Left = 12, Top = 12, Width = 380, Text = "Comma-separated process names (without .exe), e.g. copilot,codex" };
        var tb = new TextBox() { Left = 12, Top = 36, Width = 380, Text = string.Join(',', settings.Targets) };
        var ok = new Button() { Text = "OK", Left = 236, Width = 80, Top = 72, DialogResult = DialogResult.OK };
        var cancel = new Button() { Text = "Cancel", Left = 320, Width = 80, Top = 72, DialogResult = DialogResult.Cancel };
        f.Controls.Add(lbl); f.Controls.Add(tb); f.Controls.Add(ok); f.Controls.Add(cancel);
        f.AcceptButton = ok; f.CancelButton = cancel;
        if (f.ShowDialog() == DialogResult.OK) {
            var parts = tb.Text.Split(new[] {',',';',' '}, StringSplitOptions.RemoveEmptyEntries).Select(s=>s.Trim()).Where(s=>s.Length>0).ToArray();
            if (parts.Length>0) {
                settings.Targets = parts;
                targets = settings.Targets;
                SaveSettings();
            }
        }
        f.Dispose();
    }

    static void ShowSettingsDialog() {
        var f = new Form() { Width = 420, Height = 200, Text = "Settings", StartPosition = FormStartPosition.CenterScreen };
        var lbl1 = new Label() { Left = 12, Top = 12, Width = 380, Text = "Poll interval (ms):" };
        var num = new NumericUpDown() { Left = 12, Top = 36, Width = 120, Minimum = 500, Maximum = 60000, Value = settings.PollIntervalMs };
        var chk = new CheckBox() { Left = 150, Top = 38, Width = 220, Text = "Start monitoring on launch", Checked = settings.StartMonitoringOnLaunch };
        var lbl2 = new Label() { Left = 12, Top = 72, Width = 380, Text = "Targets (comma separated):" };
        var tb = new TextBox() { Left = 12, Top = 96, Width = 380, Text = string.Join(',', settings.Targets) };
        var ok = new Button() { Text = "OK", Left = 236, Width = 80, Top = 132, DialogResult = DialogResult.OK };
        var cancel = new Button() { Text = "Cancel", Left = 320, Width = 80, Top = 132, DialogResult = DialogResult.Cancel };
        f.Controls.Add(lbl1); f.Controls.Add(num); f.Controls.Add(chk); f.Controls.Add(lbl2); f.Controls.Add(tb); f.Controls.Add(ok); f.Controls.Add(cancel);
        f.AcceptButton = ok; f.CancelButton = cancel;
        if (f.ShowDialog() == DialogResult.OK) {
            settings.PollIntervalMs = (int)num.Value;
            settings.StartMonitoringOnLaunch = chk.Checked;
            settings.Targets = tb.Text.Split(new[] {',',';',' '}, StringSplitOptions.RemoveEmptyEntries).Select(s=>s.Trim()).Where(s=>s.Length>0).ToArray();
            targets = settings.Targets;
            SaveSettings();
            if (checkTimer != null) {
                // restart with new interval
                StartMonitoring();
            }
        }
        f.Dispose();
    }
n    static void UpdateStatus() {
        try {
            var procs = Process.GetProcesses();
            var found = procs.Any(p => targets.Contains(p.ProcessName, StringComparer.OrdinalIgnoreCase));
            if (found) {
                SetState(State.Running);
            } else {
                // if previously running, mark Completed, otherwise Unknown/gray
                if (lastState == State.Running) SetState(State.Completed);
                else SetState(State.Unknown);
            }
        } catch (Exception) {
            SetState(State.Error);
        }
    }

    static void SetState(State s) {
        if (s == lastState) return;
        lastState = s;
        switch(s) {
            case State.Running: tray.Icon = iconGreen; tray.Text = "Tray Light - Running"; break;
            case State.Completed: tray.Icon = iconYellow; tray.Text = "Tray Light - Completed"; break;
            case State.Error: tray.Icon = iconRed; tray.Text = "Tray Light - Error"; break;
            default: tray.Icon = iconGray; tray.Text = "Tray Light"; break;
        }
    }

    static Icon CreateCircleIcon(Color fill, int size) {
        var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp)) {
            g.Clear(Color.Transparent);
            using (var brush = new SolidBrush(fill)) {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.FillEllipse(brush, 0, 0, size-1, size-1);
                using (var pen = new Pen(Color.FromArgb(200,0,0,0))) g.DrawEllipse(pen, 0, 0, size-1, size-1);
            }
        }
        IntPtr h = bmp.GetHicon();
        var ico = Icon.FromHandle(h);
        var clone = (Icon)ico.Clone();
        ico.Dispose();
        DestroyIcon(h);
        bmp.Dispose();
        return clone;
    }

    static void Cleanup() {
        try { checkTimer?.Dispose(); } catch {}
        try { if (iconGreen!=null) iconGreen.Dispose(); } catch {}
        try { if (iconYellow!=null) iconYellow.Dispose(); } catch {}
        try { if (iconRed!=null) iconRed.Dispose(); } catch {}
        try { if (iconGray!=null) iconGray.Dispose(); } catch {}
    }
n    static void CleanupAndExit() {
        Cleanup();
        Application.Exit();
    }
}
