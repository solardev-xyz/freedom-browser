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
 * So the inventory is not written down twice. It is derived from the three
 * places that decide what ships —
 *
 *   1. `package.json` `build.extraResources` (every scope, not just the
 *      mac/linux/win ones that exist today), which is what puts binaries and
 *      native addons under `resources/`;
 *   2. `src/renderer/vendor/`, whose committed files ship inside `app.asar`
 *      via the `src/**` files pattern;
 *   3. the rest of what that same `src/**` pattern ships — every committed
 *      non-source file under `src/`, because `vendor/` is a convention, not a
 *      boundary: qrious would have shipped exactly the same way from
 *      `src/renderer/lib/`, and the committed page media is third-party-
 *      looking content nothing else in the audit names;
 *
 * — and every entry must be classified below. Adding a bundled component
 * without classifying it fails this suite, which is the property that was
 * missing. Versions are read from their single source of truth (the fetch
 * scripts' pins, the lockfile) and compared with what the audit records, so a
 * bump cannot leave the audit stale either, and the audit's own baseline is
 * pinned to `package.json`'s version so a release cannot carry a stale one.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = __dirname;
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const audit = JSON.parse(read('licenses-audit.json'));
const notices = read('NOTICES');
const auditDoc = read('LICENSE_AUDIT.md');

const SRC_DIR = 'src';
const VENDOR_DIR = 'src/renderer/vendor';

/** Extensions `src/` holds that are Freedom's own source rather than an asset. */
const SOURCE_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.md']);

/** Extensions worth reading as text when sweeping `src/` for licence headers. */
const TEXT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, '.svg', '.c', '.h', '.mjs', '.cjs', '.ts']);

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
    // Deliberately not pinning the platform wording here: it is a claim about
    // the artifacts, checked against `package.json` by `platformClaims` below
    // rather than against a literal that has to be hand-edited to match.
    noticeMatch: /^Arti \(Tor client, .+ builds\)$/m,
    pin: { file: 'scripts/fetch-arti.js', re: /PINNED_ARTI_VERSION = '([^']+)'/ },
    // Arti is the one component that does not ship to every platform, so every
    // sentence stating which platforms it reaches has to move with
    // `build.<scope>.extraResources`. See `platform claims` below.
    platformClaims: [
      { file: 'NOTICES', line: /^Arti \(Tor client, .+ builds\)$/m },
      { file: 'LICENSE_AUDIT.md', line: /^ *- Arti \(Tor client\) — .*$/m },
      {
        file: 'LICENSE_AUDIT.md',
        block: /^### Arti \(Tor Client\)/m,
        line: /^- \*\*Platforms:\*\* .*$/m,
      },
    ],
  },
  'node_modules/electron/dist/LICENSES.chromium.html': {
    thirdParty: true,
    label: "Chromium's third-party notices",
    auditName: 'electron',
    noticeMatch: /^Electron$/m,
  },
  // Freedom's own icons, but `assets/adblock/` packages EasyList and friends,
  // whose CC BY-SA arm needs attribution. Classifying the whole path as
  // first-party exempted that obligation from every check below, so the
  // filter-list block could be deleted from NOTICES with the suite green.
  'assets/': {
    thirdParty: true,
    label: 'icons plus the CC BY-SA filter-list data in `assets/adblock/`',
    auditName: 'ad-blocking filter lists',
    noticeMatch: /^Ad-blocking filter lists \(bundled data, not code\)$/m,
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

/**
 * Every non-source file the `src/**` files pattern ships, by the directory it
 * lives in. `src/renderer/vendor/` is enumerated file-by-file above; this
 * covers the rest, which the audit never named — `home.png` alone is 2.65 MB
 * inside every artifact.
 *
 * `thirdParty` entries must be attributed; `firstParty` ones are Freedom's own
 * work and must not be. Every `label` must appear in LICENSE_AUDIT.md, and
 * every `auditName` in licenses-audit.json.
 */
const SRC_ASSETS = {
  'src/main/myotis/native/': {
    thirdParty: false,
    label: "Freedom's own Myotis supervisor sources",
  },
  'src/renderer/pages/images/': {
    thirdParty: false,
    label: "Freedom's own internal-page artwork and wordmark",
    auditName: 'internal-page artwork',
  },
  'src/renderer/assets/chains/': {
    thirdParty: true,
    label: 'chain marks',
    auditName: 'chain and token marks',
    noticeMatch: /^Chain and token marks \(sidebar and wallet icons\)$/m,
  },
  'src/renderer/assets/tokens/': {
    thirdParty: true,
    label: 'token marks',
    auditName: 'chain and token marks',
    noticeMatch: /^Chain and token marks \(sidebar and wallet icons\)$/m,
  },
};

const ALL_PLATFORMS = ['linux', 'mac', 'win'];

/**
 * Every electron-builder scope an `extraResources` entry may sit under, and
 * the platforms an entry there ships to. Enumerated rather than defaulted:
 * a scope this map does not name fails the sweep below, because guessing
 * "every platform" for an unrecognised one would silently over-claim the
 * artifact set — which is the bug this whole derivation exists to catch.
 */
const SCOPE_PLATFORMS = {
  mac: ['mac'],
  mas: ['mac'],
  dmg: ['mac'],
  pkg: ['mac'],
  linux: ['linux'],
  deb: ['linux'],
  appImage: ['linux'],
  rpm: ['linux'],
  snap: ['linux'],
  pacman: ['linux'],
  freebsd: ['linux'],
  win: ['win'],
  nsis: ['win'],
  nsisWeb: ['win'],
  portable: ['win'],
  appx: ['win'],
  msi: ['win'],
  squirrelWindows: ['win'],
};

/**
 * Every `from` path in every scope of `build.extraResources`, with the
 * platforms whose artifacts carry it.
 *
 * Walked rather than read from a fixed [build, mac, linux, win] list: an entry
 * added under `mas`, or under a target-level scope, ships exactly the same and
 * would otherwise never reach the classification check below. The platform set
 * is what makes a per-platform claim ("Arti ships on macOS and Linux only")
 * checkable against the tree instead of being written down twice and trusted.
 */
function walkExtraResources() {
  const platforms = new Map();
  const unknownScopes = [];
  const collect = (scope, key, inherited) => {
    if (!scope || typeof scope !== 'object') return;
    const ships = key === null ? ALL_PLATFORMS : (SCOPE_PLATFORMS[key] ?? inherited);
    for (const entry of scope.extraResources ?? []) {
      const from = typeof entry === 'string' ? entry : entry.from;
      if (!SCOPE_PLATFORMS[key] && key !== null) unknownScopes.push(`${key}: ${from}`);
      if (!platforms.has(from)) platforms.set(from, new Set());
      for (const platform of ships ?? []) platforms.get(from).add(platform);
    }
    for (const [child, value] of Object.entries(scope)) {
      if (child !== 'extraResources') collect(value, child, ships);
    }
  };
  collect(pkg.build, null, null);
  return { platforms, unknownScopes };
}

function declaredExtraResources() {
  return [...walkExtraResources().platforms.keys()];
}

/** The platforms whose artifacts carry `from`, sorted. */
function shippedPlatforms(from) {
  return [...(walkExtraResources().platforms.get(from) ?? [])].sort();
}

/**
 * How a derived platform set is written in prose. NOTICES and
 * LICENSE_AUDIT.md have to name the set the tree actually ships, so the
 * wording is derived from it rather than pinned as a literal string.
 */
const PLATFORM_WORDING = {
  'linux,mac,win': 'macOS, Linux and Windows',
  'linux,mac': 'macOS and Linux',
  'mac,win': 'macOS and Windows',
  'linux,win': 'Linux and Windows',
  mac: 'macOS',
  linux: 'Linux',
  win: 'Windows',
};

/**
 * Every file `build.files`' `src/**\/*` pattern puts in `app.asar`, minus the
 * `**\/*.test.js` and `**\/coverage/**` it excludes. Read from disk, not from
 * git: electron-builder packs the working tree, so an uncommitted file ships
 * too.
 */
function shippedSrcFiles() {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'coverage') walk(child);
      } else if (!child.endsWith('.test.js')) {
        files.push(child);
      }
    }
  };
  walk(SRC_DIR);
  return files.sort();
}

/** The non-source files among them — what SRC_ASSETS has to account for. */
const shippedSrcAssets = () =>
  shippedSrcFiles().filter((file) => !SOURCE_EXTENSIONS.has(path.extname(file)));

const auditByName = new Map(
  [...audit.dependencies, ...(audit.assets ?? [])].map((entry) => [entry.name, entry])
);

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

  it('classifies every non-source file the src/**/* pattern ships', () => {
    for (const file of shippedSrcAssets()) {
      const dir = `${path.dirname(file)}/`;
      expect({ file, classified: dir in SRC_ASSETS }).toEqual({ file, classified: true });
    }
  });

  it('keeps third-party bundles in src/renderer/vendor, where they get read', () => {
    // The vendor sweeps below are what catch a copyleft bundle, and they only
    // look in one directory. A pre-built library dropped anywhere else under
    // `src/` ships identically and is invisible to them — which is the qrious
    // bug with the directory changed.
    const bundled = /\.(min|bundle|umd|esm|dist)\.(js|mjs|cjs|css)$/;
    for (const file of shippedSrcFiles()) {
      if (!bundled.test(path.basename(file))) continue;
      expect({ file, inVendorDir: file.startsWith(`${VENDOR_DIR}/`) }).toEqual({
        file,
        inVendorDir: true,
      });
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
    const assetDirs = new Set(shippedSrcAssets().map((file) => `${path.dirname(file)}/`));
    for (const dir of Object.keys(SRC_ASSETS)) {
      expect({ dir, present: assetDirs.has(dir) }).toEqual({ dir, present: true });
    }
  });
});

describe('NOTICES attributes every third-party component that ships', () => {
  const attributable = [
    ...Object.entries(EXTRA_RESOURCES),
    ...Object.entries(VENDOR_FILES),
    ...Object.entries(SRC_ASSETS),
  ].filter(([, meta]) => meta.thirdParty && !meta.coveredBy);

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

describe('platform claims match the artifacts that carry the component', () => {
  // Every other bundled component ships everywhere, so its platform set is not
  // written down and cannot go stale. Arti's is, in three sentences and one
  // JSON field, and nothing tied any of them to `package.json`: reverting
  // `platforms` to ["mac","linux"] and the prose to "macOS and Linux only"
  // left this suite green, so the audit could describe an artifact set that no
  // longer exists. The set is now derived from the `extraResources` scopes
  // that put the binary in an artifact, and every statement of it is compared
  // with that.

  /** The file a claim lives in, and where a block inside it ends. */
  const CLAIM_FILES = {
    NOTICES: { text: notices, blockEnd: /\n(?=\S)/ },
    'LICENSE_AUDIT.md': { text: auditDoc, blockEnd: /\n(?=### |---)/ },
  };

  /**
   * The line stating a platform set, scoped to its block when the claim names
   * one — `- **Platforms:**` is a shape any component's section can carry, so
   * a whole-file sweep would read the wrong one as soon as a second component
   * states a platform set.
   */
  const claimLine = (claim) => {
    const { text, blockEnd } = CLAIM_FILES[claim.file];
    let scope = text;
    if (claim.block) {
      const start = scope.search(claim.block);
      if (start < 0) return null;
      scope = scope.slice(start);
      const end = scope.slice(1).search(blockEnd);
      if (end >= 0) scope = scope.slice(0, end + 1);
    }
    return scope.match(claim.line)?.[0] ?? null;
  };

  const claimed = Object.entries(EXTRA_RESOURCES).filter(([, meta]) => meta.platformClaims);

  it('resolves every extraResources scope to a platform set', () => {
    expect(walkExtraResources().unknownScopes).toEqual([]);
  });

  it('guards every audit entry that records a platform set', () => {
    // A second component gaining a `platforms` field without a claim list here
    // would be exactly as unguarded as Arti was.
    const guarded = new Set(claimed.map(([, meta]) => meta.auditName));
    for (const entry of [...audit.dependencies, ...(audit.assets ?? [])]) {
      if (!entry.platforms) continue;
      expect({ name: entry.name, guarded: guarded.has(entry.name) }).toEqual({
        name: entry.name,
        guarded: true,
      });
    }
  });

  it.each(claimed)('%s records the platforms package.json ships it to', (id, meta) => {
    expect({
      id,
      platforms: [...(auditByName.get(meta.auditName).platforms ?? [])].sort(),
    }).toEqual({ id, platforms: shippedPlatforms(id) });
  });

  it.each(claimed)('%s states that set everywhere it is written down', (id, meta) => {
    const wording = PLATFORM_WORDING[shippedPlatforms(id).join(',')];
    expect({ id, platforms: shippedPlatforms(id), wording }).toEqual({
      id,
      platforms: shippedPlatforms(id),
      wording: expect.any(String),
    });
    for (const claim of meta.platformClaims) {
      const line = claimLine(claim);
      expect({ id, claim: String(claim.line), found: line !== null }).toEqual({
        id,
        claim: String(claim.line),
        found: true,
      });
      expect({ id, line, states: line.includes(wording) }).toEqual({ id, line, states: true });
      // A narrower wording left behind by a platform gain reads as a true
      // sentence on its own, which is how "macOS and Linux only" survived
      // Windows picking up Arti. Anything not implied by the right wording is
      // a contradiction.
      const contradicts = Object.values(PLATFORM_WORDING).filter(
        (other) => other !== wording && !wording.includes(other) && line.includes(other)
      );
      expect({ id, line, contradicts }).toEqual({ id, line, contradicts: [] });
    }
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
  // A bare `GPL` counts. The version-or-full-phrase form this replaces read
  // `Released under the GPL`, `GNU GPL, version 3` (the comma defeated
  // `[-\s]*`) and a plain `@license GPL` as clean.
  const GPL = /\ba?gpl\b|general public license/i;

  // A minified bundle very often carries no licence header at all, which no
  // regex over its contents can catch. So every attributable vendor file has
  // to *say* what it is: banners are conventionally the first thing in the
  // file, so only the head is trusted.
  const LICENCE_HEADER =
    /\b(mit|bsd|apache|mpl|mozilla public license|isc|lgpl|gpl|unlicense|cc0|zlib|wtfpl|public domain)\b/i;

  it.each(fs.readdirSync(path.join(repoRoot, VENDOR_DIR)).sort())(
    '%s declares no GPL/AGPL licence',
    (file) => {
      const text = fs.readFileSync(path.join(repoRoot, VENDOR_DIR, file), 'utf8');
      expect({ file, gpl: GPL.test(stripLgpl(text)) }).toEqual({ file, gpl: false });
    }
  );

  it.each(Object.entries(VENDOR_FILES).filter(([, meta]) => meta.thirdParty && !meta.coveredBy))(
    '%s carries a licence header of its own',
    (file) => {
      const head = fs.readFileSync(path.join(repoRoot, VENDOR_DIR, file), 'utf8').slice(0, 4096);
      expect({ file, declares: LICENCE_HEADER.test(head) }).toEqual({ file, declares: true });
    }
  );

  it('finds no GPL/AGPL licence anywhere else under src/', () => {
    // `src/renderer/vendor/` is where a third-party bundle is *supposed* to
    // go, not where it has to go: the `src/**\/*` files pattern ships all of
    // `src/`, so the same file in `src/renderer/lib/` is the same bug.
    for (const file of shippedSrcFiles()) {
      if (file.startsWith(`${VENDOR_DIR}/`)) continue; // swept per-file above
      if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      expect({ file, gpl: GPL.test(stripLgpl(text)) }).toEqual({ file, gpl: false });
    }
  });

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

  // npm records a package's licence three ways: the current `license` string,
  // the object form `{"type": "...", "url": "..."}`, and the deprecated
  // `licenses` array. Reading only the string form stringifies the object to
  // `[object Object]` and leaves the array as `UNKNOWN` — neither matches a
  // GPL pattern, so a GPL package declaring either would have swept clean.
  const declaredLicense = (meta) => {
    if (typeof meta.license === 'string') return meta.license;
    if (meta.license && typeof meta.license.type === 'string') return meta.license.type;
    const legacy = (Array.isArray(meta.licenses) ? meta.licenses : [meta.licenses])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter(Boolean);
    if (legacy.length) return legacy.join(' OR ');
    return 'UNKNOWN';
  };

  /**
   * Every package a production install puts in `app.asar`.
   *
   * `dependencies` alone is not that set: npm installs `optionalDependencies`
   * by default (`gun`'s `@peculiar/webcrypto` is a live example, eight
   * packages deep) and auto-installs missing `peerDependencies`. Both ship,
   * so both are walked.
   */
  const productionTree = () => {
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
      seen.set(dir, { name: meta.name, version: meta.version, license: declaredLicense(meta) });
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const dep of Object.keys(meta[field] || {})) walk(dep, dir);
      }
    };
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(pkg[field] || {})) walk(dep, repoRoot);
    }
    return [...seen.values()];
  };

  it('finds no GPL/AGPL package in the production dependency tree', () => {
    if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) return; // bare checkout

    const offenders = productionTree()
      .filter((p) => GPL.test(stripLgpl(String(p.license))))
      .map((p) => `${p.name}@${p.version} (${p.license})`);
    expect(offenders).toEqual([]);
  });

  it('leaves no production package with an unread licence', () => {
    // An UNKNOWN matches no licence pattern, so it is indistinguishable from a
    // clean sweep. Nothing was asserting the set was empty.
    if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) return; // bare checkout

    const unknown = productionTree()
      .filter((p) => p.license === 'UNKNOWN')
      .map((p) => `${p.name}@${p.version}`);
    expect(unknown).toEqual([]);
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

  it('is baselined against the version being released', () => {
    // Nothing tied the audit's baseline to `package.json`, so the 0.8.5 cut
    // would have carried an rc-stamped audit with the whole suite green —
    // exactly the undetected staleness (`generated_at: 2026-08-19` against a
    // moved tree) this file exists to stop, one release later.
    expect({ field: 'audit_baseline', version: audit.audit_baseline }).toEqual({
      field: 'audit_baseline',
      version: pkg.version,
    });
    const documented = auditDoc.match(/^\*\*Baseline:\*\* `([^`]+)`$/m);
    expect({ field: 'LICENSE_AUDIT.md Baseline', found: Boolean(documented) }).toEqual({
      field: 'LICENSE_AUDIT.md Baseline',
      found: true,
    });
    expect({ field: 'LICENSE_AUDIT.md Baseline', version: documented[1] }).toEqual({
      field: 'LICENSE_AUDIT.md Baseline',
      version: pkg.version,
    });
    const footer = auditDoc.match(/Re-derived from the installed tree on [\d-]+ against `([^`]+)`/);
    expect({ field: 'LICENSE_AUDIT.md footer', version: footer?.[1] }).toEqual({
      field: 'LICENSE_AUDIT.md footer',
      version: pkg.version,
    });
  });

  it('describes every classified src asset in both audit files', () => {
    for (const [dir, meta] of Object.entries(SRC_ASSETS)) {
      expect({ dir, described: auditDoc.includes(meta.label) }).toEqual({ dir, described: true });
      if (!meta.auditName) continue;
      expect({ dir, recorded: auditByName.has(meta.auditName) }).toEqual({ dir, recorded: true });
    }
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
