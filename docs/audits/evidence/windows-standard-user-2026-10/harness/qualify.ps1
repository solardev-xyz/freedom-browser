$rt = Join-Path $env:LOCALAPPDATA 'Programs\freedom-browser\resources\windows-workspace'
"user: $(whoami)"; "runtime: $rt"
Set-Location C:\e2e\repo
node scripts\qualify-windows-workspace.js --root "$env:LOCALAPPDATA\freedom-agent-tests" --runtime $rt
"qualify exit: $LASTEXITCODE"
