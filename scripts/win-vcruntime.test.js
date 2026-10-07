const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  VC_RUNTIME_DLL,
  readPeImports,
  findRedistDir,
  bundleVcRuntime,
  missingVcRuntime,
} = require('./win-vcruntime');

// A minimal PE32+ image: DOS header, PE header, optional header with the
// import data directory, one section holding the import descriptors and the
// DLL name strings. Enough for readPeImports, which is all it has to satisfy.
function fakePe(dlls) {
  const SECTION_RVA = 0x1000;
  const SECTION_FILE = 0x200;
  const pe = 0x40;
  const opt = pe + 24;
  const optSize = 240; // PE32+ optional header with 16 data directories
  const sectionTable = opt + optSize;

  const descriptors = Buffer.alloc((dlls.length + 1) * 20);
  const names = [];
  let nameAt = descriptors.length;
  dlls.forEach((dll, i) => {
    descriptors.writeUInt32LE(SECTION_RVA + nameAt, i * 20 + 12);
    names.push(Buffer.from(`${dll}\0`, 'latin1'));
    nameAt += dll.length + 1;
  });
  const section = Buffer.concat([descriptors, ...names]);

  const buf = Buffer.alloc(SECTION_FILE + section.length);
  buf.writeUInt16LE(0x5a4d, 0); // MZ
  buf.writeUInt32LE(pe, 0x3c);
  buf.writeUInt32LE(0x00004550, pe); // PE\0\0
  buf.writeUInt16LE(1, pe + 6); // one section
  buf.writeUInt16LE(optSize, pe + 20);
  buf.writeUInt16LE(0x20b, opt); // PE32+
  buf.writeUInt32LE(SECTION_RVA, opt + 112 + 8); // import directory RVA
  buf.writeUInt32LE(section.length, opt + 112 + 12);
  buf.write('.idata', sectionTable, 'latin1');
  buf.writeUInt32LE(section.length, sectionTable + 8); // virtual size
  buf.writeUInt32LE(SECTION_RVA, sectionTable + 12);
  buf.writeUInt32LE(section.length, sectionTable + 16); // raw size
  buf.writeUInt32LE(SECTION_FILE, sectionTable + 20);
  section.copy(buf, SECTION_FILE);
  return buf;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'win-vcruntime-'));
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe('readPeImports', () => {
  test('lists the imported DLL names, lower-cased', () => {
    expect(readPeImports(fakePe(['KERNEL32.dll', 'VCRUNTIME140.dll']))).toEqual([
      'kernel32.dll',
      'vcruntime140.dll',
    ]);
  });

  test('is null for anything that is not a PE image', () => {
    expect(readPeImports(Buffer.from('\x7fELF\x02\x01\x01'.padEnd(128, '\0'), 'latin1'))).toBe(
      null
    );
    expect(readPeImports(Buffer.alloc(0))).toBe(null);
  });

  test('an image with no import directory imports nothing', () => {
    const buf = fakePe([]);
    buf.writeUInt32LE(0, 0x40 + 24 + 112 + 8);
    expect(readPeImports(buf)).toEqual([]);
  });
});

describe('VC_RUNTIME_DLL', () => {
  test('matches the redistributable runtime and not the Universal CRT', () => {
    for (const name of [
      'vcruntime140.dll',
      'VCRUNTIME140_1.dll',
      'msvcp140.dll',
      'msvcp140_2.dll',
    ]) {
      expect(name).toMatch(VC_RUNTIME_DLL);
    }
    for (const name of ['ucrtbase.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'kernel32.dll']) {
      expect(name).not.toMatch(VC_RUNTIME_DLL);
    }
  });
});

describe('bundleVcRuntime', () => {
  let app;
  let redist;

  beforeEach(() => {
    app = tmpDir();
    redist = tmpDir();
    for (const dll of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
      write(path.join(redist, dll), `redist ${dll}`);
    }
  });

  test('copies the runtime DLLs each binary imports into its own directory', () => {
    write(path.join(app, 'Freedom.exe'), fakePe(['kernel32.dll']));
    write(
      path.join(app, 'resources/arti-bin/arti.exe'),
      fakePe(['kernel32.dll', 'VCRUNTIME140.dll'])
    );
    write(
      path.join(app, 'resources/radicle-bin/libradicle.node'),
      fakePe(['vcruntime140.dll', 'api-ms-win-crt-heap-l1-1-0.dll'])
    );
    write(
      path.join(app, 'resources/addon/x.node'),
      fakePe(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
    );
    // A Linux prebuild in the same tree is not a PE image and is left alone.
    write(path.join(app, 'resources/addon/linux-x64.node'), '\x7fELF');

    const placed = bundleVcRuntime(app, { redistDir: redist });

    expect(missingVcRuntime(app)).toEqual([]);
    expect(placed.map((p) => p.binary).sort()).toEqual(
      [
        path.join('resources', 'addon', 'x.node'),
        path.join('resources', 'arti-bin', 'arti.exe'),
        path.join('resources', 'radicle-bin', 'libradicle.node'),
      ].sort()
    );
    expect(fs.readdirSync(path.join(app, 'resources/arti-bin')).sort()).toEqual([
      'arti.exe',
      'vcruntime140.dll',
    ]);
    expect(fs.readdirSync(path.join(app, 'resources/radicle-bin')).sort()).toEqual([
      'libradicle.node',
      'vcruntime140.dll',
    ]);
    expect(fs.readdirSync(path.join(app, 'resources/addon')).sort()).toEqual([
      'linux-x64.node',
      'msvcp140.dll',
      'vcruntime140.dll',
      'vcruntime140_1.dll',
      'x.node',
    ]);
    // Nothing beside Freedom.exe, which does not import the runtime.
    expect(fs.existsSync(path.join(app, 'vcruntime140.dll'))).toBe(false);
    expect(fs.readFileSync(path.join(app, 'resources/arti-bin/vcruntime140.dll'), 'utf8')).toBe(
      'redist vcruntime140.dll'
    );
  });

  test('missingVcRuntime names what an unbundled tree lacks', () => {
    write(path.join(app, 'resources/arti-bin/arti.exe'), fakePe(['vcruntime140.dll']));
    write(path.join(app, 'resources/addon/x.node'), fakePe(['msvcp140.dll', 'vcruntime140.dll']));
    write(path.join(app, 'resources/addon/vcruntime140.dll'), 'present');
    expect(missingVcRuntime(app)).toEqual(
      expect.arrayContaining([
        { binary: path.join('resources', 'arti-bin', 'arti.exe'), missing: ['vcruntime140.dll'] },
        { binary: path.join('resources', 'addon', 'x.node'), missing: ['msvcp140.dll'] },
      ])
    );
    expect(missingVcRuntime(app)).toHaveLength(2);
  });

  test('is a no-op, and needs no redistributable, when nothing imports the runtime', () => {
    write(path.join(app, 'Freedom.exe'), fakePe(['kernel32.dll']));
    expect(bundleVcRuntime(app, { redistDir: null })).toEqual([]);
  });

  test('fails the build when a binary needs the runtime and none can be shipped', () => {
    write(path.join(app, 'resources/ant-bin/antd.exe'), fakePe(['vcruntime140.dll']));
    expect(() => bundleVcRuntime(app, { redistDir: null })).toThrow(
      /antd\.exe import the Visual C\+\+ runtime \(vcruntime140\.dll\).*FREEDOM_VCRUNTIME_DIR/
    );
  });

  test('fails the build when the redistributable lacks an imported DLL', () => {
    fs.rmSync(path.join(redist, 'msvcp140.dll'));
    write(path.join(app, 'resources/addon/x.node'), fakePe(['msvcp140.dll']));
    expect(() => bundleVcRuntime(app, { redistDir: redist })).toThrow(/msvcp140\.dll is imported/);
  });
});

describe('findRedistDir', () => {
  test('FREEDOM_VCRUNTIME_DIR wins', () => {
    expect(findRedistDir('x64', { FREEDOM_VCRUNTIME_DIR: 'C:\\crt', VCToolsRedistDir: 'x' })).toBe(
      'C:\\crt'
    );
  });

  test("resolves the developer shell's VCToolsRedistDir to its <arch> CRT directory", () => {
    const vc = tmpDir();
    fs.mkdirSync(path.join(vc, 'x64', 'Microsoft.VC143.CRT'), { recursive: true });
    fs.mkdirSync(path.join(vc, 'x64', 'Microsoft.VC143.OpenMP'), { recursive: true });
    expect(findRedistDir('x64', { VCToolsRedistDir: vc })).toBe(
      path.join(vc, 'x64', 'Microsoft.VC143.CRT')
    );
    expect(findRedistDir('arm64', { VCToolsRedistDir: vc })).toBe(null);
  });

  test('is null outside a developer shell', () => {
    expect(findRedistDir('x64', {})).toBe(null);
  });
});
