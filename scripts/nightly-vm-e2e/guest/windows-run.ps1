# Runs inside the Windows guest in tester's logged-in desktop session, started
# by a scheduled task with a standard (non-elevated) token, the way a user
# runs things under UAC. Copied there and started by run-nightly.sh.
#
#   windows-run.ps1 <version> <commit> <installer url>
#
# Downloads the published installer, runs its per-user silent install, and
# runs the packaged suites against the installed Freedom.exe. Results land in
# C:\e2e\results; exitcode.txt is written last and is what the host polls for.
param([string]$Version, [string]$Commit, [string]$InstallerUrl)
# Not 'Stop': Windows PowerShell 5.1 turns a native command's redirected
# stderr into errors, and git/npm write progress there. Cmdlets that must
# not fail quietly say -ErrorAction Stop; native exit codes are checked.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$work = 'C:\e2e\work'
$results = 'C:\e2e\results'
Remove-Item -Recurse -Force $work, $results -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work, $results | Out-Null
Start-Transcript -Path "$results\run.log" | Out-Null

function Step($text) { Write-Host "`n== $text" }
function Finish([int]$code) {
  Step "done: exit $code"
  Stop-Transcript | Out-Null
  Set-Content "$results\exitcode.txt" $code
  exit $code
}

try {
  $os = Get-CimInstance Win32_OperatingSystem
  Step "guest: $($os.Caption) $($os.Version), node $(node --version)"

  Step 'download installer'
  $installer = Join-Path $work ([IO.Path]::GetFileName($InstallerUrl))
  Invoke-WebRequest $InstallerUrl -OutFile $installer -UseBasicParsing -ErrorAction Stop

  Step 'silent per-user install'
  Start-Process -Wait -FilePath $installer -ArgumentList '/S' -ErrorAction Stop
  # The one-click installer starts Freedom when it finishes; the suites launch
  # their own instance against a scratch profile.
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $running = @(Get-Process -Name Freedom -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $root = Join-Path $env:LOCALAPPDATA 'Programs'
  $found = @(Get-ChildItem -Path $root -Filter Freedom.exe -File -Recurse -Depth 1 -ErrorAction SilentlyContinue)
  if ($found.Count -ne 1) { throw "Expected exactly one Freedom.exe under $root, found $($found.Count)" }
  $exe = $found[0].FullName
  Write-Host "Installed to $exe ($($found[0].VersionInfo.ProductVersion))"

  Step "check out $Commit"
  $repo = Join-Path $work 'repo'
  git init -q $repo
  git -C $repo fetch -q --depth 1 https://github.com/solardev-xyz/freedom-browser $Commit
  if ($LASTEXITCODE -ne 0) { Finish 92 }
  git -C $repo checkout -q FETCH_HEAD
  Set-Location $repo
  $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
  npm ci --ignore-scripts --no-audit --no-fund *> "$results\npm-ci.log"
  if ($LASTEXITCODE -ne 0) { Get-Content "$results\npm-ci.log" -Tail 40; Finish 93 }

  Step "packaged suites: installer ($exe)"
  $env:FREEDOM_E2E_EXECUTABLE = $exe
  $env:FREEDOM_E2E_EXPECTED_VERSION = $Version
  $env:PLAYWRIGHT_JSON_OUTPUT_FILE = "$results\installer.json"
  $env:PLAYWRIGHT_HTML_OUTPUT_DIR = "$results\installer-report"
  $env:PLAYWRIGHT_HTML_OPEN = 'never'
  npx playwright test --project=packaged --project=packaged-live `
    --reporter=list,json,html --output="$results\installer-artifacts" 2>&1 |
    ForEach-Object { "$_" } | Tee-Object "$results\installer-playwright.log"
  if ($LASTEXITCODE -ne 0) { Finish 1 }
  Finish 0
} catch {
  Write-Host "error: $_"
  Finish 90
}
