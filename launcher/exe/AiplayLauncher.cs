// AIPLAY Studio.exe — a small Windows front door for launcher\launcher.mjs.
//
// It does what AIPLAY Studio.cmd does (find Node.js 20+, preferring the private
// copy in .\node that AIPLAY Studio Setup.exe puts there, fetch the npm
// packages if missing, run the launcher) without a console window, and keeps a
// tray icon while the launcher runs: click it to reopen the launcher window,
// right-click to open Studio or to stop Studio and quit. The launcher's output
// goes to %USERPROFILE%\.aiplay-studio\launcher.log.
//
// Build: node scripts/build-launcher-exe.mjs (uses the C# compiler that ships
// with Windows' .NET Framework 4; nothing to install).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("AIPLAY Studio")]
[assembly: AssemblyDescription("AIPLAY Studio launcher")]
[assembly: AssemblyProduct("AIPLAY Studio")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const string Title = "AIPLAY Studio";

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main()
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        if (!File.Exists(Path.Combine(root, @"launcher\launcher.mjs")))
        {
            Fail("AIPLAY Studio.exe has to stay in the AIPLAY Studio folder, next to the \"launcher\" and \"server\" folders.\n\nLooked in:\n" + root);
            return 1;
        }

        string path = MergedPath();
        // A private Node.js the installer put next to this exe comes first, so a
        // PC with no Node at all needs nothing installed. It is only ever on the
        // PATH of Studio's own processes, never the machine's.
        string privateNode = Path.Combine(root, "node");
        if (File.Exists(Path.Combine(privateNode, "node.exe"))) path = privateNode + ";" + path;
        string node = FindOnPath("node.exe", path);
        if (node == null)
        {
            if (MessageBox.Show("Node.js is not installed, and Studio's server is written in it.\n\nOpen nodejs.org to get the LTS installer? Run AIPLAY Studio again afterwards.",
                    Title, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                Process.Start("https://nodejs.org/");
            return 1;
        }

        int major = NodeMajor(node, root, path);
        if (major < 20)
        {
            Fail("Please update Node.js to version 20 or newer (found " + (major > 0 ? "version " + major : "an unreadable version") + ").\n\n" + node);
            return 1;
        }

        if (!DepsPresent(root))
        {
            string npm = Path.Combine(Path.GetDirectoryName(node), "npm.cmd");
            string npmCmd = File.Exists(npm) ? "\"" + npm + "\"" : "npm";
            var psi = new ProcessStartInfo("cmd.exe",
                "/s /c \"title AIPLAY Studio - fetching dependencies & echo Fetching dependencies (a few seconds)... & " + npmCmd +
                " install --omit=dev --no-audit --no-fund || (echo. & echo npm install failed. Are you online? & pause)\"");
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.EnvironmentVariables["PATH"] = path;
            using (var p = Process.Start(psi)) p.WaitForExit();
            if (!DepsPresent(root))
            {
                Fail("Studio's npm packages are still missing (ws, three, gltf-validator, @pixiv/three-vrm).\n\nOpen a terminal in\n" + root + "\nand run: npm install --omit=dev");
                return 1;
            }
        }

        var tray = new TrayApp(root, node, path);
        if (!tray.Start()) return 1;
        Application.Run(tray);
        return tray.ExitCode;
    }

    static void Fail(string message)
    {
        MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    // Explorer's PATH can predate a Node.js install; the registry has the current one.
    static string MergedPath()
    {
        var parts = new List<string>();
        foreach (var src in new[] {
            Environment.GetEnvironmentVariable("PATH"),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) })
        {
            if (string.IsNullOrEmpty(src)) continue;
            foreach (var raw in src.Split(';'))
            {
                string dir = Environment.ExpandEnvironmentVariables(raw.Trim());
                if (dir.Length > 0 && !parts.Exists(x => string.Equals(x, dir, StringComparison.OrdinalIgnoreCase)))
                    parts.Add(dir);
            }
        }
        string pf = Environment.GetEnvironmentVariable("ProgramFiles");
        if (!string.IsNullOrEmpty(pf)) parts.Add(Path.Combine(pf, "nodejs"));
        return string.Join(";", parts.ToArray());
    }

    static string FindOnPath(string exe, string path)
    {
        foreach (var dir in path.Split(';'))
        {
            try
            {
                string candidate = Path.Combine(dir, exe);
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return null;
    }

    static int NodeMajor(string node, string root, string path)
    {
        try
        {
            var psi = new ProcessStartInfo(node, "-p \"process.versions.node.split('.')[0]\"");
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.EnvironmentVariables["PATH"] = path;
            using (var p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(10000);
                int n;
                return int.TryParse(output, out n) ? n : 0;
            }
        }
        catch { return 0; }
    }

    static bool DepsPresent(string root)
    {
        foreach (var pkg in new[] { "ws", "three", "gltf-validator", "@pixiv/three-vrm" })
            if (!Directory.Exists(Path.Combine(root, "node_modules", pkg))) return false;
        return true;
    }
}

sealed class TrayApp : ApplicationContext
{
    const string Title = "AIPLAY Studio";
    readonly string root, node, path, logPath;
    readonly Queue<string> tail = new Queue<string>();
    readonly SynchronizationContext ui;
    readonly NotifyIcon icon = new NotifyIcon();
    Process proc;
    StreamWriter log;
    string baseUrl;
    volatile bool quitting;
    public int ExitCode;

    public TrayApp(string root, string node, string path)
    {
        this.root = root;
        this.node = node;
        this.path = path;
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".aiplay-studio");
        logPath = Path.Combine(dir, "launcher.log");
        try { Directory.CreateDirectory(dir); log = new StreamWriter(logPath, false, new UTF8Encoding(false)); log.AutoFlush = true; }
        catch { log = null; }

        if (SynchronizationContext.Current == null)
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        ui = SynchronizationContext.Current;

        icon.Text = Title;
        icon.Icon = LoadIcon();
        var menu = new ContextMenuStrip();
        var open = menu.Items.Add("Open launcher", null, (s, e) => Post("api/show"));
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add("Open Studio in browser", null, (s, e) => Post("api/open"));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Stop Studio and quit", null, (s, e) => Quit());
        icon.ContextMenuStrip = menu;
        icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Post("api/show"); };
        icon.BalloonTipClicked += (s, e) => Post("api/show");

        Microsoft.Win32.SystemEvents.SessionEnding += (s, e) => KillLauncher();
        Application.ApplicationExit += (s, e) => { KillLauncher(); icon.Visible = false; };
    }

    Icon LoadIcon()
    {
        try
        {
            string ico = Path.Combine(root, @"launcher\aiplay.ico");
            if (File.Exists(ico)) return new Icon(ico, SystemInformation.SmallIconSize);
        }
        catch { }
        return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    }

    public bool Start()
    {
        var psi = new ProcessStartInfo(node, "\"launcher\\launcher.mjs\"");
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        // A console without a window: Studio, ComfyUI and every tool they run
        // inherit it, so nothing flashes a console on screen.
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.EnvironmentVariables["PATH"] = path;
        psi.EnvironmentVariables["AIPLAY_LAUNCHER_HOST"] = "exe";
        try
        {
            proc = new Process();
            proc.StartInfo = psi;
            proc.EnableRaisingEvents = true;
            proc.OutputDataReceived += (s, e) => OnLine(e.Data);
            proc.ErrorDataReceived += (s, e) => OnLine(e.Data);
            proc.Exited += (s, e) => ui.Post(_ => OnExit(), null);
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not start the launcher:\n" + ex.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }
    }

    void OnLine(string line)
    {
        if (line == null) return;
        lock (tail)
        {
            tail.Enqueue(line);
            while (tail.Count > 30) tail.Dequeue();
            try { if (log != null) log.WriteLine(line); } catch { }
        }
        string t = line.Trim();
        if (t.StartsWith("launcher: http"))
        {
            baseUrl = t.Substring("launcher: ".Length).Trim();
            if (!baseUrl.EndsWith("/")) baseUrl += "/";
            ui.Post(_ => icon.Visible = true, null);
        }
        else if (t.StartsWith("Launcher window closed; Studio is still running"))
        {
            ui.Post(_ => icon.ShowBalloonTip(6000, "Studio is still running",
                "Click the AIPLAY icon to reopen the launcher. Right-click it to stop Studio and quit.", ToolTipIcon.Info), null);
        }
    }

    void OnExit()
    {
        int code = 0;
        try { code = proc.ExitCode; } catch { }
        icon.Visible = false;
        if (code != 0 && !quitting)
        {
            string lines;
            lock (tail) lines = string.Join("\n", tail.ToArray());
            MessageBox.Show("The launcher stopped (exit code " + code + ").\n\n" + lines + "\n\nFull log: " + logPath,
                Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        ExitCode = code;
        try { if (log != null) log.Dispose(); } catch { }
        ExitThread();
    }

    void Post(string route)
    {
        if (baseUrl == null) return;
        string url = baseUrl + route;
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.Proxy = null;
                req.Timeout = 8000;
                req.ContentType = "application/json";
                byte[] body = Encoding.UTF8.GetBytes("{}");
                req.ContentLength = body.Length;
                using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                using (req.GetResponse()) { }
            }
            catch { }
        });
    }

    void Quit()
    {
        quitting = true;
        icon.Visible = false;
        string url = baseUrl;
        ThreadPool.QueueUserWorkItem(_ =>
        {
            if (url != null)
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(url + "api/quit");
                    req.Method = "POST";
                    req.Proxy = null;
                    req.Timeout = 5000;
                    req.ContentLength = 0;
                    using (req.GetResponse()) { }
                }
                catch { }
            }
            try { if (!proc.WaitForExit(15000)) KillLauncher(); } catch { }
        });
    }

    // Last resort: the launcher and everything under it (Studio, ComfyUI).
    void KillLauncher()
    {
        try
        {
            if (proc == null || proc.HasExited) return;
            var psi = new ProcessStartInfo("taskkill", "/PID " + proc.Id + " /T /F");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (var k = Process.Start(psi)) k.WaitForExit(10000);
        }
        catch { }
    }
}
