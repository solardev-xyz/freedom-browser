whoami; whoami /groups | Select-String 'Mandatory Label'
$rt = 'C:\Users\freedomstd\AppData\Local\Programs\freedom-browser\resources\windows-workspace'
& (Join-Path $rt 'plant-control.exe'); "control exit (elevated admin): $LASTEXITCODE"
"--- markers.log (positive controls)"
Get-Content C:\ProgramData\freedom-dll-plant\markers.log
Copy-Item C:\ProgramData\freedom-dll-plant\markers.log C:\ProgramData\freedom-dll-plant\positive-control.log -Force
Remove-Item C:\ProgramData\freedom-dll-plant\markers.log
"markers.log reset: $(-not (Test-Path C:\ProgramData\freedom-dll-plant\markers.log))"
