/**
 * Keeps NOTICES, LICENSE_AUDIT.md and licenses-audit.json honest about what
 * the packaged app actually ships.
 *
 * `release-process.md` §4 makes a pre-tag license check a manual step. Left
 * manual, it drifted: the 0.8.5 artifacts picked up Myotis (Apache-2.0, with
 * an upstream NOTICE that section 4(d) requires us to reproduce) and the Arti
 * Tor client (MIT/Apache-2.0) without either being attributed anywhere, while
 * the audit files still described a pre-0.8.5 inventory (electron 39.2.7, ant
 * v0.5.21, libradicle 0.3.0, "downloaded binaries: 2"). The same blind spot
 * hid a GPL-3.0 QR library (`qrious.min.js`) shipping inside `app.asar`.
 *
 * So the inventory is not written down twice. It is derived from the two
 * places that decide what ships —
 *
 *   1. `package.json` `build.extraResources` (+ the mac/linux/win scopes),
 *      which is what puts binaries and native addons under `resources/`;
 *   2. `src/renderer/vendor/`, whose committed files ship inside `app.asar`
 *      via the `src/**` files pattern;
 *
 * — and every entry must be classified below. Adding a bundled component
 * without classifying it fails this suite, which is the property that was
 * missing. Versions are read from their single source of truth (the fetch
 * scripts' pins, the lockfile) and compared with what the audit records, so a
 * bump cannot leave the audit stale either.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = __dirname;
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const audit = JSON.parse(read('licenses-audit.json'));
const notices = read('NOTICES');
const auditDoc = read('LICENSE_AUDIT.md');

const VENDOR_DIR = 'src/renderer/vendor';

/**
 * Every `from` path `build.extraResources` may name, and what it ships.
 *
 * `thirdParty` entries must be attributed; `firstParty` ones are Freedom's
 * own code or data and must not be. `auditName` keys into
 * licenses-audit.json's `dependencies`; `pin` says where the version lives.
 */
const EXTRA_RESOURCES = {
  'ant-bin/${os}-${arch}/': {
    thirdParty: true,
    label: 'Ant',
    auditName: 'ant (Swarm)',
    noticeMatch: /^Ant \(antd, Swarm node\)$/m,
    pin: { file: 'scripts/fetch-ant.js', re: /PINNED_RELEASE_TAG = '([^']+)'/ },
  },
  'native/freedom-ipfs-node/prebuilds/${os}-${arch}/': {
    thirdParty: true,
    label: 'freedom-ipfs',
    auditName: 'freedom-ipfs',
    noticeMatch: /^freedom-ipfs$/m,
    pin: {
      file: 'scripts/fetch-freedom-ipfs-native.js',
      re: /FREEDOM_IPFS_RELEASE_TAG \|\| '([^']+)'/,
    },
  },
  'radicle-bin/${os}-${arch}/': {
    thirdParty: true,
    label: 'libradicle',
    auditName: 'libradicle',
    noticeMatch: /^libradicle$/m,
    pin: {
      file: 'src/shared/radicle-addon-version.js',
      re: /RADICLE_ADDON_VERSION = '([^']+)'/,
    },
  },
  'myotis-bin/${os}-${arch}/': {
    thirdParty: true,
    label: 'Myotis',
    auditName: 'myotis',
    noticeMatch: /^Myotis \(trustless Ethereum wallet engine\)$/m,
    pin: { file: 'scripts/fetch-myotis.js', re: /PINNED_RELEASE_TAG = '([^']+)'/ },
  },
  'arti-bin/${os}-${arch}/': {
    thirdParty: true,
    label: 'Arti',
    auditName: 'arti',
    noticeMatch: /^Arti \(Tor client, macOS and Linux builds only\)$/m,
    pin: { file: 'scripts/fetch-arti.js', re: /PINNED_ARTI_VERSION = '([^']+)'/ },
  },
  'node_modules/electron/dist/LICENSES.chromium.html': {
    thirdParty: true,
    label: "Chromium's third-party notices",
    auditName: 'electron',
    noticeMatch: /^Electron$/m,
  },
  'assets/': {
    thirdParty: false,
    label: 'icons plus the CC BY-SA filter-list data in assets/adblock/',
  },
  'config/ant.yaml': { thirdParty: false, label: "Freedom's own Ant config" },
  'config/default-bookmarks.json': { thirdParty: false, label: "Freedom's own bookmark seed" },
  LICENSE: { thirdParty: false, label: "Freedom's own MPL-2.0 licence text" },
  NOTICES: { thirdParty: false, label: 'this attribution set' },
};

/** Where Chromium's notices come from, and the macOS quirk that needs them copied. */
const CHROMIUM_NOTICES = 'node_modules/electron/dist/LICENSES.chromium.html';

/** Every file `src/renderer/vendor/` may hold, and what it is. */
const VENDOR_FILES = {
  'openlv.esm.js': {
    thirdParty: true,
    label: 'OpenLV',
    auditName: 'openlv (@openlv/core, @openlv/session, @openlv/signaling, @openlv/transport)',
    noticeMatch: /^OpenLV \(@openlv\/core, @openlv\/session/m,
    copyleft: 'LGPL-3.0-only',
  },
  'highlight.min.js': {
    thirdParty: true,
    label: 'highlight.js',
    auditName: 'highlight.js',
    noticeMatch: /^highlight\.js \(syntax highlighting/m,
  },
  'hljs-github-dark.css': { thirdParty: true, coveredBy: 'highlight.min.js' },
  'hljs-github-light.css': { thirdParty: true, coveredBy: 'highlight.min.js' },
  'marked.min.js': {
    thirdParty: true,
    label: 'marked',
    auditName: 'marked',
    noticeMatch: /^marked \(Markdown parser\)$/m,
  },
  'purify.min.js': {
    thirdParty: true,
    label: 'DOMPurify',
    auditName: 'dompurify',
    noticeMatch: /^DOMPurify \(HTML sanitizer\)$/m,
  },
};

/** Every `from` path in every scope of `build.extraResources`. */
function declaredExtraResources() {
  const scopes = [pkg.build, pkg.build.mac, pkg.build.linux, pkg.build.win];
  const froms = [];
  for (const scope of scopes) {
    for (const entry of scope?.extraResources ?? []) {
      froms.push(typeof entry === 'string' ? entry : entry.from);
    }
  }
  return [...new Set(froms)];
}

const auditByName = new Map(audit.dependencies.map((d) => [d.name, d]));

describe('bundled-component inventory', () => {
  it('classifies every path build.extraResources ships', () => {
    for (const from of declaredExtraResources()) {
      expect({ from, classified: from in EXTRA_RESOURCES }).toEqual({ from, classified: true });
    }
  });

  it('classifies every file committed under src/renderer/vendor', () => {
    for (const file of fs.readdirSync(path.join(repoRoot, VENDOR_DIR)).sort()) {
      expect({ file, classified: file in VENDOR_FILES }).toEqual({ file, classified: true });
    }
  });

  it('does not classify a component that no longer ships', () => {
    const shipped = new Set(declaredExtraResources());
    for (const from of Object.keys(EXTRA_RESOURCES)) {
      expect({ from, shipped: shipped.has(from) }).toEqual({ from, shipped: true });
    }
    const vendor = new Set(fs.readdirSync(path.join(repoRoot, VENDOR_DIR)));
    for (const file of Object.keys(VENDOR_FILES)) {
      expect({ file, present: vendor.has(file) }).toEqual({ file, present: true });
    }
  });
});

describe('NOTICES attributes every third-party component that ships', () => {
  const attributable = [...Object.entries(EXTRA_RESOURCES), ...Object.entries(VENDOR_FILES)].filter(
    ([, meta]) => meta.thirdParty && !meta.coveredBy
  );

  it.each(attributable)('%s', (id, meta) => {
    expect({ id, attributed: meta.noticeMatch.test(notices) }).toEqual({ id, attributed: true });
  });

  it.each(attributable)('%s is recorded in licenses-audit.json', (id, meta) => {
    expect({ id, recorded: auditByName.has(meta.auditName) }).toEqual({ id, recorded: true });
  });

  it.each(attributable)('%s is described in LICENSE_AUDIT.md', (id, meta) => {
    expect({ id, described: auditDoc.includes(meta.label) }).toEqual({ id, described: true });
  });
});

describe("Chromium's third-party notices reach every artifact", () => {
  // Electron's dist carries LICENSES.chromium.html beside the executable, and
  // that copy is what Linux and Windows packages ship. macOS is the exception,
  // and the exception is invisible from this repo's own config — hence these
  // three checks, one per link in the chain NOTICES promises.

  it('is generated by the Electron this build packages', () => {
    // Only meaningful on a tree that could actually package: CI's unit job
    // installs with `npm ci --ignore-scripts`, so electron's postinstall never
    // downloads a dist and there is no file to look for. `scripts/build.js` is
    // what refuses to package on a machine in that state.
    if (!fs.existsSync(path.join(repoRoot, 'node_modules', 'electron', 'dist'))) return;
    expect({
      file: CHROMIUM_NOTICES,
      present: fs.existsSync(path.join(repoRoot, CHROMIUM_NOTICES)),
    }).toEqual({ file: CHROMIUM_NOTICES, present: true });
  });

  it('is still unlinked from the macOS app dir by the installed electron-builder', () => {
    // The whole reason for the mac-only copy below. If a future
    // electron-builder stops deleting it, this fails and the copy can be
    // reconsidered rather than carried forever as cargo cult.
    const macPack = 'node_modules/app-builder-lib/out/electron/electronMac.js';
    if (!fs.existsSync(path.join(repoRoot, macPack))) return; // bare checkout
    const unlinks = /unlinkIfExists[^\n]*appOutDir, "LICENSES\.chromium\.html"/.test(read(macPack));
    expect({ macPack, unlinks }).toEqual({ macPack, unlinks: true });
  });

  it('is copied into the macOS bundle, which the .dmg and .zip actually carry', () => {
    const macFroms = (pkg.build.mac?.extraResources ?? []).map((e) =>
      typeof e === 'string' ? e : e.from
    );
    expect(macFroms).toContain(CHROMIUM_NOTICES);
  });

  it('has a location in NOTICES for each platform, not a bare filename', () => {
    const electronEntry = notices.slice(notices.search(/^Electron$/m)).split(/\n(?=\S)/)[0];
    for (const required of [
      'LICENSES.chromium.html',
      'Freedom.app/Contents/Resources/',
      'freedom` executable',
      'Freedom.exe',
    ]) {
      expect({ required, stated: electronEntry.includes(required) }).toEqual({
        required,
        stated: true,
      });
    }
  });
});

describe('recorded versions match their pins', () => {
  const pinned = Object.entries(EXTRA_RESOURCES).filter(([, meta]) => meta.pin);

  it.each(pinned)('%s', (id, meta) => {
    const source = read(meta.pin.file);
    const match = source.match(meta.pin.re);
    expect({ id, foundPin: Boolean(match) }).toEqual({ id, foundPin: true });
    expect({ id, version: auditByName.get(meta.auditName).version }).toEqual({
      id,
      version: match[1],
    });
  });

  it('records the lockfile-resolved electron and better-sqlite3 versions', () => {
    const lock = JSON.parse(read('package-lock.json'));
    for (const name of ['electron', 'better-sqlite3']) {
      expect({ name, version: auditByName.get(name).version }).toEqual({
        name,
        version: lock.packages[`node_modules/${name}`].version,
      });
    }
  });
});

describe('copyleft', () => {
  // What actually shipped a GPL-3.0 library: a committed vendor file nobody
  // read the header of. Strip LGPL first — the OpenLV bundle is legitimately
  // LGPL and says so — then anything left saying GPL is a hard stop.
  const stripLgpl = (text) => text.replace(/lgpl|lesser general public license/gi, '');
  const GPL = /a?gpl[-\s]*v?[0-9]|general public license/i;

  it.each(fs.readdirSync(path.join(repoRoot, VENDOR_DIR)).sort())(
    '%s declares no GPL/AGPL licence',
    (file) => {
      const text = fs.readFileSync(path.join(repoRoot, VENDOR_DIR, file), 'utf8');
      expect({ file, gpl: GPL.test(stripLgpl(text)) }).toEqual({ file, gpl: false });
    }
  );

  it('every LGPL vendor bundle keeps its relinking instructions in NOTICES', () => {
    const lgpl = Object.entries(VENDOR_FILES).filter(([, meta]) => meta.copyleft?.includes('LGPL'));
    expect(lgpl.length).toBeGreaterThan(0);
    for (const [file, meta] of lgpl) {
      // LGPL-3.0 §4 is only satisfied while the library stays separately
      // replaceable, so the notice has to tell a user how to replace it.
      const entry = notices.slice(notices.search(meta.noticeMatch));
      expect({
        file,
        explained: /relink|replace that one file/i.test(entry.slice(0, 1200)),
      }).toEqual({ file, explained: true });
    }
  });

  it('finds no GPL/AGPL package in the production dependency tree', () => {
    const nodeModules = path.join(repoRoot, 'node_modules');
    if (!fs.existsSync(nodeModules)) return; // bare checkout; CI installs first

    const resolveDir = (name, fromDir) => {
      let dir = fromDir;
      for (;;) {
        const candidate = path.join(dir, 'node_modules', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        if (dir === repoRoot) return null;
        dir = path.dirname(dir);
      }
    };

    const seen = new Map();
    const walk = (name, fromDir) => {
      const dir = resolveDir(name, fromDir);
      if (!dir || seen.has(dir)) return;
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      seen.set(dir, { name: meta.name, version: meta.version, license: meta.license || 'UNKNOWN' });
      for (const dep of Object.keys(meta.dependencies || {})) walk(dep, dir);
    };
    for (const dep of Object.keys(pkg.dependencies)) walk(dep, repoRoot);

    const offenders = [...seen.values()]
      .filter((p) => GPL.test(stripLgpl(String(p.license))))
      .map((p) => `${p.name}@${p.version} (${p.license})`);
    expect(offenders).toEqual([]);
  });
});

describe('audit files agree with each other', () => {
  it('reports no unresolved blockers and an OK_TO_SHIP verdict', () => {
    expect(audit.blockers).toEqual([]);
    expect(audit.verdict.status).toBe('OK_TO_SHIP');
  });

  it('does not claim zero copyleft while shipping copyleft', () => {
    // The stale audit's "Copyleft (GPL/AGPL/LGPL): 0" line is what made a
    // green license check meaningless. If an LGPL component is classified
    // above, both audit files have to say so.
    const shipsLgpl = Object.values(VENDOR_FILES).some((m) => m.copyleft?.includes('LGPL'));
    expect(shipsLgpl).toBe(true);
    expect(auditDoc).toMatch(/LGPL-3\.0/);
    expect(JSON.stringify(audit)).toMatch(/LGPL-3\.0/);
    expect(auditDoc).not.toMatch(/Zero GPL\/AGPL\/LGPL dependencies/);
  });

  it('names the pinned version of every bundled binary in LICENSE_AUDIT.md', () => {
    for (const [, meta] of Object.entries(EXTRA_RESOURCES).filter(([, m]) => m.pin)) {
      const version = read(meta.pin.file).match(meta.pin.re)[1];
      expect({ label: meta.label, documented: auditDoc.includes(version) }).toEqual({
        label: meta.label,
        documented: true,
      });
    }
  });
});
