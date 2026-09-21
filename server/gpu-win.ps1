# VRAM and load for ANY graphics card on Windows: AMD, Intel, NVIDIA alike.
#
# Started by server/gpu.js only when nvidia-smi is not there. Prints one JSON
# line per adapter reading every $IntervalMs, until its parent goes away:
#
#   {"adapters":[{"name":"AMD Radeon RX 9060 XT","vendor":"amd","totalMb":16304,
#                 "usedMb":2310,"utilPct":7,"luid":"0x00000000_0x0000D1B4"}]}
#
# Where the numbers come from, both built into Windows 10 1709 and later:
#   - DXGI (DirectX) names each adapter, its vendor, its dedicated memory and
#     its LUID, the id Windows uses for it everywhere else. Asked once.
#   - The "GPU Adapter Memory" and "GPU Engine" performance counters, keyed by
#     that LUID. The same counters Task Manager's GPU page reads, so the two
#     agree with each other.
#
# Read-only. Nothing is installed, loaded into a driver, or changed.
param([int]$IntervalMs = 2000, [int]$ParentPid = 0)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class AiplayGpu {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DXGI_ADAPTER_DESC1 {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision;
        public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public uint LuidLow; public int LuidHigh;
        public uint Flags;
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIAdapter1 {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
        [PreserveSig] int GetDesc1(out DXGI_ADAPTER_DESC1 desc);
    }

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIFactory1 {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
        [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
    }

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

    public class Adapter {
        public string Name, Vendor, Luid;
        public long TotalMb;
        public PerformanceCounter Dedicated;
    }

    static string VendorOf(uint id) {
        if (id == 0x1002 || id == 0x1022) return "amd";
        if (id == 0x8086) return "intel";
        if (id == 0x10DE) return "nvidia";
        return null;
    }

    public static List<Adapter> Adapters() {
        var list = new List<Adapter>();
        Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        object f;
        if (CreateDXGIFactory1(ref iid, out f) != 0) return list;
        var factory = (IDXGIFactory1)f;
        for (uint i = 0; i < 16; i++) {
            IDXGIAdapter1 a;
            if (factory.EnumAdapters1(i, out a) != 0) break;
            DXGI_ADAPTER_DESC1 d;
            if (a.GetDesc1(out d) != 0) continue;
            // DXGI_ADAPTER_FLAG_SOFTWARE: the Basic Render Driver, not a card.
            if ((d.Flags & 2) != 0 || d.VendorId == 0x1414) continue;
            var ad = new Adapter();
            ad.Name = d.Description.Trim();
            ad.Vendor = VendorOf(d.VendorId);
            ad.TotalMb = (long)((ulong)d.DedicatedVideoMemory / 1048576UL);
            ad.Luid = String.Format("0x{0:X8}_0x{1:X8}", d.LuidHigh, d.LuidLow);
            list.Add(ad);
        }
        return list;
    }

    static string Match(string category, string luid, string suffix) {
        foreach (var n in new PerformanceCounterCategory(category).GetInstanceNames())
            if (n.IndexOf("luid_" + luid, StringComparison.OrdinalIgnoreCase) >= 0 && (suffix == null || n.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))) return n;
        return null;
    }

    /// Memory in use (MB), or -1 when the counter cannot be read.
    public static long Used(Adapter a) {
        try {
            if (a.Dedicated == null) {
                string inst = Match("GPU Adapter Memory", a.Luid, null);
                if (inst == null) return -1;
                a.Dedicated = new PerformanceCounter("GPU Adapter Memory", "Dedicated Usage", inst, true);
            }
            return (long)(a.Dedicated.NextValue() / 1048576f);
        } catch { a.Dedicated = null; return -1; }
    }

    /// Busiest engine type (3D, Compute, Copy, ...) per adapter in percent,
    /// like Task Manager's headline figure.
    ///
    /// ONE READ OF THE WHOLE CATEGORY PER TICK. A PerformanceCounter per engine
    /// looked cheap, but every NextValue() re-reads the entire "GPU Engine"
    /// category (hundreds of instances, one per process per engine), which cost
    /// ~80 ms of CPU a second. Reading the category once and working out each
    /// rate from the previous tick's raw sample is the same number for a
    /// fraction of that.
    static PerformanceCounterCategory engineCat;
    static Dictionary<string, CounterSample> prevEngine = new Dictionary<string, CounterSample>();

    public static Dictionary<string, int> UtilAll(List<Adapter> list) {
        var result = new Dictionary<string, int>();
        try {
            if (engineCat == null) engineCat = new PerformanceCounterCategory("GPU Engine");
            InstanceDataCollection col = engineCat.ReadCategory()["Utilization Percentage"];
            var now = new Dictionary<string, CounterSample>();
            var sums = new Dictionary<string, Dictionary<string, float>>();
            foreach (InstanceData d in col.Values) {
                string n = d.InstanceName;
                Adapter owner = null;
                foreach (var a in list) if (n.IndexOf("luid_" + a.Luid, StringComparison.OrdinalIgnoreCase) >= 0) { owner = a; break; }
                if (owner == null) continue;
                now[n] = d.Sample;
                CounterSample before;
                if (!prevEngine.TryGetValue(n, out before)) continue;   // a rate needs two samples
                float v = CounterSample.Calculate(before, d.Sample);
                int at = n.LastIndexOf("engtype_", StringComparison.OrdinalIgnoreCase);
                string type = at >= 0 ? n.Substring(at + 8) : "?";
                Dictionary<string, float> byType;
                if (!sums.TryGetValue(owner.Luid, out byType)) { byType = new Dictionary<string, float>(); sums[owner.Luid] = byType; }
                float s; byType.TryGetValue(type, out s); byType[type] = s + v;
            }
            prevEngine = now;
            foreach (var a in list) {
                float max = 0;
                Dictionary<string, float> byType;
                if (sums.TryGetValue(a.Luid, out byType)) foreach (var v in byType.Values) if (v > max) max = v;
                result[a.Luid] = (int)Math.Round(Math.Min(100f, Math.Max(0f, max)));
            }
        } catch { foreach (var a in list) result[a.Luid] = -1; }
        return result;
    }

    static string Js(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    /// One output line: every adapter, read now.
    public static string Tick(List<Adapter> list) {
        var util = UtilAll(list);
        var sb = new System.Text.StringBuilder("{\"adapters\":[");
        for (int i = 0; i < list.Count; i++) {
            var a = list[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"name\":").Append(Js(a.Name))
              .Append(",\"vendor\":").Append(a.Vendor == null ? "null" : Js(a.Vendor))
              .Append(",\"luid\":").Append(Js(a.Luid))
              .Append(",\"totalMb\":").Append(a.TotalMb)
              .Append(",\"usedMb\":").Append(Used(a))
              .Append(",\"utilPct\":").Append(util.ContainsKey(a.Luid) ? util[a.Luid] : -1).Append('}');
        }
        return sb.Append("]}").ToString();
    }
}
"@

$adapters = [AiplayGpu]::Adapters()
if ($adapters.Count -eq 0) { [Console]::Out.WriteLine('{"adapters":[],"error":"no hardware adapter"}'); exit 0 }

# The parent check every fifth tick (10 s at the default).
$tick = 0
while ($true) {
  if (($tick % 5) -eq 0 -and $ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  [Console]::Out.WriteLine([AiplayGpu]::Tick($adapters))
  [Console]::Out.Flush()
  $tick++
  Start-Sleep -Milliseconds $IntervalMs
}
