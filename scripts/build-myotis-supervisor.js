// Build only from local source with the installed target compiler. No downloads.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function buildSupervisor(arch = process.arch) {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    throw new Error('Unsupported Myotis supervisor build host');
  }
  if (!['arm64', 'x64'].includes(arch) || (process.platform !== 'darwin' && arch !== process.arch)) {
    throw new Error('Build the Myotis supervisor on its target architecture');
  }
  const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const output = path.join(__dirname, '..', 'myotis-bin', `${os}-${arch}`, `myotis-supervisor${os === 'win' ? '.exe' : ''}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (os === 'win') {
    if (arch !== 'x64' || process.env.VSCMD_ARG_TGT_ARCH !== 'x64') {
      throw new Error('Build Windows Myotis in an installed x64 MSVC developer shell');
    }
    execFileSync('cl.exe', ['/nologo', '/O2', '/MT', '/W4', '/WX', '/std:c11',
      path.join(__dirname, '..', 'src/main/myotis/native/myotis-supervisor-win.c'),
      `/Fe:${output}`, `/Fo:${path.join(path.dirname(output), 'myotis-supervisor.obj')}`],
    { stdio: 'inherit' });
    return output;
  }
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
  if (process.platform === 'darwin') args.push('-arch', arch === 'x64' ? 'x86_64' : 'arm64');
  args.push(path.join(__dirname, '..', 'src/main/myotis/native/myotis-supervisor.c'), '-o', output);
  execFileSync(process.env.CC || 'cc', args, { stdio: 'inherit' });
  return output;
}

function buildForTargets(platform, archs) {
  const host = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  for (const arch of archs) {
    if (platform === 'win' && arch !== 'x64') continue; // No upstream addon.
    if (platform === host && (platform === 'mac' || arch === process.arch)) {
      buildSupervisor(arch);
    } else {
      const binary = `myotis-supervisor${platform === 'win' ? '.exe' : ''}`;
      const target = path.join(__dirname, '..', 'myotis-bin', `${platform}-${arch}`, binary);
      if (!fs.existsSync(target)) {
        throw new Error(`Build Myotis supervisor for ${platform}-${arch} on its target host with ` +
          `npm run myotis:build-supervisor -- ${arch}, then supply ${target}. No compiler is downloaded.`);
      }
    }
  }
}

if (require.main === module) console.log(buildSupervisor(process.argv[2]));
module.exports = { buildSupervisor, buildForTargets };
