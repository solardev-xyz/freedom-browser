# First-logon setup of the Windows 11 golden image (#559), run once by
# autounattend.xml from the provisioning CD (drive letter in $args[0]).
# Installs what the host needs to drive the guest — OpenSSH server with the
# host's key, Node 24, Git — keeps tester auto-logged-in with nothing that
# would lock or sleep the desktop, then powers off so provision-windows.sh
# knows it is done.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cd = $args[0]
Start-Transcript -Path C:\Windows\Temp\freedom-e2e-setup-transcript.log

function Get-LatestAsset($repo, $pattern) {
  $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'freedom-e2e' }
  ($release.assets | Where-Object name -match $pattern | Select-Object -First 1).browser_download_url
}

function Install-Msi($url, $extra) {
  $msi = Join-Path $env:TEMP ([IO.Path]::GetFileName($url))
  Invoke-WebRequest $url -OutFile $msi -UseBasicParsing
  $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$msi`" /qn /norestart $extra"
  if ($p.ExitCode -ne 0) { throw "msiexec $url exited $($p.ExitCode)" }
}

Set-NetConnectionProfile -NetworkCategory Private

# OpenSSH server, PowerShell as its shell, key-only login for the admin.
Install-Msi (Get-LatestAsset 'PowerShell/Win32-OpenSSH' 'OpenSSH-Win64-v.*\.msi$') 'ADDLOCAL=Server'
New-Item -Force -Path HKLM:\SOFTWARE\OpenSSH | Out-Null
Set-ItemProperty HKLM:\SOFTWARE\OpenSSH DefaultShell 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
# The MSI's `Subsystem sftp sftp-server.exe` is relative, sshd cannot stat it
# and hands it to the shell instead, so scp/sftp die at once. An absolute
# path, in 8.3 form because sshd_config splits on the space in Program Files.
$sshdConfig = 'C:\ProgramData\ssh\sshd_config'
if (-not (Test-Path $sshdConfig)) { Copy-Item 'C:\Program Files\OpenSSH\sshd_config_default' $sshdConfig }
(Get-Content $sshdConfig) -replace '^Subsystem\s+sftp\s+.*', 'Subsystem sftp C:/PROGRA~1/OpenSSH/sftp-server.exe' |
  Set-Content $sshdConfig
Copy-Item "$cd\authorized_keys" C:\ProgramData\ssh\administrators_authorized_keys
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
if (-not (Get-NetFirewallRule -Name freedom-e2e-sshd -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name freedom-e2e-sshd -DisplayName 'OpenSSH (Freedom E2E)' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
}
Set-Service sshd -StartupType Automatic
Start-Service sshd

# Node 24 (npm ci + Playwright) and Git (checking out the nightly's commit).
$index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$node = ($index | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1).version
Install-Msi "https://nodejs.org/dist/$node/node-$node-x64.msi" ''
$git = Join-Path $env:TEMP 'git-setup.exe'
Invoke-WebRequest (Get-LatestAsset 'git-for-windows/git' 'Git-.*-64-bit\.exe$') -OutFile $git -UseBasicParsing
Start-Process $git -Wait -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'

# Stay logged in on the console for good (the unattend AutoLogon only counts
# one logon), and never blank, lock or sleep: the suites run in this session.
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $winlogon AutoAdminLogon '1'
Set-ItemProperty $winlogon DefaultUserName 'tester'
Set-ItemProperty $winlogon DefaultPassword (Get-Content "$cd\password" -Raw).Trim()
Remove-ItemProperty $winlogon AutoLogonCount -ErrorAction SilentlyContinue
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
New-Item -Force -Path HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization | Out-Null
Set-ItemProperty HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization NoLockScreen 1

# Windows Update would download and install during a run, and every run
# starts from this image again anyway. Defender and SmartScreen stay on.
New-Item -Force -Path HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU | Out-Null
Set-ItemProperty HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU NoAutoUpdate 1

New-Item -Force -ItemType Directory C:\e2e | Out-Null
Set-Content C:\e2e\provisioned.txt (Get-Date -Format o)
Stop-Transcript
shutdown /s /t 10
