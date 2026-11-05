# Runs C:\e2e\std\<script> as freedomstd inside its interactive console session
# (standard, non-elevated token) via a scheduled task; waits and prints its log.
param([string]$Script, [string]$Arguments = '', [int]$TimeoutSec = 1800)
$ErrorActionPreference = 'Stop'
$name = [IO.Path]::GetFileNameWithoutExtension($Script)
$log = "C:\e2e\std\out\$name.log"; $done = "C:\e2e\std\out\$name.done"
Remove-Item $log, $done -ErrorAction SilentlyContinue
$cmd = "-NoProfile -ExecutionPolicy Bypass -Command `"& { & 'C:\e2e\std\$Script' $Arguments *>&1 | Out-File -Encoding utf8 '$log'; Set-Content '$done' `$LASTEXITCODE }`""
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument $cmd
$p = New-ScheduledTaskPrincipal -UserId freedomstd -LogonType Interactive -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "alan-$name" -Action $a -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName "alan-$name"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
if (Test-Path $log) { Get-Content $log }
if (Test-Path $done) { "== exit: $(Get-Content $done)" } else { "== TIMEOUT" }
Unregister-ScheduledTask -TaskName "alan-$name" -Confirm:$false
