# Keeps the JustAE Flow window docked at EffectCraft's right edge (Windows).
#
# EffectCraft docks only ScriptUI panels, so the Flow window is an app window of
# Edge or Chrome. This helper makes it behave like a docked panel:
#
#   1. reports whether a Flow window is already open ("found" / "missing"), so
#      the server opens one only when there is none;
#   2. puts EffectCraft and the Flow window side by side on EffectCraft's monitor,
#      the Flow window on the right at full height ("docked");
#   3. while both are open, keeps the Flow window on EffectCraft's right edge when
#      EffectCraft is moved, resized, minimized or restored. Moving the Flow
#      window yourself undocks it; opening it again from the panel re-docks it.
#
# One JSON line per stage on stdout. Started by server/dock.ts.

param([int]$Width = 560, [int]$WaitMs = 20000, [string]$Title = 'JustAE Flow')

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FlowDock {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  const int SW_MINIMIZE = 6, SW_SHOWNOACTIVATE = 4, SW_RESTORE = 9;

  static void Say(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }

  /** EffectCraft's main window: the largest visible top-level window of effectcraft.exe titled "EffectCraft…". */
  static IntPtr FindEffectCraft() {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string name;
      try { name = Process.GetProcessById((int)pid).ProcessName; } catch { return true; }
      if (!name.Equals("effectcraft", StringComparison.OrdinalIgnoreCase)) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (!t.ToString().StartsWith("EffectCraft")) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  /** The Flow window: a Chromium app window whose title is the page's title, exactly. */
  static IntPtr FindFlow(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /** The visible frame, without the invisible resize borders Windows 10/11 add around a window. */
  static RECT Frame(IntPtr h) {
    RECT f;
    if (DwmGetWindowAttribute(h, 9, out f, Marshal.SizeOf(typeof(RECT))) == 0) return f;
    GetWindowRect(h, out f);
    return f;
  }

  /** Move a window so that its visible frame lands exactly on x, y, w, h. */
  static void Place(IntPtr h, int x, int y, int w, int hgt, uint flags) {
    RECT r, f; GetWindowRect(h, out r); f = Frame(h);
    int li = f.L - r.L, ti = f.T - r.T, ri = r.R - f.R, bi = r.B - f.B;
    SetWindowPos(h, IntPtr.Zero, x - li, y - ti, w + li + ri, hgt + ti + bi, flags);
  }

  static RECT Work(IntPtr h) {
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
    return mi.rcWork;
  }

  static int Scaled(IntPtr h, int px) {
    uint dpi = 96;
    try { dpi = GetDpiForWindow(h); } catch { }
    if (dpi == 0) dpi = 96;
    return (int)Math.Round(px * dpi / 96.0);
  }

  static bool Same(RECT a, RECT b) { return a.L == b.L && a.T == b.T && a.R == b.R && a.B == b.B; }

  /** Side by side when EffectCraft keeps a usable width, else over EffectCraft's right edge. */
  static string Dock(IntPtr ef, IntPtr flow, int width) {
    if (IsIconic(ef) || IsZoomed(ef)) ShowWindow(ef, SW_RESTORE);
    if (IsIconic(flow)) ShowWindow(flow, SW_RESTORE);
    RECT w = Work(ef);
    int fw = Scaled(ef, width), H = w.B - w.T, efW = (w.R - w.L) - fw;
    string mode;
    if (efW >= Scaled(ef, 960)) {
      Place(ef, w.L, w.T, efW, H, SWP_NOZORDER | SWP_NOACTIVATE);
      Place(flow, w.L + efW, w.T, fw, H, SWP_SHOWWINDOW);
      mode = "side";
    } else {
      Place(flow, w.R - fw, w.T, fw, H, SWP_SHOWWINDOW);
      mode = "over";
    }
    SetForegroundWindow(flow);
    return mode;
  }

  public static void Run(int width, int waitMs, string title) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    IntPtr ef = FindEffectCraft();
    IntPtr flow = FindFlow(title);
    Say("{\"stage\":\"" + (flow != IntPtr.Zero ? "found" : "missing") + "\",\"effectcraft\":" + (ef != IntPtr.Zero ? "true" : "false") + "}");
    // Without EffectCraft at all there is nothing to wait for beyond the Flow window.
    if (ef == IntPtr.Zero && Process.GetProcessesByName("effectcraft").Length == 0) waitMs = Math.Min(waitMs, 8000);
    // Both may still be on their way: a new Flow window, and EffectCraft just launched
    // (its control channel opens before its window shows).
    var clock = Stopwatch.StartNew();
    while ((flow == IntPtr.Zero || ef == IntPtr.Zero) && clock.ElapsedMilliseconds < waitMs) {
      Thread.Sleep(200);
      if (flow == IntPtr.Zero) flow = FindFlow(title);
      if (ef == IntPtr.Zero) ef = FindEffectCraft();
    }
    if (flow == IntPtr.Zero) { Say("{\"stage\":\"timeout\"}"); return; }
    if (ef == IntPtr.Zero) { SetForegroundWindow(flow); Say("{\"stage\":\"alone\"}"); return; }
    Thread.Sleep(300); // let a new window finish its first layout before moving it
    Say("{\"stage\":\"docked\",\"mode\":\"" + Dock(ef, flow, width) + "\"}");

    // Follow EffectCraft until one of the two windows closes or the Flow window is moved by hand.
    RECT lastEf = Frame(ef), placed = Frame(flow);
    bool efMin = false;
    while (IsWindow(ef) && IsWindow(flow)) {
      Thread.Sleep(150);
      if (IsIconic(ef)) { if (!efMin) { ShowWindow(flow, SW_MINIMIZE); efMin = true; } continue; }
      if (efMin) { ShowWindow(flow, SW_SHOWNOACTIVATE); efMin = false; Thread.Sleep(200); placed = Frame(flow); }
      if (IsIconic(flow)) continue;
      RECT nowFlow = Frame(flow);
      if (!Same(nowFlow, placed)) { Say("{\"stage\":\"undocked\"}"); return; }
      RECT nowEf = Frame(ef);
      if (Same(nowEf, lastEf) || IsZoomed(ef)) { lastEf = nowEf; continue; }
      lastEf = nowEf;
      RECT w = Work(ef);
      int fw = nowFlow.R - nowFlow.L, x = nowEf.R;
      if (x + fw > w.R) x = w.R - fw;
      Place(flow, x, nowEf.T, fw, nowEf.B - nowEf.T, SWP_NOZORDER | SWP_NOACTIVATE);
      placed = Frame(flow);
    }
    Say("{\"stage\":\"closed\"}");
  }
}
'@

[FlowDock]::Run($Width, $WaitMs, $Title)
