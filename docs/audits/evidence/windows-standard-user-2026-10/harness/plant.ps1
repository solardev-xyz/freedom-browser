$ErrorActionPreference = 'Stop'
$rt = Join-Path $env:LOCALAPPDATA 'Programs\freedom-browser\resources\windows-workspace'
"user: $(whoami)"
foreach ($f in 'netapi32.dll', 'fwpuclnt.dll', 'plant-control.exe') { Copy-Item "C:\e2e\std\$f" $rt -Force }
Get-FileHash (Join-Path $rt '*.dll'), (Join-Path $rt 'plant-control.exe') -Algorithm SHA256 | ft Hash, Path -AutoSize | Out-String -Width 300
& (Join-Path $rt 'plant-control.exe'); "control exit (standard user): $LASTEXITCODE"
