'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { downloadToFile } = require('./lib/fetch-with-retry');
const { WHISPER_VERSION, WHISPER_REVISION, WHISPER_SOURCE_TREE_SHA256, SUPPORTED_TARGETS } = require('../src/shared/dictation-runtime');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// whisper.cpp publishes no source asset, and GitHub regenerates archive bytes
// (compression, headers) without notice. Pin what is built instead: every file's
// path and content. Same value as, in the extracted source directory or a git
// checkout of the revision, `git ls-files -z | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum`
// (or `find . -type f -print0 | sed -z 's|^\./||' | ...` without git).
function sourceTreeSha256(root) {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error(`Whisper source contains an unexpected entry: ${name}`);
    }
  };
  walk('');
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return hash(files.map(name => `${hash(fs.readFileSync(path.join(root, name)))}  ${name}\n`).join(''));
}

// Upstream's backend loader also scans the current directory for
// [lib]ggml-<name>-*.so/.dll and loads the best scorer, on every target and
// even with --no-gpu. Keep only the executable's own (bundled) directory.
const CWD_BACKEND_SEARCH = `        std::error_code cwd_ec;
        const fs::path cwd = fs::current_path(cwd_ec);
        if (cwd_ec) {
            GGML_LOG_DEBUG("%s: current_path() failure, error-message: %s\\n", __func__, cwd_ec.message().c_str());
        } else {
            search_paths.push_back(cwd);
        }
`;

function restrictBackendSearch(source) {
  const file = path.join(source, 'ggml', 'src', 'ggml-backend-reg.cpp');
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(CWD_BACKEND_SEARCH).length !== 2 || !text.includes('search_paths.push_back(get_executable_path());'))
    throw new Error('The ggml backend search patch no longer applies; review ggml-backend-reg.cpp for this whisper.cpp version');
  fs.writeFileSync(file, text.replace(CWD_BACKEND_SEARCH, ''));
}

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
  if (!SUPPORTED_TARGETS.includes(`${platform}-${arch}`)) {
    console.log(`Skipping local dictation runtime for unsupported target ${platform}-${arch}`);
    return;
  }
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
    const source = path.join(scratch, 'source');
    const build = path.join(scratch, 'build');
    fs.mkdirSync(source);
    const tar = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    // The content is verified after extraction, so admit only plain files and
    // directories (no links to write through) into the private scratch directory.
    const listing = execFileSync(tar, ['-tvzf', archive], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (listing.split('\n').some(line => line && !/^[-d]/.test(line))) throw new Error('Whisper source archive contains links or special files');
    execFileSync(tar, ['-xzf', archive, '-C', source, '--strip-components=1'], { timeout: 60000 });
    if (sourceTreeSha256(source) !== WHISPER_SOURCE_TREE_SHA256) throw new Error('Whisper source checksum mismatch');
    restrictBackendSearch(source);
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
      sourceTreeSha256: WHISPER_SOURCE_TREE_SHA256, recipeSha256, platform, arch, libraries, binarySha256: hash(fs.readFileSync(pending)) }, null, 2)}\n`);
    // Never leave stale backends beside a new engine: the upstream loader scans
    // its own directory. Preserve the old artifact outside the packaged path.
    if (fs.existsSync(output)) fs.renameSync(output, `${output}.previous-${Date.now()}-${process.pid}`);
    fs.renameSync(ready, output);
    console.log(`Built whisper.cpp ${WHISPER_VERSION} for ${platform}-${arch}`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

module.exports = { buildDictationRuntime, configureArguments, sourceTreeSha256, restrictBackendSearch };
if (require.main === module) buildDictationRuntime(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
