$rt = 'C:\Users\freedomstd\AppData\Local\Programs\freedom-browser\resources\windows-workspace'
"--- planted files still beside the helpers"
Get-ChildItem $rt -Filter *.dll | % { "$($_.Name) $((Get-FileHash $_.FullName).Hash)" }
"--- direct elevated launch of the installed setup helper (no request; expect exit 1)"
whoami /groups | Select-String 'Mandatory Label'
$p = Start-Process -FilePath "$rt\freedom-windows-sandbox-setup.exe" -Wait -PassThru -WindowStyle Hidden
"exit code: $($p.ExitCode)"
"--- markers.log after setup x2, qualification x6, S8 and the direct launch"
"exists: $(Test-Path C:\ProgramData\freedom-dll-plant\markers.log)"
Get-Content C:\ProgramData\freedom-dll-plant\markers.log -ErrorAction SilentlyContinue
"--- positive-control.log (kept from the control run)"
Get-Content C:\ProgramData\freedom-dll-plant\positive-control.log
"--- sandbox accounts and firewall rules created by setup"
Get-LocalUser | ? Name -like 'FreedomSbx*' | ft Name, Enabled -AutoSize | Out-String
(Get-NetFirewallRule -DisplayName 'Freedom Sandbox*' -ErrorAction SilentlyContinue | Measure-Object).Count | % { "firewall rules named 'Freedom Sandbox*': $_" }
Get-ChildItem 'C:\Users\freedomstd\AppData\Local\FreedomBrowser\Sandbox' -ErrorAction SilentlyContinue | ft Name -AutoSize | Out-String
