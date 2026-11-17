/**
 * The Windows peer source read straight from the kernel: one PowerShell,
 * started per check, declares the Win32 calls it needs with
 * `System.Reflection.Emit` (P/Invoke stubs in an in-memory assembly, nothing
 * compiled, nothing written to disk) and asks
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
 * per cold call.
 *
 * Why not `Add-Type` (the first version): in Windows PowerShell 5.1 it
 * compiles C# by starting `csc.exe` on every check. Measured 2026-11-17 on
 * Windows 11: PowerShell start 181 ms median, `Add-Type` 140-310 ms, the
 * native calls 28 ms; on the windows-latest CI runner the compile pushed the
 * check past its 5 s bound. Emitting the stubs costs no compiler.
 *
 * Under Constrained Language Mode (AppLocker, WDAC) the Reflection.Emit
 * calls are refused like `Add-Type` was: the script reports stage `interop`
 * and the caller falls back.
 *
 * The reply is one line of ASCII JSON (every other character is a `\uXXXX`
 * escape), so the console code page cannot alter it. This module only builds
 * the script and checks the reply's shape; `process-identity.ts` decides.
 */

/** The stages the script itself reports when it cannot answer. */
export const KERNEL_SCRIPT_STAGES = ['interop', 'tcp-table', 'native'] as const;
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

// Declares the Win32 calls as P/Invoke stubs of an in-memory type. Every
// pointer argument is a raw buffer (no ref/out, no structs), read with
// Marshal. A failure here is stage `interop`.
const INTEROP = String.raw`try {
  $M = [Runtime.InteropServices.Marshal]
  $an = New-Object Reflection.AssemblyName('BrowserLinkPeer')
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly($an, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $tb = $ab.DefineDynamicModule('BrowserLinkPeer').DefineType('BrowserLinkPeerNative', [Reflection.TypeAttributes]'Public, Class')
  $defs = @(
    @('iphlpapi.dll', 'GetExtendedTcpTable', [uint32], @([IntPtr], [IntPtr], [bool], [int], [int], [int])),
    @('kernel32.dll', 'OpenProcess', [IntPtr], @([uint32], [bool], [int])),
    @('kernel32.dll', 'CloseHandle', [bool], @([IntPtr])),
    @('kernel32.dll', 'QueryFullProcessImageNameW', [bool], @([IntPtr], [int], [IntPtr], [IntPtr])),
    @('advapi32.dll', 'OpenProcessToken', [bool], @([IntPtr], [uint32], [IntPtr])),
    @('advapi32.dll', 'GetTokenInformation', [bool], @([IntPtr], [int], [IntPtr], [int], [IntPtr])),
    @('advapi32.dll', 'ConvertSidToStringSidW', [bool], @([IntPtr], [IntPtr])),
    @('kernel32.dll', 'LocalFree', [IntPtr], @([IntPtr])),
    @('kernel32.dll', 'CreateToolhelp32Snapshot', [IntPtr], @([uint32], [uint32])),
    @('kernel32.dll', 'Process32FirstW', [bool], @([IntPtr], [IntPtr])),
    @('kernel32.dll', 'Process32NextW', [bool], @([IntPtr], [IntPtr]))
  )
  foreach ($d in $defs) {
    $params = [Type[]]@($d[3])
    $mb = $tb.DefinePInvokeMethod($d[1], $d[0], [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $d[2], $params, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $mb.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $Win = $tb.CreateType()
} catch { Write-Output '{"v":1,"stage":"interop"}'; exit 0 }`;

// Reads the table, the processes and the table again; prints the reply.
// __MAX__ is replaced by KERNEL_MAX_PROCESSES.
const QUERY = String.raw`try {
  $port = [int]$env:BROWSER_LINK_PEER_PORT
  $serverPid = [int]$env:BROWSER_LINK_SERVER_PID
  if ($port -lt 1 -or $port -gt 65535 -or $serverPid -lt 1) { throw 'bad input' }
  function Q($s) {
    if ($null -eq $s) { return 'null' }
    $b = New-Object Text.StringBuilder
    [void]$b.Append([char]34)
    foreach ($c in $s.ToCharArray()) {
      $i = [int]$c
      if ($i -eq 34 -or $i -eq 92) { [void]$b.Append([char]92).Append($c) }
      elseif ($i -lt 32 -or $i -gt 126) { [void]$b.Append([char]92).Append('u').Append($i.ToString('x4')) }
      else { [void]$b.Append($c) }
    }
    [void]$b.Append([char]34)
    return $b.ToString()
  }
  function Rows($pids) {
    $out = New-Object Collections.Generic.List[string]
    foreach ($af in @(2, 23)) {
      $sizePtr = $M::AllocHGlobal(4)
      $buf = [IntPtr]::Zero
      $r = 1
      $size = 0
      try {
        for ($a = 0; $a -lt 4; $a++) {
          $M::WriteInt32($sizePtr, 0)
          [void]$Win::GetExtendedTcpTable([IntPtr]::Zero, $sizePtr, $false, $af, 5, 0)
          $size = $M::ReadInt32($sizePtr) + 4096
          $M::WriteInt32($sizePtr, $size)
          $buf = $M::AllocHGlobal($size)
          $r = $Win::GetExtendedTcpTable($buf, $sizePtr, $false, $af, 5, 0)
          if ($r -eq 0) { break }
          $M::FreeHGlobal($buf)
          $buf = [IntPtr]::Zero
          if ($r -ne 122) { break }
        }
        # A machine without IPv6 has no IPv6 rows; a missing row is never an accept.
        if ($r -ne 0) { if ($af -eq 2) { return $null } else { continue } }
        if ($af -eq 2) { $rowSize = 24; $lpOff = 8 } else { $rowSize = 56; $lpOff = 20 }
        $count = $M::ReadInt32($buf)
        if ($count -lt 0 -or (4 + [long]$count * $rowSize) -gt $size) { return $null }
        for ($i = 0; $i -lt $count; $i++) {
          $row = [IntPtr]::Add($buf, 4 + $i * $rowSize)
          $v = $M::ReadInt32($row, $lpOff)
          if (((($v -band 0xff) -shl 8) -bor (($v -shr 8) -band 0xff)) -ne $port) { continue }
          if ($af -eq 2) {
            $state = $M::ReadInt32($row, 0)
            $la = '{0}.{1}.{2}.{3}' -f $M::ReadByte($row, 4), $M::ReadByte($row, 5), $M::ReadByte($row, 6), $M::ReadByte($row, 7)
            $ra = '{0}.{1}.{2}.{3}' -f $M::ReadByte($row, 12), $M::ReadByte($row, 13), $M::ReadByte($row, 14), $M::ReadByte($row, 15)
            $v = $M::ReadInt32($row, 16)
            $owner = $M::ReadInt32($row, 20)
          } else {
            $bytes = New-Object byte[] 16
            $M::Copy($row, $bytes, 0, 16)
            $la = (New-Object Net.IPAddress -ArgumentList (,$bytes)).ToString()
            $M::Copy([IntPtr]::Add($row, 24), $bytes, 0, 16)
            $ra = (New-Object Net.IPAddress -ArgumentList (,$bytes)).ToString()
            $v = $M::ReadInt32($row, 44)
            $state = $M::ReadInt32($row, 48)
            $owner = $M::ReadInt32($row, 52)
          }
          $rp = (($v -band 0xff) -shl 8) -bor (($v -shr 8) -band 0xff)
          $out.Add('{"state":' + $state + ',"la":' + (Q $la) + ',"lp":' + $port + ',"ra":' + (Q $ra) + ',"rp":' + $rp + ',"pid":' + $owner + '}')
          if ($null -ne $pids -and $owner -ne 0 -and -not $pids.Contains($owner)) { $pids.Add($owner) }
        }
      } finally {
        if ($buf -ne [IntPtr]::Zero) { $M::FreeHGlobal($buf) }
        $M::FreeHGlobal($sizePtr)
      }
    }
    return '[' + ($out -join ',') + ']'
  }
  $pids = New-Object Collections.Generic.List[int]
  $rows = Rows $pids
  if ($null -eq $rows) { Write-Output '{"v":1,"stage":"tcp-table"}'; exit 0 }
  [void]$pids.Remove($serverPid)
  $pids.Insert(0, $serverPid)
  if ($pids.Count -gt __MAX__) { $pids.RemoveRange(__MAX__, $pids.Count - __MAX__) }
  $handles = @{}
  foreach ($p in $pids) { $handles[$p] = $Win::OpenProcess(0x1000, $false, $p) }
  try {
    # Names and the second table read come after every handle is open: a
    # process with an open handle keeps its pid until the handle closes.
    $names = @{}
    $snap = $Win::CreateToolhelp32Snapshot(2, 0)
    if ($snap.ToInt64() -ne -1) {
      if ([IntPtr]::Size -eq 8) { $esz = 568; $nameOff = 44 } else { $esz = 556; $nameOff = 36 }
      $e = $M::AllocHGlobal($esz)
      try {
        $M::WriteInt32($e, $esz)
        $ok = $Win::Process32FirstW($snap, $e)
        while ($ok) {
          $ep = $M::ReadInt32($e, 8)
          if ($handles.ContainsKey($ep)) { $names[$ep] = $M::PtrToStringUni([IntPtr]::Add($e, $nameOff)) }
          $ok = $Win::Process32NextW($snap, $e)
        }
      } finally {
        $M::FreeHGlobal($e)
        [void]$Win::CloseHandle($snap)
      }
    }
    $procs = New-Object Collections.Generic.List[string]
    $pathBuf = $M::AllocHGlobal(65536)
    $intBuf = $M::AllocHGlobal(8)
    $ptrBuf = $M::AllocHGlobal(8)
    try {
      foreach ($p in $pids) {
        $h = $handles[$p]
        $path = $null
        $sid = $null
        $err = $null
        if ($h -eq [IntPtr]::Zero) { $err = 'open' } else {
          $M::WriteInt32($intBuf, 32768)
          if ($Win::QueryFullProcessImageNameW($h, 0, $pathBuf, $intBuf)) { $path = $M::PtrToStringUni($pathBuf, $M::ReadInt32($intBuf)) } else { $err = 'path' }
          if (-not $Win::OpenProcessToken($h, 8, $ptrBuf)) {
            if ($err) { $err = $err + '; token' } else { $err = 'token' }
          } else {
            $tok = $M::ReadIntPtr($ptrBuf)
            try {
              $M::WriteInt32($intBuf, 0)
              [void]$Win::GetTokenInformation($tok, 1, [IntPtr]::Zero, 0, $intBuf)
              $need = $M::ReadInt32($intBuf)
              if ($need -gt 0) {
                $info = $M::AllocHGlobal($need)
                try {
                  if ($Win::GetTokenInformation($tok, 1, $info, $need, $intBuf)) {
                    if ($Win::ConvertSidToStringSidW($M::ReadIntPtr($info), $ptrBuf)) {
                      $str = $M::ReadIntPtr($ptrBuf)
                      $sid = $M::PtrToStringUni($str)
                      [void]$Win::LocalFree($str)
                    }
                  }
                } finally { $M::FreeHGlobal($info) }
              }
            } finally { [void]$Win::CloseHandle($tok) }
            if ($null -eq $sid) { if ($err) { $err = $err + '; sid' } else { $err = 'sid' } }
          }
        }
        $procs.Add('{"pid":' + $p + ',"name":' + (Q $names[$p]) + ',"path":' + (Q $path) + ',"sid":' + (Q $sid) + ',"err":' + (Q $err) + '}')
      }
    } finally {
      $M::FreeHGlobal($pathBuf)
      $M::FreeHGlobal($intBuf)
      $M::FreeHGlobal($ptrBuf)
    }
    $after = Rows $null
    if ($null -eq $after) { Write-Output '{"v":1,"stage":"tcp-table"}'; exit 0 }
  } finally {
    foreach ($h in $handles.Values) { if ($h -ne [IntPtr]::Zero) { [void]$Win::CloseHandle($h) } }
  }
  Write-Output ('{"v":1,"rows":' + $rows + ',"rowsAfter":' + $after + ',"procs":[' + ($procs -join ',') + ']}')
} catch { Write-Output '{"v":1,"stage":"native"}'; exit 0 }`;

/** The environment variables that carry one check's inputs to the script. */
export const KERNEL_PORT_VAR = 'BROWSER_LINK_PEER_PORT';
export const KERNEL_SERVER_PID_VAR = 'BROWSER_LINK_SERVER_PID';

/**
 * The PowerShell `-Command` text, the same for every check: the inputs come
 * from `kernelOwnerEnv`, never from the text. Measured 2026-11-17 on
 * Windows 11: with the port written into the text, most checks spent about
 * 2.3 s before the script's first line ran; with this unchanged text only the
 * first check on the machine does, the others take about 0.3 s. That fits
 * the antimalware scan (AMSI) of a script text it has not seen yet; the
 * cause was inferred from timings, not observed. The script reads both variables as
 * integers and refuses any that is out of range (stage `native`). Any failure
 * it can catch (the interop stubs refused under Constrained Language Mode, a
 * failing native call) prints a `stage` reply instead of rows.
 */
export const KERNEL_OWNER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  INTEROP,
  QUERY.replaceAll('__MAX__', String(KERNEL_MAX_PROCESSES)),
].join('\n');

/**
 * The environment of one check: `port` is the peer's local port and
 * `serverPid` this server's pid, both checked to be safe positive integers.
 * The rest of this process's environment is kept (PowerShell needs `PATH`,
 * `SystemRoot` and the like).
 */
export function kernelOwnerEnv(
  port: number,
  serverPid: number,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError('port out of range');
  }
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0) throw new RangeError('invalid pid');
  return { ...base, [KERNEL_PORT_VAR]: String(port), [KERNEL_SERVER_PID_VAR]: String(serverPid) };
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
