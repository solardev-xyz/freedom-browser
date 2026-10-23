'use strict';

/**
 * Freedom's security-release rule for Electron, as pure functions (#644,
 * roadmap item 0.2). Decided 2026-10-23:
 *
 *   1. A Chromium/Electron security fix on the current major reaches the
 *      stable release within 7 days of its npm publish.
 *   2. Within 72 hours when the bug is exploited in the wild: Chrome's release
 *      notes say an exploit exists in the wild, or the CVE is in CISA's Known
 *      Exploited Vulnerabilities catalog.
 *   3. Never ship an end-of-life Electron major. Electron supports the latest
 *      three stable majors.
 *   4. Adopt each new major within 8 weeks of its first stable release.
 *
 * `scripts/electron-watch.js` fetches the inputs, calls these and writes the
 * issues and the bump pull request; `.github/workflows/electron-watch.yml`
 * runs it every 6 hours. Nothing here touches the network or the disk, so the
 * whole decision is tested against recorded upstream data
 * (`scripts/fixtures/electron-watch/`).
 *
 * How Electron marks a security release, as observed over 1,000 releases
 * (v20.3.3, 2022-10, to v45.0.0, 2026-10). There is no "Security" heading and
 * no machine-readable flag; the evidence is spread over four places, and
 * which one carries it has changed over time:
 *
 *   - Release notes, "Other Changes":
 *       * `Security: backported fix(es) for CVE-…` and `Security: backported
 *         fix for <crbug id>` (2022 to mid-2025, now occasional). The only
 *         form that names CVEs.
 *       * `Backported fixes from upstream ANGLE, Chromium, PDFium and V8.`
 *         (the 2026-06 onwards automation; one line per cherry-pick batch, no
 *         CVE ids, and the linked PR lists Gerrit commits, not CVEs).
 *       * `Backported fix for 483569511.` / `… for chromium:…` (crbug ids).
 *       * `Updated Chromium to 152.0.7977.167.` — a Chromium patch roll. It
 *         carries whatever Chrome's own release for that build fixed, which
 *         only Chrome's release notes say.
 *   - A `> [!NOTE] This release contains the fix for https://github.com/
 *     electron/electron/security/advisories/GHSA-…` callout (2026-10).
 *   - Electron's GitHub security advisories, which name the patched version
 *     on each major and often a CVE. They are frequently published weeks
 *     after the release they describe; the notes of the patched release then
 *     read like an ordinary "Fixed …" line.
 *   - Chrome's release blog for the Chromium builds Electron rolls to: it
 *     lists the CVEs per build and, for exploited bugs, says "Google is aware
 *     that an exploit for CVE-… exists in the wild."
 *
 * A release counts as a security release when any of those applies to it.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Rule 1 and rule 2. */
const STANDARD_WINDOW_MS = 7 * DAY_MS;
const EXPLOITED_WINDOW_MS = 72 * HOUR_MS;
/** Rule 4. */
const MAJOR_ADOPTION_WINDOW_MS = 56 * DAY_MS;
/** Rule 3: Electron's support policy is the latest three stable majors. */
const SUPPORTED_MAJORS = 3;
/** One release cycle: the oldest supported major goes EOL with the next major. */
const EOL_WARNING_MS = 56 * DAY_MS;

const LABEL = 'security-release';
const BRANCH_PREFIX = 'electron-watch/electron-';
const MARKER_RE = /<!-- electron-watch:((?:security|major|eol):[0-9.]+) -->/;

/** How many CVE ids an issue lists before "and N more" (the body limit is 65,536). */
const MAX_LISTED_CVES = 60;

const CVE_RE = /\bCVE-\d{4}-\d{4,}\b/g;
const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/;
const GHSA_RE = /\bGHSA(?:-[0-9a-z]{4}){3}\b/gi;
const GHSA_ONE_RE = /\bGHSA(?:-[0-9a-z]{4}){3}\b/i;
const GHSA_ID_RE = /^GHSA(?:-[0-9a-z]{4}){3}$/i;

// Upstream data is untrusted. Every value from releases.electronjs.org that
// reaches a committed file must be in its exact numeric format, and every
// link an issue renders must point at the source it claims to be.
const CHROMIUM_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}\.\d{1,6}$/;
const NODE_VERSION_RE = /^\d{1,3}\.\d{1,4}\.\d{1,4}$/;
const MODULES_RE = /^\d{1,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RULES = [
  /^https:\/\/github\.com\/electron\/electron\/pull\/\d+$/,
  /^https:\/\/github\.com\/electron\/electron\/releases\/tag\/v\d+\.\d+\.\d+$/,
  /^https:\/\/github\.com\/electron\/electron\/security\/advisories\/GHSA(?:-[0-9a-z]{4}){3}$/,
  /^https:\/\/chromereleases\.googleblog\.com\/\d{4}\/\d{2}\/[a-z0-9_-]+\.html$/,
];

/** `url` when it is one of the sources above, else null. */
function safeUrl(url) {
  const text = String(url ?? '');
  return URL_RULES.some((re) => re.test(text)) ? text : null;
}

/**
 * Upstream text as inert Markdown: one line in a `<code>` element, every
 * character other than a letter, digit or space written as a numeric HTML
 * entity. Entities are never Markdown syntax, so no bracket, backtick, pipe,
 * angle bracket or `://` in the text can open a link, an image, a tag, a
 * table cell or an autolink; and GitHub resolves no mention or issue
 * reference inside `<code>`. It renders as the characters it was.
 */
function mdCode(text) {
  const body = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!body) return '';
  return `<code>${[...body].map((ch) => (/[A-Za-z0-9 ]/.test(ch) ? ch : `&#${ch.codePointAt(0)};`)).join('')}</code>`;
}

/** `[text](url)` for an accepted source, plain `text` otherwise. */
function mdLink(text, url) {
  const safe = safeUrl(url);
  return safe ? `[${text}](${safe})` : text;
}

/**
 * A releases.electronjs.org entry reduced to the fields the watch uses, each
 * kept only in its exact format; anything else reads as unknown.
 */
function sanitizeElectronRelease(entry) {
  if (!entry || !parseVersion(entry.version)) return null;
  const field = (value, re) => (re.test(String(value ?? '')) ? String(value) : null);
  return {
    version: String(entry.version),
    chrome: field(entry.chrome, CHROMIUM_VERSION_RE),
    node: field(entry.node, NODE_VERSION_RE),
    modules: field(entry.modules, MODULES_RE),
  };
}

// ---------------------------------------------------------------------------
// Versions

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `44.9.3` → `{ major: 44, minor: 9, patch: 3, pre: [] }`; null when not semver. */
function parseVersion(text) {
  const m = VERSION_RE.exec(String(text || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

function isStableVersion(text) {
  const v = parseVersion(text);
  return Boolean(v) && v.pre.length === 0;
}

function majorOf(text) {
  const v = parseVersion(text);
  return v ? v.major : null;
}

/** Semver precedence: negative, zero or positive, like a sort comparator. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const xn = /^\d+$/.test(x.pre[i]);
    const yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn && Number(x.pre[i]) !== Number(y.pre[i]))
      return Number(x.pre[i]) - Number(y.pre[i]);
    if (xn !== yn) return xn ? -1 : 1;
    if (x.pre[i] !== y.pre[i]) return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` satisfies a GitHub advisory range such as
 * `>= 44.0.0-alpha.1, < 44.9.1` or `< 42.11.16`.
 */
function satisfiesRange(version, range) {
  const parts = String(range || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  return parts.every((part) => {
    const m = /^(>=|<=|>|<|=)?\s*(\S+)$/.exec(part);
    if (!m || !parseVersion(m[2])) return false;
    const c = compareVersions(version, m[2]);
    switch (m[1] || '=') {
      case '>=':
        return c >= 0;
      case '<=':
        return c <= 0;
      case '>':
        return c > 0;
      case '<':
        return c < 0;
      default:
        return c === 0;
    }
  });
}

/** Chromium build numbers: `152.0.7977.130` → `{ branch: '152.0.7977', build: 130 }`. */
function parseChromiumVersion(text) {
  const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(String(text || '').trim());
  return m ? { branch: m[1], build: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------
// npm

/**
 * Stable Electron releases from the npm packument's `time` map, oldest first,
 * as `{ version, major, publishedAt }` (ms since the epoch). Only what was
 * published by `now` counts, so a recorded packument can be replayed at any
 * point in its history.
 */
function npmStableReleases(packument, now = Date.now()) {
  const time = packument && packument.time;
  if (!time || typeof time !== 'object') throw new Error('npm packument has no `time` map');
  const out = [];
  for (const [version, iso] of Object.entries(time)) {
    if (!isStableVersion(version)) continue;
    const publishedAt = Date.parse(iso);
    if (!Number.isFinite(publishedAt) || publishedAt > now) continue;
    out.push({ version, major: majorOf(version), publishedAt });
  }
  if (!out.length) throw new Error('npm packument lists no stable Electron release');
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

function latestOnMajor(releases, major) {
  const onMajor = releases.filter((r) => r.major === major);
  return onMajor.length ? onMajor[onMajor.length - 1] : null;
}

/** The first stable release of each major, by version (x.0.0 when it exists). */
function firstStableByMajor(releases) {
  const out = new Map();
  for (const r of releases) if (!out.has(r.major)) out.set(r.major, r);
  return out;
}

// ---------------------------------------------------------------------------
// Electron release notes

const BULLET_RE = /^\s*(?:>\s*)*(?:[*+-]|\d+\.)?\s*/;
/** A bug id after "Backported fix for …": crbug numbers, tracker:id, CVEs, Google's b/…. */
const BACKPORT_ID_RE =
  /\b(?:CVE-\d{4}-\d{4,}|(?:chromium|v8|skia|angleproject|pdfium|webrtc|dawn):\d+|b\/\d+|crbug\.com\/\d+|issues\.chromium\.org\/issues\/\d+|\d{6,})\b|\bfor none\b/i;
/** Prose backports (2026-04/05) that describe a security bug class. */
const BACKPORT_SECURITY_WORDS_RE =
  /use[- ]after[- ]free|\bUAF\b|memory[- ]safety|out[- ]of[- ]bounds|overflow|type confusion|sandbox|security|vulnerab|exploit|validation|lifetime|maglev|turbofan|turboshaft|turbolev/i;
const CHROMIUM_ROLL_RE = /\b(?:Updated|Bumped|Upgraded) Chromium to (\d+\.\d+\.\d+\.\d+)/i;

/** One note line without its bullet, PR links and "Also in" tail, for display. */
function cleanNoteLine(line) {
  return line
    .replace(BULLET_RE, '')
    .replace(/<(?:sup|span)\b.*$/i, '')
    .replace(/\s*\[#\d+\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `[{ number, url }]` for the PR links on a note line. */
function noteLinePulls(line) {
  const out = [];
  for (const m of line.matchAll(
    /\[#(\d+)\]\((https:\/\/github\.com\/electron\/electron\/pull\/\d+)\)/g
  )) {
    out.push({ number: Number(m[1]), url: m[2] });
  }
  return out.slice(0, 1);
}

/**
 * Why one release-notes line marks a security fix, or null. See the module
 * comment for the phrasings; `Backported …` lines without an id, an
 * `upstream` source or a security word ("Backported fix for AVX related
 * crashes") are bug-fix backports and do not count.
 */
function classifyNoteLine(line) {
  const text = cleanNoteLine(line);
  if (!text) return null;
  if (/\bsecurity\s*:/i.test(text)) return 'security';
  if (/\bCVE-\d{4}-\d{4,}\b/.test(text)) return 'cve';
  if (GHSA_ONE_RE.test(text) || /security\/advisories\//i.test(text)) return 'advisory';
  if (/\bin the wild\b/i.test(text)) return 'exploited';
  if (/^backported\b/i.test(text)) {
    if (/\bfrom upstream\b/i.test(text)) return 'backport';
    if (BACKPORT_ID_RE.test(text)) return 'backport';
    if (BACKPORT_SECURITY_WORDS_RE.test(text)) return 'backport';
  }
  return null;
}

/**
 * What one Electron release's notes say about security.
 *
 * @returns {{
 *   lines: {kind: string, text: string, pull: ({number: number, url: string}|undefined)}[],
 *   otherBackports: string[],
 *   cves: string[],
 *   advisories: string[],
 *   chromium: string|null,
 *   exploitedInWild: boolean,
 * }}
 */
function parseReleaseNotes(body) {
  const text = String(body || '');
  const lines = [];
  const otherBackports = [];
  let chromium = null;
  for (const raw of text.split(/\r?\n/)) {
    const kind = classifyNoteLine(raw);
    if (kind) lines.push({ kind, text: cleanNoteLine(raw), pull: noteLinePulls(raw)[0] });
    else if (/^backported\b/i.test(cleanNoteLine(raw))) otherBackports.push(cleanNoteLine(raw));
    const roll = CHROMIUM_ROLL_RE.exec(raw);
    if (roll) chromium = roll[1];
  }
  return {
    lines,
    otherBackports,
    cves: unique(text.match(CVE_RE) || []),
    advisories: unique((text.match(GHSA_RE) || []).map(normalizeGhsa)),
    chromium,
    exploitedInWild: /\bin the wild\b/i.test(text),
  };
}

function normalizeGhsa(id) {
  return `GHSA${id.slice(4).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Chrome release blog (chromereleases.googleblog.com, Blogger JSON feed)

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlToText(html) {
  return String(html || '')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code =
          name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Every full Chromium version a post names, with the slash shorthand
 * expanded: `152.0.7977.82/.83` and `146.0.7680.177/178` are two builds each.
 */
function chromiumVersionsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(
    /\b(\d{2,4}\.\d+\.\d{3,5})\.(\d{1,4})((?:\s*\/\s*\.?\d{1,4}\b)*)/g
  )) {
    out.push(`${m[1]}.${m[2]}`);
    for (const extra of m[3].matchAll(/\/\s*\.?(\d{1,4})/g)) out.push(`${m[1]}.${extra[1]}`);
  }
  return unique(out);
}

/**
 * One Chrome release post: the builds it ships, the CVEs it fixes, and the
 * CVEs it says are exploited in the wild ("Google is aware that an exploit
 * for CVE-… exists in the wild", "… reports that exploits for CVE-… and
 * CVE-… exist in the wild").
 */
function parseChromePost(entry) {
  const title = entry?.title?.$t ?? '';
  const text = htmlToText(entry?.content?.$t ?? '');
  const link = (entry?.link || []).find((l) => l.rel === 'alternate');
  const exploited = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    if (/\bin the wild\b/i.test(sentence)) exploited.push(...(sentence.match(CVE_RE) || []));
  }
  const fixes = /\bThis update includes (\d+) security fix/i.exec(text);
  return {
    title,
    url: link ? safeUrl(link.href) : null,
    publishedAt: Date.parse(entry?.published?.$t ?? '') || null,
    versions: chromiumVersionsIn(text),
    cves: unique(text.match(CVE_RE) || []),
    exploited: unique(exploited),
    securityFixes: fixes ? Number(fixes[1]) : null,
  };
}

/** The desktop posts of a Blogger feed page (Android, iOS and ChromeOS posts are other builds). */
function parseChromeFeed(feed) {
  const entries = feed?.feed?.entry;
  if (!Array.isArray(entries)) {
    if (feed?.feed && !('entry' in feed.feed)) return [];
    throw new Error('Chrome release feed has no `feed.entry` list');
  }
  return entries.filter((e) => /\bdesktop\b/i.test(e?.title?.$t ?? '')).map(parseChromePost);
}

/**
 * The Chrome posts whose builds an Electron Chromium roll from `from` to `to`
 * newly includes: same Chromium branch, build number in `(from, to]`. A roll
 * carries every earlier fix on its branch, so this is a superset of what the
 * Electron release fixes for the first time — an earlier Electron backport of
 * the same fix is not visible here, which can only make a deadline stricter.
 */
function chromePostsForRoll(posts, from, to) {
  const a = parseChromiumVersion(from);
  const b = parseChromiumVersion(to);
  if (!a || !b || a.branch !== b.branch || b.build <= a.build) return [];
  return posts.filter((post) =>
    post.versions.some((v) => {
      const p = parseChromiumVersion(v);
      return p && p.branch === b.branch && p.build > a.build && p.build <= b.build;
    })
  );
}

// ---------------------------------------------------------------------------
// CISA KEV and Electron's advisories

/** `cveID` → entry, from CISA's `known_exploited_vulnerabilities.json`. */
function parseKev(json) {
  if (!json || !Array.isArray(json.vulnerabilities)) {
    throw new Error('CISA KEV feed has no `vulnerabilities` list');
  }
  const out = new Map();
  for (const v of json.vulnerabilities) {
    if (v && CVE_ID_RE.test(String(v.cveID))) out.set(v.cveID, v);
  }
  return out;
}

/** KEV entries for Chromium and the engines it bundles. */
function isChromiumKevEntry(entry) {
  return (
    /google/i.test(entry.vendorProject || '') &&
    /chrom|v8|skia|angle|webp|pdfium|dawn|webrtc/i.test(
      `${entry.product} ${entry.vulnerabilityName}`
    )
  );
}

/** Electron's GitHub security advisories, reduced to what the rule needs. */
function parseAdvisories(list) {
  if (!Array.isArray(list)) throw new Error('Electron advisories response is not a list');
  return list
    .filter((a) => a && GHSA_ID_RE.test(String(a.ghsa_id)) && !a.withdrawn_at)
    .map((a) => ({
      id: normalizeGhsa(a.ghsa_id),
      cve: CVE_ID_RE.test(String(a.cve_id)) ? a.cve_id : null,
      url:
        safeUrl(a.html_url) ||
        `https://github.com/electron/electron/security/advisories/${normalizeGhsa(a.ghsa_id)}`,
      summary: a.summary || '',
      severity: a.severity || null,
      publishedAt: Date.parse(a.published_at || '') || null,
      ranges: (a.vulnerabilities || [])
        .filter((v) => v?.package?.name === 'electron')
        .map((v) => ({ vulnerable: v.vulnerable_version_range, patched: v.patched_versions })),
    }));
}

/**
 * The stable versions an advisory names as the fix for `base`: `base` sits in
 * a vulnerable range and the range's patched version is on `base`'s major.
 */
function advisoryFixesFor(advisory, base) {
  const major = majorOf(base);
  const out = [];
  for (const r of advisory.ranges) {
    if (!satisfiesRange(base, r.vulnerable)) continue;
    for (const p of String(r.patched || '').split(',')) {
      const v = p.trim();
      if (isStableVersion(v) && majorOf(v) === major && compareVersions(v, base) > 0) out.push(v);
    }
  }
  return unique(out);
}

// ---------------------------------------------------------------------------
// Decisions

/**
 * The version comparison every security decision starts from.
 *
 * `pinned` is what `main`'s lockfile resolves (what the next release ships),
 * `shipped` what the latest stable Freedom release carries, when known. A fix
 * already on `main` but not released is still owed to users, so on the same
 * major the older of the two is the base.
 */
function securityBase(pinned, shipped) {
  if (shipped && majorOf(shipped) === majorOf(pinned) && compareVersions(shipped, pinned) < 0) {
    return shipped;
  }
  return pinned;
}

/**
 * Which major's fixes are owed, and from which version.
 *
 * Users run `shipped`. While `main` adopts a newer major, the shipped major's
 * fixes stay owed until a stable release carries the new major, so the track
 * stays there (`crossMajor`): the 8-week adoption window never stands in for a
 * 7-day or 72-hour deadline. Otherwise the track is the pinned major, from
 * `securityBase()`.
 */
function securityTrack(pinned, shipped) {
  if (shipped && majorOf(shipped) < majorOf(pinned)) {
    return { base: shipped, major: majorOf(shipped), crossMajor: true };
  }
  return { base: securityBase(pinned, shipped), major: majorOf(pinned), crossMajor: false };
}

/**
 * Rules 1 and 2, on the major `securityTrack()` picks.
 *
 * @param {object} input
 * @param {string} input.pinned          lockfile version on `main`
 * @param {string|null} input.shipped    Electron in the latest stable release
 * @param {object[]} input.releases      `npmStableReleases()`
 * @param {Map<string, {body: string, url: string}|null>} input.notes  per version; null = no GitHub release
 * @param {Map<string, {chrome: string, node: string, modules: string}>|null} input.electronReleases
 * @param {object[]|null} input.chromePosts  `parseChromeFeed()`; null = not fetched
 * @param {Map<string, object>} input.kev
 * @param {object[]|null} input.advisories   `parseAdvisories()`; null = not fetched
 * @param {number} input.now
 * @returns {null|object} null when no newer release on the major carries a security fix
 */
function decideSecurity(input) {
  const { pinned, shipped = null, releases, notes, now } = input;
  const electronReleases = input.electronReleases || null;
  // Only what was known at `now` counts, so recorded feeds replay faithfully.
  const kev = new Map(
    [...input.kev].filter(([, e]) => !e.dateAdded || Date.parse(`${e.dateAdded}T00:00:00Z`) <= now)
  );
  const chromePosts = input.chromePosts
    ? input.chromePosts.filter((p) => !p.publishedAt || p.publishedAt <= now)
    : null;
  const advisories = input.advisories
    ? input.advisories.filter((a) => !a.publishedAt || a.publishedAt <= now)
    : null;
  const { base, major, crossMajor } = securityTrack(pinned, shipped);
  const latest = latestOnMajor(releases, major);
  if (!latest || compareVersions(latest.version, base) <= 0) return null;

  const candidates = releases.filter(
    (r) =>
      r.major === major &&
      compareVersions(r.version, base) > 0 &&
      compareVersions(r.version, latest.version) <= 0
  );

  // Chrome says "exploited in the wild" in any post we read: a CVE named that
  // way counts wherever an Electron release names it, mapped post or not.
  const chromeExploited = new Map();
  for (const post of chromePosts || []) {
    for (const cve of post.exploited) if (!chromeExploited.has(cve)) chromeExploited.set(cve, post);
  }

  const advisoryFixes = new Map();
  for (const a of advisories || []) {
    for (const v of advisoryFixesFor(a, base)) {
      if (!advisoryFixes.has(v)) advisoryFixes.set(v, []);
      advisoryFixes.get(v).push(a);
    }
  }

  const chromeOf = (version) => {
    const value = electronReleases?.get(version)?.chrome;
    return CHROMIUM_VERSION_RE.test(String(value ?? '')) ? value : null;
  };
  let previousChrome = chromeOf(base);
  const evaluated = candidates.map((release) => {
    const note = notes.get(release.version);
    const parsed = note ? parseReleaseNotes(note.body) : null;
    const notesUrl = note ? safeUrl(note.url) || electronReleaseUrl(release.version) : null;
    const chrome = chromeOf(release.version) ?? parsed?.chromium ?? null;
    const evidence = [];

    // Evidence text renders inert (`mdCode`) unless it is marked `built`:
    // made here from validated versions and counts.
    for (const line of parsed?.lines || []) {
      evidence.push({
        source: 'notes',
        kind: line.kind,
        text: line.text,
        url: safeUrl(line.pull?.url) ?? notesUrl,
      });
    }
    for (const a of advisoryFixes.get(release.version) || []) {
      if (parsed && parsed.advisories.includes(a.id)) continue; // already a notes line
      evidence.push({
        source: 'advisory',
        kind: 'advisory',
        text: `${a.id}${a.cve ? ` (${a.cve})` : ''}: ${a.summary}`,
        url: a.url,
      });
    }

    let chromePostsHit = [];
    if (chromePosts && chrome && previousChrome && chrome !== previousChrome) {
      chromePostsHit = chromePostsForRoll(chromePosts, previousChrome, chrome).filter(
        (p) => p.cves.length > 0
      );
      if (chromePostsHit.length) {
        const count = unique(chromePostsHit.flatMap((p) => p.cves)).length;
        evidence.push({
          source: 'chrome',
          kind: 'chromium',
          built: true,
          text: `Chromium ${previousChrome} to ${chrome}: ${count} CVE${count === 1 ? '' : 's'} in Chrome's release notes`,
          url: chromePostsHit[0].url,
        });
      }
    }
    if (chrome) previousChrome = chrome;

    const cves = unique([
      ...(parsed?.cves || []),
      ...(advisoryFixes.get(release.version) || []).map((a) => a.cve).filter(Boolean),
      ...chromePostsHit.flatMap((p) => p.cves),
    ]).sort(compareCves);
    const inKev = cves.filter((c) => kev.has(c));
    const chromeSaysExploited = cves.filter((c) => chromeExploited.has(c));
    const exploited =
      inKev.length > 0 || chromeSaysExploited.length > 0 || Boolean(parsed?.exploitedInWild);
    const security = evidence.length > 0;
    return {
      version: release.version,
      publishedAt: release.publishedAt,
      notesUrl,
      notesMissing: !note,
      chrome,
      security,
      evidence,
      otherBackports: parsed?.otherBackports || [],
      cves,
      inKev,
      chromeSaysExploited,
      exploitedInWild: Boolean(parsed?.exploitedInWild),
      exploited,
      windowMs: exploited ? EXPLOITED_WINDOW_MS : STANDARD_WINDOW_MS,
      dueAt: security
        ? release.publishedAt + (exploited ? EXPLOITED_WINDOW_MS : STANDARD_WINDOW_MS)
        : null,
    };
  });

  const securityReleases = evaluated.filter((r) => r.security);
  if (!securityReleases.length) return null;
  const governing = securityReleases.reduce((a, b) => (b.dueAt < a.dueAt ? b : a));
  const allCves = unique(securityReleases.flatMap((r) => r.cves)).sort(compareCves);
  const basePublishedAt = releases.find((r) => r.version === base)?.publishedAt ?? null;

  // Exploited Chromium bugs CISA added since the base was published that no
  // release above names. Electron's batch backports carry no CVE ids, so one
  // of these may well be fixed by the target; the issue says so, and what the
  // deadline would be, without claiming it.
  const unmatchedKev = [...kev.values()]
    .filter(
      (e) =>
        isChromiumKevEntry(e) &&
        !allCves.includes(e.cveID) &&
        basePublishedAt !== null &&
        Date.parse(`${e.dateAdded}T23:59:59Z`) >= basePublishedAt
    )
    .sort((a, b) => compareCves(a.cveID, b.cveID));

  const missing = [];
  if (!chromePosts) missing.push('chrome');
  if (!advisories) missing.push('advisories');
  if (!electronReleases) missing.push('electron-releases');

  return {
    key: `security:${latest.version}`,
    target: latest.version,
    targetPublishedAt: latest.publishedAt,
    base,
    pinned,
    shipped,
    major,
    crossMajor,
    pinnedMajor: majorOf(pinned),
    releases: evaluated,
    securityReleases,
    governing,
    dueAt: governing.dueAt,
    exploited: securityReleases.some((r) => r.exploited),
    overdue: now > governing.dueAt,
    cves: allCves,
    inKev: unique(securityReleases.flatMap((r) => r.inKev)).sort(compareCves),
    chromeSaysExploited: unique(securityReleases.flatMap((r) => r.chromeSaysExploited)).sort(
      compareCves
    ),
    unmatchedKev,
    unmatchedKevDueAt: latest.publishedAt + EXPLOITED_WINDOW_MS,
    missing,
  };
}

/**
 * Rule 4: one entry per stable major newer than what Freedom ships (or, when
 * the shipped version is unknown, what `main` pins).
 */
function decideMajors({ pinned, shipped = null, releases, now }) {
  const baseMajor = majorOf(shipped || pinned);
  const pinnedMajor = majorOf(pinned);
  const out = [];
  for (const [major, first] of firstStableByMajor(releases)) {
    if (major <= baseMajor) continue;
    const dueAt = first.publishedAt + MAJOR_ADOPTION_WINDOW_MS;
    out.push({
      key: `major:${major}`,
      major,
      firstVersion: first.version,
      firstPublishedAt: first.publishedAt,
      latest: latestOnMajor(releases, major).version,
      dueAt,
      overdue: now > dueAt,
      onMain: pinnedMajor >= major,
      pinned,
      shipped,
    });
  }
  return out.sort((a, b) => a.major - b.major);
}

/**
 * Rule 3 for the pinned major: past EOL when it is older than the latest three
 * stable majors (or Electron's schedule says its EOL date has passed), nearing
 * EOL when it is the oldest of the three (or its EOL date is within one
 * release cycle).
 *
 * @param {object[]|null} schedule  releases.electronjs.org/schedule.json, optional
 */
function decideEol({ pinned, releases, schedule = null, now }) {
  const major = majorOf(pinned);
  const latestMajor = Math.max(...releases.map((r) => r.major));
  const oldestSupported = latestMajor - (SUPPORTED_MAJORS - 1);
  const entry = (schedule || []).find((e) => majorOf(e.version) === major);
  const eolAt = entry && entry.eolDate ? Date.parse(`${entry.eolDate}T00:00:00Z`) : null;
  const past = major < oldestSupported || (eolAt !== null && eolAt <= now);
  const nearing =
    !past && (major === oldestSupported || (eolAt !== null && eolAt - now <= EOL_WARNING_MS));
  if (!past && !nearing) return null;
  // Without a schedule, the next major (and with it this one's EOL) is due one
  // cadence after the latest one shipped.
  const latestFirst = firstStableByMajor(releases).get(latestMajor);
  const expectedEolAt =
    eolAt ?? (nearing ? latestFirst.publishedAt + MAJOR_ADOPTION_WINDOW_MS : null);
  return {
    key: `eol:${major}`,
    major,
    pinned,
    past,
    nearing,
    eolAt,
    expectedEolAt,
    fromSchedule: eolAt !== null,
    supported: Array.from({ length: SUPPORTED_MAJORS }, (_, i) => latestMajor - i),
  };
}

// ---------------------------------------------------------------------------
// Issue text

function formatTime(ms) {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d{3}Z$/, ' UTC');
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function marker(key) {
  return `<!-- electron-watch:${key} -->`;
}

function electronReleaseUrl(version) {
  return `https://github.com/electron/electron/releases/tag/v${version}`;
}

function cveLink(cve) {
  return CVE_ID_RE.test(String(cve))
    ? `[${cve}](https://www.cve.org/CVERecord?id=${cve})`
    : mdCode(cve);
}

function listCves(cves) {
  if (!cves.length) return 'none named';
  const shown = cves.slice(0, MAX_LISTED_CVES).map(cveLink).join(', ');
  return cves.length > MAX_LISTED_CVES
    ? `${shown} and ${cves.length - MAX_LISTED_CVES} more`
    : shown;
}

/**
 * "Due …" plus "(overdue)" once it is, and nothing finer: the body is
 * rewritten only when what it says changes, so a countdown would edit every
 * open issue every 6 hours.
 */
function dueLine(dueAt, now) {
  return `**Due ${formatTime(dueAt)}**${now > dueAt ? ' (**overdue**)' : ''}.`;
}

/** Text this module built (versions, counts), for one table cell. */
function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** A release's notes link: the GitHub release when the URL is one, else the canonical one. */
function releaseLink(version, url) {
  return `[${version}](${safeUrl(url) || electronReleaseUrl(version)})`;
}

const PLAYBOOK_URL_PATH = 'docs/agent-playbooks/release-process.md#security-release-electron';

/**
 * The security-release issue for `decision.target`.
 *
 * @param {object} decision  `decideSecurity()`
 * @param {object} ctx
 * @param {string} ctx.repo            owner/name
 * @param {number} ctx.now
 * @param {string|null} ctx.shippedTag  e.g. `v0.8.7`
 * @param {object|null} ctx.bump        `{ state: 'pr'|'branch'|'pending', number?, branch? }`
 * @param {object|null} ctx.mainTrack   while `crossMajor`: `{ decision, bump }` for `main`'s own major
 */
function renderSecurityIssue(decision, ctx) {
  const { now } = ctx;
  const d = decision;
  const rule = d.governing.exploited ? '72 hours' : '7 days';
  const title = `Ship Electron ${d.target} (security release), due ${formatDate(d.dueAt)}`;
  const lines = [
    marker(d.key),
    `${dueLine(d.dueAt, now)} Set by Electron ${d.governing.version}: ${rule} from its npm publish (${formatTime(d.governing.publishedAt)})${d.governing.exploited ? ', because it fixes a bug exploited in the wild' : ''}. Every release below has its own deadline, and the earliest one counts.`,
    '',
    `Electron ${d.target} is the newest ${d.major}.x release and carries every fix below. ${describeBase(d, ctx)}`,
    '',
    '| Electron | npm publish | Due | Why it counts |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of d.securityReleases) {
    const why = r.evidence
      .map((e) => mdLink(e.built ? cell(e.text) : mdCode(e.text), e.url))
      .join('<br>');
    const flags = [];
    if (r.inKev.length) flags.push(`in CISA KEV: ${r.inKev.join(', ')}`);
    if (r.chromeSaysExploited.length)
      flags.push(`exploited in the wild per Chrome: ${r.chromeSaysExploited.join(', ')}`);
    if (r.exploitedInWild && !flags.length) flags.push('notes say exploited in the wild');
    lines.push(
      `| ${releaseLink(r.version, r.notesUrl)} | ${formatTime(r.publishedAt)} | ${formatTime(r.dueAt)}${r.exploited ? ' (72 h)' : ''} | ${why}${flags.length ? `<br>**${cell(flags.join('; '))}**` : ''} |`
    );
  }
  const quiet = d.releases.filter((r) => !r.security);
  if (quiet.length) {
    lines.push(
      '',
      `Releases in the range with no security fix found: ${quiet.map((r) => `${releaseLink(r.version, r.notesUrl)}${r.notesMissing ? ' (no release notes on GitHub)' : ''}`).join(', ')}.`
    );
  }
  lines.push(
    '',
    `**CVEs** (${d.cves.length}): ${listCves(d.cves)}.`,
    '',
    `- In CISA KEV: ${d.inKev.length ? d.inKev.map(cveLink).join(', ') : 'none'}.`,
    `- Exploited in the wild per Chrome's release notes: ${d.chromeSaysExploited.length ? d.chromeSaysExploited.map(cveLink).join(', ') : 'none'}.`
  );
  if (d.unmatchedKev.length) {
    const listed = d.unmatchedKev.map(
      (e) =>
        `${cveLink(e.cveID)} (${mdCode(e.product)}, added ${DATE_RE.test(String(e.dateAdded)) ? e.dateAdded : 'on an unreadable date'})`
    );
    lines.push(
      '',
      `> [!WARNING]`,
      `> CISA added these Chromium CVEs to KEV since Electron ${d.base} was published, and no note, advisory or Chrome post above ties them to a release: ${listed.join(', ')}. Electron's batch backports name no CVEs, so check the backport PRs: if ${d.target} fixes one of them, the 72-hour rule applies and the deadline is ${formatTime(Math.min(d.dueAt, d.unmatchedKevDueAt))}.`
    );
  }
  if (d.missing.length) {
    lines.push(
      '',
      `Not checked this run (source unavailable): ${d.missing.map(describeSource).join(', ')}.`
    );
  }
  if (d.crossMajor) {
    lines.push('', crossMajorBumpLine(d, ctx), ...mainTrackLines(ctx));
  } else {
    lines.push('', bumpLine(d.pinned, d.target, ctx.bump, ctx.repo));
  }
  lines.push('', ...securityChecklist(d, ctx), '', footer());
  return { key: d.key, title, body: lines.join('\n'), labels: [LABEL] };
}

function describeBase(d, ctx) {
  const tag = ctx.shippedTag ? `, ${ctx.shippedTag},` : '';
  if (d.crossMajor) {
    return `The latest release${tag} ships ${d.shipped}, and \`main\` has moved on to Electron ${d.pinnedMajor} (${d.pinned}). Until a stable release ships Electron ${d.pinnedMajor}, these ${d.major}.x fixes are owed to everyone running Freedom; the adoption issue for ${d.pinnedMajor} does not replace this deadline.`;
  }
  const parts = [`\`main\` pins ${d.pinned}`];
  if (d.shipped) parts.push(`the latest release${tag} ships ${d.shipped}`);
  else
    parts.push(
      'the Electron in the latest release could not be read, so the deadline counts from `main`'
    );
  return `${parts.join('; ')}.`;
}

function describeSource(name) {
  return (
    {
      chrome: "Chrome's release notes (Chromium rolls and in-the-wild exploits)",
      advisories: "Electron's security advisories",
      'electron-releases': "releases.electronjs.org (each release's Chromium version)",
    }[name] || name
  );
}

function bumpLine(pinned, target, bump, repo) {
  if (compareVersions(pinned, target) >= 0) {
    return `**Bump:** \`main\` already pins ${pinned}; what is left is the release.`;
  }
  switch ((bump || {}).state) {
    case 'pr':
      return `**Bump PR:** #${bump.number}.`;
    case 'branch':
      return `**Bump:** branch [\`${bump.branch}\`](https://github.com/${repo}/tree/${bump.branch}) is ready, but GitHub Actions may not open pull requests in this repository. [Open the pull request](https://github.com/${repo}/compare/main...${bump.branch}?expand=1).`;
    default:
      return '**Bump PR:** being opened by this workflow run.';
  }
}

/**
 * While `main` is on a newer major, there is nothing to bump on `main` for
 * these fixes; one of two releases settles them.
 */
function crossMajorBumpLine(d, ctx) {
  const from = ctx.shippedTag ? `\`${ctx.shippedTag}\`` : 'the last release tag';
  return `**Bump:** none on \`main\`, which is on Electron ${d.pinnedMajor}. Either ship a fast-path release from ${from} with Electron ${d.target} (on the release branch: \`node scripts/electron-watch.js bump --version ${d.target}\`), or ship a release from \`main\` on an Electron ${d.pinnedMajor}.x published to npm after ${d.target} (${formatTime(d.targetPublishedAt)}). Electron releases each security fix on every supported major together, so such a release carries these fixes; this issue closes on that basis, and any later ${d.pinnedMajor}.x fix is tracked from that release on.`;
}

/** `main`'s own major while the shipped one is older: keep the pin current for the release that adopts it. */
function mainTrackLines(ctx) {
  const t = ctx.mainTrack;
  if (!t || !t.decision) return [];
  const m = t.decision;
  return [
    '',
    `**\`main\`'s major:** \`main\` pins ${m.pinned}, and Electron ${m.target} is the newest ${m.major}.x with security fixes since (${m.securityReleases.map((r) => releaseLink(r.version, r.notesUrl)).join(', ')}). A release from \`main\` has to carry it.`,
    bumpLine(m.pinned, m.target, t.bump, ctx.repo),
  ];
}

function securityChecklist(d, ctx) {
  const playbook = `https://github.com/${ctx.repo}/blob/main/${PLAYBOOK_URL_PATH}`;
  const from = ctx.shippedTag ? `\`${ctx.shippedTag}\`` : 'the last release tag';
  const head = d.crossMajor
    ? [
        `- [ ] Release chosen: a fast-path release on ${d.major}.x from ${from}, or a release from \`main\` on an Electron ${d.pinnedMajor}.x published after ${d.target}`,
        `- [ ] Fast path: \`release/<version>\` branched from ${from}, Electron ${d.target} applied with \`node scripts/electron-watch.js bump --version ${d.target}\`, nothing else`,
      ]
    : [
        '- [ ] Bump pull request reviewed and merged into `main` with `ci-ok` green (Electron only: `package.json`, `package-lock.json`, `licenses-audit.json`, `LICENSE_AUDIT.md`, one `changelog.d/` fragment)',
        `- [ ] \`release/<version>\` branched from ${from}, the bump cherry-picked onto it, nothing else`,
      ];
  return [
    `### Checklist ([playbook](${playbook}))`,
    '',
    ...head,
    '- [ ] `<version>-rc.1` set, audit re-stamped, changelog assembled from the fragment, `v<version>-rc.1` tagged',
    '- [ ] Release run green: the four builds and `smoke-mac-arm64`, `smoke-linux-x64`, `smoke-linux-arm64`, `smoke-windows-x64`',
    '- [ ] By hand on one machine: launch, About shows the candidate, an `https://` page renders',
    `- [ ] \`v<version>\` tagged, draft re-checked, published to freedom.baby and GitHub by ${formatTime(d.dueAt)}`,
    d.crossMajor
      ? "- [ ] Release branch merged back into `main`, keeping `main`'s Electron, lockfile and license audit"
      : "- [ ] Release branch merged back into `main`, with the bump's fragment removed there",
  ];
}

function footer() {
  return '<sub>Kept up to date by `.github/workflows/electron-watch.yml` every 6 hours; edits to this text are overwritten, so comment instead. Closed automatically once a stable release ships it or a newer one supersedes it.</sub>';
}

function renderMajorIssue(m, ctx) {
  const { now } = ctx;
  const title = `Adopt Electron ${m.major}, due ${formatDate(m.dueAt)}`;
  const track = ctx.mainTrack && ctx.mainTrack.decision;
  const lines = [
    marker(m.key),
    `${dueLine(m.dueAt, now)} Rule: adopt each new Electron major within 8 weeks of its first stable release; Electron ${m.firstVersion} was published to npm ${formatTime(m.firstPublishedAt)}.`,
    '',
    `Freedom ${m.shipped ? `ships Electron ${m.shipped}` : 'ships an Electron that could not be read'}; \`main\` pins ${m.pinned}. The newest ${m.major}.x release is [${m.latest}](${electronReleaseUrl(m.latest)}).${m.onMain ? ` \`main\` is on ${m.major}.x already; what is left is the release.` : ''}`,
    ...(track && ctx.mainTrackInMajor && track.major === m.major ? mainTrackLines(ctx) : []),
    '',
    'A major is not an automatic bump. `docs/agent-playbooks/release-process.md` §2 lists the checks: the breaking-changes grep, the native-module rebuild (`npm ci` against the new headers) and the build pipeline, then a release of its own.',
    '',
    `- [Electron ${m.major} release notes](${electronReleaseUrl(m.firstVersion)})`,
    `- [Breaking changes](https://github.com/electron/electron/blob/main/docs/breaking-changes.md)`,
    `- [Electron's release schedule](https://releases.electronjs.org/schedule)`,
    '',
    footer(),
  ];
  return { key: m.key, title, body: lines.join('\n'), labels: [LABEL] };
}

function renderEolIssue(e) {
  const when = e.eolAt ?? e.expectedEolAt;
  const title = e.past
    ? `Electron ${e.major} is past end of life`
    : `Electron ${e.major} reaches end of life${when ? ` on ${formatDate(when)}` : ' with the next major'}`;
  const lines = [
    marker(e.key),
    e.past
      ? `**Electron ${e.major} is no longer supported.** Rule: never ship an end-of-life Electron major. \`main\` pins ${e.pinned}.`
      : `**Electron ${e.major} is the oldest supported major.** It goes out of support when the next major ships${when ? `: ${e.fromSchedule ? '' : 'expected around '}${formatDate(when)}` : ''}. Rule: never ship an end-of-life Electron major. \`main\` pins ${e.pinned}.`,
    '',
    `Electron supports the latest ${SUPPORTED_MAJORS} stable majors: ${e.supported.join(', ')}.${e.fromSchedule ? ` [Electron's schedule](https://releases.electronjs.org/schedule) gives ${formatDate(e.eolAt)} as the end of life of ${e.major}.` : ''} Once it is past, Electron publishes no security fixes for ${e.major}, and the next Freedom release must be on a supported major.`,
    '',
    footer(),
  ];
  return { key: e.key, title, body: lines.join('\n'), labels: [LABEL] };
}

// ---------------------------------------------------------------------------
// Issue sync plan

/** The marker's key, when its value is well formed (a version, or a major number). */
function issueKey(issue) {
  const m = MARKER_RE.exec(issue?.body || '');
  if (!m) return null;
  const [kind, value] = m[1].split(':');
  if (kind === 'security') return isStableVersion(value) ? m[1] : null;
  return /^\d+$/.test(value) ? m[1] : null;
}

function normalizeBody(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * What to do with GitHub issues: one per key, created once, updated in place,
 * never duplicated. A closed issue for a key is left closed (a person closed
 * it, or it was resolved); no new one is opened for that key.
 *
 * @param {object} input
 * @param {{key: string, title: string, body: string, labels: string[]}[]} input.desired
 * @param {{number: number, title: string, body: string, state: string}[]} input.existing
 * @param {string|null} input.shipped
 * @param {string|null} input.shippedTag
 * @param {string} input.pinned
 * @param {Map<string, number>} [input.published]  npm publish time per version
 * @returns {{type: string, key: string, number?: number, title?: string, body?: string, labels?: string[], comment?: string, supersededBy?: string}[]}
 */
function planIssues({
  desired,
  existing,
  shipped = null,
  shippedTag = null,
  pinned,
  published = new Map(),
}) {
  const byKey = new Map();
  for (const issue of existing) {
    const key = issueKey(issue);
    if (!key) continue;
    const prev = byKey.get(key);
    // Prefer the open one, then the oldest: a duplicate from an earlier bug
    // or a person is never the one we keep writing to.
    if (
      !prev ||
      (prev.state !== 'open' && issue.state === 'open') ||
      (prev.state === issue.state && issue.number < prev.number)
    ) {
      byKey.set(key, issue);
    }
  }

  const actions = [];
  const desiredKeys = new Set(desired.map((d) => d.key));
  for (const want of desired) {
    const have = byKey.get(want.key);
    if (!have) {
      actions.push({
        type: 'create',
        key: want.key,
        title: want.title,
        body: want.body,
        labels: want.labels,
      });
    } else if (have.state !== 'open') {
      actions.push({ type: 'skip-closed', key: want.key, number: have.number });
    } else if (have.title !== want.title || normalizeBody(have.body) !== normalizeBody(want.body)) {
      actions.push({
        type: 'update',
        key: want.key,
        number: have.number,
        title: want.title,
        body: want.body,
      });
    } else {
      actions.push({ type: 'unchanged', key: want.key, number: have.number });
    }
  }

  const desiredTargets = desired
    .filter((d) => d.key.startsWith('security:'))
    .map((d) => d.key.slice('security:'.length));
  const newestOn = (major) =>
    desiredTargets
      .filter((v) => majorOf(v) === major)
      .sort(compareVersions)
      .pop();
  const shippedNote = shippedTag
    ? `${shippedTag} ships Electron ${shipped}`
    : `the latest release ships Electron ${shipped}`;
  for (const [key, have] of byKey) {
    if (have.state !== 'open' || desiredKeys.has(key)) continue;
    const [kind, value] = key.split(':');
    if (kind === 'security') {
      const major = majorOf(value);
      const newer = newestOn(major);
      const shippedMajor = shipped ? majorOf(shipped) : null;
      if (newer && compareVersions(newer, value) > 0) {
        actions.push({
          type: 'close',
          key,
          number: have.number,
          supersededBy: `security:${newer}`,
          comment: `Superseded by the issue for Electron ${newer}, which carries this deadline forward.`,
        });
      } else if (shippedMajor === major && compareVersions(shipped, value) >= 0) {
        actions.push({
          type: 'close',
          key,
          number: have.number,
          comment: `Shipped: ${shippedNote}.`,
        });
      } else if (shippedMajor !== null && shippedMajor > major) {
        // A release moved to a newer major. Its fixes are carried by a
        // release of that major published after this target (Electron
        // releases each security fix on every supported major together);
        // anything later is a security release of the new major, tracked by
        // its own issue.
        const next = newestOn(shippedMajor);
        const shippedAt = published.get(shipped);
        const targetAt = published.get(value);
        if (next) {
          actions.push({
            type: 'close',
            key,
            number: have.number,
            supersededBy: `security:${next}`,
            comment: `Superseded by the issue for Electron ${next}: ${shippedNote}, and its ${shippedMajor}.x security releases carry this deadline forward.`,
          });
        } else if (shippedAt && targetAt && shippedAt >= targetAt) {
          actions.push({
            type: 'close',
            key,
            number: have.number,
            comment: `Shipped through the newer major: ${shippedNote}, published to npm ${formatTime(shippedAt)}, after Electron ${value} (${formatTime(targetAt)}). Electron releases each security fix on every supported major together, so it carries these fixes.`,
          });
        }
      }
    } else if (kind === 'major') {
      const base = shipped || pinned;
      if (majorOf(base) >= Number(value)) {
        actions.push({
          type: 'close',
          key,
          number: have.number,
          comment: shipped
            ? `Adopted: ${shippedNote}.`
            : `Adopted: \`main\` pins Electron ${pinned}.`,
        });
      }
    } else if (kind === 'eol') {
      actions.push({
        type: 'close',
        key,
        number: have.number,
        comment: `\`main\` pins Electron ${pinned}, which is not near end of life.`,
      });
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// The bump: the files an Electron bump touches besides package.json and the lockfile

/** `licenses-audit.json` records the lockfile-resolved Electron (`licenses-audit.test.js`). */
function updateLicenseAuditJson(text, version) {
  const re = /("name":\s*"electron",\s*\n\s*"version":\s*")([^"]+)(")/g;
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1)
    throw new Error(`licenses-audit.json: expected one electron entry, found ${hits.length}`);
  return text.replace(re, `$1${version}$3`);
}

/** `LICENSE_AUDIT.md`'s Electron Framework section names the same version. */
function updateLicenseAuditMarkdown(text, version) {
  const re =
    /(## Electron Framework\s*\n\s*\n- \*\*Version:\*\* )(\d+\.\d+\.\d+)( \(lockfile-resolved\))/g;
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1)
    throw new Error(`LICENSE_AUDIT.md: expected one Electron version line, found ${hits.length}`);
  return text.replace(re, `$1${version}$3`);
}

/**
 * The parenthetical on the changelog line, in `changelog-process.md`'s form:
 * `Chromium 152.0.7977.130 and Node 24.21.0, unchanged`, or the moves. Every
 * value must be in its exact numeric format: this text is committed by the
 * one job that can push.
 */
function chromiumNodeDetail(from, to) {
  const ok = (e) =>
    e &&
    CHROMIUM_VERSION_RE.test(String(e.chrome ?? '')) &&
    NODE_VERSION_RE.test(String(e.node ?? ''));
  if (!ok(from) || !ok(to)) return null;
  const chrome = from.chrome === to.chrome;
  const node = from.node === to.node;
  if (chrome && node) return `Chromium ${to.chrome} and Node ${to.node}, unchanged`;
  const c = chrome ? `Chromium ${to.chrome} unchanged` : `Chromium ${from.chrome} to ${to.chrome}`;
  const n = node ? `Node ${to.node} unchanged` : `Node ${from.node} to ${to.node}`;
  return `${c}, ${n}`;
}

/** The only shapes `chromiumNodeDetail()` produces; anything else is dropped, not written. */
const DETAIL_RE =
  /^Chromium \d+(?:\.\d+){3}(?: to \d+(?:\.\d+){3}| unchanged)?(?:, | and )Node \d+(?:\.\d+){2}(?: to \d+(?:\.\d+){2}| unchanged)?(?:, unchanged)?$/;

function safeDetail(detail) {
  return typeof detail === 'string' && DETAIL_RE.test(detail) ? detail : null;
}

const FRAGMENT_LINE_RE =
  /^(\s*- Electron )(\d+\.\d+\.\d+)( to )(\d+\.\d+\.\d+)(?: \(([^)]*)\))?[ \t]*$/m;

/**
 * The changelog fragment for the bump. An unreleased Electron line already in
 * `changelog.d/` keeps its starting version and moves its target (and is
 * renamed if its file name carries the old target), the way the 44.5.1 to
 * 44.6.0 to 44.7.0 bumps did; otherwise a new fragment is written, starting
 * from `pinned`.
 *
 * The parenthetical's Chromium/Node half is regenerated by `detailFor(from)`
 * (null when unknown, and then dropped rather than left stale); any prose a
 * person added after a `;` is kept.
 *
 * @param {{name: string, text: string}[]} fragments  `changelog.d/*.md`
 * @param {{pinned: string, to: string, detailFor: (from: string) => string|null}} bump
 * @returns {{write: {name: string, text: string}, remove: string|null, from: string}}
 */
function planChangelogFragment(fragments, { pinned, to, detailFor }) {
  for (const f of fragments) {
    const m = FRAGMENT_LINE_RE.exec(f.text);
    if (!m) continue;
    const old = m[5] || '';
    const split = old.indexOf(';');
    const head = split === -1 ? old : old.slice(0, split);
    const prose = /^Chromium /.test(head.trim())
      ? split === -1
        ? ''
        : old.slice(split + 1).trim()
      : old.trim();
    const parts = [safeDetail(detailFor(m[2])), prose].filter(Boolean);
    const line = `${m[1]}${m[2]}${m[3]}${to}${parts.length ? ` (${parts.join('; ')})` : ''}`;
    const text = f.text.replace(FRAGMENT_LINE_RE, line);
    const renamed = f.name.replace(/(electron-)(\d+\.\d+\.\d+)(\.md)$/, `$1${to}$3`);
    return {
      write: { name: renamed, text },
      remove: renamed !== f.name ? f.name : null,
      from: m[2],
    };
  }
  const detail = safeDetail(detailFor(pinned));
  const line = `  - Electron ${pinned} to ${to}${detail ? ` (${detail})` : ''}`;
  return {
    write: {
      name: `security--deps-electron-${to}.md`,
      text: `- Updated runtime dependencies:\n${line}\n`,
    },
    remove: null,
    from: pinned,
  };
}

function bumpBranch(version) {
  return `${BRANCH_PREFIX}${version}`;
}

// ---------------------------------------------------------------------------

function unique(list) {
  return [...new Set(list)];
}

function compareCves(a, b) {
  const [, ya, na] = a.split('-');
  const [, yb, nb] = b.split('-');
  return Number(ya) - Number(yb) || Number(na) - Number(nb);
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  STANDARD_WINDOW_MS,
  EXPLOITED_WINDOW_MS,
  MAJOR_ADOPTION_WINDOW_MS,
  SUPPORTED_MAJORS,
  EOL_WARNING_MS,
  LABEL,
  BRANCH_PREFIX,
  safeUrl,
  mdCode,
  sanitizeElectronRelease,
  parseVersion,
  isStableVersion,
  majorOf,
  compareVersions,
  satisfiesRange,
  parseChromiumVersion,
  npmStableReleases,
  latestOnMajor,
  firstStableByMajor,
  classifyNoteLine,
  parseReleaseNotes,
  htmlToText,
  chromiumVersionsIn,
  parseChromePost,
  parseChromeFeed,
  chromePostsForRoll,
  parseKev,
  isChromiumKevEntry,
  parseAdvisories,
  advisoryFixesFor,
  securityBase,
  securityTrack,
  decideSecurity,
  decideMajors,
  decideEol,
  formatTime,
  formatDate,
  renderSecurityIssue,
  renderMajorIssue,
  renderEolIssue,
  issueKey,
  planIssues,
  updateLicenseAuditJson,
  updateLicenseAuditMarkdown,
  chromiumNodeDetail,
  planChangelogFragment,
  bumpBranch,
};
