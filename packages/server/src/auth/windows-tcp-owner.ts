/**
 * The Windows peer source read straight from the kernel: one PowerShell,
 * started per check, compiles a small C# helper with `Add-Type` and asks
 *
 * - `GetExtendedTcpTable` (IPv4 and IPv6, every TCP state, with the owning
 *   pid) for the rows whose local port is the peer's port, and
 * - for every pid on those rows and for this server: the user SID of its
 *   process token, its image path (`QueryFullProcessImageName`) and its image
 *   name (the Toolhelp process snapshot, the same name CIM's
 *   `Win32_Process.Name` reports),
 *
 * then reads the table a second time while it still holds every process
 * handle, so a pid that exited and was reused in between cannot pass as the
 * owner (the caller requires the same owner in both reads).
 *
 * Why not `netstat` + CIM: `netstat` does not print rows in state 0, which a
 * fresh loopback connection can sit in for up to seconds (measured
 * 2026-11-10/17: about 1 % of first looks), and WMI takes about 1.3-1.5 s
 * per cold call. This source took a median of about 0.3-0.4 s cold.
 *
 * The reply is one line of ASCII JSON (every other character is a `\uXXXX`
 * escape), so the console code page cannot alter it. This module only builds
 * the script and checks the reply's shape; `process-identity.ts` decides.
 */

/** The stages the script itself reports when it cannot answer. */
export const KERNEL_SCRIPT_STAGES = ['add-type', 'tcp-table', 'native'] as const;
export type KernelScriptStage = (typeof KERNEL_SCRIPT_STAGES)[number];

/** One TCP row whose local port is the peer's port. Addresses are as .NET
 * prints them (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`); `state` is the raw
 * MIB_TCP_STATE (0 included); `pid` 0 is a row no process owns (TIME_WAIT). */
export interface KernelTcpRow {
  state: number;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  pid: number;
}

/** What the script read about one process. A field it could not read is
 * null and `err` says which call failed (for the log, never compared). */
export interface KernelProcess {
  pid: number;
  name: string | null;
  path: string | null;
  sid: string | null;
  err: string | null;
}

export type KernelReply =
  | { kind: 'stage'; stage: KernelScriptStage }
  | { kind: 'table'; rows: KernelTcpRow[]; rowsAfter: KernelTcpRow[]; procs: KernelProcess[] };

/** The most processes the script reads: the distinct owners of the peer's
 * local port plus this server. More owners than that cannot be one owner. */
export const KERNEL_MAX_PROCESSES = 64;

// The C# helper. Single-quoted here-string: PowerShell expands nothing in it.
// No line may start with `'@`.
const HELPER = String.raw`using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
public static class BrowserLinkPeer {
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int cls, int reserved);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buf, int len, out int needed);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref Entry e);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Entry {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  static string Q(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < ' ' || c > '~') { b.Append("\\u"); b.Append(((int)c).ToString("x4")); }
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static int Port(int v) { return ((v & 0xff) << 8) | ((v >> 8) & 0xff); }
  static string Table(int af, int port, StringBuilder sb, List<int> pids) {
    int size = 0; uint r = 0; IntPtr buf = IntPtr.Zero;
    for (int attempt = 0; attempt < 4; attempt++) {
      size = 0;
      GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 5, 0);
      size += 4096;
      buf = Marshal.AllocHGlobal(size);
      r = GetExtendedTcpTable(buf, ref size, false, af, 5, 0);
      if (r == 0) break;
      Marshal.FreeHGlobal(buf); buf = IntPtr.Zero;
      if (r != 122) break;
    }
    if (r != 0) return "error " + r;
    try {
      int rowSize = af == 2 ? 24 : 56;
      int n = Marshal.ReadInt32(buf);
      if (n < 0 || 4 + (long)n * rowSize > size) return "short table";
      bool first = sb[sb.Length - 1] == '[';
      for (int i = 0; i < n; i++) {
        IntPtr row = IntPtr.Add(buf, 4 + i * rowSize);
        int state, lport, rport, pid; string la, ra;
        if (af == 2) {
          state = Marshal.ReadInt32(row, 0);
          la = Marshal.ReadByte(row, 4) + "." + Marshal.ReadByte(row, 5) + "." + Marshal.ReadByte(row, 6) + "." + Marshal.ReadByte(row, 7);
          lport = Port(Marshal.ReadInt32(row, 8));
          ra = Marshal.ReadByte(row, 12) + "." + Marshal.ReadByte(row, 13) + "." + Marshal.ReadByte(row, 14) + "." + Marshal.ReadByte(row, 15);
          rport = Port(Marshal.ReadInt32(row, 16));
          pid = Marshal.ReadInt32(row, 20);
        } else {
          byte[] a = new byte[16];
          Marshal.Copy(row, a, 0, 16); la = new IPAddress(a).ToString();
          lport = Port(Marshal.ReadInt32(row, 20));
          Marshal.Copy(IntPtr.Add(row, 24), a, 0, 16); ra = new IPAddress(a).ToString();
          rport = Port(Marshal.ReadInt32(row, 44));
          state = Marshal.ReadInt32(row, 48);
          pid = Marshal.ReadInt32(row, 52);
        }
        if (lport != port) continue;
        if (!first) sb.Append(',');
        first = false;
        sb.Append("{\"state\":").Append(state).Append(",\"la\":").Append(Q(la)).Append(",\"lp\":").Append(lport)
          .Append(",\"ra\":").Append(Q(ra)).Append(",\"rp\":").Append(rport).Append(",\"pid\":").Append(pid).Append('}');
        if (pids != null && pid != 0 && !pids.Contains(pid)) pids.Add(pid);
      }
      return null;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  static string Rows(int port, StringBuilder sb, List<int> pids) {
    sb.Append('[');
    string e = Table(2, port, sb, pids);
    if (e != null) return e;
    // A machine without IPv6 has no IPv6 rows to read; its error only means
    // that, and a missing row is never an accept.
    Table(23, port, sb, pids);
    sb.Append(']');
    return null;
  }
  static string Sid(IntPtr token) {
    int need;
    GetTokenInformation(token, 1, IntPtr.Zero, 0, out need);
    if (need <= 0) return null;
    IntPtr b = Marshal.AllocHGlobal(need);
    try {
      if (!GetTokenInformation(token, 1, b, need, out need)) return null;
      IntPtr str;
      if (!ConvertSidToStringSidW(Marshal.ReadIntPtr(b), out str)) return null;
      try { return Marshal.PtrToStringUni(str); } finally { LocalFree(str); }
    } finally { Marshal.FreeHGlobal(b); }
  }
  static Dictionary<int, string> Names() {
    var names = new Dictionary<int, string>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return names;
    try {
      var e = new Entry(); e.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
      for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) names[(int)e.th32ProcessID] = e.szExeFile;
    } finally { CloseHandle(snap); }
    return names;
  }
  public static string Run(int port, int serverPid) {
    var sb = new StringBuilder("{\"v\":1,\"rows\":");
    var pids = new List<int>();
    string e = Rows(port, sb, pids);
    if (e != null) return "{\"v\":1,\"stage\":\"tcp-table\"}";
    pids.Remove(serverPid);
    pids.Insert(0, serverPid);
    if (pids.Count > ${String(KERNEL_MAX_PROCESSES)}) pids.RemoveRange(${String(KERNEL_MAX_PROCESSES)}, pids.Count - ${String(KERNEL_MAX_PROCESSES)});
    var handles = new IntPtr[pids.Count];
    var openErrors = new int[pids.Count];
    var procs = new StringBuilder("[");
    try {
      for (int i = 0; i < pids.Count; i++) {
        handles[i] = OpenProcess(0x1000, false, pids[i]);
        if (handles[i] == IntPtr.Zero) openErrors[i] = Marshal.GetLastWin32Error();
      }
      // Names and the second table read come after every handle is open: a
      // process with an open handle keeps its pid until the handle closes.
      var names = Names();
      for (int i = 0; i < pids.Count; i++) {
        int pid = pids[i]; IntPtr h = handles[i];
        string name, path = null, sid = null, err = null;
        names.TryGetValue(pid, out name);
        if (h == IntPtr.Zero) err = "open " + openErrors[i];
        else {
          var nb = new StringBuilder(32768); int sz = nb.Capacity;
          if (QueryFullProcessImageNameW(h, 0, nb, ref sz)) path = nb.ToString(0, sz); else err = "path " + Marshal.GetLastWin32Error();
          IntPtr token;
          if (!OpenProcessToken(h, 8, out token)) err = (err == null ? "" : err + "; ") + "token " + Marshal.GetLastWin32Error();
          else { try { sid = Sid(token); } finally { CloseHandle(token); } if (sid == null) err = (err == null ? "" : err + "; ") + "sid"; }
        }
        if (i > 0) procs.Append(',');
        procs.Append("{\"pid\":").Append(pid).Append(",\"name\":").Append(Q(name)).Append(",\"path\":").Append(Q(path))
          .Append(",\"sid\":").Append(Q(sid)).Append(",\"err\":").Append(Q(err)).Append('}');
      }
      procs.Append(']');
      sb.Append(",\"rowsAfter\":");
      e = Rows(port, sb, null);
      if (e != null) return "{\"v\":1,\"stage\":\"tcp-table\"}";
    } finally { foreach (IntPtr h in handles) if (h != IntPtr.Zero) CloseHandle(h); }
    sb.Append(",\"procs\":").Append(procs).Append('}');
    return sb.ToString();
  }
}`;

/**
 * The PowerShell `-Command` text for one check. `port` is the peer's local
 * port and `serverPid` this server's pid; both are checked to be safe
 * integers before they are placed in the text. Any failure the script can
 * catch (Add-Type refused by Constrained Language Mode or AppLocker, a
 * failing native call) prints a `stage` reply instead of rows.
 */
export function buildKernelOwnerScript(port: number, serverPid: number): string {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError('port out of range');
  }
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0) throw new RangeError('invalid pid');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$src = @'",
    HELPER,
    "'@",
    `try { Add-Type -TypeDefinition $src } catch { Write-Output '{"v":1,"stage":"add-type"}'; exit 0 }`,
    `try { Write-Output ([BrowserLinkPeer]::Run(${String(port)}, ${String(serverPid)})) } catch { Write-Output '{"v":1,"stage":"native"}'; exit 0 }`,
  ].join('\n');
}

/** Parse the one JSON line the script prints. Null for anything that is not
 * exactly one of its two shapes. */
export function parseKernelOwnerReply(out: string): KernelReply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  if ('stage' in parsed) {
    const stage = parsed.stage;
    return typeof stage === 'string' && (KERNEL_SCRIPT_STAGES as readonly string[]).includes(stage)
      ? { kind: 'stage', stage: stage as KernelScriptStage }
      : null;
  }
  const rows = parseRows(parsed.rows);
  const rowsAfter = parseRows(parsed.rowsAfter);
  const procs = parseProcs(parsed.procs);
  if (rows === null || rowsAfter === null || procs === null) return null;
  return { kind: 'table', rows, rowsAfter, procs };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPort = (v: unknown): v is number => isInt(v) && v >= 0 && v <= 65535;
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseRows(v: unknown): KernelTcpRow[] | null {
  if (!Array.isArray(v)) return null;
  const rows: KernelTcpRow[] = [];
  for (const item of v as unknown[]) {
    if (!isRecord(item)) return null;
    const { state, la, lp, ra, rp, pid } = item;
    if (!isInt(state) || !isInt(pid) || pid < 0 || !isPort(lp) || !isPort(rp)) return null;
    if (typeof la !== 'string' || typeof ra !== 'string') return null;
    rows.push({
      state,
      localAddress: la,
      localPort: lp,
      remoteAddress: ra,
      remotePort: rp,
      pid,
    });
  }
  return rows;
}

function parseProcs(v: unknown): KernelProcess[] | null {
  if (!Array.isArray(v)) return null;
  const procs: KernelProcess[] = [];
  for (const item of v as unknown[]) {
    if (!isRecord(item)) return null;
    const { pid, name, path, sid, err } = item;
    if (!isInt(pid)) return null;
    if (!isStringOrNull(name) || !isStringOrNull(path) || !isStringOrNull(sid)) return null;
    if (!isStringOrNull(err)) return null;
    procs.push({ pid, name, path, sid, err });
  }
  return procs;
}
