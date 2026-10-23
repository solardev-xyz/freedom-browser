#!/usr/bin/env node

// Smoke test for the IPFS node (`npm run ipfs:native:smoke`, run per shipped
// target by ci.yml's freedom-ipfsd-smoke job against the freedom-ipfsd
// service, the default, and its freedom-ipfs-native-addon job against the
// add-on, the rollback: freedom-core design 0007). The checks below are the
// same for both; "the addon" means whichever node is under test.
//
// Hard failures (always exit 1): the addon doesn't load or reports the wrong
// target, the node doesn't start or isn't healthy, the diagnostics snapshots
// aren't valid, or the local gateway can't serve the empty identity CID
// `bafkqaaa` (content inlined in the CID itself, so no network is involved).
//
// The live-network leg fetches an immutable, widely provided /ipfs/<cid> (no
// IPNS lookup) and retries the failures only the network can explain (HTTP
// 502/504 without an addon error code, and timeouts: ours or the native
// wrapper's own no-headers timeout) with backoff inside a bounded budget. If
// the network still can't be reached, it prints a GitHub Actions ::warning::
// annotation and passes, unless strict mode is set. Any other live-leg failure
// (a 4xx, a 500, a 503 gateway_busy or any addon error code, an empty or wrong
// body, another request error, the node going unhealthy) still fails the run.
// The issue #102 root page fetch goes through the same retry/warn logic; its
// gateway_busy fan-out assertions stay hard. See issue #747.
//
// Environment:
//   FREEDOM_IPFS_BACKEND                 `addon` = the add-on; anything else = the
//                                        freedom-ipfsd service, at FREEDOM_IPFSD_PATH
//                                        or freedom-ipfsd-bin/<os>-<arch>/.
//   FREEDOM_IPFS_NATIVE_SMOKE_TARGET     expected `<platform>-<arch>`; fail on mismatch.
//   FREEDOM_IPFS_NATIVE_SMOKE_LIVE       live leg mode: unset/`1`/`warn` (default) =
//                                        network failure is a warning; `strict` = it
//                                        fails the run; `0`/`off` = skip the live leg.
//   FREEDOM_IPFS_NATIVE_SMOKE_PATH       gateway path for the live leg
//                                        (default: DEFAULT_LIVE_PATH below).
//   FREEDOM_IPFS_NATIVE_SMOKE_EXPECT     text the live body must contain (case-insensitive;
//                                        empty = only require a non-empty body). Defaults
//                                        to DEFAULT_LIVE_EXPECT when PATH is not overridden.
//   FREEDOM_IPFS_NATIVE_SMOKE_ATTEMPTS   max live attempts (default 5).
//   FREEDOM_IPFS_NATIVE_SMOKE_BUDGET_MS  total live-leg budget incl. backoff (default 180000).
//   FREEDOM_IPFS_NATIVE_SMOKE_ISSUE_102  issue #102 high-fanout check: unset/`0`/`off` (default)
//                                        = skip; `1`/`warn` = run, network failure on its root
//                                        page is a warning; `strict` = it fails the run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FreedomIpfsNativeNode,
  REQUEST_TIMEOUT_CODE,
} = require('../src/main/ipfs/freedom-ipfs-native-node');
const { FreedomIpfsdNode } = require('../src/main/ipfs/freedom-ipfsd-node');

// The node under test, chosen as the app chooses it: the freedom-ipfsd
// service process by default, through the production FreedomIpfsdNode and
// the binary at FREEDOM_IPFSD_PATH or freedom-ipfsd-bin/<os>-<arch>/
// (freedom-core design 0007, step 6), or with FREEDOM_IPFS_BACKEND=addon the
// add-on (Rollback). The checks and expectations are the same for both.
const BACKEND = process.env.FREEDOM_IPFS_BACKEND === 'addon' ? 'addon' : 'service';
// A request that got no response headers in time: the add-on's own
// headers timeout, or the service's `deadline` (freedom-ipfsd-node.js).
const REQUEST_TIMEOUT_CODES = new Set([REQUEST_TIMEOUT_CODE, 'deadline']);

// The IPFS public-gateway-checker's test CID: immutable and pinned by many
// gateways and providers, so it needs no IPNS resolution (ipfs.tech's IPNS
// name timed out with HTTP 504 often enough to fail CI, see #747).
const DEFAULT_LIVE_PATH = '/ipfs/bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m/';
const DEFAULT_LIVE_EXPECT = 'Hello from IPFS Gateway Checker';
const DEFAULT_LIVE_ATTEMPTS = 5;
const DEFAULT_LIVE_BUDGET_MS = 180_000;
const LIVE_TIMEOUT_MS = 45_000;
const LIVE_BACKOFF_BASE_MS = 2_000;
const LIVE_BACKOFF_MAX_MS = 30_000;
// Don't start a retry with less than this left in the budget: it would almost
// certainly time out and only pad the warning with a meaningless failure.
const LIVE_MIN_ATTEMPT_MS = 10_000;
// Statuses the addon's gateway uses for a provider lookup or retrieval that
// failed or timed out (freedom-ipfs v0.4.6 gateway_error(): BadGateway/Unixfs
// -> 502, retrieval timeout -> 504), i.e. network weather. Its own faults use
// other statuses (500 Internal, 503 + `x-freedom-ipfs-error-code: gateway_busy`)
// and stay hard failures, as does any response carrying an addon error code.
const LIVE_NETWORK_STATUSES = new Set([502, 504]);
// The empty identity CID: its (zero) bytes are inlined in the CID itself, so
// the local gateway answers it without touching the network. It is also the
// fingerprint the app's own IPFS gateway probes use. (As of 2026-10-19, the
// v0.4.6 addon answers this one locally but 504s non-empty identity CIDs, so
// don't swap in a CID with content without re-checking.)
const LOCAL_TEXT = '';
const LOCAL_PATH = '/ipfs/bafkqaaa';
const LOCAL_TIMEOUT_MS = 30_000;
const ISSUE_102_PATH =
  '/ipfs/bafybeiccfclkdtucu6y4yc5cpr6y3yuinr67svmii46v5cfcrkp47ihehy/frontend/pages/QXBvbGxvIDEyIE1hZ2F6aW5lIDUwL1E=.html';
const ISSUE_102_CONCURRENCY = 48;
const ISSUE_102_MAX_ASSETS = 96;
const ISSUE_102_ASSET_TIMEOUT_MS = 30_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJson(label, value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label} was not valid JSON: ${err.message}`, { cause: err });
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTitle(body) {
  const match = body.match(/<title[^>]*>(.*?)<\/title>/is);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

function gatewayPathToIpfsUrl(gatewayPath) {
  const match = gatewayPath.match(/^\/(ipfs|ipns)\/([^/?#]+)([^?#]*)?(\?[^#]*)?(#.*)?$/);
  if (!match) return null;
  const [, protocol, host, pathname = '/', search = '', hash = ''] = match;
  return `${protocol}://${host}${pathname || '/'}${search}${hash}`;
}

function ipfsUrlToGatewayPath(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'ipfs:' && url.protocol !== 'ipns:') return null;
  return `/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}`;
}

function discoverIpfsSubresources(html, baseGatewayPath) {
  const baseUrl = gatewayPathToIpfsUrl(baseGatewayPath);
  if (!baseUrl) return [];

  const resources = new Set();
  const attrPattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrPattern.exec(html))) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('javascript:')) {
      continue;
    }
    try {
      const resolved = new URL(raw, baseUrl).toString();
      const gatewayPath = ipfsUrlToGatewayPath(resolved);
      if (gatewayPath && gatewayPath !== baseGatewayPath) resources.add(gatewayPath);
    } catch {
      // Ignore malformed subresource references in live pages.
    }
  }

  return [...resources];
}

/**
 * The backend behind one surface: `request(init)`, the node's `request()` on
 * what it serves now; `stats()`, its gateway counters as of now (the
 * service's come in `ipfs.stats` replies, so a fresh one is asked for); and
 * `isHealthy()`.
 */
function smokeBackend(dataDir) {
  if (BACKEND === 'service') {
    const node = new FreedomIpfsdNode({
      // As the app lays it out: the store's directory, and a lock directory
      // outside it.
      dataDir: path.join(dataDir, 'freedom-ipfs'),
      lockDir: path.join(dataDir, 'locks'),
      shellVersion: 'smoke',
    });
    return {
      node,
      label: 'freedom-ipfsd service',
      available: () => FreedomIpfsdNode.isAvailable(),
      request: (init) => node.request(node.capture(), init),
      isHealthy: () => node.isHealthy(),
      async stats(label) {
        await node.statsFlight;
        await node.refreshStats();
        return parseJson(label, node.nativeGatewayStatsJson());
      },
    };
  }
  const node = new FreedomIpfsNativeNode({ dataDir });
  return {
    node,
    label: 'freedom-ipfs native addon',
    available: () => FreedomIpfsNativeNode.isAvailable(),
    request: (init) => node.request(init),
    isHealthy: () => node.isHealthy(),
    stats: async (label) => parseJson(label, node.nativeGatewayStatsJson()),
  };
}

async function requestText(node, gatewayPath, { signal } = {}) {
  const response = await node.request({
    method: 'GET',
    path: gatewayPath,
    headers: new Headers({
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }),
    signal,
  });
  const body = await response.text();
  return { response, body };
}

function parseMode(name, defaultMode) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return defaultMode;
  if (['1', 'on', 'true', 'yes', 'warn'].includes(raw)) return 'warn';
  if (['0', 'off', 'false', 'no'].includes(raw)) return 'off';
  if (raw === 'strict') return 'strict';
  throw new Error(`${name}=${JSON.stringify(raw)} is not one of warn, strict, 0`);
}

function liveMode() {
  return parseMode('FREEDOM_IPFS_NATIVE_SMOKE_LIVE', 'warn');
}

function issue102Mode() {
  return parseMode('FREEDOM_IPFS_NATIVE_SMOKE_ISSUE_102', 'off');
}

function liveRetryOptions() {
  return {
    attempts: parsePositiveInt(
      process.env.FREEDOM_IPFS_NATIVE_SMOKE_ATTEMPTS,
      DEFAULT_LIVE_ATTEMPTS
    ),
    budgetMs: parsePositiveInt(
      process.env.FREEDOM_IPFS_NATIVE_SMOKE_BUDGET_MS,
      DEFAULT_LIVE_BUDGET_MS
    ),
  };
}

// Escape per the GitHub Actions workflow-command format.
function annotationEscape(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// A failure the network, not the addon, can explain: the attempt timed out
// (our abort, or the native wrapper's own ATTEMPT_TIMEOUT_MS with no headers),
// or the gateway answered 502/504 with no addon error code.
class LiveNetworkError extends Error {}

async function loadLocalContent(node) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  try {
    const { response, body } = await requestText(node, LOCAL_PATH, {
      signal: controller.signal,
    });
    assert(response.status === 200, `local identity CID returned HTTP ${response.status}`);
    assert(
      body === LOCAL_TEXT,
      `local identity CID body was ${JSON.stringify(body.slice(0, 200))}, expected ${JSON.stringify(LOCAL_TEXT)}`
    );
    return { path: LOCAL_PATH, status: response.status, bytes: body.length };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`local identity CID did not answer within ${LOCAL_TIMEOUT_MS}ms`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function liveAttempt(node, smokePath, expectedText, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let result;
  try {
    result = await requestText(node, smokePath, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new LiveNetworkError(`${label} timed out after ${timeoutMs}ms`, { cause: err });
    }
    if (REQUEST_TIMEOUT_CODES.has(err?.code)) {
      throw new LiveNetworkError(`${label}: ${err.message}`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const { response, body } = result;
  const code = response.headers.get('x-freedom-ipfs-error-code');
  const status = `HTTP ${response.status}${code ? ` (${code})` : ''}`;
  if (LIVE_NETWORK_STATUSES.has(response.status) && !code) {
    throw new LiveNetworkError(`${label} returned ${status}`);
  }
  assert(response.status >= 200 && response.status < 400, `${label} returned ${status}`);
  assert(body.length > 0, `${label} body is empty`);
  if (expectedText) {
    assert(
      body.toLowerCase().includes(expectedText.toLowerCase()),
      `${label} did not contain expected text: ${expectedText}`
    );
  }
  return { status: response.status, body };
}

// Fetch `smokePath` with backoff retries on network-only failures inside
// `budgetMs`. Resolves `{ page }` on success, or `{ failures, summary }` once
// the budget or attempts run out on network failures alone; throws on
// anything else.
async function fetchLiveWithRetry(node, { smokePath, expectedText, label, attempts, budgetMs }) {
  const legStartedAt = Date.now();
  const deadline = legStartedAt + budgetMs;
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline - Date.now();
    // Attempt 1 always runs, with at least LIVE_MIN_ATTEMPT_MS, however small
    // the budget: a pass (or a warn-mode skip) must never rest on zero
    // requests. The budget only decides whether to retry.
    if (attempt > 1 && remaining <= 0) break;
    const startedAt = Date.now();
    try {
      const page = await liveAttempt(
        node,
        smokePath,
        expectedText,
        Math.min(LIVE_TIMEOUT_MS, Math.max(remaining, LIVE_MIN_ATTEMPT_MS)),
        label
      );
      return { page: { ...page, ms: Date.now() - startedAt, attempt } };
    } catch (err) {
      // Anything the network can't explain is the addon's fault: fail now.
      if (!(err instanceof LiveNetworkError)) throw err;
      failures.push(`#${attempt}: ${err.message}`);
      // A node that fell over while we waited is a real failure too.
      assert(
        node.isHealthy(),
        `native node became unhealthy during the ${label} fetch (${err.message})`
      );
      const delayMs = Math.min(LIVE_BACKOFF_BASE_MS * 2 ** (attempt - 1), LIVE_BACKOFF_MAX_MS);
      // Only retry if a useful attempt window is left after the backoff.
      if (attempt < attempts && Date.now() + delayMs + LIVE_MIN_ATTEMPT_MS <= deadline) {
        console.warn(
          `[freedom-ipfs-native-smoke] ${label} attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      } else {
        break;
      }
    }
  }
  const summary =
    `could not fetch ${smokePath} after ${failures.length} attempt(s) ` +
    `in ${Date.now() - legStartedAt}ms: ${failures.join('; ')}`;
  return { failures, summary };
}

function reportNetworkSkip({ title, envName, mode, summary, consequence }) {
  if (mode === 'strict') {
    throw new Error(`${summary} (${envName}=strict)`);
  }
  console.log(
    `::warning title=${title}::${annotationEscape(
      `${summary}. ${consequence} Treating this as network weather (set ${envName}=strict to fail instead).`
    )}`
  );
}

async function loadLivePage(node) {
  const mode = liveMode();
  if (mode === 'off') return null;

  const customPath = process.env.FREEDOM_IPFS_NATIVE_SMOKE_PATH;
  const smokePath = customPath || DEFAULT_LIVE_PATH;
  const expectedText =
    process.env.FREEDOM_IPFS_NATIVE_SMOKE_EXPECT ?? (customPath ? '' : DEFAULT_LIVE_EXPECT);
  const result = await fetchLiveWithRetry(node, {
    smokePath,
    expectedText,
    label: 'live page',
    ...liveRetryOptions(),
  });
  if (result.page) {
    const { body, ...page } = result.page;
    return { path: smokePath, mode, ...page, bytes: body.length, title: extractTitle(body) };
  }

  reportNetworkSkip({
    title: 'freedom-ipfs live-network leg skipped',
    envName: 'FREEDOM_IPFS_NATIVE_SMOKE_LIVE',
    mode,
    summary: `live-network leg ${result.summary}`,
    consequence: 'The addon loaded, started and served local content.',
  });
  return { path: smokePath, mode, skipped: true, failures: result.failures };
}

async function loadIssue102Fanout(node) {
  const mode = issue102Mode();
  if (mode === 'off') return null;

  const startedAt = Date.now();
  // The root page is a live-network fetch like the live leg: retry and, in
  // warn mode, skip with a warning on network weather. Everything after it
  // (subresource discovery, the gateway_busy fan-out checks) stays hard.
  const rootResult = await fetchLiveWithRetry(node, {
    smokePath: ISSUE_102_PATH,
    expectedText: '',
    label: 'issue #102 root',
    ...liveRetryOptions(),
  });
  if (!rootResult.page) {
    reportNetworkSkip({
      title: 'freedom-ipfs issue #102 check skipped',
      envName: 'FREEDOM_IPFS_NATIVE_SMOKE_ISSUE_102',
      mode,
      summary: `issue #102 high-fanout check ${rootResult.summary}`,
      consequence: 'The fan-out (gateway_busy) checks did not run.',
    });
    return { path: ISSUE_102_PATH, mode, skipped: true, failures: rootResult.failures };
  }
  const root = rootResult.page;

  const assets = discoverIpfsSubresources(root.body, ISSUE_102_PATH).slice(0, ISSUE_102_MAX_ASSETS);
  assert(assets.length >= 40, `issue #102 expected many subresources, discovered ${assets.length}`);

  const beforeStats = await node.stats('native stats before issue #102 fanout');
  const results = [];
  let next = 0;

  async function worker() {
    while (next < assets.length) {
      const asset = assets[next++];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ISSUE_102_ASSET_TIMEOUT_MS);
      try {
        const response = await node.request({
          method: 'GET',
          path: asset,
          headers: new Headers({ Accept: '*/*' }),
          signal: controller.signal,
        });
        await response.arrayBuffer();
        results.push({
          path: asset,
          status: response.status,
          errorCode: response.headers.get('x-freedom-ipfs-error-code') || null,
        });
      } catch (err) {
        results.push({
          path: asset,
          status: 0,
          errorCode: err.code || null,
          error: err.message,
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ISSUE_102_CONCURRENCY, assets.length) }, () => worker())
  );

  const afterStats = await node.stats('native stats after issue #102 fanout');
  const gatewayBusy = results.filter(
    (result) => result.status === 503 && result.errorCode === 'gateway_busy'
  );
  const busyDelta =
    (afterStats.total_gateway_busy_responses || 0) -
    (beforeStats.total_gateway_busy_responses || 0);

  assert(gatewayBusy.length === 0, `issue #102 saw ${gatewayBusy.length} gateway_busy responses`);
  assert(busyDelta === 0, `issue #102 gateway busy counter increased by ${busyDelta}`);

  return {
    path: ISSUE_102_PATH,
    mode,
    rootBytes: root.body.length,
    discoveredAssets: assets.length,
    fetchedAssets: results.length,
    non2xxAssets: results.filter((result) => result.status < 200 || result.status >= 400).length,
    gatewayBusyResponses: gatewayBusy.length,
    gatewayBusyDelta: busyDelta,
    ms: Date.now() - startedAt,
  };
}

async function main() {
  // Reject a bad mode value before starting anything.
  liveMode();
  issue102Mode();
  const expectedTarget = process.env.FREEDOM_IPFS_NATIVE_SMOKE_TARGET;
  const actualTarget = `${process.platform}-${process.arch}`;

  if (expectedTarget) {
    assert(
      actualTarget === expectedTarget,
      `native smoke target mismatch: expected ${expectedTarget}, got ${actualTarget}`
    );
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-native-smoke-'));
  const backend = smokeBackend(dataDir);
  const { node } = backend;
  assert(backend.available(), `${backend.label} is not available`);
  let started = false;

  try {
    started = await node.start();
    assert(started, 'native node failed to start');
    assert(node.isHealthy(), 'native node did not become healthy after start');
    // The service names its build in its handshake, so both are read once
    // the node has started.
    const version = node.version;
    assert(typeof version === 'string' && version.length > 0, 'native version is empty');
    const buildInfo = parseJson('native build info', node.buildInfoJson());

    const progress = parseJson('progress snapshot', node.progressSnapshotJson());
    const stats = await backend.stats('native gateway stats');
    const localContent = await loadLocalContent(backend);
    const livePage = await loadLivePage(backend);
    const issue102Fanout = await loadIssue102Fanout(backend);

    assert(progress && Array.isArray(progress.active), 'progress snapshot missing active list');
    assert(stats && typeof stats === 'object' && !Array.isArray(stats), 'stats must be an object');

    console.log(
      JSON.stringify(
        {
          target: actualTarget,
          backend: BACKEND,
          version,
          buildInfo,
          dataDir,
          localContent,
          livePage,
          issue102Fanout,
          statsKeys: Object.keys(stats).sort(),
        },
        null,
        2
      )
    );
  } finally {
    if (started) {
      await node.stop();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[freedom-ipfs-native-smoke] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { fetchLiveWithRetry, LiveNetworkError };
