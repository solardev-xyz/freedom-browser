'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { downloadToFile } = require('./lib/fetch-with-retry');
const { WHISPER_VERSION, WHISPER_REVISION, WHISPER_SOURCE_SHA256, SUPPORTED_TARGETS } = require('../src/shared/dictation-runtime');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function configureArguments(source, build, platform, arch) {
  const dispatch = arch === 'x64';
  const args = ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release',
    `-DBUILD_SHARED_LIBS=${dispatch ? 'ON' : 'OFF'}`, '-DWHISPER_BUILD_IS_DEV=OFF', '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF', '-DWHISPER_CURL=OFF', '-DWHISPER_SDL2=OFF',
    '-DWHISPER_COMMON_FFMPEG=OFF', '-DGGML_NATIVE=OFF', '-DGGML_CCACHE=OFF',
    '-DGGML_OPENMP=OFF', `-DGGML_BACKEND_DL=${dispatch ? 'ON' : 'OFF'}`, `-DGGML_CPU_ALL_VARIANTS=${dispatch ? 'ON' : 'OFF'}`, '-DGGML_BLAS=OFF',
    '-DGGML_METAL=OFF', '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF'];
  // Portable baseline, not instructions selected for the CI runner's CPU.
  for (const instruction of ['SSE42', 'AVX', 'AVX2', 'BMI2', 'FMA', 'F16C']) args.push(`-DGGML_${instruction}=OFF`);
  if (platform === 'darwin') args.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`,
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0', '-DGGML_ACCELERATE=ON');
  if (platform === 'win32') args.push('-A', 'x64', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
  if (dispatch && platform !== 'win32') args.push('-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
    `-DCMAKE_INSTALL_RPATH=${platform === 'darwin' ? '@loader_path' : '$ORIGIN'}`);
  return args;
}

async function buildDictationRuntime(arch = process.arch, platform = process.platform) {
  if (platform !== process.platform) throw new Error('Build the dictation runtime on the target operating system');
  if (!SUPPORTED_TARGETS.includes(`${platform}-${arch}`)) throw new Error('Unsupported local dictation build target');
  if (platform !== 'darwin' && arch !== process.arch) throw new Error('Build local dictation on its target architecture');
  const output = path.resolve(__dirname, '../out/dictation-runtime', `${{ darwin: 'mac', win32: 'win', linux: 'linux' }[platform]}-${arch}`);
  const executable = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const destination = path.join(output, executable);
  const notices = path.resolve(__dirname, '../src/main/agent/dictation-local-notices.txt');
  const recipeSha256 = hash(Buffer.concat([fs.readFileSync(__filename), fs.readFileSync(notices)]));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    if (manifest.revision === WHISPER_REVISION && manifest.recipeSha256 === recipeSha256 &&
        manifest.platform === platform && manifest.arch === arch &&
        manifest.binarySha256 === hash(fs.readFileSync(destination)) &&
        manifest.libraries?.every(file => /^[A-Za-z0-9_.-]+$/.test(file.name) && file.sha256 === hash(fs.readFileSync(path.join(output, file.name))))) return;
  } catch { /* A missing or stale build is regenerated from pinned source. */ }
  const cmake = process.env.CMAKE || 'cmake';
  try { execFileSync(cmake, ['--version'], { stdio: 'pipe', timeout: 10000 }); }
  catch { throw new Error('CMake and a C++ compiler are required to build local dictation. Packaged Freedom needs neither.'); }
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, '.build-'));
  try {
    const archive = path.join(scratch, 'source.tar.gz');
    await downloadToFile(`https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${WHISPER_REVISION}`, archive,
      { maxBytes: 40 * 1024 * 1024 });
    if (hash(fs.readFileSync(archive)) !== WHISPER_SOURCE_SHA256) throw new Error('Whisper source checksum mismatch');
    const source = path.join(scratch, 'source');
    const build = path.join(scratch, 'build');
    fs.mkdirSync(source);
    const tar = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    execFileSync(tar, ['-xzf', archive, '-C', source, '--strip-components=1'], { timeout: 60000 });
    execFileSync(cmake, configureArguments(source, build, platform, arch), { stdio: 'inherit', timeout: 120000 });
    const variants = arch === 'x64' ? ['ggml-cpu-x64', 'ggml-cpu-sse42', 'ggml-cpu-sandybridge', 'ggml-cpu-haswell'] : [];
    execFileSync(cmake, ['--build', build, '--config', 'Release', '--target', 'whisper-cli', ...variants, '--parallel', '4'],
      { stdio: 'inherit', timeout: 15 * 60_000 });
    const binDir = path.join(build, 'bin', ...(platform === 'win32' ? ['Release'] : []));
    const binary = path.join(binDir, executable);
    const ready = path.join(scratch, 'ready');
    fs.mkdirSync(ready);
    const libraries = [];
    for (const name of fs.readdirSync(binDir).filter(name => /^(?:lib)?(?:ggml|whisper)[A-Za-z0-9_.-]*\.(?:dll|dylib|so(?:\.[0-9.]+)?)$/.test(name))) {
      const target = path.join(ready, name);
      // Copy aliases as regular files too; never ship build-directory symlinks.
      fs.copyFileSync(path.join(binDir, name), target);
      if (platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', target], { timeout: 30000 });
      libraries.push({ name, sha256: hash(fs.readFileSync(target)) });
    }
    const pending = path.join(ready, executable);
    fs.copyFileSync(binary, pending);
    fs.chmodSync(pending, 0o755);
    if (platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', pending], { timeout: 30000 });
    fs.copyFileSync(notices, path.join(ready, 'NOTICES.txt'));
    fs.writeFileSync(path.join(ready, 'manifest.json'), `${JSON.stringify({ version: WHISPER_VERSION, revision: WHISPER_REVISION,
      sourceSha256: WHISPER_SOURCE_SHA256, recipeSha256, platform, arch, libraries, binarySha256: hash(fs.readFileSync(pending)) }, null, 2)}\n`);
    // Never leave stale backends beside a new engine: the upstream loader scans
    // its own directory. Preserve the old artifact outside the packaged path.
    if (fs.existsSync(output)) fs.renameSync(output, `${output}.previous-${Date.now()}-${process.pid}`);
    fs.renameSync(ready, output);
    console.log(`Built whisper.cpp ${WHISPER_VERSION} for ${platform}-${arch}`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

module.exports = { buildDictationRuntime, configureArguments };
if (require.main === module) buildDictationRuntime(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
