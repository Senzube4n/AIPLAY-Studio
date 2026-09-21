// AIPLAY Studio Setup.exe — a one-time installer. Run it, press Install, throw it away.
//
// It never has to be rebuilt when Studio changes, because it knows nothing about
// Studio beyond two repository names:
//
//   1. asks GitHub which commit `main` is on, for Bucky's fork and Senzu's
//      original, and how far apart the two are (ahead / behind);
//   2. downloads that commit as a zip, straight from GitHub, no account;
//   3. unpacks only what the zip's own install.json lists (no docs, no notes,
//      no website banners). A repository without the file gets a built-in list;
//   4. writes server\version.gen.json, so the build line names its commit
//      instead of saying "unknown" (a zip has no .git to ask);
//   5. uses the PC's Node.js 20+ if there is one, and otherwise puts the official
//      portable Node.js from nodejs.org into .\node, checked against the
//      SHA-256 list nodejs.org publishes. No admin prompt, no PATH change:
//      only Studio's own processes ever see it;
//   6. fetches the three npm packages, so the first start is instant;
//   7. swaps the finished folder into place in one move, so a failure halfway
//      leaves the previous install (or nothing) rather than half of one;
//   8. Start menu and desktop shortcuts, and an entry in Apps > Installed apps
//      (per user, no admin) that runs a generated uninstall script.
//
// It never touches ComfyUI, Python, CUDA, ROCm or torch, and never downloads a
// model. Your songs, settings and any engine live in %USERPROFILE%\.aiplay-studio,
// outside the install folder, so a reinstall never touches them.
//
// Updates after this are the launcher's job, not this file's.
//
// Build: node scripts/build-installer.mjs (the C# compiler of .NET Framework 4,
// which every Windows 10/11 already has; nothing to install).
//
// CHANGING THIS FILE MEANS PUBLISHING A NEW INSTALLER: bump SetupVersion and the
// assembly versions below, build, sign, and publish a GitHub release. RELEASING.md
// has the exact steps.
//
// Unattended, for testing:  "AIPLAY Studio Setup.exe" /quiet /dir:"C:\somewhere"
//   [/repo:senzu|bucky] [/noshortcuts] [/privatenode]
// /noshortcuts also skips the Installed apps entry; /privatenode downloads the
// private Node.js even when the PC has one. A log is always written to
// %TEMP%\aiplay-setup.log.
//
// /shot:<prefix> saves the three pages as <prefix>-choose/-work/-done.png and
// exits, installing nothing: how the window is reviewed without running it.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("AIPLAY Studio Setup")]
[assembly: AssemblyDescription("Installs AIPLAY Studio from GitHub")]
[assembly: AssemblyProduct("AIPLAY Studio")]
[assembly: AssemblyCompany("AIPLAY Studio")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
// Without this a hand-compiled exe runs with the .NET 4.0 path rules, which
// refuse any path over 260 characters. npm's own folders go deeper than that.
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

static class Program
{
    public const string Title = "AIPLAY Studio";
    public const string SetupVersion = "1.0";

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

    [STAThread]
    static int Main(string[] args)
    {
        // TLS 1.2: GitHub and nodejs.org refuse anything older, and .NET 4's
        // default on an un-updated Windows 10 can still be TLS 1.0.
        try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { }
        try { AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false); AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false); } catch { }
        Log.Open();
        var opt = Options.Parse(args);
        if (opt.Quiet)
        {
            try { AttachConsole(-1); } catch { }
            return Quiet(opt);
        }
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(opt));
        return 0;
    }

    static int Quiet(Options opt)
    {
        var src = Sources.ByKey(opt.Repo);
        if (src == null) { Log.Say("unknown /repo: " + opt.Repo + " (bucky or senzu)"); return 2; }
        Sources.Check(Sources.All);
        var job = new Installer(src, opt.Dir ?? Installer.DefaultDir(), !opt.NoShortcuts, !opt.NoShortcuts, opt.PrivateNode);
        // Byte counters would be thousands of lines; the window shows those.
        job.Detail += (text) => { if (text.Length > 0 && !text.Contains(" MB")) Log.Say("      " + text); };
        try
        {
            var r = job.Run();
            Log.Say("installed " + r.BuildLine + " into " + r.Dir);
            foreach (var n in r.Notes) Log.Say("note: " + n);
            return 0;
        }
        catch (Exception ex) { Log.Say("FAILED: " + ex.Message); return 1; }
    }
}

sealed class Options
{
    public bool Quiet, NoShortcuts, PrivateNode;
    public string Dir, Repo = "senzu", Shot;

    public static Options Parse(string[] args)
    {
        var o = new Options();
        foreach (var raw in args)
        {
            string a = raw.Trim();
            string low = a.ToLowerInvariant();
            if (low == "/quiet" || low == "--quiet") o.Quiet = true;
            else if (low == "/noshortcuts" || low == "--noshortcuts") o.NoShortcuts = true;
            else if (low == "/privatenode" || low == "--privatenode") o.PrivateNode = true;
            else if (low.StartsWith("/dir:") || low.StartsWith("--dir=")) o.Dir = a.Substring(a.IndexOfAny(new[] { ':', '=' }) + 1).Trim('"');
            else if (low.StartsWith("/shot:")) o.Shot = a.Substring(6).Trim('"');
            else if (low.StartsWith("/repo:") || low.StartsWith("--repo=")) o.Repo = low.Substring(low.IndexOfAny(new[] { ':', '=' }) + 1);
        }
        return o;
    }
}

static class Log
{
    static StreamWriter file;
    static readonly object gate = new object();

    public static void Open()
    {
        try { file = new StreamWriter(Path.Combine(Path.GetTempPath(), "aiplay-setup.log"), false, new UTF8Encoding(false)); file.AutoFlush = true; }
        catch { file = null; }
    }

    public static void Say(string line)
    {
        lock (gate)
        {
            try { if (file != null) file.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + line); } catch { }
            try { Console.WriteLine(line); } catch { }
        }
    }
}

// ─── the two repositories ──────────────────────────────────────────────────

sealed class Source
{
    public string Key, Name, Letter, Repo;
    // Filled in by Sources.Check; null when GitHub could not be asked.
    public string Sha, Date, Newest, Relation, Why;
    public int RelationLevel; // 0 plain, 1 good, 2 attention

    public Source(string key, string name, string letter, string repo) { Key = key; Name = name; Letter = letter; Repo = repo; }

    public string Owner { get { return Repo.Split('/')[0]; } }
    public string Short { get { return Sha == null ? "" : Sha.Substring(0, Math.Min(7, Sha.Length)); } }

    /// "B 26.09.21 · 7e0159f", the same shape as the app's own build line.
    public string BuildLine
    {
        get
        {
            if (Sha == null) return Letter;
            return Letter + " " + Stamp(Date) + " · " + Short;
        }
    }

    public static string Stamp(string iso)
    {
        if (string.IsNullOrEmpty(iso) || iso.Length < 10) return "unknown";
        return iso.Substring(2, 2) + "." + iso.Substring(5, 2) + "." + iso.Substring(8, 2);
    }
}

static class Sources
{
    // The original first: it is the default. A fork is one more line here, and
    // is compared against the original (ahead / behind).
    public static readonly Source[] All = {
        new Source("senzu", "Senzu", "S", "Senzube4n/AIPLAY-Studio"),
        new Source("bucky", "Bucky", "B", "bani4kaskashka/AIPLAY-Studio-Bucky-Fork"),
    };
    public static Source Original { get { return All[0]; } }

    public static Source ByKey(string key)
    {
        foreach (var s in All) if (s.Key == key) return s;
        return null;
    }

    /// Asks GitHub where each main is, and how each fork stands against the
    /// original. 1 + 2 per fork requests; GitHub allows 60 an hour per address.
    /// Never throws: whatever could not be asked stays null and says why.
    public static void Check(Source[] all)
    {
        foreach (var s in all)
        {
            try
            {
                var j = Net.Json(Net.GetString("https://api.github.com/repos/" + s.Repo + "/commits/main"));
                s.Sha = (string)j["sha"];
                var c = (Dictionary<string, object>)j["commit"];
                s.Date = (string)((Dictionary<string, object>)c["committer"])["date"];
                s.Newest = ((string)c["message"]).Split('\n')[0].Trim();
            }
            catch (Exception ex) { s.Why = ex.Message; }
        }
        var orig = Original;
        if (orig.Sha != null) { orig.Relation = "the original, where Studio is made"; orig.RelationLevel = 0; }
        foreach (var s in all)
        {
            if (s == orig || s.Sha == null || orig.Sha == null) continue;
            try
            {
                // Across the fork network: base is the original's main, head the
                // fork's. ahead = the fork's commits the original lacks.
                var j = Net.Json(Net.GetString("https://api.github.com/repos/" + orig.Repo + "/compare/" + orig.Sha + "..." + s.Sha));
                int ahead = Convert.ToInt32(j["ahead_by"]), behind = Convert.ToInt32(j["behind_by"]);
                if (ahead == 0 && behind == 0) { s.Relation = "same as " + orig.Name + "'s build"; s.RelationLevel = 1; }
                else
                {
                    s.Relation = ahead + " ahead of " + orig.Name + "'s build · " + behind + " behind";
                    s.RelationLevel = behind > 0 ? 2 : 1;
                }
            }
            catch { s.Relation = null; }
        }
    }
}

// ─── the network, three calls deep ─────────────────────────────────────────

static class Net
{
    const string UserAgent = "AIPLAY-Studio-Setup";

    static HttpWebRequest Request(string url, int timeoutMs)
    {
        var r = (HttpWebRequest)WebRequest.Create(url);
        // GitHub refuses a request with no user agent. This names the program
        // and nothing else about the machine.
        r.UserAgent = UserAgent;
        r.Accept = url.Contains("api.github.com") ? "application/vnd.github+json" : "*/*";
        r.Timeout = timeoutMs;
        r.ReadWriteTimeout = timeoutMs;
        r.AllowAutoRedirect = true;
        return r;
    }

    public static string GetString(string url)
    {
        try
        {
            using (var resp = (HttpWebResponse)Request(url, 15000).GetResponse())
            using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return rd.ReadToEnd();
        }
        catch (WebException ex) { throw new InstallException(Explain(url, ex)); }
    }

    /// Streams to a file. `progress(done, total)`; total is -1 when the server
    /// does not say (GitHub's zips usually do not).
    public static void Download(string url, string file, Action<long, long> progress)
    {
        try
        {
            using (var resp = (HttpWebResponse)Request(url, 60000).GetResponse())
            using (var input = resp.GetResponseStream())
            using (var output = File.Create(file))
            {
                long total = resp.ContentLength, done = 0;
                var buf = new byte[1 << 16];
                int n, tick = 0;
                while ((n = input.Read(buf, 0, buf.Length)) > 0)
                {
                    output.Write(buf, 0, n);
                    done += n;
                    if (++tick % 16 == 0) progress(done, total);
                }
                progress(done, total);
            }
        }
        catch (WebException ex) { throw new InstallException(Explain(url, ex)); }
    }

    static string Explain(string url, WebException ex)
    {
        string host = new Uri(url).Host;
        var resp = ex.Response as HttpWebResponse;
        if (resp != null && ((int)resp.StatusCode == 403 || (int)resp.StatusCode == 429) && host.Contains("github"))
            return "GitHub is limiting requests from this address (60 an hour without an account). Try again in a while.";
        if (resp != null) return host + " answered " + (int)resp.StatusCode + ".";
        if (ex.Status == WebExceptionStatus.Timeout) return host + " did not answer in time.";
        return "Could not reach " + host + ". Are you online? (" + ex.Message + ")";
    }

    public static Dictionary<string, object> Json(string text)
    {
        var js = new JavaScriptSerializer();
        js.MaxJsonLength = int.MaxValue;
        return js.Deserialize<Dictionary<string, object>>(text);
    }

    public static object JsonAny(string text)
    {
        var js = new JavaScriptSerializer();
        js.MaxJsonLength = int.MaxValue;
        return js.DeserializeObject(text);
    }
}

static class LongPath
{
    const string Prefix = @"\\?\";

    /// The \\?\ prefix lifts Windows' 260-character limit for this one call.
    public static string Of(string p)
    {
        p = Path.GetFullPath(p);
        return p.StartsWith(Prefix) || p.Length < 240 ? p : Prefix + p;
    }
    public static void DeleteDir(string d)
    {
        if (Directory.Exists(d)) Directory.Delete(Prefix + Path.GetFullPath(d), true);
    }
}

sealed class InstallException : Exception { public InstallException(string m) : base(m) { } }

// ─── the install itself ────────────────────────────────────────────────────

sealed class InstallResult
{
    public string Dir, BuildLine, Exe;
    public List<string> Notes = new List<string>();
}

sealed class Installer
{
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPLAYStudio";
    const int Steps = 6;

    // What ships when a repository has no install.json yet. Kept to what the
    // app needs at run time; the repository's own list wins whenever it exists.
    static readonly string[] DefaultInclude = { "server", "web", "workflows", "launcher", "scripts",
        "package.json", "package-lock.json", "AIPLAY Studio.exe", "AIPLAY Studio.cmd", "LICENSE", "NOTICE" };
    static readonly string[] DefaultExclude = { "*.md" };
    static readonly string[] DefaultKeep = { "LICENSE*", "NOTICE*" };

    readonly Source src;
    readonly string dir;
    readonly bool startMenu, desktop, forcePrivateNode;

    public event Action<int, int, string> Step = delegate { };
    public event Action<string> Detail = delegate { };
    public event Action<double> Progress = delegate { };

    public Installer(Source src, string dir, bool startMenu, bool desktop, bool forcePrivateNode)
    {
        this.src = src;
        this.dir = Path.GetFullPath(dir.Trim().TrimEnd('\\'));
        this.startMenu = startMenu;
        this.desktop = desktop;
        this.forcePrivateNode = forcePrivateNode;
    }

    public static string DefaultDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AIPLAY Studio");
    }

    /// Where a previous install says it lives, or null.
    public static string ExistingDir()
    {
        try
        {
            using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                string d = k == null ? null : k.GetValue("InstallLocation") as string;
                if (!string.IsNullOrEmpty(d) && Directory.Exists(d)) return d;
            }
        }
        catch { }
        return Directory.Exists(DefaultDir()) && IsStudio(DefaultDir()) ? DefaultDir() : null;
    }

    public static bool IsStudio(string d)
    {
        return File.Exists(Path.Combine(d, "install-info.json")) || File.Exists(Path.Combine(d, @"launcher\launcher.mjs"));
    }

    void Say(int n, string text) { Log.Say("[" + n + "/" + Steps + "] " + text); Step(n, Steps, text); Progress(-1); }

    public InstallResult Run()
    {
        var result = new InstallResult { Dir = dir };

        /* The one refusal that protects somebody's files: only an empty folder,
         * a new one, or a previous Studio install is ever replaced. */
        if (Path.GetPathRoot(dir).TrimEnd('\\') == dir.TrimEnd('\\'))
            throw new InstallException("Pick a folder, not the root of a drive.");
        if (Directory.Exists(dir))
        {
            if (Directory.Exists(Path.Combine(dir, ".git")))
                throw new InstallException("That folder is a git clone. Update it with git pull instead; the installer will not replace it.");
            if (!IsStudio(dir) && Directory.GetFileSystemEntries(dir).Length > 0)
                throw new InstallException("That folder already has other files in it. Pick an empty folder, or a new one.");
        }
        string parent = Path.GetDirectoryName(dir);
        Directory.CreateDirectory(parent);
        // Beside the target, so the final swap is a rename on the same drive.
        // Short names: npm's deepest folders already use most of Windows' 260.
        string work = Path.Combine(parent, "~aiplay" + (DateTime.Now.Ticks % 100000));
        string stage = Path.Combine(work, "a");
        Directory.CreateDirectory(stage);
        Log.Say("installing " + src.Repo + " into " + dir);
        try
        {
            // 1. Which commit.
            Say(1, "Asking GitHub for " + src.Name + "'s newest build");
            if (src.Sha == null) Sources.Check(new[] { src });
            if (src.Sha == null) throw new InstallException(src.Why ?? "GitHub did not say which commit is newest.");
            Detail(src.BuildLine + "  " + src.Newest);

            // 2. Download it.
            Say(2, "Downloading AIPLAY Studio " + src.BuildLine);
            string zip = Path.Combine(work, "studio.zip");
            Net.Download("https://codeload.github.com/" + src.Repo + "/zip/" + src.Sha, zip, (done, total) =>
            {
                Detail(Mb(done) + (total > 0 ? " of " + Mb(total) : "") + " downloaded");
                Progress(total > 0 ? (double)done / total : -1);
            });

            // 3. Unpack what install.json names.
            Say(3, "Unpacking");
            int files = Unpack(zip, stage);
            File.Delete(zip);
            Detail(files + " files");
            WriteVersion(stage);

            // 4. Node.js.
            Say(4, "Checking for Node.js");
            string nodeExe = FindNode(work, stage, result);
            // A build whose launcher predates the private Node cannot find it.
            string launcherSrc = Path.Combine(stage, @"launcher\exe\AiplayLauncher.cs");
            if (IsPrivate(nodeExe, stage) && File.Exists(launcherSrc) && !File.ReadAllText(launcherSrc).Contains("privateNode"))
                result.Notes.Add("This build's launcher is older than the private Node.js and will not find it, so it will ask you to install Node.js from nodejs.org. That stops once " + src.Name + "'s repository has the updated launcher.");

            // 5. npm packages.
            Say(5, "Fetching Studio's npm packages");
            if (!Npm(nodeExe, stage)) result.Notes.Add("The npm packages could not be fetched. The launcher tries again on its first start.");

            // 6. Into place.
            Say(6, "Finishing");
            WriteInfo(stage, nodeExe);
            File.WriteAllText(Path.Combine(stage, "Uninstall AIPLAY Studio.cmd"), UninstallScript(), new UTF8Encoding(false));
            Swap(stage);
            result.Exe = Path.Combine(dir, "AIPLAY Studio.exe");
            if (startMenu || desktop) Register(result);
            result.BuildLine = src.BuildLine;
            Progress(1);
            return result;
        }
        finally
        {
            try { LongPath.DeleteDir(work); } catch { }
        }
    }

    static string Mb(long b) { return (b / 1048576.0).ToString("0.0") + " MB"; }

    int Unpack(string zipPath, string stage)
    {
        using (var z = ZipFile.OpenRead(zipPath))
        {
            // GitHub puts everything under one "<repo>-<sha>/" folder.
            string top = null;
            foreach (var e in z.Entries) { int i = e.FullName.IndexOf('/'); if (i > 0) { top = e.FullName.Substring(0, i + 1); break; } }
            if (top == null) throw new InstallException("The download is not the zip GitHub normally sends.");

            string[] include = DefaultInclude, exclude = DefaultExclude, keep = DefaultKeep;
            var manifest = z.GetEntry(top + "install.json");
            if (manifest != null)
            {
                using (var rd = new StreamReader(manifest.Open(), Encoding.UTF8))
                {
                    var j = Net.Json(rd.ReadToEnd());
                    include = Strings(j, "include") ?? include;
                    exclude = Strings(j, "exclude") ?? new string[0];
                    keep = Strings(j, "keep") ?? new string[0];
                }
                Log.Say("install.json: " + include.Length + " entries");
            }
            else Log.Say("no install.json in this repository; using the built-in list");

            string root = Path.GetFullPath(stage) + "\\";
            int count = 0, seen = 0, total = z.Entries.Count;
            foreach (var e in z.Entries)
            {
                if (++seen % 200 == 0) Progress((double)seen / total);
                if (!e.FullName.StartsWith(top)) continue;
                string rel = e.FullName.Substring(top.Length);
                if (rel.Length == 0 || rel.EndsWith("/")) continue;
                string first = rel.Split('/')[0];
                bool wanted = false;
                foreach (var inc in include) if (string.Equals(inc, first, StringComparison.OrdinalIgnoreCase)) { wanted = true; break; }
                if (!wanted) continue;
                string name = e.Name;
                if (Matches(name, exclude) && !Matches(name, keep)) continue;
                string target = Path.GetFullPath(Path.Combine(stage, rel.Replace('/', '\\')));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // a path that climbs out
                Directory.CreateDirectory(LongPath.Of(Path.GetDirectoryName(target)));
                e.ExtractToFile(LongPath.Of(target), true);
                count++;
            }
            if (!File.Exists(Path.Combine(stage, @"launcher\launcher.mjs")))
                throw new InstallException("The download does not contain the launcher. The repository may have moved it; nothing was installed.");
            return count;
        }
    }

    static string[] Strings(Dictionary<string, object> j, string key)
    {
        object v;
        if (!j.TryGetValue(key, out v) || !(v is object[])) return null;
        var list = new List<string>();
        foreach (var o in (object[])v) if (o is string) list.Add((string)o);
        return list.ToArray();
    }

    static bool Matches(string name, string[] patterns)
    {
        foreach (var p in patterns)
        {
            string rx = "^" + System.Text.RegularExpressions.Regex.Escape(p).Replace("\\*", ".*").Replace("\\?", ".") + "$";
            if (System.Text.RegularExpressions.Regex.IsMatch(name, rx, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return true;
        }
        return false;
    }

    /// What `git` would have told server/version.js, for an install with no .git.
    void WriteVersion(string stage)
    {
        var gen = new Dictionary<string, object> {
            { "commit", src.Short }, { "date", src.Date }, { "modified", false }, { "base", null },
            { "at", DateTime.UtcNow.ToString("o") }, { "via", "AIPLAY Studio Setup " + Program.SetupVersion }, { "repo", src.Repo },
        };
        File.WriteAllText(Path.Combine(stage, @"server\version.gen.json"), new JavaScriptSerializer().Serialize(gen), new UTF8Encoding(false));
    }

    void WriteInfo(string stage, string nodeExe)
    {
        var info = new Dictionary<string, object> {
            { "repo", src.Repo }, { "name", src.Name }, { "letter", src.Letter }, { "branch", "main" },
            { "commit", src.Sha }, { "date", src.Date }, { "newest", src.Newest },
            { "against", src == Sources.Original ? null : Sources.Original.Repo }, { "relation", src.Relation },
            { "node", IsPrivate(nodeExe, stage) ? "private" : "system" },
            { "installedAt", DateTime.UtcNow.ToString("o") }, { "installer", Program.SetupVersion },
        };
        File.WriteAllText(Path.Combine(stage, "install-info.json"), new JavaScriptSerializer().Serialize(info), new UTF8Encoding(false));
    }

    // ── Node.js ──

    bool IsPrivate(string nodeExe, string stage)
    {
        return nodeExe.StartsWith(stage + "\\", StringComparison.OrdinalIgnoreCase) || nodeExe.StartsWith(dir + "\\", StringComparison.OrdinalIgnoreCase);
    }

    /// The Node.js this install will run on. In order: a private one a previous
    /// install left (kept), the PC's own 20+, or a fresh private download.
    string FindNode(string work, string stage, InstallResult result)
    {
        string oldPrivate = Path.Combine(dir, @"node\node.exe");
        string ver;
        if (File.Exists(oldPrivate) && (ver = NodeVersion(oldPrivate)) != null && Major(ver) >= 20)
        {
            Detail("Keeping the private Node.js " + ver);
            result.Notes.Add("Kept the private Node.js " + ver + " from the previous install.");
            return oldPrivate;
        }
        if (!forcePrivateNode)
        {
            foreach (var d in MergedPath().Split(';'))
            {
                string candidate;
                try { candidate = Path.Combine(d, "node.exe"); } catch { continue; }
                if (!File.Exists(candidate)) continue;
                ver = NodeVersion(candidate);
                if (ver != null && Major(ver) >= 20)
                {
                    Detail("Using this PC's Node.js " + ver);
                    result.Notes.Add("Using this PC's Node.js " + ver + ".");
                    return candidate;
                }
                break; // the first one on PATH is what would run; an old one does not count
            }
        }
        return DownloadNode(work, stage, result);
    }

    string DownloadNode(string work, string stage, InstallResult result)
    {
        string arch = NativeArch();
        Say(4, "Getting Node.js (private to Studio)");
        var index = (object[])Net.JsonAny(Net.GetString("https://nodejs.org/dist/index.json"));
        string version = null;
        foreach (Dictionary<string, object> rel in index)
        {
            // index.json lists newest first; `lts` is false or the line's name.
            if (rel["lts"] is bool) continue;
            var files = rel["files"] as object[];
            if (files == null || Array.IndexOf(files, "win-" + arch + "-zip") < 0) continue;
            version = (string)rel["version"];
            break;
        }
        if (version == null) throw new InstallException("nodejs.org lists no LTS Node.js for Windows " + arch + ".");

        string name = "node-" + version + "-win-" + arch;
        string baseUrl = "https://nodejs.org/dist/" + version + "/";
        string zip = Path.Combine(work, name + ".zip");
        Net.Download(baseUrl + name + ".zip", zip, (done, total) =>
        {
            Detail("Node.js " + version + ": " + Mb(done) + (total > 0 ? " of " + Mb(total) : ""));
            Progress(total > 0 ? (double)done / total : -1);
        });

        // The checksum list nodejs.org publishes beside every release.
        Detail("Checking Node.js against nodejs.org's SHA-256 list");
        string sums = Net.GetString(baseUrl + "SHASUMS256.txt");
        string expected = null;
        foreach (var line in sums.Split('\n'))
        {
            var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 2 && parts[1] == name + ".zip") { expected = parts[0].ToLowerInvariant(); break; }
        }
        string actual = Sha256(zip);
        if (expected == null || expected != actual)
            throw new InstallException("The Node.js download does not match the checksum nodejs.org publishes for it, so it was thrown away. Try again.");

        Detail("Unpacking Node.js " + version);
        string target = Path.Combine(stage, "node");
        string root = Path.GetFullPath(target) + "\\";
        using (var z = ZipFile.OpenRead(zip))
        {
            int seen = 0, total = z.Entries.Count;
            foreach (var e in z.Entries)
            {
                if (++seen % 200 == 0) Progress((double)seen / total);
                string full = e.FullName;
                int i = full.IndexOf('/');
                if (i < 0) continue;
                string rel = full.Substring(i + 1);
                if (rel.Length == 0 || rel.EndsWith("/")) continue;
                string dest = Path.GetFullPath(Path.Combine(target, rel.Replace('/', '\\')));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                Directory.CreateDirectory(LongPath.Of(Path.GetDirectoryName(dest)));
                e.ExtractToFile(LongPath.Of(dest), true);
            }
        }
        File.Delete(zip);
        string exe = Path.Combine(target, "node.exe");
        if (NodeVersion(exe) == null) throw new InstallException("The private Node.js was unpacked but does not start.");
        result.Notes.Add("Node.js " + version + " was put inside the install folder. Only Studio uses it; nothing else on this PC changed.");
        return exe;
    }

    [DllImport("kernel32.dll")] static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

    /// The machine's own architecture, not this process's: an x64 program on an
    /// ARM PC still wants the ARM Node.js.
    static string NativeArch()
    {
        try
        {
            ushort p, n;
            if (IsWow64Process2(Process.GetCurrentProcess().Handle, out p, out n))
            {
                if (n == 0xAA64) return "arm64";
                if (n == 0x8664) return "x64";
                if (n == 0x014c) return "x86";
            }
        }
        catch { }
        return Environment.Is64BitOperatingSystem ? "x64" : "x86";
    }

    static string Sha256(string file)
    {
        using (var sha = SHA256.Create())
        using (var s = File.OpenRead(file))
        {
            var sb = new StringBuilder();
            foreach (var b in sha.ComputeHash(s)) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    static int Major(string v)
    {
        int n;
        string t = v.TrimStart('v').Split('.')[0];
        return int.TryParse(t, out n) ? n : 0;
    }

    static string NodeVersion(string exe)
    {
        try
        {
            var psi = new ProcessStartInfo(exe, "-v");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            using (var p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(10000);
                return o.StartsWith("v") ? o : null;
            }
        }
        catch { return null; }
    }

    /// Explorer's PATH can predate a Node.js install; the registry has the current one.
    static string MergedPath()
    {
        var parts = new List<string>();
        foreach (var s in new[] {
            Environment.GetEnvironmentVariable("PATH"),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) })
        {
            if (string.IsNullOrEmpty(s)) continue;
            foreach (var raw in s.Split(';'))
            {
                string d = Environment.ExpandEnvironmentVariables(raw.Trim());
                if (d.Length > 0 && !parts.Exists(x => string.Equals(x, d, StringComparison.OrdinalIgnoreCase))) parts.Add(d);
            }
        }
        string pf = Environment.GetEnvironmentVariable("ProgramFiles");
        if (!string.IsNullOrEmpty(pf)) parts.Add(Path.Combine(pf, "nodejs"));
        return string.Join(";", parts.ToArray());
    }

    bool Npm(string nodeExe, string stage)
    {
        string nodeDir = Path.GetDirectoryName(nodeExe);
        string npm = Path.Combine(nodeDir, "npm.cmd");
        if (!File.Exists(npm)) { Detail("npm was not found beside Node.js"); return false; }
        var psi = new ProcessStartInfo("cmd.exe", "/d /s /c \"\"" + npm + "\" install --omit=dev --no-audit --no-fund --loglevel=error\"");
        psi.WorkingDirectory = stage;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.EnvironmentVariables["PATH"] = nodeDir + ";" + MergedPath();
        using (var p = new Process())
        {
            p.StartInfo = psi;
            DataReceivedEventHandler line = (s, e) => { if (!string.IsNullOrEmpty(e.Data)) { Log.Say("npm: " + e.Data); Detail(e.Data.Trim()); } };
            p.OutputDataReceived += line;
            p.ErrorDataReceived += line;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            if (!p.WaitForExit(10 * 60 * 1000)) { try { p.Kill(); } catch { } return false; }
            p.WaitForExit();
        }
        foreach (var pkg in new[] { "ws", "three", "gltf-validator" })
            if (!Directory.Exists(Path.Combine(stage, "node_modules", pkg))) return false;
        return true;
    }

    // ── into place ──

    /// The previous install becomes a backup, the new one takes its name, the
    /// backup goes. Any failure before the second rename puts the old one back.
    void Swap(string stage)
    {
        string backup = null;
        if (Directory.Exists(dir))
        {
            backup = dir + ".old-" + DateTime.Now.Ticks;
            try { Directory.Move(dir, backup); }
            catch (IOException)
            {
                throw new InstallException("The current install is in use. Close AIPLAY Studio (the tray icon: Stop Studio and quit), then press Retry.");
            }
            catch (UnauthorizedAccessException)
            {
                throw new InstallException("The current install is in use. Close AIPLAY Studio (the tray icon: Stop Studio and quit), then press Retry.");
            }
            // A private Node.js the old install had, and nothing in `stage` replaced.
            string oldNode = Path.Combine(backup, "node"), newNode = Path.Combine(stage, "node");
            if (Directory.Exists(oldNode) && !Directory.Exists(newNode)) Directory.Move(oldNode, newNode);
        }
        try { Directory.Move(stage, dir); }
        catch
        {
            if (backup != null)
            {
                string n = Path.Combine(stage, "node");
                if (Directory.Exists(n) && !Directory.Exists(Path.Combine(backup, "node"))) try { Directory.Move(n, Path.Combine(backup, "node")); } catch { }
                try { Directory.Move(backup, dir); } catch { }
            }
            throw;
        }
        if (backup != null) try { LongPath.DeleteDir(backup); } catch { Log.Say("could not remove " + backup + "; delete it by hand"); }
    }

    static string StartMenuLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "AIPLAY Studio.lnk"); } }
    static string DesktopLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "AIPLAY Studio.lnk"); } }

    void Register(InstallResult result)
    {
        string icon = Path.Combine(dir, @"launcher\aiplay.ico");
        if (!File.Exists(icon)) icon = result.Exe;
        try
        {
            if (startMenu) Shortcut(StartMenuLink, result.Exe, dir, icon);
            if (desktop) Shortcut(DesktopLink, result.Exe, dir, icon);
            else if (File.Exists(DesktopLink)) File.Delete(DesktopLink);
        }
        catch (Exception ex) { result.Notes.Add("The shortcuts could not be made (" + ex.Message + "). Start it from " + result.Exe + "."); }

        try
        {
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", "AIPLAY Studio");
                k.SetValue("DisplayVersion", src.BuildLine);
                k.SetValue("Publisher", "AIPLAY Studio (" + src.Name + ")");
                k.SetValue("DisplayIcon", icon);
                k.SetValue("InstallLocation", dir);
                k.SetValue("URLInfoAbout", "https://github.com/" + src.Repo);
                k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall AIPLAY Studio.cmd") + "\"");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, SizeKb(dir)), RegistryValueKind.DWord);
            }
        }
        catch (Exception ex) { result.Notes.Add("Could not add AIPLAY Studio to Installed apps (" + ex.Message + ")."); }
    }

    static long SizeKb(string d)
    {
        long b = 0;
        try { foreach (var f in new DirectoryInfo(d).EnumerateFiles("*", SearchOption.AllDirectories)) b += f.Length; } catch { }
        return b / 1024;
    }

    static void Shortcut(string lnkPath, string target, string workDir, string icon)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        try
        {
            object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type lt = lnk.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { icon + ",0" });
            lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "AIPLAY Studio" });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            Marshal.FinalReleaseComObject(lnk);
        }
        finally { Marshal.FinalReleaseComObject(shell); }
    }

    /// Plain batch, readable before it is run. It copies itself to %TEMP% first,
    /// because a script cannot delete the folder it is running from. Every path
    /// is written in at install time; nothing is guessed at uninstall time.
    string UninstallScript()
    {
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".aiplay-studio");
        var s = new StringBuilder();
        Action<string> L = x => s.Append(x).Append("\r\n");
        L("@echo off");
        L("REM Removes AIPLAY Studio. Written by AIPLAY Studio Setup; safe to read first.");
        L("setlocal");
        L("if /i \"%~1\"==\"--from-temp\" goto :run");
        L("copy /y \"%~f0\" \"%TEMP%\\aiplay-uninstall.cmd\" >nul");
        L("start \"Uninstall AIPLAY Studio\" \"%TEMP%\\aiplay-uninstall.cmd\" --from-temp");
        L("exit /b");
        L(":run");
        L("title Uninstall AIPLAY Studio");
        L("set \"APP=" + dir + "\"");
        L("set \"DATA=" + data + "\"");
        L("echo.");
        L("echo   Uninstall AIPLAY Studio from:");
        L("echo   %APP%");
        L("echo.");
        L("choice /c YN /n /m \"  Remove it? [Y/N] \"");
        L("if errorlevel 2 goto :eof");
        L("rmdir /s /q \"%APP%\" 2>nul");
        L("if exist \"%APP%\" goto :busy");
        L("del \"" + StartMenuLink + "\" 2>nul");
        L("del \"" + DesktopLink + "\" 2>nul");
        L("reg delete \"HKCU\\" + UninstallKey + "\" /f >nul 2>nul");
        L("echo.");
        L("echo   AIPLAY Studio is removed.");
        L("echo.");
        L("echo   Your songs, pictures and settings are still in:");
        L("echo   %DATA%");
        L("echo   That folder also holds any engine and models Studio installed for you,");
        L("echo   which can be many gigabytes. Keeping it costs nothing if you come back.");
        L("echo.");
        L("choice /c YN /n /m \"  Delete that folder too? [Y/N] \"");
        L("if errorlevel 2 goto :done");
        L("rmdir /s /q \"%DATA%\"");
        L(":done");
        L("echo.");
        L("echo   Done.");
        L("pause");
        L("goto :eof");
        L(":busy");
        L("echo.");
        L("echo   Some files are in use. Close AIPLAY Studio (tray icon: Stop Studio and quit)");
        L("echo   and run the uninstaller again.");
        L("pause");
        return s.ToString();
    }
}

// ─── the window ────────────────────────────────────────────────────────────

static class Theme
{
    public static readonly Color Bg = Color.FromArgb(10, 12, 16);
    public static readonly Color Raise = Color.FromArgb(22, 26, 34);
    public static readonly Color Ink = Color.FromArgb(245, 245, 245);
    public static readonly Color Dim = Color.FromArgb(217, 217, 217);
    public static readonly Color Faint = Color.FromArgb(173, 173, 173);
    public static readonly Color Ghost = Color.FromArgb(133, 133, 133);
    public static readonly Color Primary = Color.FromArgb(51, 204, 255);
    public static readonly Color PrimaryHover = Color.FromArgb(26, 196, 255);
    public static readonly Color Secondary = Color.FromArgb(255, 102, 204);
    public static readonly Color On = Color.FromArgb(10, 18, 26);
    public static readonly Color Ok = Color.FromArgb(34, 197, 94);
    public static readonly Color Warn = Color.FromArgb(246, 162, 32);
    public static readonly Color Err = Color.FromArgb(240, 82, 82);
    public static readonly Color Edge = Color.FromArgb(46, 255, 255, 255);

    static FontFamily Pick(params string[] names)
    {
        foreach (var n in names) try { var f = new FontFamily(n); return f; } catch { }
        return FontFamily.GenericSansSerif;
    }
    public static readonly FontFamily Display = Pick("Bahnschrift", "Segoe UI Semibold", "Segoe UI");
    public static readonly FontFamily Body = Pick("Segoe UI");
    public static readonly FontFamily Mono = Pick("Cascadia Mono", "Consolas");

    public static GraphicsPath Round(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        float d = Math.Min(rad * 2, Math.Min(r.Width, r.Height));
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}

class Painted : Control
{
    public Painted()
    {
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint
            | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Color.Transparent;
    }
}

/// A rounded button: filled cyan when primary, outlined otherwise.
sealed class Pill : Painted
{
    public bool Primary;
    bool hover;

    public Pill(string text, bool primary) { Text = text; Primary = primary; Cursor = Cursors.Hand; Font = new Font(Theme.Body, 10f, primary ? FontStyle.Bold : FontStyle.Regular); }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        int alpha = Enabled ? 255 : 90;
        using (var path = Theme.Round(r, Height / 2f))
        {
            if (Primary)
            {
                using (var b = new SolidBrush(Color.FromArgb(alpha, hover ? Theme.PrimaryHover : Theme.Primary))) g.FillPath(b, path);
            }
            else
            {
                if (hover && Enabled) using (var b = new SolidBrush(Color.FromArgb(22, 255, 255, 255))) g.FillPath(b, path);
                using (var pen = new Pen(Color.FromArgb(Enabled ? 90 : 40, Theme.Primary), 1f)) g.DrawPath(pen, path);
            }
        }
        var fg = Primary ? Theme.On : Theme.Dim;
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, Color.FromArgb(alpha, fg),
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}

/// One repository to pick: its name, build line, how it stands, its newest commit.
sealed class Card : Painted
{
    public Source Src;
    public bool Selected;
    public event EventHandler Picked = delegate { };
    bool hover;

    public Card(Source s) { Src = s; Cursor = Cursors.Hand; }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnClick(EventArgs e) { Picked(this, e); base.OnClick(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        using (var path = Theme.Round(r, 12))
        {
            using (var b = new SolidBrush(Selected ? Color.FromArgb(30, Theme.Primary) : Color.FromArgb(hover ? 16 : 9, 255, 255, 255))) g.FillPath(b, path);
            using (var pen = new Pen(Selected ? Color.FromArgb(200, Theme.Primary) : Theme.Edge, Selected ? 1.5f : 1f)) g.DrawPath(pen, path);
        }
        // The radio dot.
        var dot = new RectangleF(18, 16, 16, 16);
        using (var pen = new Pen(Selected ? Theme.Primary : Theme.Ghost, 1.5f)) g.DrawEllipse(pen, dot);
        if (Selected) using (var b = new SolidBrush(Theme.Primary)) g.FillEllipse(b, 22, 20, 8, 8);

        var flags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis;
        using (var name = new Font(Theme.Display, 12f, FontStyle.Bold))
            TextRenderer.DrawText(g, Src.Name + "'s build", name, new Rectangle(46, 13, 220, 22), Theme.Ink, flags);
        using (var mono = new Font(Theme.Mono, 9f))
            TextRenderer.DrawText(g, Src.BuildLine, mono, new Rectangle(Width - 236, 16, 220, 20), Theme.Faint, flags | TextFormatFlags.Right);
        using (var body = new Font(Theme.Body, 9f))
        {
            string rel = Src.Relation ?? (Src.Sha == null ? (Src.Why != null ? "could not check" : "checking GitHub…") : "");
            Color rc = Src.RelationLevel == 2 ? Theme.Warn : Src.RelationLevel == 1 ? Theme.Ok : Theme.Faint;
            TextRenderer.DrawText(g, rel, body, new Rectangle(46, 38, Width - 62, 18), rc, flags);
        }
        if (!string.IsNullOrEmpty(Src.Newest))
            using (var small = new Font(Theme.Body, 8.5f))
                TextRenderer.DrawText(g, "newest: " + Src.Newest, small, new Rectangle(46, 58, Width - 62, 18), Theme.Ghost, flags);
    }
}

/// A thin bar in the Welcome page's two colours. Negative = "busy, no number".
sealed class Bar : Painted
{
    double value = -1;
    float phase;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 16 };

    public Bar() { timer.Tick += (s, e) => { phase = (phase + 0.012f) % 1.4f; Invalidate(); }; timer.Start(); }
    public double Value { get { return value; } set { this.value = value; Invalidate(); } }

    protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var track = new RectangleF(0, 0, Width - 1, Height - 1);
        using (var p = Theme.Round(track, Height / 2f)) using (var b = new SolidBrush(Color.FromArgb(28, 255, 255, 255))) g.FillPath(b, p);
        RectangleF fill;
        if (value < 0) { float w = Width * 0.3f; fill = new RectangleF((phase - 0.3f) * Width, 0, w, Height - 1); }
        else fill = new RectangleF(0, 0, Math.Max(Height, (float)(Width * Math.Min(1, value))), Height - 1);
        fill.Intersect(track);
        if (fill.Width < 1) return;
        using (var p = Theme.Round(fill, Height / 2f))
        using (var b = new LinearGradientBrush(new RectangleF(-1, 0, Width + 2, Height), Theme.Primary, Theme.Secondary, 0f))
            g.FillPath(b, p);
    }
}

sealed class SetupForm : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    readonly Options opt;
    readonly List<Control> choose = new List<Control>(), work = new List<Control>(), done = new List<Control>();
    readonly List<Card> cards = new List<Card>();
    Source picked;
    Label net, stepLabel, statusLabel, detailLabel, doneTitle, doneLine, doneNotes;
    TextBox dirBox;
    CheckBox chkDesktop, chkDelete;
    Pill installBtn, primaryBtn, closeBtn;
    Bar bar;
    InstallResult last;
    bool failed;

    public SetupForm(Options opt)
    {
        this.opt = opt;
        Text = "AIPLAY Studio Setup";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96f, 96f);
        ClientSize = new Size(560, 600);
        BackColor = Theme.Bg;
        ForeColor = Theme.Ink;
        Font = new Font(Theme.Body, 9.5f);
        DoubleBuffered = true;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        // Header, on every page.
        var logo = new PictureBox { Location = new Point(32, 28), Size = new Size(64, 64), SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.Transparent };
        try { var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png"); if (s != null) logo.Image = Image.FromStream(s); } catch { }
        Controls.Add(logo);
        Controls.Add(MakeLabel("AIPLAY Studio", 108, 30, 420, 36, new Font(Theme.Display, 21f, FontStyle.Bold), Theme.Ink));
        Controls.Add(MakeLabel("Made with AI, by people who wanted more from it.", 110, 68, 420, 20, new Font(Theme.Body, 9.5f), Theme.Faint));

        BuildChoose();
        BuildWork();
        BuildDone();
        Show(choose);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // A dark title bar to match (Windows 10 2004+ / 11; ignored elsewhere).
        try { int on = 1; DwmSetWindowAttribute(Handle, 20, ref on, 4); } catch { }
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var g = e.Graphics;
        using (var b = new SolidBrush(Theme.Bg)) g.FillRectangle(b, ClientRectangle);
        // The Welcome page's bloom, cyan behind the logo and pink to the right.
        Bloom(g, new RectangleF(-160, -200, 520, 440), Color.FromArgb(46, Theme.Primary));
        Bloom(g, new RectangleF(ClientSize.Width - 300, -120, 480, 380), Color.FromArgb(34, Theme.Secondary));
    }

    static void Bloom(Graphics g, RectangleF r, Color c)
    {
        using (var p = new GraphicsPath())
        {
            p.AddEllipse(r);
            using (var b = new PathGradientBrush(p) { CenterColor = c, SurroundColors = new[] { Color.FromArgb(0, c) } }) g.FillPath(b, p);
        }
    }

    Label MakeLabel(string text, int x, int y, int w, int h, Font f, Color c)
    {
        return new Label { Text = text, Location = new Point(x, y), Size = new Size(w, h), Font = f, ForeColor = c, BackColor = Color.Transparent, AutoEllipsis = true };
    }

    Label Caps(string text, int y) { return MakeLabel(text, 32, y, 496, 18, new Font(Theme.Body, 8f, FontStyle.Bold), Theme.Ghost); }

    void Add(List<Control> page, Control c) { page.Add(c); Controls.Add(c); }

    void Show(List<Control> page)
    {
        SuspendLayout();
        foreach (var l in new[] { choose, work, done }) foreach (var c in l) c.Visible = l == page;
        ResumeLayout();
    }

    void BuildChoose()
    {
        string existing = Installer.ExistingDir();
        Add(choose, Caps("VERSION", 118));
        int y = 140;
        foreach (var s in Sources.All)
        {
            var card = new Card(s) { Location = new Point(32, y), Size = new Size(496, 82) };
            card.Picked += (o, e) => Pick(((Card)o).Src);
            cards.Add(card);
            Add(choose, card);
            y += 90;
        }
        net = MakeLabel("Asking GitHub where each version is…", 32, y + 2, 496, 18, new Font(Theme.Body, 8.5f), Theme.Ghost);
        Add(choose, net);

        Add(choose, Caps("INSTALL TO", 350));
        dirBox = new TextBox { Location = new Point(32, 372), Size = new Size(392, 26), BackColor = Theme.Raise, ForeColor = Theme.Ink, BorderStyle = BorderStyle.FixedSingle,
            Font = new Font(Theme.Body, 10f), Text = opt.Dir ?? existing ?? Installer.DefaultDir() };
        Add(choose, dirBox);
        var browse = new Pill("Change…", false) { Location = new Point(436, 369), Size = new Size(92, 32) };
        browse.Click += (s, e) => Browse();
        Add(choose, browse);

        chkDesktop = new CheckBox { Text = "Put a shortcut on the desktop", Location = new Point(32, 416), Size = new Size(496, 24), Checked = true, ForeColor = Theme.Dim, BackColor = Color.Transparent };
        chkDelete = new CheckBox { Text = "Delete this installer when I close it", Location = new Point(32, 442), Size = new Size(496, 24), Checked = true, ForeColor = Theme.Dim, BackColor = Color.Transparent };
        Add(choose, chkDesktop);
        Add(choose, chkDelete);

        installBtn = new Pill(existing != null ? "Reinstall" : "Install", true) { Location = new Point(32, 522), Size = new Size(496, 46) };
        installBtn.Click += (s, e) => StartInstall();
        Add(choose, installBtn);

        Pick(Sources.ByKey(opt.Repo) ?? Sources.All[0]);
        if (existing != null) net.Text = "AIPLAY Studio is already installed there. Reinstalling replaces the app and keeps your songs and settings.";
        var t = new Thread(() =>
        {
            Sources.Check(Sources.All);
            BeginInvoke((Action)(() =>
            {
                foreach (var c in cards) c.Invalidate();
                bool any = false;
                foreach (var s in Sources.All) if (s.Sha != null) any = true;
                if (!any) net.Text = "Could not reach GitHub. " + (Sources.All[0].Why ?? "") + " Install tries again when you press it.";
                else if (existing == null) net.Text = "Both are free and open. " + Sources.All[0].Name + "'s build is the default.";
                if (opt.Shot != null) Shots();
            }));
        }) { IsBackground = true };
        t.Start();
    }

    /// The review path: every page drawn to a file, with sample text on the two
    /// that only exist mid-install. Nothing is downloaded or written elsewhere.
    void Shots()
    {
        chkDelete.Checked = false;
        Snap("choose");
        Show(work);
        stepLabel.Text = "STEP 2 OF 6"; statusLabel.Text = "Downloading AIPLAY Studio " + picked.BuildLine;
        detailLabel.Text = "18.4 MB of 41.0 MB downloaded"; bar.Value = 0.45;
        Snap("work");
        var r = new InstallResult { Dir = dirBox.Text, BuildLine = picked.BuildLine, Exe = "" };
        r.Notes.Add("Node.js v24.21.0 was put inside the install folder. Only Studio uses it; nothing else on this PC changed.");
        Finish(r, null);
        Snap("done");
        Close();
    }

    void Snap(string page)
    {
        Refresh();
        using (var bmp = new Bitmap(Width, Height))
        {
            DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
            bmp.Save(opt.Shot + "-" + page + ".png", System.Drawing.Imaging.ImageFormat.Png);
        }
    }

    void Pick(Source s)
    {
        picked = s;
        foreach (var c in cards) { c.Selected = c.Src == s; c.Invalidate(); }
    }

    void Browse()
    {
        using (var d = new FolderBrowserDialog { Description = "Where should AIPLAY Studio go? A folder called \"AIPLAY Studio\" is made inside the one you pick.", ShowNewFolderButton = true })
        {
            if (d.ShowDialog(this) != DialogResult.OK) return;
            string sel = d.SelectedPath;
            dirBox.Text = string.Equals(Path.GetFileName(sel.TrimEnd('\\')), "AIPLAY Studio", StringComparison.OrdinalIgnoreCase) ? sel : Path.Combine(sel, "AIPLAY Studio");
        }
    }

    void BuildWork()
    {
        stepLabel = Caps("", 150);
        statusLabel = MakeLabel("", 32, 172, 496, 32, new Font(Theme.Display, 14f, FontStyle.Bold), Theme.Ink);
        bar = new Bar { Location = new Point(32, 218), Size = new Size(496, 8) };
        detailLabel = MakeLabel("", 32, 238, 496, 40, new Font(Theme.Mono, 8.5f), Theme.Ghost);
        detailLabel.AutoEllipsis = true;
        Add(work, stepLabel);
        Add(work, statusLabel);
        Add(work, bar);
        Add(work, detailLabel);
        Add(work, MakeLabel("Nothing here touches ComfyUI, your graphics drivers or any model. Your songs and settings stay where they are.",
            32, 520, 496, 40, new Font(Theme.Body, 8.5f), Theme.Ghost));
    }

    void BuildDone()
    {
        doneTitle = MakeLabel("", 32, 130, 496, 36, new Font(Theme.Display, 18f, FontStyle.Bold), Theme.Ink);
        doneLine = MakeLabel("", 32, 170, 496, 20, new Font(Theme.Mono, 9f), Theme.Faint);
        doneNotes = MakeLabel("", 32, 204, 496, 290, new Font(Theme.Body, 9.5f), Theme.Dim);
        doneNotes.AutoEllipsis = false;
        primaryBtn = new Pill("", true) { Location = new Point(32, 522), Size = new Size(340, 46) };
        closeBtn = new Pill("Close", false) { Location = new Point(384, 522), Size = new Size(144, 46) };
        primaryBtn.Click += (s, e) => { if (failed) StartInstall(); else Launch(); };
        closeBtn.Click += (s, e) => Close();
        Add(done, doneTitle);
        Add(done, doneLine);
        Add(done, doneNotes);
        Add(done, primaryBtn);
        Add(done, closeBtn);
    }

    void StartInstall()
    {
        string dir = dirBox.Text.Trim();
        if (dir.Length == 0) { dirBox.Focus(); return; }
        var job = new Installer(picked, dir, true, chkDesktop.Checked, opt.PrivateNode);
        job.Step += (n, total, text) => BeginInvoke((Action)(() => { stepLabel.Text = "STEP " + n + " OF " + total; statusLabel.Text = text; detailLabel.Text = ""; }));
        job.Detail += (text) => BeginInvoke((Action)(() => detailLabel.Text = text));
        job.Progress += (v) => BeginInvoke((Action)(() => bar.Value = v));
        Show(work);
        ControlBox = false; // closing mid-swap is the one way to leave a mess
        var t = new Thread(() =>
        {
            InstallResult r = null; string error = null;
            try { r = job.Run(); }
            catch (InstallException ex) { error = ex.Message; }
            catch (Exception ex) { error = ex.Message; Log.Say(ex.ToString()); }
            BeginInvoke((Action)(() => Finish(r, error)));
        }) { IsBackground = true };
        t.Start();
    }

    void Finish(InstallResult r, string error)
    {
        ControlBox = true;
        failed = r == null;
        last = r;
        if (failed)
        {
            doneTitle.Text = "That did not work";
            doneTitle.ForeColor = Theme.Err;
            doneLine.Text = "";
            doneNotes.Text = error + "\n\nNothing was left half-installed. The log is in " + Path.Combine(Path.GetTempPath(), "aiplay-setup.log") + ".";
            primaryBtn.Text = "Retry";
        }
        else
        {
            doneTitle.Text = "AIPLAY Studio is installed";
            doneTitle.ForeColor = Theme.Ink;
            doneLine.Text = r.BuildLine + "   " + r.Dir;
            var notes = new StringBuilder();
            foreach (var n in r.Notes) notes.Append("•  ").Append(n).Append("\n\n");
            notes.Append("•  Start it any time from the Start menu" + (chkDesktop.Checked ? " or the desktop" : "") + ". The launcher checks your graphics card and ComfyUI, and says what is missing.");
            doneNotes.Text = notes.ToString();
            primaryBtn.Text = "Launch AIPLAY Studio";
        }
        Show(done);
    }

    void Launch()
    {
        try
        {
            Process.Start(new ProcessStartInfo(last.Exe) { WorkingDirectory = last.Dir, UseShellExecute = true });
            Close();
        }
        catch (Exception ex) { MessageBox.Show(this, "Could not start AIPLAY Studio:\n" + ex.Message, Program.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        base.OnFormClosed(e);
        if (!chkDelete.Checked) return;
        string me = Application.ExecutablePath;
        // Never delete an installer that sits inside a folder it installed to,
        // or the build output in a developer's dist\.
        if (last != null && me.StartsWith(last.Dir + "\\", StringComparison.OrdinalIgnoreCase)) return;
        if (me.IndexOf("\\dist\\", StringComparison.OrdinalIgnoreCase) >= 0) return;
        try
        {
            // A running exe cannot delete itself; a hidden command waits for it to close.
            var psi = new ProcessStartInfo("cmd.exe", "/d /c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + me + "\"");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
        }
        catch { }
    }
}
