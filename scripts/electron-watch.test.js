// scripts/electron-watch.js end to end, with GitHub and the feeds replaced by
// fakes that serve the recorded fixtures (scripts/fixtures/electron-watch/).
// No network, no `gh`, no git: every external call goes through an injected
// function, and the tests assert on what was asked of it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const watch = require('./electron-watch');
const W = require('./lib/electron-watch');

const repoRoot = path.join(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures', 'electron-watch');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));

const REPO = 'solardev-xyz/freedom-browser';
const NOW = Date.parse('2026-10-23T12:00:00Z');

function fakeFetchers(overrides = {}) {
  return {
    npm: async () => fixture('npm-electron.json'),
    kev: async () => fixture('kev.json'),
    electronReleases: async () => fixture('electron-releases.json'),
    schedule: async () => fixture('electron-schedule.json'),
    chromePage: async () => fixture('chrome-releases-feed.json'),
    ...overrides,
  };
}

/** An in-memory repository: issues, pull requests and branches, plus a call log. */
function fakeGitHub({ issues = [], pulls = {}, branches = [], shipped = '44.7.0' } = {}) {
  const releases = new Map(fixture('github-releases.json').map((r) => [r.tag_name.slice(1), r]));
  const state = { issues: issues.map((i) => ({ ...i })), next: 900, calls: [] };
  const log = (name, ...args) => state.calls.push([name, ...args]);
  const api = {
    state,
    writes: () => state.calls.filter(([name]) => /^(create|update|comment|ensure)/.test(name)),
    electronRelease: (version) => releases.get(version) || null,
    electronAdvisories: () => fixture('electron-advisories.json'),
    latestRelease: () => (shipped ? { tag_name: 'v0.8.7' } : null),
    fileAtRef: (file, ref) => {
      log('fileAtRef', file, ref);
      return JSON.stringify({ packages: { 'node_modules/electron': { version: shipped } } });
    },
    listIssues: () => state.issues.map((i) => ({ ...i })),
    ensureLabel: () => log('ensureLabel'),
    createIssue: (fields) => {
      log('createIssue', fields);
      const issue = { number: state.next++, state: 'open', ...fields };
      state.issues.push(issue);
      return issue;
    },
    updateIssue: (number, fields) => {
      log('updateIssue', number, fields);
      Object.assign(
        state.issues.find((i) => i.number === number),
        fields
      );
    },
    commentIssue: (number, body) => log('commentIssue', number, body),
    pullsForBranch: (branch) => pulls[branch] || [],
    branchExists: (branch) => branches.includes(branch),
    createPull: (fields) => {
      log('createPull', fields);
      return { number: 950, html_url: `https://github.com/${REPO}/pull/950` };
    },
  };
  return api;
}

async function run({
  github = fakeGitHub(),
  fetchers = fakeFetchers(),
  pinned = '44.7.0',
  dryRun = false,
  now = NOW,
} = {}) {
  const gathered = await watch.gather({ github, fetchers, pinned, now });
  const result = watch.sync({ github, gathered, repo: REPO, now, dryRun });
  return { github, gathered, result };
}

describe('watch: issues', () => {
  test('first run: opens the security issue and the major issue, and asks for the bump', async () => {
    const { github, gathered, result } = await run();
    expect(gathered).toMatchObject({
      pinned: '44.7.0',
      shipped: '44.7.0',
      shippedTag: 'v0.8.7',
      latest: '44.9.3',
    });
    expect(gathered.warnings).toEqual([]);
    const created = github.state.calls.filter(([n]) => n === 'createIssue').map(([, f]) => f.title);
    expect(created).toEqual([
      'Ship Electron 44.9.3 (security release), due 2026-10-21',
      'Adopt Electron 45, due 2026-12-16',
    ]);
    expect(github.state.calls[0]).toEqual(['fileAtRef', 'package-lock.json', 'v0.8.7']);
    expect(github.state.calls).toContainEqual(['ensureLabel']);
    expect(result.bumpVersion).toBe('44.9.3');
    expect(result.issueNumber).toBe(900);
  });

  test('an already-open issue is updated, not duplicated', async () => {
    const first = await run();
    const security = first.github.state.issues.find((i) => i.number === 900);
    // A run later: same facts, but the body was edited by hand.
    const github = fakeGitHub({
      issues: [{ ...security, body: `${security.body}\n\nedited` }, first.github.state.issues[1]],
    });
    const { result } = await run({ github });
    expect(github.writes().map(([n, number]) => [n, number])).toEqual([['updateIssue', 900]]);
    expect(github.state.issues).toHaveLength(2);
    expect(result.bumpVersion).toBe('44.9.3');
    expect(result.issueNumber).toBe(900);
  });

  test('a run with nothing new writes nothing', async () => {
    const first = await run();
    const github = fakeGitHub({ issues: first.github.state.issues });
    const { result } = await run({ github });
    expect(github.writes()).toEqual([]);
    expect(result.actions.map((a) => a.type)).toEqual(['unchanged', 'unchanged']);
  });

  test('an open bump pull request is linked, and no second one is asked for', async () => {
    const github = fakeGitHub({
      pulls: { 'electron-watch/electron-44.9.3': [{ number: 905, state: 'open' }] },
    });
    const { result } = await run({ github });
    expect(result.bumpVersion).toBeNull();
    const body = github.state.calls.find(([n]) => n === 'createIssue')[1].body;
    expect(body).toContain('**Bump PR:** #905.');
  });

  test('a pushed branch without a pull request gets a compare link instead of a second push', async () => {
    const github = fakeGitHub({ branches: ['electron-watch/electron-44.9.3'] });
    const { result } = await run({ github });
    expect(result.bumpVersion).toBeNull();
    const body = github.state.calls.find(([n]) => n === 'createIssue')[1].body;
    expect(body).toContain('/compare/main...electron-watch/electron-44.9.3?expand=1');
  });

  test('a newer target supersedes the open issue for an older one', async () => {
    const older = {
      number: 880,
      state: 'open',
      title: 'Ship Electron 44.8.0 (security release), due 2026-10-21',
      body: '<!-- electron-watch:security:44.8.0 -->\nold',
    };
    const github = fakeGitHub({ issues: [older] });
    await run({ github });
    expect(github.state.calls).toContainEqual([
      'commentIssue',
      880,
      'Superseded by #900 (Electron 44.9.3), which carries this deadline forward.',
    ]);
    expect(github.state.calls).toContainEqual([
      'updateIssue',
      880,
      { state: 'closed', state_reason: 'completed' },
    ]);
  });

  test('a security issue a person closed is not reopened, and no bump follows', async () => {
    const closed = {
      number: 870,
      state: 'closed',
      title: 'x',
      body: '<!-- electron-watch:security:44.9.3 -->',
    };
    const github = fakeGitHub({ issues: [closed] });
    const { result } = await run({ github });
    expect(github.state.calls.filter(([n]) => n === 'createIssue').map(([, f]) => f.title)).toEqual(
      ['Adopt Electron 45, due 2026-12-16']
    );
    expect(result.bumpVersion).toBeNull();
  });

  test('main already on the target: the issue stays, no bump', async () => {
    const { result, github } = await run({ pinned: '44.9.3' });
    expect(result.bumpVersion).toBeNull();
    const body = github.state.calls.find(([n]) => n === 'createIssue')[1].body;
    expect(body).toContain('`main` already pins 44.9.3');
  });

  test('a non-security patch opens no security issue', async () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const { result, github } = await run({
      pinned: '44.8.0',
      now,
      github: fakeGitHub({ shipped: '44.8.0' }),
    });
    expect(result.desired).toEqual([]);
    expect(result.bumpVersion).toBeNull();
    expect(github.writes()).toEqual([]);
  });

  test('a dry run writes nothing', async () => {
    const github = fakeGitHub();
    const { result } = await run({ github, dryRun: true });
    expect(github.writes()).toEqual([]);
    expect(result.actions.filter((a) => a.type === 'create')).toHaveLength(2);
  });
});

describe('watch: sources', () => {
  test('KEV is required: both URLs failing fails the run', async () => {
    const fetchers = watch.createFetchers(async (url) => {
      if (url.includes('known_exploited')) throw new Error(`403 from ${new URL(url).host}`);
      if (url.includes('registry.npmjs.org')) return fixture('npm-electron.json');
      if (url.includes('releases.json')) return fixture('electron-releases.json');
      if (url.includes('schedule.json')) return fixture('electron-schedule.json');
      return fixture('chrome-releases-feed.json');
    });
    await expect(run({ fetchers })).rejects.toThrow(/403 from raw\.githubusercontent\.com/);
  });

  test("KEV falls back to CISA's GitHub copy", async () => {
    const seen = [];
    const fetchers = watch.createFetchers(async (url) => {
      seen.push(new URL(url).host);
      if (url.startsWith('https://www.cisa.gov/')) throw new Error('403');
      return fixture('kev.json');
    });
    await expect(fetchers.kev()).resolves.toMatchObject({ catalogVersion: '2026.10.21' });
    expect(seen).toEqual(['www.cisa.gov', 'raw.githubusercontent.com']);
  });

  test("Chrome's blog being down is a warning, named in the issue", async () => {
    const fetchers = fakeFetchers({
      chromePage: async () => {
        throw new Error('503');
      },
    });
    const { gathered, github } = await run({ fetchers });
    expect(gathered.warnings).toEqual(['Chrome release feed: 503']);
    expect(gathered.security.missing).toEqual(['chrome']);
    const body = github.state.calls.find(([n]) => n === 'createIssue')[1].body;
    expect(body).toContain("Not checked this run (source unavailable): Chrome's release notes");
  });

  test('the Chrome feed is read page by page from before the base release', async () => {
    const asked = [];
    const page = fixture('chrome-releases-feed.json');
    const full = { feed: { entry: Array.from({ length: 150 }, () => page.feed.entry[0]) } };
    const posts = await watch.fetchChromePosts(
      {
        chromePage: async (min, start) => {
          asked.push([new Date(min).toISOString(), start]);
          return start === 1 ? full : page;
        },
      },
      Date.parse('2026-08-08T00:00:00Z')
    );
    expect(asked).toEqual([
      ['2026-08-08T00:00:00.000Z', 1],
      ['2026-08-08T00:00:00.000Z', 151],
    ]);
    expect(posts).toHaveLength(150 + page.feed.entry.length);
  });

  test('an unreadable latest release falls back to main for the deadline', async () => {
    const github = fakeGitHub();
    github.fileAtRef = () => {
      throw new Error('HTTP 502');
    };
    const { gathered } = await run({ github });
    expect(gathered.shipped).toBeNull();
    expect(gathered.warnings).toEqual(['latest release: HTTP 502']);
    expect(gathered.security.base).toBe('44.7.0');
  });

  test('createGitHub: 404 is null, other errors throw, issues skip pull requests', () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args.join(' '));
      const target = args.find((a) => a.startsWith('repos/'));
      if (target.includes('/releases/tags/v99.0.0')) {
        const error = new Error('exit 1');
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      if (target.includes('/releases/latest')) {
        const error = new Error('exit 1');
        error.stderr = 'gh: Server Error (HTTP 502)';
        throw error;
      }
      if (target.includes('/issues?'))
        return JSON.stringify([{ number: 1 }, { number: 2, pull_request: {} }]);
      return '{}';
    };
    const gh = watch.createGitHub({ repo: REPO, exec });
    expect(gh.electronRelease('99.0.0')).toBeNull();
    expect(() => gh.latestRelease()).toThrow(/HTTP 502/);
    expect(gh.listIssues()).toEqual([{ number: 1 }]);
    expect(calls[2]).toBe(
      `api repos/${REPO}/issues?labels=security-release&state=all&per_page=100&page=1`
    );
  });
});

describe('bump', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-watch-bump-'));
    for (const f of [
      'package.json',
      'package-lock.json',
      'licenses-audit.json',
      'LICENSE_AUDIT.md',
    ]) {
      fs.copyFileSync(path.join(repoRoot, f), path.join(root, f));
    }
    fs.mkdirSync(path.join(root, 'changelog.d'));
    fs.copyFileSync(
      path.join(repoRoot, 'changelog.d', 'README.md'),
      path.join(root, 'changelog.d', 'README.md')
    );
    fs.writeFileSync(path.join(root, 'changelog.d', 'fixed--1-something.md'), '- Something\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const pinned = () =>
    JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[
      'node_modules/electron'
    ].version;

  /** Stands in for `npm install --package-lock-only --save-dev electron@<v>`. */
  function fakeNpm(calls) {
    return (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (cmd === 'npm' && args[0] === '--version') return '11.19.0\n';
      if (cmd === 'npm' && args[0] === 'install') {
        const version = args[args.length - 1].split('@')[1];
        const pkgPath = path.join(opts.cwd, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        pkg.devDependencies.electron = `^${version}`;
        fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
        const lockPath = path.join(opts.cwd, 'package-lock.json');
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        lock.packages[''].devDependencies.electron = `^${version}`;
        lock.packages['node_modules/electron'].version = version;
        fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      }
      return '';
    };
  }

  test('moves every file that records the Electron version, resolving without running package code', async () => {
    const from = pinned();
    const calls = [];
    const b = await watch.applyBump({
      version: '44.9.3',
      root,
      exec: fakeNpm(calls),
      fetchers: fakeFetchers(),
    });
    expect(calls[0]).toEqual([
      'npm',
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-dev',
      'electron@44.9.3',
    ]);
    expect(pinned()).toBe('44.9.3');
    const audit = JSON.parse(fs.readFileSync(path.join(root, 'licenses-audit.json'), 'utf8'));
    expect(audit.dependencies.find((d) => d.name === 'electron').version).toBe('44.9.3');
    expect(fs.readFileSync(path.join(root, 'LICENSE_AUDIT.md'), 'utf8')).toContain(
      '- **Version:** 44.9.3 (lockfile-resolved)'
    );
    expect(b).toMatchObject({
      pinned: from,
      version: '44.9.3',
      fragment: 'changelog.d/security--deps-electron-44.9.3.md',
      abiChanged: false,
      npm: '11.19.0',
    });
    expect(fs.readFileSync(path.join(root, b.fragment), 'utf8')).toBe(
      `- Updated runtime dependencies:\n  - Electron ${from} to 44.9.3 (${W.chromiumNodeDetail(
        fixture('electron-releases.json').find((e) => e.version === from),
        fixture('electron-releases.json').find((e) => e.version === '44.9.3')
      )})\n`
    );
    // The changelog.d/ guard accepts what it wrote, and the assembler files it under Security.
    const { collectFragments } = require('./assemble-changelog');
    expect([...collectFragments(path.join(root, 'changelog.d')).keys()].sort()).toEqual([
      'Fixed',
      'Security',
    ]);
  });

  test.each([
    ['45.0.0', /across majors/],
    ['44.0.0', /already at or past/],
    ['44.9', /must be x\.y\.z/],
    ['44.9.3; rm -rf /', /must be x\.y\.z/],
  ])('refuses %s', async (version, message) => {
    await expect(
      watch.applyBump({ version, root, exec: fakeNpm([]), fetchers: fakeFetchers() })
    ).rejects.toThrow(message);
  });

  test('npm resolving something else fails the bump', async () => {
    const exec = (cmd, args) => (args[0] === '--version' ? '11.19.0' : '');
    await expect(
      watch.applyBump({ version: '44.9.3', root, exec, fetchers: fakeFetchers() })
    ).rejects.toThrow(/npm left electron at/);
  });

  test('main having moved past the version since the watch job is a no-op, not a failure', async () => {
    const output = path.join(root, 'github-output');
    const saved = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = output;
    try {
      const calls = [];
      const out = await watch.runBump(
        { command: 'bump', version: pinned(), openPr: false },
        { root, exec: fakeNpm(calls), fetchers: fakeFetchers(), github: fakeGitHub() }
      );
      expect(out).toEqual({ bump: null });
      expect(calls).toEqual([]);
      expect(fs.readFileSync(output, 'utf8')).toBe('dispatch_ci=false\n');
    } finally {
      if (saved === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = saved;
    }
  });
});

describe('open the pull request', () => {
  const bump = {
    pinned: '44.7.0',
    version: '44.9.3',
    from: '44.7.0',
    fragment: 'changelog.d/security--deps-electron-44.9.3.md',
    fragmentText: '- Updated runtime dependencies:\n  - Electron 44.7.0 to 44.9.3\n',
    abiChanged: false,
    npm: '11.19.0',
  };

  function fakeGit(status) {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return cmd === 'git' && args[0] === 'status' ? status : '';
    };
    return { calls, exec };
  }

  test('commits only the bump, pushes a new branch without force, and opens the PR against main', () => {
    const { calls, exec } = fakeGit(
      ' M LICENSE_AUDIT.md\n M licenses-audit.json\n M package-lock.json\n M package.json\n?? changelog.d/security--deps-electron-44.9.3.md\n'
    );
    const github = fakeGitHub();
    const out = watch.openPullRequest(bump, { issue: 900, repo: REPO, github, exec, root: '/x' });
    expect(out).toEqual({
      branch: 'electron-watch/electron-44.9.3',
      pr: { number: 950, url: `https://github.com/${REPO}/pull/950` },
    });
    const push = calls.find((c) => c.includes('push'));
    expect(push).toContain('HEAD:refs/heads/electron-watch/electron-44.9.3');
    expect(push.join(' ')).not.toMatch(/--force|\+HEAD/);
    expect(push.join(' ')).not.toMatch(/ghp_|ghs_/);
    const [, pr] = github.state.calls.find(([n]) => n === 'createPull');
    expect(pr).toMatchObject({
      head: 'electron-watch/electron-44.9.3',
      base: 'main',
      title: 'chore(deps): Electron 44.9.3 (security release)',
    });
    expect(pr.body).toContain('Refs #900');
    expect(pr.body).toContain('dispatches `ci.yml` on this branch');
    const commit = calls.find((c) => c.includes('commit'));
    expect(commit.join(' ')).toContain('user.name=github-actions[bot]');
    expect(commit[commit.length - 1]).toMatch(
      /^chore\(deps\): Electron 44\.9\.3 \(security release\)\n/
    );
  });

  test('anything outside the bump in the tree stops the push', () => {
    const { calls, exec } = fakeGit(' M package.json\n M scripts/electron-watch.js\n');
    expect(() =>
      watch.openPullRequest(bump, {
        issue: 900,
        repo: REPO,
        github: fakeGitHub(),
        exec,
        root: '/x',
      })
    ).toThrow(/outside the bump: scripts\/electron-watch\.js/);
    expect(calls.some((c) => c.includes('push'))).toBe(false);
  });

  test('a repository that does not let Actions open pull requests gets the branch and a compare link', () => {
    const { exec } = fakeGit(' M package.json\n');
    const github = fakeGitHub();
    github.createPull = () => {
      throw new Error(
        'gh api -X POST repos/x/pulls: GitHub Actions is not permitted to create or approve pull requests. (HTTP 403)'
      );
    };
    const out = watch.openPullRequest(bump, { issue: 900, repo: REPO, github, exec, root: '/x' });
    expect(out).toEqual({
      branch: 'electron-watch/electron-44.9.3',
      pr: null,
      compare: `https://github.com/${REPO}/compare/main...electron-watch/electron-44.9.3?expand=1`,
    });
  });
});

describe('arguments', () => {
  test('parses both commands and rejects the rest', () => {
    expect(watch.parseArgs(['watch', '--dry-run', '--now', '2026-10-23T12:00:00Z'])).toMatchObject({
      command: 'watch',
      dryRun: true,
      now: NOW,
    });
    expect(
      watch.parseArgs(['bump', '--version', '44.9.3', '--issue', '900', '--open-pr'])
    ).toMatchObject({
      command: 'bump',
      version: '44.9.3',
      issue: 900,
      openPr: true,
    });
    expect(watch.parseArgs(['bump', '--version', '44.9.3', '--issue', ''])).toMatchObject({
      issue: null,
    });
    expect(() => watch.parseArgs(['bump', '--issue', '9; x'])).toThrow(/issue number/);
    expect(() => watch.parseArgs(['merge'])).toThrow(/usage/);
    expect(() => watch.parseArgs(['watch', '--force'])).toThrow(/unknown argument/);
  });
});
