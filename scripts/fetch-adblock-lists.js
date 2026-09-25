const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchText, TIMEOUTS } = require('./lib/fetch-with-retry');
const { Resources, evaluatePreprocessor } = require('@ghostery/adblocker');
const ADBLOCKER_VERSION = require('@ghostery/adblocker/package.json').version;

// Fetches the EasyList-family filter lists the adblock service compiles at
// runtime (src/main/adblock/service.js) and writes them, plus a manifest,
// to assets/adblock/. The directory is gitignored and packaged via
// extraResources — run this before a dist build (like ant:download etc.).
//
// The catalog mirrors freedom-adblock-service/sources.json (the iOS artifact
// builder) so both platforms block from the same lists. The Swarm-distributed
// update channel will publish these same artifacts; bundled copies are the
// offline/first-launch fallback.
//
// EasyList/EasyPrivacy are dual-licensed GPLv3+ / CC BY-SA 3.0+; Freedom
// redistributes under CC BY-SA with attribution (see NOTICES).
//
// The `ublock` category and the scriptlet resources are different: the uBlock
// Origin filters (uAssets) and the scriptlets bundled in resources.json are
// GPL-3.0 only. They are shipped as separate, unmodified-in-substance data
// files next to the MPL-2.0 application and loaded at runtime — see NOTICES
// and LICENSE_AUDIT.md for the licensing position (#410). They are bundled
// only: the Swarm update channel (freedom-adblock-service/sources.json) does
// not publish them yet, so they refresh with each release.
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'adblock');

const CATEGORIES = {
  ads: {
    file: 'easylist.txt',
    title: 'EasyList',
    sourceUrl: 'https://easylist.to/easylist/easylist.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
  privacy: {
    file: 'easyprivacy.txt',
    title: 'EasyPrivacy',
    sourceUrl: 'https://easylist.to/easylist/easyprivacy.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
  cookies: {
    file: 'easylist-cookies.txt',
    title: 'Fanboy Cookiemonster',
    sourceUrl: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
  annoyances: {
    file: 'easylist-annoyances.txt',
    title: 'Fanboy Annoyances',
    sourceUrl: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
  // uBlock Origin's own filters plus its Quick fixes — the lists that carry
  // the YouTube ad-pruning scriptlets (`youtube.com##+js(json-prune, …)`).
  // Gated by the same "Block ads" setting as EasyList (service.js), but kept
  // a separate category so a Swarm update carrying only `ads` can't shadow it.
  ublock: {
    file: 'ublock-filters.txt',
    title: 'uBlock filters',
    sourceUrl: 'https://ublockorigin.github.io/uAssets/filters/filters.txt',
    extraSourceUrls: ['https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt'],
    license: 'GPL-3.0-only',
    format: 'ublock',
    // The Pages site above serves this repo branch. The build resolves the
    // branch head once and downloads every file at that commit from
    // raw.githubusercontent.com, so the manifest and the list header can name
    // an exact, permanent source (a GitHub URL at a commit, not a branch).
    // If the commit can't be resolved (API down, rate-limited) it falls back
    // to the Pages URLs and records the fetch date instead.
    pin: {
      repo: 'uBlockOrigin/uAssets',
      branch: 'gh-pages',
      pagesBase: 'https://ublockorigin.github.io/uAssets/',
    },
  },
};

// Scriptlet + redirect resources for `+js(...)` / `$redirect=` rules, in the
// JSON shape @ghostery/adblocker's `engine.updateResources()` parses. The
// file is Ghostery's build of uBlock Origin's scriptlets, and it is
// executable code injected into pages, so it is pinned the way this repo pins
// every other downloaded executable: a fixed upstream tag plus an in-repo
// sha256, checked before anything is written. The tag is the installed
// @ghostery/adblocker release (fetch-adblock-lists.test.js fails if the two
// drift apart), so bumping the library is the moment to re-pin this.
//
// `upstream` records where those bytes come from, for GPL-3.0 §6 (the script
// bodies are minified, so the corresponding source is uBlock Origin's own
// tree). Ghostery doesn't label its build with a uBlock revision, so the
// revision was identified by content and is re-checkable by anyone:
//   - the file last changed in ghostery/adblocker at `ghostery.commit`
//     (2026-08-04 12:06 UTC), written by `ghostery.buildScript`, which copies
//     Ghostery's CDN build of uBlock's resources verbatim;
//   - its 148 scriptlet names equal exactly the set uBlock's
//     src/js/resources/ declares from be3bb05f (07-20) to 505fbc7a (08-06),
//     and `prevent-clipboard-write` already takes `excludeMatches` as a vararg
//     (0e1001f5, 08-02) while every scriptlet still calls `getExtraArgs`
//     (renamed in 505fbc7a) — no other commit touches that directory in
//     between, so the source tree is 0e1001f5's;
//   - uBlock tag 1.72.3rc4 is that tree (released 08-02, the last tag before
//     Ghostery's build), and 1.73.0 stable ships byte-identical
//     src/js/resources/, src/js/redirect-resources.js and
//     src/web_accessible_resources/ (same git tree hashes).
// The `MIME_TYPE_STUB.*` redirects are Ghostery's additions, not uBlock's.
// Re-derive all of this when bumping the tag; the test only guards the tag.
const RESOURCES = {
  file: 'resources.json',
  title: 'uBlock Origin scriptlets and redirect resources (via @ghostery/adblocker)',
  tag: 'v2.18.2',
  sourceUrl:
    'https://raw.githubusercontent.com/ghostery/adblocker/v2.18.2/packages/adblocker/assets/ublock-origin/resources.json',
  sha256: 'e14b498f693c4166d27971f7fdfe49b167c139a8e659cc59bedc9ab29a2348f5',
  license: 'GPL-3.0-only',
  upstream: {
    ublockOrigin: {
      repo: 'gorhill/uBlock',
      tag: '1.72.3rc4',
      commit: 'de31aee0fcd69dc89cde558f1a0638c1aa77b75e',
      sourceUrl:
        'https://github.com/gorhill/uBlock/tree/de31aee0fcd69dc89cde558f1a0638c1aa77b75e/src/js/resources',
      sameSourceAsRelease: '1.73.0',
      sameSourceAsReleaseUrl: 'https://github.com/gorhill/uBlock/tree/1.73.0/src/js/resources',
    },
    ghostery: {
      repo: 'ghostery/adblocker',
      tag: 'v2.18.2',
      tagCommit: 'c4c20aa63e3a72113f66777cf35a3f58877a36ee',
      commit: 'e08ecf7fe10f929d5053234017d72d65001640a6',
      commitUrl:
        'https://github.com/ghostery/adblocker/commit/e08ecf7fe10f929d5053234017d72d65001640a6',
      buildScript:
        'https://github.com/ghostery/adblocker/blob/v2.18.2/packages/adblocker/assets/update.js',
    },
  },
};

// GPL-3.0 §4/§6: the uBlock filters and scriptlets must travel with the
// licence text. Fixed text, so pinned the same way.
const GPL_TEXT = {
  file: 'COPYING.GPL-3.0.txt',
  sourceUrl: 'https://www.gnu.org/licenses/gpl-3.0.txt',
  sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
};

// `!#if` tokens for uBlock-format lists, evaluated here at build time because
// the engine is built with preprocessors off (with them off, @ghostery would
// load *both* branches of every `!#if … !#else`). Freedom is a Chromium
// desktop browser without HTML filtering; any token not listed is false.
const UBLOCK_ENV = new Map([['env_chromium', true]]);
const MAX_INCLUDE_DEPTH = 3;

function countRules(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('!') && !trimmed.startsWith('[')) count++;
  }
  return count;
}

// Downloads go through scripts/lib/fetch-with-retry.js, which uses plain
// `https` rather than the global fetch: when a list server drops the TLS
// connection mid-body, Node 24's undici can die on an internal assertion
// (`assert(!this.paused)`) that surfaces as an uncaught exception, outside
// any try/catch — the v0.8.5-rc.1 release run failed exactly that way. The
// https client reports the same condition as a catchable 'error', so the
// retry loop actually gets a chance to run.
function download(url, options = {}) {
  return fetchText(url, {
    label: `${url} download`,
    headers: { 'User-Agent': 'Freedom-Adblock-Fetcher' },
    // These are a few megabytes of text, not a binary — but easylist.to is
    // routinely slow, so it gets more than the metadata deadline.
    timeoutMs: TIMEOUTS.list,
    ...options,
  });
}

/**
 * The shape check is deliberately outside the retry loop, like a checksum: a
 * server that answered 200 with something that is not a filter list is not
 * going to answer differently three seconds later, and installing it would
 * silently disable blocking.
 *
 * Resolves to `{ text, source }`; `source` is the exact upstream revision for
 * lists that have one (the uBlock category), null otherwise.
 */
async function fetchList(category, meta, options = {}) {
  if (meta.format === 'ublock') return fetchUblockList(meta, options);
  const text = await download(meta.sourceUrl, { label: `${meta.title} download`, ...options });
  if (!text.includes('[Adblock')) {
    throw new Error(`${meta.sourceUrl} does not look like an ABP filter list`);
  }
  return { text, source: null };
}

/**
 * Evaluate `!#if` / `!#else` / `!#endif` blocks against UBLOCK_ENV and splice
 * in `!#include <file>` directives (resolved against the including list's own
 * URL, same directory only — uBlock's rule). The result is plain filter text
 * the engine can parse with preprocessors off.
 */
async function resolveUblockText(text, baseUrl, fetchOne, depth = 0) {
  const out = [];
  // One frame per open `!#if`: whether its current branch is live.
  const stack = [];
  const live = () => stack.every((frame) => frame.active);
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('!#if ')) {
      const cond = evaluatePreprocessor(line.slice(5).trim(), UBLOCK_ENV);
      stack.push({ cond, active: cond });
      continue;
    }
    if (line.trim() === '!#else') {
      const frame = stack[stack.length - 1];
      if (!frame) throw new Error(`${baseUrl}: !#else without !#if`);
      frame.active = !frame.cond;
      continue;
    }
    if (line.trim() === '!#endif') {
      if (!stack.pop()) throw new Error(`${baseUrl}: !#endif without !#if`);
      continue;
    }
    if (!live()) continue;
    if (line.startsWith('!#include ')) {
      const name = line.slice('!#include '.length).trim();
      if (depth >= MAX_INCLUDE_DEPTH) throw new Error(`${baseUrl}: !#include nested too deep`);
      const includeUrl = new URL(name, baseUrl);
      const base = new URL('.', baseUrl);
      if (includeUrl.origin !== base.origin || !includeUrl.pathname.startsWith(base.pathname)) {
        throw new Error(`${baseUrl}: refusing out-of-tree !#include ${name}`);
      }
      const included = await fetchOne(includeUrl.href);
      out.push(await resolveUblockText(included, includeUrl.href, fetchOne, depth + 1));
      continue;
    }
    out.push(line);
  }
  if (stack.length > 0) throw new Error(`${baseUrl}: unterminated !#if`);
  return out.join('\n');
}

// Top-level uBlock lists carry a `! Title:` header; the files they
// `!#include` (filters-2024.txt, …) don't always, so those only have to not be
// an HTML error page.
function assertUblockList(text, url, { topLevel }) {
  const head = text.slice(0, 2048);
  if (topLevel ? !/^! Title: uBlock/m.test(head) : /^\s*</.test(head)) {
    throw new Error(`${url} does not look like a uBlock filter list`);
  }
}

// GPL-3.0 §5(a): the list Freedom ships is a modified work (branches
// evaluated, includes spliced, Quick fixes appended), so it says so up front,
// and names the exact source revision it was built from.
function ublockHeader(meta, source) {
  return [
    `! Title: ${meta.title} (Freedom build)`,
    `! Built by Freedom's scripts/fetch-adblock-lists.js on ${source.fetchedAt.slice(0, 10)} from:`,
    ...source.urls.map((url) => `!   ${url}`),
    source.commit
      ? `! (${source.repo} commit ${source.commit})`
      : `! (commit unresolved: fetched from the live site on ${source.fetchedAt})`,
    '! Modified: `!#if` blocks evaluated for a Chromium desktop build, `!#include`',
    '! files spliced in, lists concatenated. Rules themselves are unchanged.',
    '! License: GPL-3.0 (see COPYING.GPL-3.0.txt next to this file).',
    '! Copyright (C) Raymond Hill and the uBlock Origin contributors,',
    '! https://github.com/uBlockOrigin/uAssets',
    '',
  ].join('\n');
}

const GITHUB_API_HOST = 'api.github.com';

/**
 * The commit a branch points at right now, or null when GitHub can't say
 * (the caller then falls back to the Pages URLs). Like fetch-ant.js, the
 * token only goes to GitHub's own API host, recomputed per redirect hop.
 */
async function resolveBranchCommit({ repo, branch }, options = {}) {
  const url = `https://${GITHUB_API_HOST}/repos/${repo}/commits/${branch}`;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try {
    const sha = (
      await fetchText(url, {
        label: `${repo}@${branch} commit lookup`,
        timeoutMs: TIMEOUTS.metadata,
        ...options,
        headers: (hop) => ({
          'User-Agent': 'Freedom-Adblock-Fetcher',
          Accept: 'application/vnd.github.sha',
          ...(token && new URL(hop).host === GITHUB_API_HOST
            ? { Authorization: `Bearer ${token}` }
            : {}),
        }),
      })
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected answer ${JSON.stringify(sha)}`);
    return sha;
  } catch (err) {
    (options.log || console.warn)(
      `\n⚠️  Could not resolve ${repo}@${branch} (${err.message}); ` +
        'fetching from the live site and recording the fetch date instead of a commit.'
    );
    return null;
  }
}

async function fetchUblockList(meta, options = {}) {
  const fetchedAt = new Date().toISOString();
  const { repo, branch, pagesBase } = meta.pin;
  const commit = await resolveBranchCommit(meta.pin, options);
  const pagesUrls = [meta.sourceUrl, ...(meta.extraSourceUrls || [])];
  const atCommit = (url, host) => {
    if (!commit) return url;
    if (!url.startsWith(pagesBase)) throw new Error(`${url} is not under ${pagesBase}`);
    return `${host}${url.slice(pagesBase.length)}`;
  };
  const rawBase = `https://raw.githubusercontent.com/${repo}/${commit}/`;
  const source = {
    repo,
    branch,
    commit,
    fetchedAt,
    // Permanent, human-readable URLs at the commit (or the Pages URLs).
    urls: pagesUrls.map((url) => atCommit(url, `https://github.com/${repo}/blob/${commit}/`)),
    ...(commit ? { treeUrl: `https://github.com/${repo}/tree/${commit}` } : {}),
  };
  const fetchOne = async (url, topLevel = false) => {
    const text = await download(url, { label: `${meta.title} download (${url})`, ...options });
    assertUblockList(text, url, { topLevel });
    return text;
  };
  const parts = [ublockHeader(meta, source)];
  for (const pagesUrl of pagesUrls) {
    const url = atCommit(pagesUrl, rawBase);
    parts.push(await resolveUblockText(await fetchOne(url, true), url, fetchOne));
  }
  return { text: parts.join('\n'), source };
}

/**
 * Download the pinned resources file and refuse anything whose digest isn't
 * the in-repo pin, or that the engine can't parse.
 */
async function fetchResources(options = {}) {
  const text = await fetchPinnedText(RESOURCES, 'scriptlet resources download', options);
  const digest = RESOURCES.sha256;
  const parsed = Resources.parse(text, { checksum: digest });
  if (parsed.scriptlets.length === 0) {
    throw new Error('scriptlet resources contain no scriptlets');
  }
  return { text, digest, scriptletCount: parsed.scriptlets.length };
}

/** Download a pinned text file and refuse anything but the pinned bytes. */
async function fetchPinnedText({ sourceUrl, sha256 }, label, options = {}) {
  const text = await download(sourceUrl, { label, ...options });
  const digest = crypto.createHash('sha256').update(text).digest('hex');
  if (digest !== sha256) {
    throw new Error(`${label}: sha256 mismatch: expected ${sha256}, got ${digest}`);
  }
  return text;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const manifest = {
    version: new Date().toISOString().slice(0, 10),
    fetchedAt: new Date().toISOString(),
    categories: {},
  };

  for (const [category, meta] of Object.entries(CATEGORIES)) {
    process.stdout.write(`Fetching ${meta.title} (${category})... `);
    const { text, source } = await fetchList(category, meta);
    fs.writeFileSync(path.join(OUTPUT_DIR, meta.file), text, 'utf-8');
    manifest.categories[category] = {
      file: meta.file,
      title: meta.title,
      sourceUrl: meta.sourceUrl,
      ...(source ? { source } : {}),
      license: meta.license,
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
      ruleCount: countRules(text),
    };
    console.log(`${manifest.categories[category].ruleCount} rules`);
  }

  process.stdout.write('Fetching scriptlet resources... ');
  const resources = await fetchResources();
  fs.writeFileSync(path.join(OUTPUT_DIR, RESOURCES.file), resources.text, 'utf-8');
  manifest.resources = {
    file: RESOURCES.file,
    title: RESOURCES.title,
    sourceUrl: RESOURCES.sourceUrl,
    version: RESOURCES.tag,
    upstream: RESOURCES.upstream,
    license: RESOURCES.license,
    sha256: resources.digest,
    bytes: Buffer.byteLength(resources.text),
    scriptletCount: resources.scriptletCount,
  };
  console.log(`${resources.scriptletCount} scriptlets (${RESOURCES.tag})`);

  process.stdout.write('Fetching GPL-3.0 text... ');
  const gpl = await fetchPinnedText(GPL_TEXT, 'GPL-3.0 text download');
  fs.writeFileSync(path.join(OUTPUT_DIR, GPL_TEXT.file), gpl, 'utf-8');
  manifest.licenseFiles = [GPL_TEXT.file];
  console.log('ok');

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  console.log(
    `\n✅ Wrote ${Object.keys(CATEGORIES).length} lists + resources + manifest to ${OUTPUT_DIR}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  });
}

// Exported for unit tests; `npm run adblock:download` still runs main() above.
module.exports = {
  CATEGORIES,
  RESOURCES,
  GPL_TEXT,
  UBLOCK_ENV,
  ADBLOCKER_VERSION,
  countRules,
  download,
  fetchList,
  fetchResources,
  resolveBranchCommit,
  resolveUblockText,
  main,
};
