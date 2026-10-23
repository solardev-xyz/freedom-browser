#!/usr/bin/env node
'use strict';

// Electron security-release watch (#644, roadmap item 0.2). The rule and how
// Electron marks its security releases are documented in
// scripts/lib/electron-watch.js; this file fetches the inputs and writes the
// results. `.github/workflows/electron-watch.yml` runs it every 6 hours.
//
// Usage:
//   node scripts/electron-watch.js watch [--dry-run] [--now <ISO time>]
//       Read the pinned Electron, the npm releases, Electron's release notes
//       and advisories, Chrome's release notes and CISA KEV; open, update or
//       close the `security-release` issues. Prints the plan; `--dry-run`
//       writes nothing. In Actions it also sets the `bump_version` and
//       `issue_number` outputs when a bump pull request is due.
//   node scripts/electron-watch.js bump --version <x.y.z> [--issue <n> --open-pr]
//       Move package.json, package-lock.json, licenses-audit.json,
//       LICENSE_AUDIT.md and the changelog fragment to Electron <x.y.z>.
//       With `--open-pr`, commit that on `electron-watch/electron-<x.y.z>`,
//       push it and open the pull request against `main`.
//
// Needs `gh` (authenticated through GH_TOKEN) and GH_REPO or
// GITHUB_REPOSITORY. Locally, `GH_REPO=solardev-xyz/freedom-browser node
// scripts/electron-watch.js watch --dry-run` shows what a run would do.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { fetchJson, TIMEOUTS } = require('./lib/fetch-with-retry');
const { readLockedElectronVersion } = require('./check-electron-version');
const W = require('./lib/electron-watch');

const repoRoot = path.join(__dirname, '..');

const USER_AGENT =
  'freedom-browser-electron-watch (+https://github.com/solardev-xyz/freedom-browser)';

const SOURCES = {
  npm: 'https://registry.npmjs.org/electron',
  // CISA's own URL first; its CDN refuses some datacenter ranges, and CISA
  // publishes the same file to GitHub.
  kev: [
    'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
    'https://raw.githubusercontent.com/cisagov/kev-data/main/known_exploited_vulnerabilities.json',
  ],
  electronReleases: 'https://releases.electronjs.org/releases.json',
  schedule: 'https://releases.electronjs.org/schedule.json',
  chromeFeed: 'https://chromereleases.googleblog.com/feeds/posts/default/-/Desktop%20Update',
};

/** Chrome posts are read from this long before the base version's npm publish. */
const CHROME_LOOKBACK_MS = 60 * W.DAY_MS;
const CHROME_PAGE_SIZE = 150;
const CHROME_MAX_PAGES = 6;
/** More versions than this between the pin and the newest patch means something is off. */
const MAX_CANDIDATES = 80;

const LABEL_COLOR = 'b60205';
const LABEL_DESCRIPTION =
  'Electron security release, major adoption or end of life (electron-watch)';

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
/** A git credential helper that answers with `GH_TOKEN` from the environment. */
const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
/** Everything an Electron bump may touch; anything else in the tree aborts the push. */
const BUMP_PATHS = [
  'package.json',
  'package-lock.json',
  'licenses-audit.json',
  'LICENSE_AUDIT.md',
  'changelog.d/',
];

// ---------------------------------------------------------------------------
// Sources

function httpJson(url, options = {}) {
  return fetchJson(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeoutMs: TIMEOUTS.list,
    maxBytes: 64 * 1024 * 1024,
    ...options,
  });
}

function createFetchers(http = httpJson) {
  return {
    npm: () => http(SOURCES.npm, { label: 'npm electron packument' }),
    kev: async () => {
      let lastError;
      for (const url of SOURCES.kev) {
        try {
          return await http(url, { label: 'CISA KEV' });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    electronReleases: () => http(SOURCES.electronReleases, { label: 'releases.electronjs.org' }),
    schedule: () => http(SOURCES.schedule, { label: 'Electron schedule' }),
    chromePage: (publishedMin, startIndex) =>
      http(
        `${SOURCES.chromeFeed}?alt=json&max-results=${CHROME_PAGE_SIZE}&start-index=${startIndex}` +
          `&published-min=${encodeURIComponent(new Date(publishedMin).toISOString())}`,
        { label: 'Chrome release feed' }
      ),
  };
}

/** Chrome desktop posts published since `publishedMin`, every page. */
async function fetchChromePosts(fetchers, publishedMin) {
  const posts = [];
  for (let page = 0; page < CHROME_MAX_PAGES; page++) {
    const feed = await fetchers.chromePage(publishedMin, 1 + page * CHROME_PAGE_SIZE);
    const entries = feed?.feed?.entry || [];
    posts.push(...W.parseChromeFeed(feed));
    if (entries.length < CHROME_PAGE_SIZE) break;
  }
  return posts;
}

// ---------------------------------------------------------------------------
// GitHub, through `gh api`

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createGitHub({ repo, exec = execFileSync }) {
  const owner = repo.split('/')[0];
  const call = (args, input) => {
    try {
      const out = exec('gh', ['api', ...args], {
        encoding: 'utf8',
        input,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return out;
    } catch (error) {
      const stderr = String(error.stderr || error.message || '');
      const status = Number((/\(HTTP (\d{3})\)/.exec(stderr) || [])[1]) || null;
      throw new GitHubError(`gh api ${args.join(' ')}: ${stderr.trim()}`, status);
    }
  };
  const json = (args, body) => {
    const out =
      body === undefined ? call(args) : call([...args, '--input', '-'], JSON.stringify(body));
    return out.trim() ? JSON.parse(out) : null;
  };
  const orNull = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  const pages = (pathname) => {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const sep = pathname.includes('?') ? '&' : '?';
      const batch = json([`${pathname}${sep}per_page=100&page=${page}`]);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };
  return {
    electronRelease: (version) =>
      orNull(() => json([`repos/electron/electron/releases/tags/v${version}`])),
    electronAdvisories: () =>
      json([
        'repos/electron/electron/security-advisories?per_page=100&sort=published&direction=desc',
      ]),
    latestRelease: () => orNull(() => json([`repos/${repo}/releases/latest`])),
    fileAtRef: (file, ref) =>
      call([
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`,
      ]),
    // By label, and by author too: an issue whose label a person removed is
    // still ours, and must not be opened a second time.
    listIssues: () => {
      const seen = new Map();
      for (const query of [`labels=${W.LABEL}`, `creator=${encodeURIComponent(BOT_NAME)}`]) {
        for (const issue of pages(`repos/${repo}/issues?${query}&state=all`)) {
          if (!issue.pull_request) seen.set(issue.number, issue);
        }
      }
      return [...seen.values()];
    },
    ensureLabel: () => {
      if (orNull(() => json([`repos/${repo}/labels/${W.LABEL}`]))) return;
      json(['-X', 'POST', `repos/${repo}/labels`], {
        name: W.LABEL,
        color: LABEL_COLOR,
        description: LABEL_DESCRIPTION,
      });
    },
    createIssue: ({ title, body, labels }) =>
      json(['-X', 'POST', `repos/${repo}/issues`], { title, body, labels }),
    updateIssue: (number, fields) =>
      json(['-X', 'PATCH', `repos/${repo}/issues/${number}`], fields),
    commentIssue: (number, body) =>
      json(['-X', 'POST', `repos/${repo}/issues/${number}/comments`], { body }),
    pullsForBranch: (branch) =>
      json([
        `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=10`,
      ]),
    branchExists: (branch) =>
      Boolean(orNull(() => json([`repos/${repo}/branches/${encodeURIComponent(branch)}`]))),
    createPull: (fields) => json(['-X', 'POST', `repos/${repo}/pulls`], fields),
  };
}

// ---------------------------------------------------------------------------
// watch

function optional(name, fn, warnings) {
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      warnings.push(`${name}: ${error.message}`);
      return null;
    });
}

/** The Electron in the latest stable Freedom release, read from its tag's lockfile. */
function readShipped(github, warnings) {
  try {
    const release = github.latestRelease();
    if (!release) return { shipped: null, shippedTag: null };
    const lock = JSON.parse(github.fileAtRef('package-lock.json', release.tag_name));
    const shipped = lock?.packages?.['node_modules/electron']?.version ?? null;
    if (!shipped) warnings.push(`latest release ${release.tag_name}: no electron in its lockfile`);
    return { shipped, shippedTag: release.tag_name };
  } catch (error) {
    warnings.push(`latest release: ${error.message}`);
    return { shipped: null, shippedTag: null };
  }
}

async function gather({ github, fetchers, pinned, now }) {
  const warnings = [];
  const releases = W.npmStableReleases(await fetchers.npm(), now);
  if (!releases.some((r) => r.version === pinned)) {
    throw new Error(`npm lists no stable electron ${pinned} (the version package-lock.json pins)`);
  }
  const { shipped, shippedTag } = readShipped(github, warnings);
  const base = W.securityBase(pinned, shipped);
  const major = W.majorOf(pinned);
  const latest = W.latestOnMajor(releases, major);
  const candidates = releases.filter(
    (r) => r.major === major && W.compareVersions(r.version, base) > 0
  );
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `${candidates.length} Electron ${major}.x releases after ${base}; refusing to guess`
    );
  }

  let security = null;
  if (candidates.length) {
    const notes = new Map();
    for (const r of candidates) {
      const release = github.electronRelease(r.version);
      notes.set(r.version, release ? { body: release.body || '', url: release.html_url } : null);
    }
    const kev = W.parseKev(await fetchers.kev());
    const basePublishedAt = releases.find((r) => r.version === base).publishedAt;
    const [advisories, electronReleases, chromePosts] = await Promise.all([
      optional(
        'Electron advisories',
        () => W.parseAdvisories(github.electronAdvisories()),
        warnings
      ),
      optional(
        'releases.electronjs.org',
        async () => indexElectronReleases(await fetchers.electronReleases()),
        warnings
      ),
      optional(
        'Chrome release feed',
        () => fetchChromePosts(fetchers, basePublishedAt - CHROME_LOOKBACK_MS),
        warnings
      ),
    ]);
    security = W.decideSecurity({
      pinned,
      shipped,
      releases,
      notes,
      kev,
      advisories,
      electronReleases,
      chromePosts,
      now,
    });
  }
  const schedule = await optional('Electron schedule', fetchers.schedule, warnings);
  return {
    pinned,
    shipped,
    shippedTag,
    latest: latest.version,
    releases,
    security,
    majors: W.decideMajors({ pinned, shipped, releases, now }),
    eol: W.decideEol({
      pinned,
      releases,
      schedule: Array.isArray(schedule) ? schedule : null,
      now,
    }),
    warnings,
  };
}

function indexElectronReleases(list) {
  if (!Array.isArray(list)) throw new Error('releases.json is not a list');
  return new Map(list.filter((e) => e && e.version).map((e) => [e.version, e]));
}

/** Where the bump for `target` stands: an existing PR, a pushed branch, or nothing yet. */
function bumpState(github, target) {
  const branch = W.bumpBranch(target);
  const pulls = github.pullsForBranch(branch) || [];
  const pr = pulls.find((p) => p.state === 'open') || pulls[0];
  if (pr) return { state: 'pr', number: pr.number, branch, prState: pr.state };
  if (github.branchExists(branch)) return { state: 'branch', branch };
  return { state: 'pending', branch };
}

/**
 * Turn the gathered decisions into issue writes. Returns the plan, and the
 * bump to make: only for a security target newer than `main`'s pin whose
 * issue is open and for which no branch or pull request exists yet (closed
 * ones included, so a bump a person turned down is not reopened).
 */
function sync({ github, gathered, repo, now, dryRun, log = () => {} }) {
  const { security, majors, eol, pinned, shipped, shippedTag } = gathered;
  const bump = security ? bumpState(github, security.target) : null;
  const ctx = { repo, now, shippedTag, bump };
  const desired = [];
  if (security) desired.push(W.renderSecurityIssue(security, ctx));
  for (const m of majors) desired.push(W.renderMajorIssue(m, ctx));
  if (eol) desired.push(W.renderEolIssue(eol, ctx));

  const existing = github.listIssues();
  const actions = W.planIssues({ desired, existing, shipped, shippedTag, pinned });
  const numbers = new Map();
  for (const a of actions) if (a.number) numbers.set(a.key, a.number);

  if (!dryRun) {
    if (actions.some((a) => a.type === 'create')) github.ensureLabel();
    for (const a of actions) {
      if (a.type === 'create') {
        const issue = github.createIssue({ title: a.title, body: a.body, labels: a.labels });
        numbers.set(a.key, issue.number);
        log(`created #${issue.number}: ${a.title}`);
      } else if (a.type === 'update') {
        github.updateIssue(a.number, { title: a.title, body: a.body });
        log(`updated #${a.number}: ${a.title}`);
      }
    }
    for (const a of actions) {
      if (a.type !== 'close') continue;
      const next = a.supersededBy && numbers.get(a.supersededBy);
      const comment = next
        ? `Superseded by #${next} (Electron ${a.supersededBy.split(':')[1]}), which carries this deadline forward.`
        : a.comment;
      github.commentIssue(a.number, comment);
      github.updateIssue(a.number, { state: 'closed', state_reason: 'completed' });
      log(`closed #${a.number}: ${comment}`);
    }
  }

  let bumpVersion = null;
  let issueNumber = null;
  if (security && bump.state === 'pending' && W.compareVersions(pinned, security.target) < 0) {
    const issueAction = actions.find((a) => a.key === security.key);
    if (issueAction && issueAction.type !== 'skip-closed') {
      bumpVersion = security.target;
      issueNumber = numbers.get(security.key) ?? null;
    }
  }
  return { actions, desired, bump, bumpVersion, issueNumber };
}

function describePlan(gathered, result) {
  const lines = ['## Electron watch', ''];
  const { security, majors, eol } = gathered;
  lines.push(
    `- Pinned on \`main\`: ${gathered.pinned}; latest release: ${gathered.shippedTag ? `${gathered.shippedTag} (Electron ${gathered.shipped || 'unknown'})` : 'unknown'}; newest on ${W.majorOf(gathered.pinned)}.x: ${gathered.latest}`
  );
  if (security) {
    lines.push(
      `- Security: Electron ${security.target}, due ${W.formatTime(security.dueAt)}${security.overdue ? ' (overdue)' : ''}, ${security.exploited ? '72 hours (exploited in the wild)' : '7 days'}; security releases ${security.securityReleases.map((r) => r.version).join(', ')}; ${security.cves.length} CVEs`
    );
    const other = security.releases.flatMap((r) =>
      r.otherBackports.map((t) => `${r.version}: ${t}`)
    );
    if (other.length) lines.push(`- Backports not counted as security: ${other.join('; ')}`);
  } else {
    lines.push('- Security: no newer release on the pinned major carries a security fix');
  }
  for (const m of majors)
    lines.push(
      `- Major ${m.major}: adopt by ${W.formatTime(m.dueAt)}${m.overdue ? ' (overdue)' : ''}`
    );
  if (eol)
    lines.push(
      `- End of life: Electron ${eol.major} ${eol.past ? 'is past end of life' : 'is nearing end of life'}`
    );
  lines.push('', '| Action | Issue | Title |', '| --- | --- | --- |');
  for (const a of result.actions) {
    lines.push(
      `| ${a.type} | ${a.number ? `#${a.number}` : ''} | ${a.title || a.comment || a.key} |`
    );
  }
  if (result.bumpVersion) lines.push('', `Bump pull request due: Electron ${result.bumpVersion}.`);
  else if (result.bump && result.bump.state === 'branch') {
    lines.push('', `Bump branch \`${result.bump.branch}\` exists without a pull request.`);
  }
  if (gathered.warnings.length) {
    lines.push('', '**Not checked this run:**', ...gathered.warnings.map((w) => `- ${w}`));
  }
  return lines.join('\n');
}

function writeGitHubFile(variable, text) {
  const file = process.env[variable];
  if (file) fs.appendFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
}

async function runWatch(opts, deps = {}) {
  const repo = requireRepo();
  const now = opts.now ?? Date.now();
  const github = deps.github || createGitHub({ repo });
  const fetchers = deps.fetchers || createFetchers();
  const pinned = deps.pinned || readLockedElectronVersion();
  if (!W.isStableVersion(pinned)) throw new Error(`package-lock.json pins electron ${pinned}`);
  const gathered = await gather({ github, fetchers, pinned, now });
  for (const w of gathered.warnings)
    console.log(`::warning title=electron-watch::${w.replace(/\r?\n/g, ' ')}`);
  const result = sync({
    github,
    gathered,
    repo,
    now,
    dryRun: opts.dryRun,
    log: (l) => console.log(l),
  });
  const summary = describePlan(gathered, result);
  console.log(summary);
  writeGitHubFile('GITHUB_STEP_SUMMARY', summary);
  if (!opts.dryRun) {
    writeGitHubFile(
      'GITHUB_OUTPUT',
      `bump_version=${result.bumpVersion || ''}\nissue_number=${result.issueNumber || ''}`
    );
  }
  return { gathered, result };
}

// ---------------------------------------------------------------------------
// bump

/** `main` moved past the version between the watch job and the bump job. */
class AlreadyBumped extends Error {}

function readText(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

/**
 * Edit the tree to Electron `version`. npm resolves the lockfile with
 * `--package-lock-only --ignore-scripts`: no package code runs in the job
 * that holds a write token, and no node_modules is needed.
 */
async function applyBump({
  version,
  root = repoRoot,
  exec = execFileSync,
  fetchers = createFetchers(),
  log = () => {},
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || ''))
    throw new Error(`--version must be x.y.z, got ${version}`);
  const lockPath = path.join(root, 'package-lock.json');
  const pinned = readLockedElectronVersion(lockPath);
  if (W.majorOf(version) !== W.majorOf(pinned)) {
    throw new Error(
      `refusing to bump across majors (${pinned} to ${version}); a major is a release of its own`
    );
  }
  if (W.compareVersions(version, pinned) <= 0)
    throw new AlreadyBumped(`electron ${pinned} is already at or past ${version}`);

  exec(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-dev',
      `electron@${version}`,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  const locked = readLockedElectronVersion(lockPath);
  const range = JSON.parse(readText(root, 'package.json')).devDependencies?.electron;
  if (locked !== version || range !== `^${version}`) {
    throw new Error(
      `npm left electron at ${locked} (range ${range}), expected ${version} (^${version})`
    );
  }

  fs.writeFileSync(
    path.join(root, 'licenses-audit.json'),
    W.updateLicenseAuditJson(readText(root, 'licenses-audit.json'), version)
  );
  fs.writeFileSync(
    path.join(root, 'LICENSE_AUDIT.md'),
    W.updateLicenseAuditMarkdown(readText(root, 'LICENSE_AUDIT.md'), version)
  );

  let index = null;
  try {
    index = indexElectronReleases(await fetchers.electronReleases());
  } catch (error) {
    log(
      `releases.electronjs.org unavailable (${error.message}); the changelog line gets no Chromium/Node detail`
    );
  }
  const detailFor = (from) =>
    index ? W.chromiumNodeDetail(index.get(from), index.get(version)) : null;
  const dir = path.join(root, 'changelog.d');
  const fragments = fs
    .readdirSync(dir)
    .filter((f) => /^[a-z]+--.+\.md$/.test(f))
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
  const plan = W.planChangelogFragment(fragments, { pinned, to: version, detailFor });
  if (plan.remove) fs.unlinkSync(path.join(dir, plan.remove));
  fs.writeFileSync(path.join(dir, plan.write.name), plan.write.text);

  const abi = index && index.get(pinned)?.modules !== index.get(version)?.modules;
  return {
    pinned,
    version,
    from: plan.from,
    fragment: `changelog.d/${plan.write.name}`,
    fragmentText: plan.write.text,
    detail: detailFor(plan.from),
    abiChanged: Boolean(abi),
    npm: String(exec('npm', ['--version'], { cwd: root, encoding: 'utf8' })).trim(),
  };
}

function commitMessage(b, issue) {
  return [
    `chore(deps): Electron ${b.version} (security release)`,
    '',
    `Opened by .github/workflows/electron-watch.yml${issue ? ` for #${issue}` : ''}: Electron`,
    `${b.version} is the newest ${W.majorOf(b.version)}.x release and carries security fixes that`,
    'have not reached a Freedom release yet.',
    '',
    `  electron ${b.pinned} -> ${b.version}`,
    '',
    `licenses-audit.json and LICENSE_AUDIT.md record ${b.version}; ${b.fragment}`,
    `reads ${b.from} to ${b.version}. Resolved with npm ${b.npm} (\`npm install`,
    '--package-lock-only --ignore-scripts`), so no package code ran.',
  ].join('\n');
}

function pullBody(b, { issue, repo }) {
  const line = b.fragmentText.split('\n').find((l) => /- Electron /.test(l)) || '';
  return [
    `Electron ${b.pinned} to ${b.version}${issue ? ` for #${issue}, which has the deadline, the fixes and the CVEs` : ''}. Opened by \`.github/workflows/electron-watch.yml\`; Electron-only, as the [security-release fast path](https://github.com/${repo}/blob/main/docs/agent-playbooks/release-process.md#security-release-electron) needs.`,
    '',
    '- `package.json`, `package-lock.json`: `electron` `^' +
      b.version +
      '`, resolved with `npm install --package-lock-only --ignore-scripts` (npm ' +
      b.npm +
      ')',
    `- \`licenses-audit.json\`, \`LICENSE_AUDIT.md\`: record ${b.version}`,
    `- \`${b.fragment}\`: \`${line.trim()}\``,
    '',
    b.abiChanged
      ? `**NODE_MODULE_VERSION changes between ${b.pinned} and ${b.version}:** native addons need the rebuild check in \`release-process.md\` §2 before this merges.`
      : `NODE_MODULE_VERSION is unchanged between ${b.pinned} and ${b.version} (per releases.electronjs.org), so native addons need no rebuild.`,
    '',
    "**CI.** A pull request opened with the workflow's `GITHUB_TOKEN` starts no `pull_request` workflow, by GitHub's design. The same workflow run therefore dispatches `ci.yml` on this branch (a `workflow_dispatch` from `GITHUB_TOKEN` does start a run), and its `ci-ok` lands on this pull request's head commit. If it is missing, run CI from Actions > CI > Run workflow on `" +
      W.bumpBranch(b.version) +
      '`, or push a commit to the branch.',
    '',
    'Before merging: read the Electron release notes the issue links, and check the changelog line.',
    '',
    issue ? `Refs #${issue}` : '',
  ]
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\n')
    .trim();
}

/**
 * Commit the bump on its own branch, push it and open the pull request. A
 * repository that does not let GitHub Actions open pull requests gets the
 * branch and a compare link instead; the issue shows the same link from the
 * next run on.
 */
function openPullRequest(
  b,
  { issue, repo, github, exec = execFileSync, root = repoRoot, log = () => {} }
) {
  const branch = W.bumpBranch(b.version);
  const status = String(
    exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
  );
  const stray = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, ''))
    .filter(
      (p) =>
        !BUMP_PATHS.some(
          (allowed) => p === allowed || (allowed.endsWith('/') && p.startsWith(allowed))
        )
    );
  if (stray.length)
    throw new Error(`refusing to commit files outside the bump: ${stray.join(', ')}`);

  const git = (args) => exec('git', args, { cwd: root, stdio: 'inherit' });
  git(['switch', '--create', branch]);
  git(['add', '--all', '--', ...BUMP_PATHS]);
  git([
    '-c',
    `user.name=${BOT_NAME}`,
    '-c',
    `user.email=${BOT_EMAIL}`,
    'commit',
    '--quiet',
    '--message',
    commitMessage(b, issue),
  ]);
  // The checkout keeps no credentials (persist-credentials: false). This
  // helper hands git the job's token from the environment for this one push,
  // so it is never on a command line or in .git/config.
  git([
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=${CREDENTIAL_HELPER}`,
    'push',
    '--quiet',
    'origin',
    `HEAD:refs/heads/${branch}`,
  ]);

  try {
    const pr = github.createPull({
      title: `chore(deps): Electron ${b.version} (security release)`,
      head: branch,
      base: 'main',
      body: pullBody(b, { issue, repo }),
      maintainer_can_modify: true,
    });
    log(`opened ${pr.html_url}`);
    return { branch, pr: { number: pr.number, url: pr.html_url } };
  } catch (error) {
    if (!/not permitted to create or approve pull requests/i.test(error.message)) throw error;
    const compare = `https://github.com/${repo}/compare/main...${branch}?expand=1`;
    log(
      `::warning title=electron-watch::GitHub Actions may not open pull requests in ${repo}; open ${compare}`
    );
    return { branch, pr: null, compare };
  }
}

async function runBump(opts, deps = {}) {
  const repo = opts.openPr
    ? requireRepo()
    : process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const log = (l) => console.log(l);
  let b;
  try {
    b = await applyBump({
      version: opts.version,
      fetchers: deps.fetchers,
      exec: deps.exec,
      root: deps.root,
      log,
    });
  } catch (error) {
    if (!(error instanceof AlreadyBumped)) throw error;
    log(`::notice title=electron-watch::${error.message}; nothing to bump`);
    writeGitHubFile('GITHUB_OUTPUT', 'dispatch_ci=false');
    return { bump: null };
  }
  log(`electron ${b.pinned} -> ${b.version}; ${b.fragment}`);
  if (!opts.openPr) return { bump: b };
  const github = deps.github || createGitHub({ repo });
  const opened = openPullRequest(b, {
    issue: opts.issue,
    repo,
    github,
    exec: deps.exec,
    root: deps.root,
    log,
  });
  writeGitHubFile(
    'GITHUB_OUTPUT',
    `branch=${opened.branch}\npr_url=${opened.pr ? opened.pr.url : ''}\ndispatch_ci=true`
  );
  const summary = opened.pr
    ? `Opened ${opened.pr.url} (Electron ${b.version}).`
    : `Pushed \`${opened.branch}\`; GitHub Actions may not open pull requests here, so [open it](${opened.compare}).`;
  writeGitHubFile('GITHUB_STEP_SUMMARY', summary);
  return { bump: b, opened };
}

// ---------------------------------------------------------------------------

function requireRepo() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
    throw new Error('GH_REPO (owner/name) or GITHUB_REPOSITORY is required');
  return repo;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, dryRun: false, openPr: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--open-pr') opts.openPr = true;
    else if (arg === '--now') {
      opts.now = Date.parse(rest[++i]);
      if (!Number.isFinite(opts.now)) throw new Error('--now needs an ISO time');
    } else if (arg === '--version') opts.version = rest[++i];
    else if (arg === '--issue') {
      const value = rest[++i];
      if (value && !/^\d+$/.test(value)) throw new Error('--issue must be an issue number');
      opts.issue = value ? Number(value) : null;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['watch', 'bump'].includes(command))
    throw new Error('usage: electron-watch.js watch|bump [options]');
  return opts;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.command === 'watch') await runWatch(opts);
  else await runBump(opts);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`electron-watch: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  SOURCES,
  createFetchers,
  fetchChromePosts,
  createGitHub,
  gather,
  sync,
  describePlan,
  runWatch,
  applyBump,
  commitMessage,
  pullBody,
  openPullRequest,
  runBump,
  parseArgs,
};
