# Disposable hosted-runner qualification only. Never used by production setup.
param([ValidateSet('Begin', 'Restore')][string]$Operation, [string]$Snapshot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:OS -ne 'Windows_NT') {
    throw 'Use only a disposable Windows CI runner'
}
function Read-Dns($entry) {
    Get-DnsClientServerAddress | Where-Object { $_.InterfaceIndex -eq $entry.Index -and $_.AddressFamily -eq $entry.Family }
}
function Read-StaticMode($entry) {
    $family = if ($entry.Family -eq 2) { 'ipv4' } else { 'ipv6' }
    $text = (& netsh interface $family show dnsservers "name=$($entry.Index)") -join "`n"
    if ($LASTEXITCODE) { throw 'Cannot read original DNS mode' }
    if ($text -match 'through DHCP') { return $false }
    if ($text -match 'Statically Configured') { return $true }
    throw "Unrecognized DNS configuration mode: $text"
}
function Write-Dns {
    param($Entry, [AllowEmptyCollection()][string[]]$Servers, [bool]$Automatic)
    $Servers = @($Servers | Where-Object { ![string]::IsNullOrWhiteSpace($_) })
    $family = if ($Entry.Family -eq 2) { 'ipv4' } else { 'ipv6' }
    Write-Host "DNS fixture: index=$($Entry.Index) family=$family automatic=$Automatic servers=$($Servers -join ',')"
    if ($Automatic) {
        & netsh interface $family set dnsservers "name=$($Entry.Index)" source=dhcp
        if ($LASTEXITCODE) { throw 'Could not restore automatic DNS' }
    } else {
        $first = if ($Servers.Count) { $Servers[0] } else { 'none' }
        & netsh interface $family set dnsservers "name=$($Entry.Index)" source=static "address=$first" validate=no
        if ($LASTEXITCODE) { throw 'Could not set owned DNS server' }
        for ($i = 1; $i -lt $Servers.Count; $i++) {
            & netsh interface $family add dnsservers "name=$($Entry.Index)" "address=$($Servers[$i])" "index=$($i + 1)" validate=no
            if ($LASTEXITCODE) { throw 'Could not restore additional DNS server' }
        }
    }
}
if ($Operation -eq 'Begin') {
    # Include connected loopback/IP interfaces, not just physical/virtual NICs.
    $connected = @(Get-NetIPInterface | Where-Object ConnectionState -eq Connected | Select-Object -ExpandProperty InterfaceIndex -Unique)
    $entries = @(foreach ($dns in @(Get-DnsClientServerAddress | Where-Object InterfaceIndex -in $connected)) {
        if ($dns.AddressFamily -notin @(2, 23)) { throw 'Unknown address family' }
        $entry = [pscustomobject]@{Index=[uint32]$dns.InterfaceIndex;Family=[int]$dns.AddressFamily;Servers=@($dns.ServerAddresses);Static=$false}
        $entry.Static = Read-StaticMode $entry
        $entry
    })
    if (!$entries.Count) { throw 'No connected DNS interfaces found' }
    # Persist every original entry before the first mutation, including source.
    $entries | ConvertTo-Json -Depth 4 | Set-Content $Snapshot -Encoding utf8
    $entries | ConvertTo-Json -Depth 4 -Compress | Write-Host
    foreach ($entry in $entries) {
        $address = if ($entry.Family -eq 2) { '127.0.0.1' } else { '::1' }
        Write-Dns -Entry $entry -Servers @($address) -Automatic $false
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
    Write-Host 'All connected DNS routes point to owned IPv4/IPv6 listeners'
} else {
    # Windows PowerShell 5 returns a root JSON array as one pipeline object;
    # wrapping that result in @() would produce a nested array and merge fields.
    $entries = ConvertFrom-Json -InputObject (Get-Content $Snapshot -Raw)
    $failures = @()
    foreach ($entry in $entries) {
        if ($entry.Index -is [array] -or $entry.Family -is [array]) { throw 'Nested DNS snapshot entry' }
        try { Write-Dns -Entry $entry -Servers @($entry.Servers) -Automatic (!$entry.Static) }
        catch { $failures += $_ }
    }
    foreach ($entry in $entries) {
        try {
            $actual = Read-Dns $entry
            if (($actual.ServerAddresses -join ',') -ne ($entry.Servers -join ',')) { throw 'Restored DNS addresses differ' }
            if ((Read-StaticMode $entry) -ne $entry.Static) { throw 'Restored automatic/static DNS mode differs' }
        } catch { $failures += $_ }
    }
    Clear-DnsClientCache
    if ($failures.Count) { throw ($failures -join '; ') }
    Write-Host 'Original DNS configuration restored and checked'
}
