'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  COMPONENTS,
  TARGETS,
  componentKey,
  fetchPrebuilt,
  pack,
  manifest,
  checkListing,
  assetName,
} = require('./prebuilt-natives');

const ROOT = path.join(__dirname, '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

let scratch;
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilt-natives-test-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A throwaway repository root holding copies of every component input. */
function fakeRoot() {
  const root = path.join(scratch, 'root');
  for (const spec of Object.values(COMPONENTS)) {
    for (const file of spec.inputs()) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
    }
  }
  return root;
}

describe('component keys', () => {
  test('every input exists and the targets are the ones the release builds', () => {
    expect(TARGETS).toEqual(['mac-arm64', 'linux-x64', 'linux-arm64', 'win-x64']);
    for (const component of Object.keys(COMPONENTS)) expect(componentKey(component)).toMatch(/^[0-9a-f]{64}$/);
    expect(COMPONENTS['windows-workspace'].inputs()).toContain(
      'src/main/agent/workspace-execution/native/windows/src/main.rs'
    );
    // windows-workspace-notices.js embeds the repository LICENSE in the notices.
    expect(COMPONENTS['windows-workspace'].inputs()).toContain('LICENSE');
  });

  test('a core.autocrlf checkout computes the same key; a changed input does not', () => {
    const root = fakeRoot();
    const file = path.join(root, 'scripts/fetch-arti.js');
    const key = componentKey('arti', root);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    expect(componentKey('arti', root)).toBe(key);
    fs.appendFileSync(file, '// changed\n');
    expect(componentKey('arti', root)).not.toBe(key);
    expect(componentKey('dictation', root)).toBe(componentKey('dictation'));
  });

  test('the output directories are the ones the build scripts and electron-builder use', () => {
    expect(COMPONENTS.arti.dir('win-x64')).toBe('arti-bin/win-x64');
    expect(COMPONENTS.dictation.dir('mac-arm64')).toBe('out/dictation-runtime/mac-arm64');
    expect(COMPONENTS['windows-workspace'].dir('win-x64')).toBe('out/windows-workspace/x64');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(JSON.stringify(pkg.build)).toContain('out/windows-workspace/${arch}/');
  });
});

describe('fetch', () => {
  // Builds a pinned release out of a fake `linux-x64` dictation output.
  function release(root) {
    const built = path.join(root, COMPONENTS.dictation.dir('linux-x64'));
    fs.mkdirSync(path.join(built, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(built, 'whisper-cli'), 'engine');
    fs.writeFileSync(path.join(built, 'lib', 'libggml.so'), 'library');
    const dist = path.join(scratch, 'dist');
    fs.mkdirSync(dist);
    const archive = path.join(dist, assetName('dictation', 'linux-x64'));
    execFileSync('tar', ['-czf', archive, '-C', built, '.']);
    fs.rmSync(built, { recursive: true });
    const pins = {
      tag: 'natives-test',
      commit: 'abc',
      components: { dictation: { key: componentKey('dictation', root), assets: { 'linux-x64': sha256(fs.readFileSync(archive)) } } },
    };
    const urls = [];
    const download = async (url, file) => {
      urls.push(url);
      fs.copyFileSync(archive, file);
    };
    return { built, archive, pins, urls, download };
  }

  test('installs a current prebuilt in place of any earlier build', async () => {
    const root = fakeRoot();
    const { built, pins, urls, download } = release(root);
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, 'stale-backend.so'), 'old');
    const result = await fetchPrebuilt('linux-x64', ['dictation'], { pins, root, download });
    expect(result).toEqual({ dictation: 'hit' });
    expect(urls).toEqual([
      'https://github.com/solardev-xyz/freedom-browser/releases/download/natives-test/dictation-linux-x64.tar.gz',
    ]);
    expect(fs.readFileSync(path.join(built, 'whisper-cli'), 'utf8')).toBe('engine');
    expect(fs.readFileSync(path.join(built, 'lib', 'libggml.so'), 'utf8')).toBe('library');
    expect(fs.existsSync(path.join(built, 'stale-backend.so'))).toBe(false);
  });

  test('a changed recipe, a missing pin or an unpinned target falls back to the source build', async () => {
    const root = fakeRoot();
    const { pins, urls, download } = release(root);
    expect(await fetchPrebuilt('linux-x64', ['arti'], { pins, root, download })).toEqual({ arti: 'stale' });
    expect(await fetchPrebuilt('linux-arm64', ['dictation'], { pins, root, download })).toEqual({ dictation: 'stale' });
    fs.appendFileSync(path.join(root, 'src/shared/dictation-runtime.js'), '\n// bumped\n');
    expect(await fetchPrebuilt('linux-x64', ['dictation'], { pins, root, download })).toEqual({ dictation: 'stale' });
    expect(await fetchPrebuilt('linux-x64', ['dictation'], { pins: { tag: null, components: {} }, root, download }))
      .toEqual({ dictation: 'stale' });
    expect(urls).toEqual([]);
  });

  test('a checksum mismatch fails and installs nothing', async () => {
    const root = fakeRoot();
    const { built, pins, download } = release(root);
    pins.components.dictation.assets['linux-x64'] = '0'.repeat(64);
    await expect(fetchPrebuilt('linux-x64', ['dictation'], { pins, root, download })).rejects.toThrow(/expected 0{64}/);
    expect(fs.existsSync(built)).toBe(false);
  });

  test('unknown components and targets a component never ships are refused', async () => {
    const pins = { tag: 'natives-test', components: {} };
    await expect(fetchPrebuilt('linux-x64', ['nope'], { pins })).rejects.toThrow('Unknown prebuilt component');
    await expect(fetchPrebuilt('linux-x64', ['windows-workspace'], { pins })).rejects.toThrow('no prebuilt for linux-x64');
  });
});

test('archive listings with links, absolute paths or parent segments are refused', () => {
  expect(() => checkListing('-rw-r--r-- 0 a a 1 Jan 1 00:00 ./arti\n', './arti\n')).not.toThrow();
  expect(() => checkListing('lrwxrwxrwx 0 a a 0 Jan 1 00:00 ./arti -> /etc/passwd\n', './arti\n')).toThrow('links');
  expect(() => checkListing('', '../evil\n')).toThrow('escapes');
  expect(() => checkListing('', '/etc/evil\n')).toThrow('escapes');
  expect(() => checkListing('', 'C:\\evil\n')).toThrow('escapes');
});

test('pack and manifest cover every component of every target', () => {
  const root = fakeRoot();
  const dist = path.join(scratch, 'dist');
  for (const target of TARGETS) {
    for (const [component, spec] of Object.entries(COMPONENTS)) {
      if (!spec.targets.includes(target)) continue;
      const dir = path.join(root, spec.dir(target));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'binary'), `${component} ${target}`);
    }
    pack(target, dist, root);
  }
  expect(fs.readdirSync(dist).sort()).toEqual([
    'arti-linux-arm64.tar.gz', 'arti-linux-x64.tar.gz', 'arti-mac-arm64.tar.gz', 'arti-win-x64.tar.gz',
    'dictation-linux-arm64.tar.gz', 'dictation-linux-x64.tar.gz', 'dictation-mac-arm64.tar.gz', 'dictation-win-x64.tar.gz',
    'windows-workspace-win-x64.tar.gz',
  ]);
  const pins = manifest(dist, 'natives-1', 'abc', root);
  expect(pins.tag).toBe('natives-1');
  expect(Object.keys(pins.components.arti.assets)).toEqual(TARGETS);
  expect(pins.components['windows-workspace'].assets['win-x64'])
    .toBe(sha256(fs.readFileSync(path.join(dist, 'windows-workspace-win-x64.tar.gz'))));
  fs.rmSync(path.join(dist, 'arti-mac-arm64.tar.gz'));
  expect(() => manifest(dist, 'natives-1', 'abc', root)).toThrow();
  fs.rmSync(path.join(root, COMPONENTS.arti.dir('mac-arm64')), { recursive: true });
  expect(() => pack('mac-arm64', dist, root)).toThrow('Nothing built');
});

test('natives.yml rebuilds on a pull request that changes any component input', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/natives.yml'), 'utf8');
  const paths = yml.split('pull_request:')[1].split('\npermissions:')[0]
    .split('\n').map((line) => line.match(/^ {6}- (\S+)$/)?.[1]).filter(Boolean);
  const covered = (file) => paths.some((entry) => entry.endsWith('/**') ? file.startsWith(entry.slice(0, -2)) : entry === file);
  for (const spec of Object.values(COMPONENTS)) {
    for (const file of spec.inputs()) expect([file, covered(file)]).toEqual([file, true]);
  }
});

test('the checked-in pin file is well formed', () => {
  const pins = JSON.parse(fs.readFileSync(path.join(__dirname, 'prebuilt-natives.json'), 'utf8'));
  expect(Object.keys(pins).sort()).toEqual(['commit', 'components', 'tag']);
  if (pins.tag !== null) expect(pins.tag).toMatch(/^natives-[0-9a-z-]+$/);
  for (const [component, pin] of Object.entries(pins.components)) {
    expect(Object.keys(COMPONENTS)).toContain(component);
    expect(pin.key).toMatch(/^[0-9a-f]{64}$/);
    for (const [target, digest] of Object.entries(pin.assets)) {
      expect(COMPONENTS[component].targets).toContain(target);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  }
});
