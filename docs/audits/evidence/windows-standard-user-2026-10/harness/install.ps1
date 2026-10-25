$ErrorActionPreference = 'Continue'
"user: $(whoami)"
Start-Process -Wait -FilePath C:\e2e\std\Freedom-Setup-0.8.8-dev.exe -ArgumentList '/S'
$deadline = (Get-Date).AddSeconds(30)
do { $r = @(Get-Process -Name Freedom -ErrorAction SilentlyContinue); if ($r.Count) { break }; Start-Sleep 1 } while ((Get-Date) -lt $deadline)
$r | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 3
$exe = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter Freedom.exe -Recurse -Depth 1 | Select -First 1
"installed: $($exe.FullName) $($exe.VersionInfo.ProductVersion)"
$rt = Join-Path $exe.DirectoryName 'resources\windows-workspace'
Get-ChildItem $rt | ft Name, Length
Get-Content (Join-Path $rt manifest.json)
Get-FileHash (Join-Path $rt '*.exe') -Algorithm SHA256 | ft Hash, Path -AutoSize | Out-String -Width 300
icacls $rt
