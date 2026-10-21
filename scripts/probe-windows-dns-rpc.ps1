# Compile and run an owned, temporary WFP experiment on disposable CI only.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or ![OperatingSystem]::IsWindows()) {
    throw 'Use only a disposable Windows CI runner'
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Installed x64 MSVC tools are required' }
Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
$scratch = Join-Path $env:RUNNER_TEMP ('freedom-dns-rpc-' + [guid]::NewGuid())
New-Item -ItemType Directory $scratch | Out-Null
$helper = Join-Path $scratch 'probe.exe'
& cl.exe /nologo /W4 /WX /EHsc /std:c++17 scripts/probe-windows-dns-rpc.cpp "/Fe:$helper" "/Fo:$scratch\probe.obj" /link Fwpuclnt.lib Rpcrt4.lib Advapi32.lib
if ($LASTEXITCODE) { throw 'DNS probe compilation failed' }
$container = Join-Path $scratch 'appcontainer.exe'
& cl.exe /nologo /W4 /WX /EHsc /std:c++17 scripts/probe-windows-appcontainer.cpp "/Fe:$container" "/Fo:$scratch\appcontainer.obj" /link Userenv.lib Rpcrt4.lib Advapi32.lib
if ($LASTEXITCODE) { throw 'AppContainer probe compilation failed' }
& node scripts/probe-windows-dns-rpc.js $helper $container --appcontainer-only
if ($LASTEXITCODE) { throw 'Windows DNS isolation experiment did not pass' }
