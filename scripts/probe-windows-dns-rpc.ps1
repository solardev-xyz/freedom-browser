# Experimental, disposable-runner-only probe. Never changes normal-user DNS,
# adapter settings or service state. Every filter is caller + interface scoped.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or ![OperatingSystem]::IsWindows()) {
    throw 'Use only a disposable Windows CI runner'
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FreedomDnsRpcProbe {
    [DllImport("rpcrt4.dll", CharSet=CharSet.Unicode)]
    static extern uint RpcBindingFromStringBindingW(string text, out IntPtr binding);
    [DllImport("rpcrt4.dll")] static extern uint RpcBindingFree(ref IntPtr binding);
    [DllImport("rpcrt4.dll")] static extern uint RpcMgmtSetComTimeout(IntPtr binding, uint timeout);
    [DllImport("rpcrt4.dll")] static extern uint RpcMgmtInqIfIds(IntPtr binding, out IntPtr vector);
    [DllImport("rpcrt4.dll")] static extern uint RpcIfIdVectorFree(ref IntPtr vector);
    [StructLayout(LayoutKind.Sequential)]
    public struct Interface { public Guid Uuid; public ushort Major; public ushort Minor; }
    public static Interface[] Discover() {
        IntPtr binding = IntPtr.Zero, vector = IntPtr.Zero;
        try {
            uint status = RpcBindingFromStringBindingW("ncalrpc:[DNSResolver]", out binding);
            if (status != 0) throw new Exception("DNSResolver binding: " + status);
            RpcMgmtSetComTimeout(binding, 2);
            status = RpcMgmtInqIfIds(binding, out vector);
            if (status != 0) throw new Exception("DNSResolver interface discovery: " + status);
            int count = Marshal.ReadInt32(vector);
            if (count < 1 || count > 64) throw new Exception("Unexpected interface count");
            var result = new List<Interface>();
            for (int i = 0; i < count; i++) {
                IntPtr entry = Marshal.ReadIntPtr(vector, IntPtr.Size + i * IntPtr.Size);
                result.Add(Marshal.PtrToStructure<Interface>(entry));
            }
            return result.ToArray();
        } finally {
            if (vector != IntPtr.Zero) RpcIfIdVectorFree(ref vector);
            if (binding != IntPtr.Zero) RpcBindingFree(ref binding);
        }
    }
}
'@

$interfaces = @([FreedomDnsRpcProbe]::Discover())
$interfaces | ForEach-Object { "Observed DNSResolver interface $($_.Uuid) $($_.Major).$($_.Minor)" }
$sid = (Get-LocalUser -Name FreedomSbxOffline).SID.Value
if ($sid -notmatch '^S-1-5-21-(\d+-){3}\d+$') { throw 'Unexpected sandbox SID' }
& netsh rpc filter add condition '?'

# Record the existing failure without converting the production gate to a skip.
$baseline = & node scripts/qualify-windows-dns.js 2>&1
$baselineExit = $LASTEXITCODE
$baseline | ForEach-Object { Write-Host $_ }
if ($baselineExit -eq 0 -or ($baseline -join "`n") -notmatch '"offlinePackets":[1-9]') {
    throw 'Probe requires the positively controlled, reproduced DNS leak'
}

$keys = [Collections.Generic.List[string]]::new()
$scratch = Join-Path $env:RUNNER_TEMP ('freedom-dns-rpc-' + [guid]::NewGuid())
New-Item -ItemType Directory $scratch | Out-Null
try {
    foreach ($interface in $interfaces) {
        # The standard RPC management interface is shared by unrelated servers.
        if ($interface.Uuid -eq [guid]'afa8bd80-7d8a-11c9-bef4-08002b102989') { continue }
        $key = [guid]::NewGuid().ToString()
        $keys.Add($key)
        $script = Join-Path $scratch "$key.txt"
        @"
rpc filter
add rule layer=um actiontype=block filterkey=$key persistence=volatile
add condition field=remote_user_token matchtype=equal data=D:(A;;CC;;;$sid)
add condition field=if_uuid matchtype=equal data=$($interface.Uuid)
add condition field=if_version matchtype=equal data=$($interface.Major).$($interface.Minor)
add condition field=protocol matchtype=equal data=ncalrpc
add filter
"@ | Set-Content $script -Encoding ascii
        & netsh -f $script
        if ($LASTEXITCODE) { throw 'Targeted RPC filter installation failed' }
    }
    if (!$keys.Count) { throw 'No DNS-specific interfaces discovered' }
    & netsh rpc filter show filter
    & node scripts/qualify-windows-dns.js
    if ($LASTEXITCODE) { throw 'Targeted RPC enforcement did not close the DNS boundary' }
} finally {
    foreach ($key in $keys) {
        & netsh rpc filter delete filter "filterkey=$key"
        if ($LASTEXITCODE) { Write-Error "Could not remove owned probe filter $key" -ErrorAction Continue }
    }
}
