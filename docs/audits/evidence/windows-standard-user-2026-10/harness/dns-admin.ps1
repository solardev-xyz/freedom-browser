param([string]$Mode)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'start') {
  New-Item -ItemType Directory -Force C:\e2e\dns | Out-Null
  Copy-Item C:\e2e\dns-listener.js C:\e2e\dns\dns-listener.js -Force
  Set-Content C:\e2e\dns\packets.log ''
  icacls C:\e2e\dns /grant 'freedomstd:(OI)(CI)RX' | Out-Null
  $node = (Get-Command node).Source
  $a = New-ScheduledTaskAction -Execute $node -Argument 'C:\e2e\dns\dns-listener.js'
  Register-ScheduledTask -TaskName alan-dns -Action $a -User 'NT AUTHORITY\SYSTEM' -RunLevel Highest -Force | Out-Null
  Start-ScheduledTask alan-dns
  Start-Sleep 3
  $rule = Add-DnsClientNrptRule -Namespace '.freedom-audit.test' -NameServers '127.0.0.1' -DisplayName 'Freedom owned DNS fixture (#779)' -PassThru
  Set-Content C:\e2e\dns\rule.txt $rule.Name
  Clear-DnsClientCache
  Get-Content C:\e2e\dns\packets.log
  "rule $($rule.Name)"
} else {
  Remove-DnsClientNrptRule -Name (Get-Content C:\e2e\dns\rule.txt) -Force
  Stop-ScheduledTask alan-dns; Unregister-ScheduledTask alan-dns -Confirm:$false
  Get-DnsClientNrptRule | Measure-Object | % { "remaining NRPT rules: $($_.Count)" }
}
