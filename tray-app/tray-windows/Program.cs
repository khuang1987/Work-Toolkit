using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

class Program {
    static NotifyIcon tray;
    static string[] targets = new[] { "copilot", "codex", "Copilot" };
    static System.Threading.Timer? checkTimer;

    [STAThread]
    static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        tray = new NotifyIcon();
        tray.Text = "Tray Light";
        tray.Icon = SystemIcons.Application; // placeholder: replace with colored icons (green/yellow/red)

        var menu = new ContextMenuStrip();
        var settings = new ToolStripMenuItem("Settings", null, (s,e) => { /* TODO: open settings window */ });
        var exit = new ToolStripMenuItem("Exit", null, (s,e) => { tray.Visible = false; Application.Exit(); });
        menu.Items.Add(settings);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exit);

        tray.ContextMenuStrip = menu;
        tray.Visible = true;

        checkTimer = new System.Threading.Timer(_ => UpdateStatus(), null, 0, 3000);

        Application.Run();
    }

    static void UpdateStatus() {
        try {
            var procs = Process.GetProcesses();
            var found = procs.Any(p => targets.Contains(p.ProcessName, StringComparer.OrdinalIgnoreCase));
            if (found) {
                // running -> green (placeholder)
                tray.Icon = SystemIcons.Shield; 
            } else {
                // not running -> yellow (placeholder)
                tray.Icon = SystemIcons.Warning;
            }
        } catch (Exception) {
            // error -> red (placeholder)
            tray.Icon = SystemIcons.Error;
        }
    }
}
