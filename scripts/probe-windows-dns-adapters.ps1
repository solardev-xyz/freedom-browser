# Disposable hosted-runner qualification only. Never used by production setup.
param([ValidateSet('Begin', 'Restore')][string]$Operation, [string]$Snapshot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:OS -ne 'Windows_NT') {
    throw 'Use only a disposable Windows CI runner'
}
function Read-Dns($entry) {
    Get-DnsClientServerAddress | Where-Object { $_.InterfaceIndex -eq $entry.Index -and $_.AddressFamily -eq $entry.Family }
}
function Write-Dns($entry, $servers, $automatic) {
    $family = if ($entry.Family -eq 2) { 'ipv4' } else { 'ipv6' }
    if ($automatic) {
        & netsh interface $family set dnsservers "name=$($entry.Index)" source=dhcp
        if ($LASTEXITCODE) { throw 'Could not restore automatic DNS' }
    } else {
        if (!$servers.Count) { throw 'Empty static DNS configuration' }
        & netsh interface $family set dnsservers "name=$($entry.Index)" source=static "address=$($servers[0])" validate=no
        if ($LASTEXITCODE) { throw 'Could not set owned DNS server' }
        for ($i = 1; $i -lt $servers.Count; $i++) {
            & netsh interface $family add dnsservers "name=$($entry.Index)" "address=$($servers[$i])" "index=$($i + 1)" validate=no
            if ($LASTEXITCODE) { throw 'Could not restore additional DNS server' }
        }
    }
}
if ($Operation -eq 'Begin') {
    $adapters = @(Get-NetAdapter -IncludeHidden | Where-Object Status -eq Up)
    if (!$adapters.Count) { throw 'No active adapters' }
    $allDns = @(Get-DnsClientServerAddress)
    $entries = @(foreach ($adapter in $adapters) {
        # Hidden non-IP adapters can be Up but have no DNS CIM object.
        foreach ($dns in @($allDns | Where-Object InterfaceIndex -eq $adapter.ifIndex)) {
            $service = if ($dns.AddressFamily -eq 2) { 'Tcpip' } elseif ($dns.AddressFamily -eq 23) { 'Tcpip6' } else { throw 'Unknown address family' }
            $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$service\Parameters\Interfaces\$(([guid]$adapter.InterfaceGuid).ToString('B'))"
            if (!(Test-Path $key)) { throw 'Cannot determine automatic/static DNS configuration' }
            $static = (Get-ItemProperty $key).NameServer
            [pscustomobject]@{Index=[uint32]$adapter.ifIndex;Family=[int]$dns.AddressFamily;Servers=@($dns.ServerAddresses);Static=[bool]$static;Key=$key}
        }
    })
    if (!$entries.Count) { throw 'No DNS configuration found' }
    # Persist every original entry before the first mutation, including source.
    $entries | ConvertTo-Json -Depth 4 | Set-Content $Snapshot -Encoding utf8
    $entries | ConvertTo-Json -Depth 4 -Compress | Write-Host
    foreach ($entry in $entries) {
        $dns = Read-Dns $entry
        if (!$dns) { throw "DNS object absent: index=$($entry.Index), family=$($entry.Family)" }
        $address = if ($entry.Family -eq 2) { '127.0.0.1' } else { '::1' }
        Write-Dns $entry @($address) $false
        $actual = Read-Dns $entry
        if (($actual.ServerAddresses -join ',') -ne $address) { throw 'Owned DNS route was not applied' }
    }
    foreach ($entry in $entries) {
        $actual = Read-Dns $entry
        $address = if ($entry.Family -eq 2) { '127.0.0.1' } else { '::1' }
        if (($actual.ServerAddresses -join ',') -ne $address) { throw 'Owned DNS routes changed while applying another family' }
    }
    $uncovered = @(Get-DnsClientServerAddress | Where-Object {
        $_.ServerAddresses.Count -and $_.InterfaceIndex -notin @($entries.Index) -and
        (Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue | Where-Object ConnectionState -eq Connected)
    })
    if ($uncovered.Count) { throw 'An active DNS-capable interface is uncovered' }
    Write-Host 'All active adapter DNS routes point to owned IPv4/IPv6 listeners'
} else {
    $entries = @(Get-Content $Snapshot -Raw | ConvertFrom-Json)
    $failures = @()
    foreach ($entry in $entries) {
        try {
            Write-Dns $entry @($entry.Servers) (!$entry.Static)
            $actual = Read-Dns $entry
            if (($actual.ServerAddresses -join ',') -ne ($entry.Servers -join ',')) { throw 'Restored DNS addresses differ' }
        } catch { $failures += $_ }
    }
    foreach ($entry in $entries) {
        $actual = Read-Dns $entry
        if (($actual.ServerAddresses -join ',') -ne ($entry.Servers -join ',')) { $failures += 'Final restored DNS addresses differ' }
        if ([bool](Get-ItemProperty $entry.Key).NameServer -ne $entry.Static) { $failures += 'Restored automatic/static DNS mode differs' }
    }
    if ($failures.Count) { throw ($failures -join '; ') }
    Write-Host 'Original adapter DNS configuration restored and checked'
}
