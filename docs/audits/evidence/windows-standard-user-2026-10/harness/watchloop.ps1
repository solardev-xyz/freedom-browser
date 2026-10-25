# Admin-side observer for #779 (runs elevated over SSH): every ~250 ms, record
# the elevated setup helper's owner, elevation and any module it loaded from
# outside System32. Stops after $Seconds.
param([int]$Seconds = 240)
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Tok {
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, out int v, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Elevated(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return "no-process-handle";
    IntPtr t; if (!OpenProcessToken(p, 8, out t)) { CloseHandle(p); return "no-token"; }
    int v, r; bool ok = GetTokenInformation(t, 20, out v, 4, out r); CloseHandle(t); CloseHandle(p);
    return ok ? (v != 0 ? "elevated" : "not-elevated") : "unknown";
  }
}
'@
$out = 'C:\e2e\watch.log'; Set-Content $out ''
$end = (Get-Date).AddSeconds($Seconds); $seen = @{}
while ((Get-Date) -lt $end) {
  foreach ($p in Get-CimInstance Win32_Process -Filter "Name = 'freedom-windows-sandbox-setup.exe'") {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner
    $elev = [Tok]::Elevated([int]$p.ProcessId)
    $mods = @($proc.Modules | % FileName)
    $nonSys = @($mods | ? { $_ -notlike 'C:\WINDOWS\System32\*' -and $_ -notlike 'C:\WINDOWS\SYSTEM32\*' })
    $named = @($mods | ? { $_ -match '\\(netapi32|fwpuclnt)\.dll$' })
    $line = "$(Get-Date -Format o) pid=$($p.ProcessId) owner=$($o.Domain)\$($o.User) token=$elev session=$($p.SessionId) parent=$($p.ParentProcessId) modules=$($mods.Count) netapi32/fwpuclnt=[$($named -join ', ')] outside-System32=[$($nonSys -join ', ')]"
    Add-Content $out $line
  }
  Start-Sleep -Milliseconds 250
}
