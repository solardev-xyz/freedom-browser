// The security-release decision for Electron, replayed against recorded
// upstream data: npm's `electron` packument, Electron's GitHub release notes
// and advisories, releases.electronjs.org, Chrome's release blog and CISA KEV
// (scripts/fixtures/electron-watch/, trimmed excerpts of the real feeds as of
// 2026-10-23). No network. `now` is set per case, and every input published
// after it is ignored, so one recording covers several points in time.

const fs = require('fs');
const path = require('path');

const W = require('./electron-watch');

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'electron-watch');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
const repoRoot = path.join(__dirname, '..', '..');

const NPM = fixture('npm-electron.json');
const NOTES = new Map(
  fixture('github-releases.json').map((r) => [
    r.tag_name.slice(1),
    { body: r.body, url: r.html_url },
  ])
);
const KEV = W.parseKev(fixture('kev.json'));
const ADVISORIES = W.parseAdvisories(fixture('electron-advisories.json'));
const CHROME = W.parseChromeFeed(fixture('chrome-releases-feed.json'));
const ELECTRON_RELEASES = new Map(fixture('electron-releases.json').map((e) => [e.version, e]));
const SCHEDULE = fixture('electron-schedule.json');

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
/** What a reader sees of an issue body's inert upstream text: entities decoded, `<code>` dropped. */
const rendered = (body) =>
  body.replace(/<\/?code>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function decide(pinned, now, extra = {}) {
  const t = at(now);
  return W.decideSecurity({
    pinned,
    shipped: null,
    releases: W.npmStableReleases(NPM, t),
    notes: NOTES,
    kev: KEV,
    advisories: ADVISORIES,
    electronReleases: ELECTRON_RELEASES,
    chromePosts: CHROME,
    now: t,
    ...extra,
  });
}

const noteLines = (version) => NOTES.get(version).body.split('\n');

describe('versions', () => {
  test('orders releases and pre-releases by semver precedence', () => {
    const sorted = [
      '44.9.3',
      '44.0.0',
      '44.0.0-beta.5',
      '44.0.0-alpha.1',
      '44.10.0',
      '44.9.10',
    ].sort(W.compareVersions);
    expect(sorted).toEqual([
      '44.0.0-alpha.1',
      '44.0.0-beta.5',
      '44.0.0',
      '44.9.3',
      '44.9.10',
      '44.10.0',
    ]);
  });

  test('reads GitHub advisory ranges', () => {
    expect(W.satisfiesRange('44.7.0', '>= 44.0.0-alpha.1, < 44.9.1')).toBe(true);
    expect(W.satisfiesRange('44.9.1', '>= 44.0.0-alpha.1, < 44.9.1')).toBe(false);
    expect(W.satisfiesRange('42.11.15', '< 42.11.16')).toBe(true);
    expect(W.satisfiesRange('43.0.0', '>= 44.0.0-alpha.1, < 44.9.1')).toBe(false);
    expect(W.satisfiesRange('44.0.0', '')).toBe(false);
  });

  test('npm releases are stable only and published by `now`', () => {
    const releases = W.npmStableReleases(NPM, at('2026-10-21T06:00:00Z'));
    const versions = releases.map((r) => r.version);
    expect(versions).toContain('44.9.3');
    expect(versions).not.toContain('45.0.0'); // published 06:03:52 that day
    expect(versions.some((v) => v.includes('-'))).toBe(false);
    expect(W.latestOnMajor(releases, 44).version).toBe('44.9.3');
  });
});

describe('Electron release notes', () => {
  test.each([
    // The current automation (2026-06 onwards): no CVE ids, one line per batch.
    ['44.7.2', 'Backported fixes from upstream ANGLE, Chromium, PDFium and V8.', 'backport'],
    // Electron's own advisory, as a callout.
    [
      '44.9.1',
      'This release contains the fix for https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9',
      'advisory',
    ],
    // The 2022-2025 form, the only one that names CVEs.
    ['35.1.2', 'Security: backported fix for CVE-2025-2783.', 'security'],
  ])('%s: "%s" is a security line', (version, start, kind) => {
    const line = noteLines(version).find((l) => l.includes(start.slice(0, 40)));
    expect(line).toBeDefined();
    expect(W.classifyNoteLine(line)).toBe(kind);
  });

  test.each([
    [
      '* Backported fix for 483569511. [#49788](https://github.com/electron/electron/pull/49788)',
      'backport',
    ],
    [
      '* Backported fix for [chromium:74266014](https://issues.chromium.org/issues/474266014). [#50175](https://github.com/electron/electron/pull/50175) ',
      'backport',
    ],
    [
      '* Security: backported 20 High-severity fixes from Chrome 148 stable release. [#51618](https://github.com/electron/electron/pull/51618) ',
      'security',
    ],
    [
      '* Backported fixes for several use-after-free and object-lifetime issues in input, UI, Aura, HID and file-system teardown paths, and a runtime-effect validation gap in Skia. [#51648](https://github.com/electron/electron/pull/51648) ',
      'backport',
    ],
    // Bug-fix backports, also verbatim from Electron's notes: not security.
    [
      '* Backported fix for AVX related crashes on certain linux machines. [#36186](https://github.com/electron/electron/pull/36186) ',
      null,
    ],
    [
      '* Fixed a crash when a WebAuthn request used a security key that required its PIN. [#54563](https://github.com/electron/electron/pull/54563)',
      null,
    ],
    [
      '* Updated Chromium to 152.0.7977.149. [#54085](https://github.com/electron/electron/pull/54085)',
      null,
    ],
  ])('historical phrasing %#', (line, kind) => {
    expect(W.classifyNoteLine(line)).toBe(kind);
  });

  test('a feature-and-fix release has no security line', () => {
    const parsed = W.parseReleaseNotes(NOTES.get('44.9.0').body);
    expect(parsed.lines).toEqual([]);
    expect(parsed.cves).toEqual([]);
    expect(parsed.chromium).toBeNull();
  });

  test('picks up the Chromium roll and the backport line', () => {
    const parsed = W.parseReleaseNotes(NOTES.get('44.8.0').body);
    expect(parsed.chromium).toBe('152.0.7977.167');
    expect(parsed.lines.map((l) => l.kind)).toEqual(['backport']);
    expect(parsed.lines[0].pull).toEqual({
      number: 55034,
      url: 'https://github.com/electron/electron/pull/55034',
    });
  });

  test('an empty release body is not an error', () => {
    expect(W.parseReleaseNotes(NOTES.get('44.9.2').body).lines).toEqual([]);
  });
});

describe("Chrome's release blog", () => {
  const byVersion = (v) => CHROME.find((p) => p.versions.includes(v));

  test('reads builds, CVEs and the in-the-wild sentence', () => {
    const post = byVersion('152.0.7977.82');
    expect(post.versions).toEqual(['152.0.7977.82', '152.0.7977.83']);
    expect(post.securityFixes).toBe(12);
    expect(post.cves).toHaveLength(12);
    expect(post.exploited).toEqual(['CVE-2026-85046']);
    expect(post.url).toMatch(/^https:\/\/chromereleases\.googleblog\.com\/2026\/09\//);
  });

  test('an Extended Stable build without security fixes lists none', () => {
    expect(byVersion('152.0.7977.149')).toMatchObject({
      cves: [],
      exploited: [],
      securityFixes: null,
    });
    expect(byVersion('152.0.7977.167').cves).toHaveLength(28);
  });

  test('expands the slash shorthand for Windows/Mac builds', () => {
    expect(W.chromiumVersionsIn('updated to 146.0.7680.177/178 for Windows/Mac')).toEqual([
      '146.0.7680.177',
      '146.0.7680.178',
    ]);
    expect(
      W.chromiumVersionsIn('Chrome 156.0.8078.47 (Linux) 156.0.8078.47/.48 Windows/Mac')
    ).toEqual(['156.0.8078.47', '156.0.8078.48']);
  });

  test('a Chromium roll maps to the posts on its branch, in (from, to]', () => {
    const posts = W.chromePostsForRoll(CHROME, '152.0.7977.78', '152.0.7977.130');
    expect(posts.map((p) => p.versions[0])).toEqual(['152.0.7977.82', '152.0.7977.130']);
    // Chrome 153 shipped in the same window, on another branch.
    expect(
      W.chromePostsForRoll(CHROME, '152.0.7977.130', '152.0.7977.167').map((p) => p.versions[0])
    ).toEqual(['152.0.7977.149', '152.0.7977.167']);
    expect(W.chromePostsForRoll(CHROME, '152.0.7977.130', '152.0.7977.130')).toEqual([]);
  });

  test('decodes entities and drops markup', () => {
    expect(W.htmlToText('<p>A&nbsp;fix&#39;s <b>CVE</b>&amp;co</p>')).toBe("A fix's CVE &co");
  });
});

describe('CISA KEV and Electron advisories', () => {
  test('KEV indexes by CVE and recognises Chromium entries', () => {
    expect(KEV.get('CVE-2025-2783').product).toBe('Chromium Mojo');
    expect(W.isChromiumKevEntry(KEV.get('CVE-2026-85046'))).toBe(true);
    expect(W.isChromiumKevEntry(KEV.get('CVE-2026-106931'))).toBe(false);
    expect(() => W.parseKev({ title: 'not the feed' })).toThrow(/vulnerabilities/);
  });

  test('an advisory names the patched version on the pinned major', () => {
    const mudhra = ADVISORIES.find((a) => a.id === 'GHSA-jr5w-w6x2-84p9');
    expect(W.advisoryFixesFor(mudhra, '44.7.0')).toEqual(['44.9.1']);
    expect(W.advisoryFixesFor(mudhra, '44.9.1')).toEqual([]);
    expect(W.advisoryFixesFor(mudhra, '43.7.0')).toEqual(['43.8.1']);
    const samesite = ADVISORIES.find((a) => a.id === 'GHSA-2p8c-gr87-2676');
    expect(samesite.cve).toBe('CVE-2026-113796');
    expect(W.advisoryFixesFor(samesite, '44.2.0')).toEqual(['44.3.0']);
    expect(W.advisoryFixesFor(samesite, '44.7.0')).toEqual([]);
  });
});

describe('rules 1 and 2: the security deadline', () => {
  test('a security patch whose CVE is in CISA KEV is due 72 hours after its npm publish', () => {
    // 35.1.2: "Security: backported fix for CVE-2025-2783", the Mojo sandbox
    // escape CISA added to KEV the same day.
    const d = decide('35.1.1', '2025-03-28T00:00:00Z');
    expect(d.target).toBe('35.1.2');
    expect(d.securityReleases.map((r) => r.version)).toEqual(['35.1.2']);
    expect(d.inKev).toEqual(['CVE-2025-2783']);
    expect(d.exploited).toBe(true);
    expect(iso(d.governing.publishedAt)).toBe('2025-03-27T14:25:42.304Z');
    expect(iso(d.dueAt)).toBe('2025-03-30T14:25:42.304Z');
    expect(d.dueAt - d.governing.publishedAt).toBe(W.EXPLOITED_WINDOW_MS);
    expect(d.unmatchedKev).toEqual([]); // KEV entries from 2026 did not exist yet
  });

  test('a Chromium roll past a build Chrome says is exploited in the wild is due in 72 hours', () => {
    // 44.4.2 rolls Chromium 152.0.7977.78 to .130. Chrome's 152.0.7977.82
    // post fixes CVE-2026-85046 and says it is exploited; CISA lists it too.
    const d = decide('44.4.1', '2026-09-18T12:00:00Z');
    expect(d.target).toBe('44.4.2');
    const r = d.securityReleases[0];
    expect(r.evidence.map((e) => e.kind)).toEqual(['backport', 'chromium']);
    expect(r.cves).toContain('CVE-2026-85046');
    expect(r.inKev).toEqual(['CVE-2026-85046']);
    expect(r.chromeSaysExploited).toEqual(['CVE-2026-85046']);
    expect(iso(d.dueAt)).toBe('2026-09-21T01:13:51.876Z');
  });

  test('the 72-hour deadline of a later release can govern over an earlier 7-day one', () => {
    const d = decide('44.3.0', '2026-09-18T12:00:00Z');
    expect(d.securityReleases.map((r) => [r.version, r.exploited])).toEqual([
      ['44.4.0', false],
      ['44.4.2', true],
    ]);
    expect(d.governing.version).toBe('44.4.2');
    expect(iso(d.dueAt)).toBe('2026-09-21T01:13:51.876Z');
    expect(d.releases.find((r) => r.version === '44.4.1').security).toBe(false);
    // Chrome 153's exploited V8 bug, added to KEV after 44.3.0 shipped and
    // named by no Electron 44 note: reported, not assumed.
    expect(d.unmatchedKev.map((e) => e.cveID)).toEqual(['CVE-2026-87491']);
  });

  test('a security patch with no exploited CVE is due 7 days after its npm publish', () => {
    // 44.7.1 only rolls Chromium to .149, whose Chrome post lists no security
    // fixes; 44.7.2 carries "Backported fixes from upstream ANGLE, Chromium,
    // PDFium and V8".
    const d = decide('44.7.0', '2026-10-14T12:00:00Z');
    expect(d.target).toBe('44.7.2');
    expect(d.securityReleases.map((r) => r.version)).toEqual(['44.7.2']);
    expect(d.releases.find((r) => r.version === '44.7.1')).toMatchObject({
      security: false,
      chrome: '152.0.7977.149',
    });
    expect(d.exploited).toBe(false);
    expect(iso(d.dueAt)).toBe('2026-10-21T01:32:13.902Z');
    expect(d.dueAt - d.governing.publishedAt).toBe(W.STANDARD_WINDOW_MS);
    expect(d.overdue).toBe(false);
  });

  test('a non-security patch opens nothing', () => {
    // 44.9.0: two features and two fixes, no backports, no advisory.
    expect(decide('44.8.0', '2026-10-17T12:00:00Z')).toBeNull();
    // Nothing newer at all.
    expect(decide('44.9.3', '2026-10-23T12:00:00Z')).toBeNull();
  });

  test('the state on 2026-10-23: 44.7.0 is pinned and 44.9.3 is overdue', () => {
    const d = decide('44.7.0', '2026-10-23T12:00:00Z');
    expect(d.key).toBe('security:44.9.3');
    expect(d.securityReleases.map((r) => r.version)).toEqual([
      '44.7.2',
      '44.8.0',
      '44.9.1',
      '44.9.3',
    ]);
    expect(d.releases.filter((r) => !r.security).map((r) => r.version)).toEqual([
      '44.7.1',
      '44.9.0',
      '44.9.2',
    ]);
    // The GHSA callout in the notes and the advisory API are one fix.
    expect(d.securityReleases.find((r) => r.version === '44.9.1').evidence).toHaveLength(1);
    expect(d.securityReleases.find((r) => r.version === '44.8.0').cves).toHaveLength(28);
    expect(d.governing.version).toBe('44.7.2');
    expect(d.overdue).toBe(true);
    expect(d.missing).toEqual([]);
  });

  test('a fix on main but not in the latest release still counts from the release', () => {
    const d = decide('44.9.3', '2026-10-23T12:00:00Z', { shipped: '44.7.0' });
    expect(d.base).toBe('44.7.0');
    expect(d.target).toBe('44.9.3');
    expect(d.governing.version).toBe('44.7.2');
  });

  test('a missing optional source is named, and the notes still decide', () => {
    const d = decide('44.7.0', '2026-10-23T12:00:00Z', { chromePosts: null, advisories: null });
    expect(d.missing).toEqual(['chrome', 'advisories']);
    expect(d.securityReleases.find((r) => r.version === '44.8.0').cves).toEqual([]);
    expect(d.governing.version).toBe('44.7.2');
  });
});

describe('rule 3: end of life', () => {
  const releases = W.npmStableReleases(NPM, at('2026-10-23T12:00:00Z'));
  const now = at('2026-10-23T12:00:00Z');

  test('a major older than the latest three is past end of life', () => {
    const e = W.decideEol({ pinned: '42.11.18', releases, schedule: SCHEDULE, now });
    expect(e).toMatchObject({ key: 'eol:42', past: true, supported: [45, 44, 43] });
    expect(iso(e.eolAt)).toBe('2026-10-20T00:00:00.000Z');
    expect(W.decideEol({ pinned: '42.11.18', releases, schedule: null, now }).past).toBe(true);
  });

  test('the oldest of the three is nearing end of life', () => {
    const e = W.decideEol({ pinned: '43.8.3', releases, schedule: SCHEDULE, now });
    expect(e).toMatchObject({ past: false, nearing: true, fromSchedule: true });
    expect(iso(e.eolAt)).toBe('2027-01-05T00:00:00.000Z');
    // Without the schedule: one cadence after 45.0.0.
    const guess = W.decideEol({ pinned: '43.8.3', releases, schedule: null, now });
    expect(guess).toMatchObject({ nearing: true, fromSchedule: false });
    expect(iso(guess.expectedEolAt)).toBe('2026-12-16T06:03:52.729Z');
  });

  test('a supported major is not flagged until its end of life is a cycle away', () => {
    expect(W.decideEol({ pinned: '44.7.0', releases, schedule: SCHEDULE, now })).toBeNull();
    const later = at('2027-01-10T00:00:00Z');
    const e = W.decideEol({
      pinned: '44.9.3',
      releases: W.npmStableReleases(NPM, later),
      schedule: SCHEDULE,
      now: later,
    });
    expect(e).toMatchObject({ nearing: true, past: false });
    expect(iso(e.eolAt)).toBe('2027-03-02T00:00:00.000Z');
  });
});

describe('rule 4: adopt each new major within 8 weeks', () => {
  test('a new major is due 8 weeks after its first stable npm publish', () => {
    const now = at('2026-10-23T12:00:00Z');
    const releases = W.npmStableReleases(NPM, now);
    const [m] = W.decideMajors({ pinned: '44.7.0', shipped: '44.7.0', releases, now });
    expect(m).toMatchObject({
      key: 'major:45',
      firstVersion: '45.0.0',
      overdue: false,
      onMain: false,
    });
    expect(iso(m.dueAt)).toBe('2026-12-16T06:03:52.729Z');
    expect(m.dueAt - m.firstPublishedAt).toBe(W.MAJOR_ADOPTION_WINDOW_MS);
  });

  test('older than 8 weeks and not adopted is overdue', () => {
    const now = at('2026-12-20T00:00:00Z');
    const [m] = W.decideMajors({
      pinned: '44.9.3',
      shipped: '44.9.3',
      releases: W.npmStableReleases(NPM, now),
      now,
    });
    expect(m.overdue).toBe(true);
  });

  test('a major on main but not released is still open; a shipped one is done', () => {
    const now = at('2026-10-23T12:00:00Z');
    const releases = W.npmStableReleases(NPM, now);
    expect(W.decideMajors({ pinned: '45.0.0', shipped: '44.7.0', releases, now })[0].onMain).toBe(
      true
    );
    expect(W.decideMajors({ pinned: '45.0.0', shipped: '45.0.0', releases, now })).toEqual([]);
    expect(
      W.decideMajors({
        pinned: '44.7.0',
        shipped: null,
        releases: W.npmStableReleases(NPM, at('2026-10-20T00:00:00Z')),
        now,
      })
    ).toEqual([]);
  });
});

describe('issue text', () => {
  const now = at('2026-10-23T12:00:00Z');
  const ctx = {
    repo: 'solardev-xyz/freedom-browser',
    now,
    shippedTag: 'v0.8.7',
    bump: { state: 'pr', number: 900 },
  };

  test('the security issue carries the deadline, the evidence, the CVEs and the checklist', () => {
    const d = decide('44.7.0', '2026-10-23T12:00:00Z', { shipped: '44.7.0' });
    const issue = W.renderSecurityIssue(d, ctx);
    expect(issue.title).toBe('Ship Electron 44.9.3 (security release), due 2026-10-21');
    expect(issue.labels).toEqual(['security-release']);
    expect(issue.body.split('\n')[0]).toBe('<!-- electron-watch:security:44.9.3 -->');
    expect(issue.body).toContain(
      '**Due 2026-10-21 01:32 UTC** (**overdue**). Set by Electron 44.7.2: 7 days'
    );
    expect(issue.body).toContain(
      '[44.7.2](https://github.com/electron/electron/releases/tag/v44.7.2)'
    );
    expect(rendered(issue.body)).toContain('GHSA-jr5w-w6x2-84p9');
    expect(issue.body).toContain('**CVEs** (28)');
    expect(issue.body).toContain('**Bump PR:** #900.');
    expect(issue.body).toContain('branched from `v0.8.7`');
    expect(issue.body).toContain('release-process.md#security-release-electron');
    expect(issue.body.length).toBeLessThan(65536);
    expect(W.issueKey(issue)).toBe('security:44.9.3');
  });

  test('a KEV hit and an unmatched KEV entry are spelled out', () => {
    const d = decide('44.3.0', '2026-09-18T12:00:00Z');
    const body = W.renderSecurityIssue(d, {
      ...ctx,
      now: at('2026-09-18T12:00:00Z'),
      bump: { state: 'pending' },
    }).body;
    expect(body).toContain('Set by Electron 44.4.2: 72 hours from its npm publish');
    expect(body).toContain('in CISA KEV: CVE-2026-85046');
    expect(body).toContain('[!WARNING]');
    expect(body).toContain('CVE-2026-87491');
    expect(body).toContain('being opened by this workflow run');
  });

  test('a branch GitHub Actions could not open a pull request for gets a compare link', () => {
    const d = decide('44.7.0', '2026-10-23T12:00:00Z');
    const body = W.renderSecurityIssue(d, {
      ...ctx,
      bump: { state: 'branch', branch: 'electron-watch/electron-44.9.3' },
    }).body;
    expect(body).toContain(
      'https://github.com/solardev-xyz/freedom-browser/compare/main...electron-watch/electron-44.9.3?expand=1'
    );
  });

  test('major and end-of-life issues', () => {
    const releases = W.npmStableReleases(NPM, now);
    const [m] = W.decideMajors({ pinned: '44.7.0', shipped: '44.7.0', releases, now });
    expect(W.renderMajorIssue(m, ctx).title).toBe('Adopt Electron 45, due 2026-12-16');
    const eol = W.decideEol({ pinned: '43.8.3', releases, schedule: SCHEDULE, now });
    expect(W.renderEolIssue(eol, ctx).title).toBe('Electron 43 reaches end of life on 2027-01-05');
    const past = W.decideEol({ pinned: '42.11.18', releases, schedule: SCHEDULE, now });
    expect(W.renderEolIssue(past, ctx).title).toBe('Electron 42 is past end of life');
  });

  test('the body does not change between runs unless the facts do', () => {
    const a = W.renderSecurityIssue(decide('44.7.0', '2026-10-23T12:00:00Z'), ctx).body;
    const b = W.renderSecurityIssue(decide('44.7.0', '2026-10-23T18:00:00Z'), {
      ...ctx,
      now: at('2026-10-23T18:00:00Z'),
    }).body;
    expect(b).toBe(a);
  });
});

describe('issue plan: one issue per key', () => {
  const want = (key, body = `<!-- electron-watch:${key} -->\nbody`) => ({
    key,
    title: `title ${key}`,
    body,
    labels: ['security-release'],
  });
  const have = (number, key, extra = {}) => ({
    number,
    title: `title ${key}`,
    body: `<!-- electron-watch:${key} -->\nbody`,
    state: 'open',
    ...extra,
  });

  test('a new key is created', () => {
    expect(
      W.planIssues({ desired: [want('security:44.9.3')], existing: [], pinned: '44.7.0' })
    ).toEqual([expect.objectContaining({ type: 'create', key: 'security:44.9.3' })]);
  });

  test('an already-open issue is updated, not duplicated', () => {
    const actions = W.planIssues({
      desired: [want('security:44.9.3', '<!-- electron-watch:security:44.9.3 -->\nnew text')],
      existing: [have(712, 'security:44.9.3')],
      pinned: '44.7.0',
    });
    expect(actions).toEqual([expect.objectContaining({ type: 'update', number: 712 })]);
  });

  test('an identical issue is left alone', () => {
    const actions = W.planIssues({
      desired: [want('major:45')],
      existing: [have(713, 'major:45')],
      pinned: '44.7.0',
    });
    expect(actions).toEqual([{ type: 'unchanged', key: 'major:45', number: 713 }]);
  });

  test('a closed issue for the key is not reopened or duplicated', () => {
    const actions = W.planIssues({
      desired: [want('security:44.9.3')],
      existing: [have(714, 'security:44.9.3', { state: 'closed' })],
      pinned: '44.7.0',
    });
    expect(actions).toEqual([{ type: 'skip-closed', key: 'security:44.9.3', number: 714 }]);
  });

  test('two open issues for one key: the older one is written, nothing is created', () => {
    const actions = W.planIssues({
      desired: [want('security:44.9.3', 'changed <!-- electron-watch:security:44.9.3 -->')],
      existing: [have(720, 'security:44.9.3'), have(715, 'security:44.9.3')],
      pinned: '44.7.0',
    });
    expect(actions).toEqual([expect.objectContaining({ type: 'update', number: 715 })]);
  });

  test('an older target is closed as superseded; a shipped one as shipped', () => {
    const actions = W.planIssues({
      desired: [want('security:44.9.3')],
      existing: [have(716, 'security:44.8.0'), have(717, 'security:44.9.3')],
      pinned: '44.7.0',
    });
    expect(actions).toContainEqual(
      expect.objectContaining({ type: 'close', number: 716, supersededBy: 'security:44.9.3' })
    );
    const shipped = W.planIssues({
      desired: [],
      existing: [have(717, 'security:44.9.3'), have(718, 'major:44'), have(719, 'eol:43')],
      shipped: '44.9.3',
      shippedTag: 'v0.8.8',
      pinned: '44.9.3',
    });
    expect(shipped.map((a) => [a.type, a.number])).toEqual([
      ['close', 717],
      ['close', 718],
      ['close', 719],
    ]);
    expect(shipped[0].comment).toBe('Shipped: v0.8.8 ships Electron 44.9.3.');
  });

  test('a newer target on another major does not supersede: each major keeps its deadline', () => {
    const actions = W.planIssues({
      desired: [want('security:45.0.2')],
      existing: [have(721, 'security:44.9.3')],
      shipped: '44.7.0',
      pinned: '45.0.0',
    });
    expect(actions.filter((a) => a.type === 'close')).toEqual([]);
  });

  test('a release on a newer major closes the old major only on evidence it carries the fixes', () => {
    const published = new Map([
      ['44.9.3', at('2026-10-21T03:31:39.419Z')],
      ['45.0.0', at('2026-10-21T06:03:52.729Z')],
      ['45.0.1', at('2026-10-28T00:00:00Z')],
    ]);
    const plan = (shipped, desired = []) =>
      W.planIssues({
        desired,
        existing: [have(722, 'security:44.9.3')],
        shipped,
        shippedTag: 'v0.9.0',
        pinned: shipped,
        published,
      });
    // Published to npm after the old target: carries it.
    const [closed] = plan('45.0.0');
    expect(closed).toMatchObject({ type: 'close', number: 722 });
    expect(closed.comment).toMatch(
      /^Shipped through the newer major: v0\.9\.0 ships Electron 45\.0\.0, published to npm 2026-10-21 06:03 UTC, after Electron 44\.9\.3/
    );
    // A 45.x security issue takes the deadline over.
    expect(plan('45.0.0', [want('security:45.0.1')])).toContainEqual(
      expect.objectContaining({ type: 'close', number: 722, supersededBy: 'security:45.0.1' })
    );
    // Published before it, and nothing on 45 tracks the fixes: stays open.
    published.set('45.0.0', at('2026-10-20T00:00:00Z'));
    expect(plan('45.0.0')).toEqual([]);
  });

  test('a malformed marker is not a key', () => {
    expect(W.issueKey({ body: '<!-- electron-watch:security:44..1 -->' })).toBeNull();
    expect(W.issueKey({ body: '<!-- electron-watch:major:4.5 -->' })).toBeNull();
    expect(W.issueKey({ body: '<!-- electron-watch:security:44.9.3 -->' })).toBe('security:44.9.3');
  });

  test('an open security issue is kept while the release is unknown', () => {
    expect(
      W.planIssues({ desired: [], existing: [have(717, 'security:44.9.3')], pinned: '44.9.3' })
    ).toEqual([]);
  });

  test('issues without the marker are never touched', () => {
    const stranger = { number: 1, title: 'Electron 44.9.3', body: 'someone else', state: 'open' };
    expect(W.planIssues({ desired: [], existing: [stranger], pinned: '44.7.0' })).toEqual([]);
  });
});

describe('the bump: files that record the Electron version', () => {
  test('licenses-audit.json and LICENSE_AUDIT.md move to the new version and nothing else', () => {
    const json = fs.readFileSync(path.join(repoRoot, 'licenses-audit.json'), 'utf8');
    const updated = W.updateLicenseAuditJson(json, '44.9.3');
    const entry = JSON.parse(updated).dependencies.find((d) => d.name === 'electron');
    expect(entry.version).toBe('44.9.3');
    expect(updated.split('\n').filter((l, i) => l !== json.split('\n')[i])).toEqual([
      '      "version": "44.9.3",',
    ]);

    const md = fs.readFileSync(path.join(repoRoot, 'LICENSE_AUDIT.md'), 'utf8');
    const mdUpdated = W.updateLicenseAuditMarkdown(md, '44.9.3');
    expect(mdUpdated).toContain(
      '## Electron Framework\n\n- **Version:** 44.9.3 (lockfile-resolved)'
    );
    expect(mdUpdated.split('\n').filter((l, i) => l !== md.split('\n')[i])).toHaveLength(1);
  });

  test('the Chromium/Node detail follows changelog-process.md', () => {
    const e = (v) => ELECTRON_RELEASES.get(v);
    expect(W.chromiumNodeDetail(e('44.6.0'), e('44.7.0'))).toBe(
      'Chromium 152.0.7977.130 and Node 24.21.0, unchanged'
    );
    expect(W.chromiumNodeDetail(e('44.7.0'), e('44.9.3'))).toBe(
      'Chromium 152.0.7977.130 to 152.0.7977.167, Node 24.21.0 to 24.22.0'
    );
    expect(W.chromiumNodeDetail(e('44.8.0'), e('44.9.3'))).toBe(
      'Chromium 152.0.7977.167 and Node 24.22.0, unchanged'
    );
    expect(W.chromiumNodeDetail(undefined, e('44.9.3'))).toBeNull();
  });

  test('with no unreleased Electron fragment, a new one is written', () => {
    const plan = W.planChangelogFragment(
      [{ name: 'fixed--731-context-menu-zoom.md', text: '- Something\n' }],
      {
        pinned: '44.7.0',
        to: '44.9.3',
        detailFor: () => 'Chromium 152.0.7977.130 to 152.0.7977.167, Node 24.21.0 to 24.22.0',
      }
    );
    expect(plan).toEqual({
      write: {
        name: 'security--deps-electron-44.9.3.md',
        text:
          '- Updated runtime dependencies:\n' +
          '  - Electron 44.7.0 to 44.9.3 (Chromium 152.0.7977.130 to 152.0.7977.167, Node 24.21.0 to 24.22.0)\n',
      },
      remove: null,
      from: '44.7.0',
    });
  });

  test('an unreleased Electron fragment keeps its start and its prose, and is renamed', () => {
    // The fragment 44.6.0's bump left (e12e64a0), verbatim.
    const text =
      '- Updated runtime dependencies:\n' +
      '  - Electron 44.4.5 to 44.6.0 (Chromium 152.0.7977.130 and Node 24.21.0, unchanged; upstream ANGLE, Chromium, Dawn and V8 security fixes, and a fix for find-in-page hanging when the host page has an iframe)\n' +
      '  - `@ledgerhq/hw-app-eth` 7.8.19 to 7.10.0\n' +
      '  - `@x402/core` and `@x402/evm` 2.27.0 to 2.28.0\n';
    const detailFor = jest.fn(() => 'Chromium 152.0.7977.130 and Node 24.21.0, unchanged');
    const plan = W.planChangelogFragment([{ name: 'security--deps-electron-44.6.0.md', text }], {
      pinned: '44.6.0',
      to: '44.7.0',
      detailFor,
    });
    expect(detailFor).toHaveBeenCalledWith('44.4.5');
    expect(plan.remove).toBe('security--deps-electron-44.6.0.md');
    expect(plan.write.name).toBe('security--deps-electron-44.7.0.md');
    expect(plan.from).toBe('44.4.5');
    expect(plan.write.text).toBe(
      '- Updated runtime dependencies:\n' +
        '  - Electron 44.4.5 to 44.7.0 (Chromium 152.0.7977.130 and Node 24.21.0, unchanged; upstream ANGLE, Chromium, Dawn and V8 security fixes, and a fix for find-in-page hanging when the host page has an iframe)\n' +
        '  - `@ledgerhq/hw-app-eth` 7.8.19 to 7.10.0\n' +
        '  - `@x402/core` and `@x402/evm` 2.27.0 to 2.28.0\n'
    );
  });

  test('a stale Chromium detail is dropped when the new one is unknown', () => {
    const plan = W.planChangelogFragment(
      [
        {
          name: 'security--deps.md',
          text: '- Updated runtime dependencies:\n  - Electron 44.7.0 to 44.8.0 (Chromium 152.0.7977.130 to 152.0.7977.167, Node 24.21.0 to 24.22.0)\n',
        },
      ],
      { pinned: '44.8.0', to: '44.9.3', detailFor: () => null }
    );
    expect(plan.write).toEqual({
      name: 'security--deps.md',
      text: '- Updated runtime dependencies:\n  - Electron 44.7.0 to 44.9.3\n',
    });
    expect(plan.remove).toBeNull();
  });
});

describe('main on a newer major than the release (review round 1, finding 1)', () => {
  test('the shipped major keeps its security deadline while main adopts the next one', () => {
    // main pins 45.0.0, the latest release still ships 44.7.0: 44.7.2's
    // deadline (2026-10-21) is still owed, and the 8-week adoption issue for
    // 45 (due 2026-12-16) does not replace it.
    const d = decide('45.0.0', '2026-10-23T12:00:00Z', { shipped: '44.7.0' });
    expect(d).toMatchObject({
      key: 'security:44.9.3',
      target: '44.9.3',
      base: '44.7.0',
      major: 44,
      crossMajor: true,
      pinnedMajor: 45,
      overdue: true,
    });
    expect(d.governing.version).toBe('44.7.2');
    expect(iso(d.dueAt)).toBe('2026-10-21T01:32:13.902Z');
    // 45.0.0 is the newest 45.x in the recording: nothing to bump on main.
    expect(decide('45.0.0', '2026-10-23T12:00:00Z')).toBeNull();
  });

  test('the issue asks for a release, not a bump on main, and names both ways to ship', () => {
    const d = decide('45.0.0', '2026-10-23T12:00:00Z', { shipped: '44.7.0' });
    const body = W.renderSecurityIssue(d, {
      repo: 'solardev-xyz/freedom-browser',
      now: at('2026-10-23T12:00:00Z'),
      shippedTag: 'v0.8.7',
      bump: null,
      mainTrack: null,
    }).body;
    expect(body).toContain('`main` has moved on to Electron 45 (45.0.0)');
    expect(body).toContain('the adoption issue for 45 does not replace this deadline');
    expect(body).toContain('**Bump:** none on `main`');
    expect(body).toContain('`node scripts/electron-watch.js bump --version 44.9.3`');
    expect(body).toContain('published to npm after 44.9.3 (2026-10-21 03:31 UTC)');
    expect(body).not.toContain('**Bump PR:**');
    expect(body).toContain("keeping `main`'s Electron, lockfile and license audit");
  });

  test("main's own major is tracked beside the deadline, to keep the pin current", () => {
    // Shipped 43.8.0, main on 44.7.0: 43.8.1 (the eMudhra advisory) and
    // 43.8.3 (a backport batch) are owed on 43; main's 44.9.3 is a bump.
    const now = '2026-10-23T12:00:00Z';
    const owed = decide('44.7.0', now, { shipped: '43.8.0' });
    expect(owed).toMatchObject({ key: 'security:43.8.3', crossMajor: true });
    expect(owed.securityReleases.map((r) => r.version)).toEqual(['43.8.1', '43.8.3']);
    expect(iso(owed.dueAt)).toBe('2026-10-27T02:54:21.154Z');
    const main = decide('44.7.0', now);
    expect(main.target).toBe('44.9.3');
    const body = W.renderSecurityIssue(owed, {
      repo: 'solardev-xyz/freedom-browser',
      now: at(now),
      shippedTag: 'v0.8.7',
      bump: null,
      mainTrack: { decision: main, bump: { state: 'pr', number: 950 } },
    }).body;
    expect(body).toContain(
      "**`main`'s major:** `main` pins 44.7.0, and Electron 44.9.3 is the newest 44.x"
    );
    expect(body).toContain('**Bump PR:** #950.');
  });
});

describe('upstream data is untrusted (review round 1, finding 2)', () => {
  const HOSTILE =
    'fix ](https://evil.invalid) [spoof `x` | <img src=x> @solardev-xyz www.evil.invalid\n- injected';
  const ctx = {
    repo: 'solardev-xyz/freedom-browser',
    now: 0,
    shippedTag: 'v1',
    bump: { state: 'pending' },
  };

  test('mdCode leaves no Markdown, HTML, autolink or mention syntax', () => {
    const out = W.mdCode(HOSTILE);
    expect(out.startsWith('<code>') && out.endsWith('</code>')).toBe(true);
    const inner = out.slice('<code>'.length, -'</code>'.length);
    expect(inner).not.toMatch(/[[\]()`|<>@:\n]|www\./);
    expect(rendered(out)).toBe(HOSTILE.replace('\n', ' '));
  });

  test('only the expected HTTPS sources are linked', () => {
    for (const url of [
      'https://github.com/electron/electron/pull/55149',
      'https://github.com/electron/electron/releases/tag/v44.9.3',
      'https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9',
      'https://chromereleases.googleblog.com/2026/09/stable-channel-update-for-desktop_01882797386.html',
    ]) {
      expect(W.safeUrl(url)).toBe(url);
    }
    for (const url of [
      'https://good.invalid',
      'http://github.com/electron/electron/pull/1',
      'https://github.com/electron/electron/pull/1)[x](https://evil.invalid',
      'https://github.com.evil.invalid/electron/electron/pull/1',
      'javascript:alert(1)',
      'https://chromereleases.googleblog.com/2026/09/x.html?u=https://evil.invalid',
    ]) {
      expect(W.safeUrl(url)).toBeNull();
    }
  });

  test("the reviewer's probe: hostile evidence text and links render inert", () => {
    const issue = W.renderSecurityIssue(
      {
        key: 'security:44.9.3',
        target: '44.9.3',
        major: 44,
        dueAt: 0,
        pinned: '44.7.0',
        shipped: '44.7.0',
        base: '44.7.0',
        governing: { version: '44.8.0', exploited: false, publishedAt: 0 },
        securityReleases: [
          {
            version: '44.8.0',
            notesUrl: 'https://good.invalid',
            publishedAt: 0,
            dueAt: 0,
            evidence: [{ text: HOSTILE, url: 'https://good.invalid' }],
            inKev: [],
            chromeSaysExploited: [],
            exploitedInWild: false,
            exploited: false,
          },
        ],
        releases: [],
        cves: [],
        inKev: [],
        chromeSaysExploited: [],
        unmatchedKev: [
          {
            cveID: 'CVE-2026-87491',
            product: 'V8](https://evil.invalid)',
            dateAdded: '2026-09-09',
          },
        ],
        unmatchedKevDueAt: 0,
        missing: [],
      },
      ctx
    );
    expect(issue.body).not.toContain('](https://evil.invalid)');
    expect(issue.body).not.toContain('good.invalid');
    expect(issue.body).not.toContain('<img');
    expect(issue.body).not.toContain('@solardev-xyz');
    expect(issue.body).not.toMatch(/\n- injected/);
    // The release link falls back to the canonical GitHub release.
    expect(issue.body).toContain(
      '[44.8.0](https://github.com/electron/electron/releases/tag/v44.8.0)'
    );
  });

  test('hostile notes and URLs from the feeds never reach the issue as Markdown', () => {
    const notes = new Map(NOTES);
    notes.set('44.7.2', {
      body: `* Backported fixes from upstream ${HOSTILE}. [#1](https://evil.invalid/pull/1)`,
      url: 'https://evil.invalid/releases/tag/v44.7.2',
    });
    const chrome = W.parseChromeFeed({
      feed: {
        entry: [
          {
            title: { $t: 'Stable Channel Update for Desktop' },
            published: { $t: '2026-10-01T00:00:00Z' },
            content: { $t: 'updated to 152.0.7977.150 [x](y) CVE-2026-1234' },
            link: [{ rel: 'alternate', href: 'javascript:alert(1)' }],
          },
        ],
      },
    });
    expect(chrome[0].url).toBeNull();
    const advisories = W.parseAdvisories([
      ...fixture('electron-advisories.json').map((a) =>
        a.ghsa_id === 'GHSA-jr5w-w6x2-84p9'
          ? { ...a, html_url: 'https://evil.invalid/a', summary: HOSTILE }
          : a
      ),
      { ghsa_id: 'GHSA-x](https://evil.invalid', vulnerabilities: [] },
      { ghsa_id: 'GHSA-aaaa-bbbb-cccc', cve_id: 'CVE-1)[x](y', vulnerabilities: [] },
    ]);
    expect(advisories.find((a) => a.id === 'GHSA-jr5w-w6x2-84p9').url).toBe(
      'https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9'
    );
    expect(advisories.some((a) => a.id.includes('evil'))).toBe(false);
    expect(advisories.find((a) => a.id === 'GHSA-aaaa-bbbb-cccc').cve).toBeNull();
    const d = decide('44.7.0', '2026-10-23T12:00:00Z', {
      notes,
      advisories,
      chromePosts: [...CHROME, ...chrome],
    });
    const body = W.renderSecurityIssue(d, { ...ctx, now: at('2026-10-23T12:00:00Z') }).body;
    expect(body).not.toContain('evil.invalid');
    expect(rendered(body)).toContain('Backported fixes from upstream fix ](https://evil.invalid)');
  });

  test('a KEV entry with a malformed CVE id is dropped', () => {
    const kev = W.parseKev({
      vulnerabilities: [
        { cveID: 'CVE-2026-1)[x](https://evil.invalid' },
        { cveID: 'CVE-2026-85046' },
      ],
    });
    expect([...kev.keys()]).toEqual(['CVE-2026-85046']);
  });

  test('releases.electronjs.org values reach the changelog only in their exact numeric format', () => {
    const hostile = W.sanitizeElectronRelease({
      version: '44.9.3',
      chrome: '152.0.7977.167`)\n- injected from upstream',
      node: '24.22.0',
      modules: '149; rm',
    });
    expect(hostile).toEqual({ version: '44.9.3', chrome: null, node: '24.22.0', modules: null });
    expect(W.sanitizeElectronRelease({ version: 'x', chrome: '1.2.3.4' })).toBeNull();
    const good = ELECTRON_RELEASES.get('44.7.0');
    expect(W.chromiumNodeDetail(good, hostile)).toBeNull();
    expect(
      W.chromiumNodeDetail(good, { chrome: '152.0.7977.167', node: '24.22.0\n- x' })
    ).toBeNull();
  });

  test("the reviewer's probe: a hostile detail never enters a fragment", () => {
    const detailFor = () => 'Chromium `)\n- injected from upstream';
    const fresh = W.planChangelogFragment([], { pinned: '44.7.0', to: '44.9.3', detailFor });
    expect(fresh.write.text).toBe(
      '- Updated runtime dependencies:\n  - Electron 44.7.0 to 44.9.3\n'
    );
    const moved = W.planChangelogFragment(
      [
        {
          name: 'security--deps-electron-44.8.0.md',
          text: '- Updated runtime dependencies:\n  - Electron 44.7.0 to 44.8.0\n',
        },
      ],
      { pinned: '44.8.0', to: '44.9.3', detailFor }
    );
    expect(moved.write.text).toBe(
      '- Updated runtime dependencies:\n  - Electron 44.7.0 to 44.9.3\n'
    );
  });
});
