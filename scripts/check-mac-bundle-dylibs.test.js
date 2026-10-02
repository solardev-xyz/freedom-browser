/**
 * The bundle-wide dylib check the macOS smoke job runs on every shipped app.
 * The otool parsing and the Mach-O detection are pure enough to test off a
 * Mac; `checkBundle` takes an injectable otool for the walk.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isMachO,
  foreignLibraries,
  installNames,
  checkBundle,
} = require('./check-mac-bundle-dylibs');

// `otool -L` of the arti binary from the broken 2026-09-29 nightly.
const BROKEN_ARTI = [
  '/Applications/Freedom.app/Contents/Resources/arti-bin/arti:',
  '\t/opt/homebrew/opt/xz/lib/liblzma.5.dylib (compatibility version 14.0.0, current version 14.8.0)',
  '\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.1.1)',
  '\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)',
  '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
  '',
].join('\n');

describe('foreignLibraries', () => {
  test('flags the Homebrew liblzma the broken nightly shipped', () => {
    expect(foreignLibraries(BROKEN_ARTI)).toEqual(['/opt/homebrew/opt/xz/lib/liblzma.5.dylib']);
  });

  test('accepts macOS system libraries', () => {
    const fixed = BROKEN_ARTI.split('\n')
      .filter((line) => !line.includes('homebrew'))
      .join('\n');
    expect(foreignLibraries(fixed)).toEqual([]);
  });

  test('accepts references resolved inside the app', () => {
    const electron = [
      'Freedom.app/Contents/MacOS/Freedom:',
      '\t@rpath/Electron Framework.framework/Electron Framework (compatibility version 0.0.0, current version 0.0.0)',
      '\t@loader_path/../Frameworks/libffmpeg.dylib (compatibility version 0.0.0, current version 0.0.0)',
      '\t@executable_path/../Frameworks/Squirrel.framework/Squirrel (compatibility version 1.0.0, current version 1.0.0)',
    ].join('\n');
    expect(foreignLibraries(electron)).toEqual([]);
  });

  test('flags /usr/local, build trees and home directories', () => {
    const out = [
      'addon.node:',
      '\t/usr/local/opt/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0, current version 3.4.0)',
      '\t/Users/runner/work/freedom-browser/target/release/deps/libfoo.dylib (compatibility version 0.0.0, current version 0.0.0)',
      '\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1700.255.0)',
    ].join('\n');
    expect(foreignLibraries(out)).toEqual([
      '/usr/local/opt/openssl@3/lib/libssl.3.dylib',
      '/Users/runner/work/freedom-browser/target/release/deps/libfoo.dylib',
    ]);
  });

  test('skips the per-architecture headers of a universal binary', () => {
    const fat = [
      'antd (architecture x86_64):',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
      'antd (architecture arm64):',
      '\t/opt/homebrew/lib/libzstd.1.dylib (compatibility version 1.0.0, current version 1.5.7)',
    ].join('\n');
    expect(foreignLibraries(fat)).toEqual(['/opt/homebrew/lib/libzstd.1.dylib']);
  });
});

// `otool -L` / `otool -D` of the Myotis addon from the macOS release build:
// its own install name points at the build tree, which is harmless.
const MYOTIS_ADDON_L = [
  'Freedom.app/Contents/Resources/myotis-node/myotis-node.node:',
  '\t/Users/runner/work/myotis/myotis/rust/target/aarch64-apple-darwin/release/deps/libmyotis_node.dylib (compatibility version 0.0.0, current version 0.0.0)',
  '\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.1.1)',
  '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
].join('\n');
const MYOTIS_ADDON_D = [
  'Freedom.app/Contents/Resources/myotis-node/myotis-node.node:',
  '/Users/runner/work/myotis/myotis/rust/target/aarch64-apple-darwin/release/deps/libmyotis_node.dylib',
].join('\n');

describe("a dylib's own install name", () => {
  test('is not a dependency', () => {
    expect(foreignLibraries(MYOTIS_ADDON_L, installNames(MYOTIS_ADDON_D))).toEqual([]);
  });

  test('without it the build-tree id would be flagged', () => {
    expect(foreignLibraries(MYOTIS_ADDON_L)).toHaveLength(1);
  });

  test('does not hide a real foreign dependency of the same dylib', () => {
    const withHomebrew = `${MYOTIS_ADDON_L}\n\t/opt/homebrew/lib/libzstd.1.dylib (compatibility version 1.0.0, current version 1.5.7)`;
    expect(foreignLibraries(withHomebrew, installNames(MYOTIS_ADDON_D))).toEqual([
      '/opt/homebrew/lib/libzstd.1.dylib',
    ]);
  });

  test('installNames reads one id per architecture and none for an executable', () => {
    expect(installNames('arti:\n')).toEqual([]);
    expect(
      installNames(
        'x (architecture x86_64):\n/a/lib.dylib\nx (architecture arm64):\n/a/lib.dylib\n'
      )
    ).toEqual(['/a/lib.dylib', '/a/lib.dylib']);
  });
});

describe('checkBundle', () => {
  let app;
  const write = (rel, bytes) => {
    const file = path.join(app, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const MACHO_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
  const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'dylib-check-'));
    write('Contents/MacOS/Freedom', MACHO_64);
    write('Contents/Resources/arti-bin/arti', FAT);
    write('Contents/Resources/app.asar', Buffer.from('not a binary'));
    write('Contents/Info.plist', Buffer.from('<?xml version="1.0"?>'));
  });

  afterEach(() => fs.rmSync(app, { recursive: true, force: true }));

  test('only hands Mach-O files to otool', () => {
    const seen = [];
    const { checked } = checkBundle(app, {
      otool: (file) => {
        seen.push(path.relative(app, file));
        return `${file}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n`;
      },
    });
    expect(checked).toBe(2);
    expect(seen.sort()).toEqual(['Contents/MacOS/Freedom', 'Contents/Resources/arti-bin/arti']);
  });

  test('reports the binary that links a foreign library', () => {
    const { problems } = checkBundle(app, {
      otool: (file) => (file.endsWith('arti') ? BROKEN_ARTI : `${file}:\n`),
    });
    expect(problems).toEqual([
      {
        file: path.join('Contents', 'Resources', 'arti-bin', 'arti'),
        libs: ['/opt/homebrew/opt/xz/lib/liblzma.5.dylib'],
      },
    ]);
  });

  test('isMachO recognises thin and fat binaries and nothing else', () => {
    expect(isMachO(path.join(app, 'Contents/MacOS/Freedom'))).toBe(true);
    expect(isMachO(path.join(app, 'Contents/Resources/arti-bin/arti'))).toBe(true);
    expect(isMachO(path.join(app, 'Contents/Resources/app.asar'))).toBe(false);
    expect(isMachO(path.join(app, 'Contents/Info.plist'))).toBe(false);
  });
});
