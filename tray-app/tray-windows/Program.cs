using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class Program {
    enum State { Unknown, Running, Completed, Error }

    static NotifyIcon tray;
    static string[] targets = new[] { "copilot", "codex" };
    static System.Threading.Timer? checkTimer;
    static Icon? iconGreen, iconYellow, iconRed, iconGray;
    static State lastState = State.Unknown;
n    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern bool DestroyIcon(IntPtr handle);

    [STAThread]
    static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // create runtime icons (colored circles)
        iconGreen = CreateCircleIcon(Color.FromArgb(76, 217, 100), 16);
        iconYellow = CreateCircleIcon(Color.FromArgb(255,204,0), 16);
        iconRed = CreateCircleIcon(Color.FromArgb(255,59,48), 16);
        iconGray = CreateCircleIcon(Color.Gray, 16);

        tray = new NotifyIcon();
        tray.Text = "Tray Light";
        tray.Icon = iconGray;

        var menu = new ContextMenuStrip();
        var targetsMenu = new ToolStripMenuItem("Targets");
        var tCopilot = new ToolStripMenuItem("Copilot") { Checked = true, CheckOnClick = true };
        var tCodex = new ToolStripMenuItem("Codex") { Checked = true, CheckOnClick = true };
        var tCustom = new ToolStripMenuItem("Custom...");
        tCopilot.Click += (_,__) => UpdateTargetsFromMenu(tCopilot, tCodex);
        tCodex.Click += (_,__) => UpdateTargetsFromMenu(tCopilot, tCodex);
        tCustom.Click += (_,__) => ShowCustomDialog();
        targetsMenu.DropDownItems.Add(tCopilot);
        targetsMenu.DropDownItems.Add(tCodex);
        targetsMenu.DropDownItems.Add(new ToolStripSeparator());
        targetsMenu.DropDownItems.Add(tCustom);

        var settings = new ToolStripMenuItem("Settings", null, (s,e) => { /* future */ });
        var exit = new ToolStripMenuItem("Exit", null, (s,e) => { tray.Visible = false; CleanupAndExit(); });
n        menu.Items.Add(targetsMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(settings);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exit);

        tray.ContextMenuStrip = menu;
        tray.Visible = true;

        // start periodic check every 2s
        checkTimer = new System.Threading.Timer(_ => UpdateStatus(), null, 0, 2000);

        Application.ApplicationExit += (_,__) => { Cleanup(); };
        Application.Run();
    }

    static void UpdateTargetsFromMenu(ToolStripMenuItem copilotItem, ToolStripMenuItem codexItem) {
        var list = new System.Collections.Generic.List<string>();
        if (copilotItem.Checked) list.Add("copilot");
        if (codexItem.Checked) list.Add("codex");
        if (list.Count == 0) list.AddRange(new[] { "copilot", "codex" });
        targets = list.ToArray();
    }

    static void ShowCustomDialog() {
        var f = new Form() { Width = 360, Height = 140, Text = "Custom targets", StartPosition = FormStartPosition.CenterScreen };
        var tb = new TextBox() { Left = 12, Top = 12, Width = 320, Text = string.Join(',', targets) };
        var ok = new Button() { Text = "OK", Left = 176, Width = 80, Top = 48, DialogResult = DialogResult.OK };
        var cancel = new Button() { Text = "Cancel", Left = 264, Width = 80, Top = 48, DialogResult = DialogResult.Cancel };
        f.Controls.Add(tb); f.Controls.Add(ok); f.Controls.Add(cancel);
        f.AcceptButton = ok; f.CancelButton = cancel;
        if (f.ShowDialog() == DialogResult.OK) {
            var parts = tb.Text.Split(new[] {',',';',' '}, StringSplitOptions.RemoveEmptyEntries).Select(s=>s.Trim()).Where(s=>s.Length>0).ToArray();
            if (parts.Length>0) targets = parts;
        }
        f.Dispose();
    }

    static void UpdateStatus() {
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
