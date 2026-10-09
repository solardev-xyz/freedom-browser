// Guards against #576: platform `files` lists that hold only negations make
// electron-builder add `**/*` ahead of them, which packs the whole repository
// into app.asar. See scripts/check-asar-contents.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');
const {
  readAsarHeader,
  listAsarFiles,
  findAsarProblems,
  prebuildTargets,
  checkPackedApp,
} = require('./check-asar-contents');

const PLATFORMS = ['mac', 'linux', 'win'];

describe('build.files per platform', () => {
  test.each(PLATFORMS)('%s files list is a full allowlist, not negations alone', (platform) => {
    const files = pkg.build[platform].files;
    if (!files) return;
    // A negation-only list is what makes electron-builder prepend `**/*`.
    expect(files.some((pattern) => !pattern.startsWith('!'))).toBe(true);
    // And it must not widen or narrow the top-level allowlist.
    for (const pattern of pkg.build.files) {
      expect(files).toContain(pattern);
    }
  });

  test.each([
    ['mac', 'darwin'],
    ['linux', 'linux'],
    ['win', 'win32'],
  ])("%s files list keeps only the target's better-sqlite3 prebuild", (platform, prefix) => {
    expect(pkg.build[platform].files).toContain(
      `!**/node_modules/better-sqlite3/prebuilds/!(${prefix}-\${arch}).node`
    );
  });
});

describe('findAsarProblems', () => {
  const targets = ['linux-x64.node'];

  test('accepts src, package.json and node_modules', () => {
    const files = [
      'package.json',
      'src/main/index.js',
      'src/renderer/index.html',
      'node_modules/foo/index.js',
      'node_modules/foo/foo.test.js',
    ];
    expect(findAsarProblems({ files, prebuilds: ['linux-x64.node'], targets })).toEqual([]);
  });

  test('flags repository files outside the allowlist', () => {
    const files = [
      'package.json',
      'src/main/index.js',
      'docs/README.md',
      'docs/agent-playbooks/x.md',
      '.claude/skills/run-freedom/SKILL.md',
      'AGENTS.md',
      '.env.example',
      'ant-bin/win-x64/antd.exe',
      'native/freedom-ipfs-node/build/Release/freedom_ipfs_native.node',
    ];
    expect(findAsarProblems({ files, targets })).toEqual([
      'unexpected top-level entry packed: .claude',
      'unexpected top-level entry packed: .env.example',
      'unexpected top-level entry packed: AGENTS.md',
      'unexpected top-level entry packed: ant-bin',
      'unexpected top-level entry packed: docs',
      'unexpected top-level entry packed: native',
    ]);
  });

  test('flags test and spec files under src', () => {
    const files = ['src/main/foo.test.js', 'src/renderer/bar.spec.js'];
    expect(findAsarProblems({ files, targets })).toEqual([
      'test file packed: src/main/foo.test.js',
      'test file packed: src/renderer/bar.spec.js',
    ]);
  });

  test('flags better-sqlite3 prebuilds for other targets', () => {
    expect(
      findAsarProblems({ files: [], prebuilds: ['linux-x64.node', 'win32-x64.node'], targets })
    ).toEqual(['foreign better-sqlite3 prebuild packed: win32-x64.node']);
  });
});

describe('prebuildTargets', () => {
  test('maps the electron platform and arch to prebuild file names', () => {
    expect(prebuildTargets('linux', 'x64')).toEqual(['linux-x64.node']);
    expect(prebuildTargets('win32', 'arm64')).toEqual(['win32-arm64.node']);
    expect(prebuildTargets('darwin', 'universal')).toEqual([
      'darwin-x64.node',
      'darwin-arm64.node',
    ]);
  });
});

describe('checkPackedApp', () => {
  let tmpRoot;

  // Mirrors @electron/asar's layout: size pickle, then header pickle.
  function writeAsar(asarPath, header) {
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(json.length + 8, 4);
    prefix.writeUInt32LE(json.length + 4, 8);
    prefix.writeUInt32LE(json.length, 12);
    fs.writeFileSync(asarPath, Buffer.concat([prefix, json]));
  }

  function linuxContext(header, prebuilds = ['linux-x64.node']) {
    const appOutDir = fs.mkdtempSync(path.join(tmpRoot, 'linux-unpacked-'));
    const resources = path.join(appOutDir, 'resources');
    const prebuildDir = path.join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'prebuilds'
    );
    fs.mkdirSync(prebuildDir, { recursive: true });
    for (const name of prebuilds) fs.writeFileSync(path.join(prebuildDir, name), '');
    writeAsar(path.join(resources, 'app.asar'), header);
    return { appOutDir, electronPlatformName: 'linux' };
  }

  const file = { size: 0, offset: '0' };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-contents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('reads nested entries from the asar header', () => {
    const asarPath = path.join(tmpRoot, 'app.asar');
    writeAsar(asarPath, {
      files: { 'package.json': file, src: { files: { main: { files: { 'index.js': file } } } } },
    });
    expect(listAsarFiles(readAsarHeader(asarPath)).sort()).toEqual([
      'package.json',
      'src/main/index.js',
    ]);
  });

  test('passes a build that packs only the allowlist', () => {
    const context = linuxContext({
      files: { 'package.json': file, src: { files: { 'index.js': file } } },
    });
    expect(checkPackedApp(context, 'x64')).toBe(2);
  });

  test('fails a build that packs the repository', () => {
    const context = linuxContext({
      files: { 'package.json': file, docs: { files: { 'README.md': file } } },
    });
    expect(() => checkPackedApp(context, 'x64')).toThrow(/unexpected top-level entry packed: docs/);
  });
});
