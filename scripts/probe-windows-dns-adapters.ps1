# Disposable hosted-runner qualification only. Never used by production setup.
param([ValidateSet('Begin', 'Restore')][string]$Operation, [string]$Snapshot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:OS -ne 'Windows_NT') {
    throw 'Use only a disposable Windows CI runner'
}
if ($Operation -eq 'Begin') {
    $adapters = @(Get-NetAdapter -IncludeHidden | Where-Object Status -eq Up)
    if (!$adapters.Count) { throw 'No active adapters' }
    $entries = @(foreach ($adapter in $adapters) {
        foreach ($dns in @(Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex)) {
            $service = if ($dns.AddressFamily -eq 2) { 'Tcpip' } elseif ($dns.AddressFamily -eq 23) { 'Tcpip6' } else { throw 'Unknown address family' }
            $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$service\Parameters\Interfaces\$(([guid]$adapter.InterfaceGuid).ToString('B'))"
            if (!(Test-Path $key)) { throw 'Cannot determine automatic/static DNS configuration' }
            $static = (Get-ItemProperty $key).NameServer
            [pscustomobject]@{Index=$adapter.ifIndex;Family=$dns.AddressFamily;Servers=@($dns.ServerAddresses);Static=[bool]$static}
        }
    })
    if (!$entries.Count) { throw 'No DNS configuration found' }
    # Persist every original entry before the first mutation, including source.
    $entries | ConvertTo-Json -Depth 4 | Set-Content $Snapshot -Encoding utf8
    foreach ($entry in $entries) {
        $dns = Get-DnsClientServerAddress -InterfaceIndex $entry.Index | Where-Object AddressFamily -eq $entry.Family
        $address = if ($entry.Family -eq 2) { '127.0.0.1' } else { '::1' }
        Set-DnsClientServerAddress -InputObject $dns -ServerAddresses @($address)
        $actual = Get-DnsClientServerAddress -InterfaceIndex $entry.Index | Where-Object AddressFamily -eq $entry.Family
        if (($actual.ServerAddresses -join ',') -ne $address) { throw 'Owned DNS route was not applied' }
    }
    foreach ($entry in $entries) {
        $actual = Get-DnsClientServerAddress -InterfaceIndex $entry.Index | Where-Object AddressFamily -eq $entry.Family
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
            $dns = Get-DnsClientServerAddress -InterfaceIndex $entry.Index | Where-Object AddressFamily -eq $entry.Family
            if ($entry.Static) { Set-DnsClientServerAddress -InputObject $dns -ServerAddresses @($entry.Servers) }
            else { Set-DnsClientServerAddress -InputObject $dns -ResetServerAddresses }
            $actual = Get-DnsClientServerAddress -InterfaceIndex $entry.Index | Where-Object AddressFamily -eq $entry.Family
            if (($actual.ServerAddresses -join ',') -ne ($entry.Servers -join ',')) { throw 'Restored DNS addresses differ' }
        } catch { $failures += $_ }
    }
    foreach ($entry in $entries) {
        $actual = Get-DnsClientServerAddress -InterfaceIndex $entry.Index | Where-Object AddressFamily -eq $entry.Family
        if (($actual.ServerAddresses -join ',') -ne ($entry.Servers -join ',')) { $failures += 'Final restored DNS addresses differ' }
    }
    if ($failures.Count) { throw ($failures -join '; ') }
    Write-Host 'Original adapter DNS configuration restored and checked'
}
