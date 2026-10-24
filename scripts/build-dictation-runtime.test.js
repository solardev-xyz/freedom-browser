const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildDictationRuntime, configureArguments } = require('./build-dictation-runtime');

test('unsupported architectures leave dictation unavailable without preventing browser startup or packaging', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await expect(buildDictationRuntime('riscv64')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(`Skipping local dictation runtime for unsupported target ${process.platform}-riscv64`);
  } finally { log.mockRestore(); }
});

test.each(['darwin', 'win32', 'linux'])('%s CLI builds disable networking and use portable runtime CPU dispatch', platform => {
  const args = configureArguments('/source with spaces', '/build', platform, 'x64');
  for (const flag of ['WHISPER_CURL', 'WHISPER_BUILD_SERVER', 'GGML_NATIVE', 'GGML_AVX2'])
    expect(args).toContain(`-D${flag}=OFF`);
  expect(args).toContain('/source with spaces');
  expect(args).toContain('-DGGML_CPU_ALL_VARIANTS=ON');
  expect(args).toContain('-DGGML_BACKEND_DL=ON');
  if (platform === 'win32') expect(args).toContain('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
  if (platform === 'darwin') expect(args).toContain('-DCMAKE_OSX_ARCHITECTURES=x86_64');
});

test('packaging includes the CLI outside asar and runs its build before packing', () => {
  const pkg = require('../package.json');
  expect(pkg.build.extraResources).toContainEqual({ from: 'out/dictation-runtime/${os}-${arch}/', to: 'dictation-runtime',
    filter: ['whisper-cli', 'whisper-cli.exe', '*.dll', '*.dylib', '*.so*', 'manifest.json', 'NOTICES.txt'] });
  expect(pkg.build.mac.binaries).toContain('Contents/Resources/dictation-runtime/whisper-cli');
  expect(pkg.build.beforePack).toBe('./scripts/prepare-native-supervisors.js');
});

test('ARM64 keeps the single CPU backend without shared dispatch libraries', () => {
  const args = configureArguments('/source', '/build', 'darwin', 'arm64');
  expect(args).toContain('-DGGML_BACKEND_DL=OFF');
  expect(args).toContain('-DBUILD_SHARED_LIBS=OFF');
});

const UPSTREAM_SEARCH = `    if (user_search_path == nullptr) {
#ifdef GGML_BACKEND_DIR
        search_paths.push_back(fs::u8path(GGML_BACKEND_DIR));
#endif
        // default search paths: executable directory, current directory
        search_paths.push_back(get_executable_path());
        std::error_code cwd_ec;
        const fs::path cwd = fs::current_path(cwd_ec);
        if (cwd_ec) {
            GGML_LOG_DEBUG("%s: current_path() failure, error-message: %s\\n", __func__, cwd_ec.message().c_str());
        } else {
            search_paths.push_back(cwd);
        }
    } else {
`;
const sha256 = data => require('crypto').createHash('sha256').update(data).digest('hex');

function sourceFixture(root, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}

// Run the real build with the network, tar and cmake replaced: `tar -x` writes
// `files` as the extracted source, and `configure` sees the tree cmake would get.
async function mockedBuild({ files, listing = '-rw-r--r-- 0 0 0 1 Oct  6 16:10 whisper.cpp/CMakeLists.txt\n', pins = {}, configure }) {
  jest.resetModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-build-test-'));
  const actualResolve = path.resolve;
  const resolve = jest.spyOn(path, 'resolve').mockImplementation((...args) =>
    args[1] === '../out/dictation-runtime' ? actualResolve(root, ...args.slice(2)) : actualResolve(...args));
  jest.doMock('../src/shared/dictation-runtime', () => ({ ...jest.requireActual('../src/shared/dictation-runtime'), ...pins }));
  jest.doMock('./lib/fetch-with-retry', () => ({ downloadToFile: jest.fn(async (_url, destination) => fs.writeFileSync(destination, 'archive bytes')) }));
  const calls = [];
  jest.doMock('child_process', () => ({ execFileSync: jest.fn((command, args) => {
    calls.push([path.basename(command), args[0]]);
    if (args[0] === '-tvzf') return listing;
    if (args[0] === '-xzf') sourceFixture(args[args.indexOf('-C') + 1], files);
    if (args[0] === '-S') configure(args[1]);
  }) }));
  try {
    const { buildDictationRuntime } = require('./build-dictation-runtime');
    const outcome = await buildDictationRuntime().then(() => null, error => error);
    return { outcome, calls, left: fs.readdirSync(root) };
  } finally {
    resolve.mockRestore();
    for (const name of ['../src/shared/dictation-runtime', './lib/fetch-with-retry', 'child_process']) jest.dontMock(name);
    jest.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('source tree digest matches the documented sha256sum recipe and ignores archive metadata', () => {
  const { sourceTreeSha256 } = require('./build-dictation-runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-tree-test-'));
  try {
    const files = { 'CMakeLists.txt': 'project(whisper)\n', 'ggml/src/a b.c': 'int a;\n', 'ggml/include/Z.h': '', '.github/x': 'y' };
    sourceFixture(path.join(root, 'one'), files);
    fs.mkdirSync(path.join(root, 'one', 'empty-dir'));
    const expected = sha256(Object.keys(files).sort().map(name => `${sha256(files[name])}  ${name}\n`).join(''));
    expect(sourceTreeSha256(path.join(root, 'one'))).toBe(expected);
    // Different timestamps, modes and directory order: same content, same pin.
    sourceFixture(path.join(root, 'two'), Object.fromEntries(Object.entries(files).reverse()));
    fs.chmodSync(path.join(root, 'two', 'CMakeLists.txt'), 0o755);
    fs.utimesSync(path.join(root, 'two', 'ggml/src/a b.c'), 1, 1);
    expect(sourceTreeSha256(path.join(root, 'two'))).toBe(expected);
    fs.writeFileSync(path.join(root, 'two', 'ggml/include/Z.h'), ' ');
    expect(sourceTreeSha256(path.join(root, 'two'))).not.toBe(expected);
    fs.writeFileSync(path.join(root, 'two', 'ggml/include/Z.h'), '');
    fs.renameSync(path.join(root, 'two', '.github/x'), path.join(root, 'two', '.github/w'));
    expect(sourceTreeSha256(path.join(root, 'two'))).not.toBe(expected);
    fs.writeFileSync(path.join(root, 'one', 'added'), '');
    expect(sourceTreeSha256(path.join(root, 'one'))).not.toBe(expected);
    if (process.platform !== 'win32') {
      fs.symlinkSync('/etc/hosts', path.join(root, 'two', 'link'));
      expect(() => sourceTreeSha256(path.join(root, 'two'))).toThrow('unexpected entry: link');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the source pin is a content digest, not the bytes of GitHub\'s regenerated archive', () => {
  const pins = require('../src/shared/dictation-runtime');
  expect(pins.WHISPER_SOURCE_TREE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  expect(pins).not.toHaveProperty('WHISPER_SOURCE_SHA256');
});

test('a source tree mismatch prevents patching and compilation, whatever the archive bytes', async () => {
  const configure = jest.fn();
  const { outcome, calls, left } = await mockedBuild({ files: { 'CMakeLists.txt': 'tampered' }, configure });
  expect(outcome?.message).toMatch('source checksum mismatch');
  expect(calls.map(call => call[1])).toEqual(['--version', '-tvzf', '-xzf']);
  expect(configure).not.toHaveBeenCalled();
  expect(left).toEqual([]);
});

test('an archive listing links or special files is refused before extraction', async () => {
  const configure = jest.fn();
  const { outcome, calls } = await mockedBuild({ files: {}, configure,
    listing: '-rw-r--r-- 0 0 0 1 Oct  6 16:10 w/a\nlrwxrwxrwx 0 0 0 0 Oct  6 16:10 w/escape -> /\n' });
  expect(outcome?.message).toMatch('links or special files');
  expect(calls.map(call => call[1])).toEqual(['--version', '-tvzf']);
});

test('the verified source no longer loads ggml backends from the working directory', async () => {
  const files = { 'ggml/src/ggml-backend-reg.cpp': `// excerpt\n${UPSTREAM_SEARCH}` };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-pin-test-'));
  sourceFixture(root, files);
  const pins = { WHISPER_SOURCE_TREE_SHA256: require('./build-dictation-runtime').sourceTreeSha256(root) };
  fs.rmSync(root, { recursive: true, force: true });
  let configured;
  const { outcome } = await mockedBuild({ files, pins, configure: source => {
    configured = fs.readFileSync(path.join(source, 'ggml/src/ggml-backend-reg.cpp'), 'utf8');
    throw new Error('stop after configure');
  } });
  expect(outcome?.message).toBe('stop after configure');
  expect(configured).toContain('search_paths.push_back(get_executable_path());');
  expect(configured).not.toMatch(/current_path|push_back\(cwd\)/);
});

test('the backend search patch fails loudly when upstream code moves', () => {
  const { restrictBackendSearch } = require('./build-dictation-runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-patch-test-'));
  try {
    for (const text of [UPSTREAM_SEARCH.replace('cwd_ec', 'ec'), UPSTREAM_SEARCH + UPSTREAM_SEARCH]) {
      sourceFixture(root, { 'ggml/src/ggml-backend-reg.cpp': text });
      expect(() => restrictBackendSearch(root)).toThrow('no longer applies');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a staged-prebuilt release build fails instead of recompiling a missing or stale runtime', async () => {
  const target = `${process.platform}-${process.arch}`;
  const dir = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  const output = path.resolve(__dirname, '../out/dictation-runtime', `${dir}-${process.arch}`);
  // A developer checkout may hold a current local build, which is reused and proves nothing here.
  if (!require('../src/shared/dictation-runtime').SUPPORTED_TARGETS.includes(target) ||
      fs.existsSync(path.join(output, 'manifest.json'))) return;
  const previous = process.env.FREEDOM_DICTATION_RUNTIME_PREBUILT;
  process.env.FREEDOM_DICTATION_RUNTIME_PREBUILT = '1';
  try {
    await expect(buildDictationRuntime(process.arch)).rejects.toThrow(`No current prebuilt dictation runtime in ${output}`);
  } finally {
    if (previous === undefined) delete process.env.FREEDOM_DICTATION_RUNTIME_PREBUILT;
    else process.env.FREEDOM_DICTATION_RUNTIME_PREBUILT = previous;
  }
});
