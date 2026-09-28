// docs/security-audit-electron.md, O-12: index.js used to append
// `--disable-features=VizDisplayCompositor`. That feature no longer exists in
// Chromium (the out-of-process display compositor is unconditional), so the
// switch did nothing but mislead: Chromium ignores unknown feature names
// silently. This guards against that happening again: every feature a main-
// process module toggles through `app.commandLine.appendSwitch('enable-
// features' | 'disable-features', …)` must still be a feature the Electron
// binary we ship knows about.

const fs = require('fs');
const path = require('path');

const MAIN_DIR = __dirname;

function mainSources(dir = MAIN_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mainSources(full));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

// [{ file, feature }] for every feature named in an enable/disable-features
// switch. Anything the regex can't read as a literal list is reported as
// `<dynamic>` so it can't slip past as "no features".
function toggledFeatures() {
  const found = [];
  const re = /appendSwitch\(\s*['"`](enable|disable)-features['"`]\s*,\s*([^)]*)\)/g;
  for (const file of mainSources()) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(re)) {
      const literal = match[2].trim().match(/^(['"`])([^'"`$]*)\1$/);
      const names = literal ? literal[2].split(',').map((s) => s.trim()) : ['<dynamic>'];
      for (const feature of names.filter(Boolean)) {
        found.push({ file: path.relative(MAIN_DIR, file), feature });
      }
    }
  }
  return found;
}

// The binary holding Chromium's feature table, when it is installed.
function electronFeatureBinary() {
  const dist = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist');
  const candidates = [
    path.join(dist, 'electron'),
    path.join(dist, 'electron.exe'),
    path.join(
      dist,
      'Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'
    ),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

describe('Chromium feature switches', () => {
  test('VizDisplayCompositor is not toggled any more', () => {
    expect(toggledFeatures().map((f) => f.feature)).not.toContain('VizDisplayCompositor');
  });

  const binary = electronFeatureBinary();
  (binary ? test : test.skip)(
    'every toggled feature exists in the shipped Electron',
    () => {
      const bytes = fs.readFileSync(binary);
      // Probe sanity: features Chromium certainly still has are found, and the
      // removed one is not — so a miss below means "unknown", not "can't see".
      expect(bytes.includes(Buffer.from('BackForwardCache'))).toBe(true);
      expect(bytes.includes(Buffer.from('VizDisplayCompositor'))).toBe(false);

      const unknown = toggledFeatures().filter(
        ({ feature }) => feature === '<dynamic>' || !bytes.includes(Buffer.from(feature))
      );
      expect(unknown).toEqual([]);
      // Reads a ~230 MB binary: well under a second alone, but give a loaded
      // full-suite run room rather than Jest's 5 s default.
    },
    30_000
  );
});
