// Opt-in live performance lab for zSwap's read-heavy quoting workload.
//
// This is deliberately not a CI gate. It captures the JSON-RPC reads emitted
// by the real contract-hosted zSwap UI, then replays that read-only corpus
// through each Freedom source in isolation. It never forwards wallet methods,
// signs messages, or broadcasts transactions.
//
//   npm run test:lab:zswap-reads

// Optional controls:
//   ZSWAP_LAB_MAX_CALLS=40
//   ZSWAP_LAB_CONCURRENCY=4
//   ZSWAP_LAB_CALL_TIMEOUT_MS=30000
//   ZSWAP_LAB_MYOTIS_WAIT_MIN=5
//   ZSWAP_LAB_OUTPUT=/private/tmp/zswap-read-lab.json

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('../live-fixtures');

const repoRoot = path.resolve(__dirname, '..', '..');
const ZSWAP_ADDRESS = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const ZSWAP_URL = `web3://${ZSWAP_ADDRESS}`;
const ORIGINAL_READ_ORDER = ['myotis', 'colibri', 'quorum', 'direct'];
const LAB_ENABLED = process.env.FREEDOM_ZSWAP_READ_LAB === '1';
const MYOTIS_PLATFORM = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] ||
  process.platform;
const MYOTIS_ADDON = process.env.MYOTIS_NODE_PATH ||
  path.join(repoRoot, 'myotis-bin', `${MYOTIS_PLATFORM}-${process.arch}`, 'myotis-node.node');
const HAS_MYOTIS_ADDON = fs.existsSync(MYOTIS_ADDON);
const MAX_CALLS = positiveInteger(process.env.ZSWAP_LAB_MAX_CALLS, 40);
const CONCURRENCY = positiveInteger(process.env.ZSWAP_LAB_CONCURRENCY, 4);
const CALL_TIMEOUT_MS = positiveInteger(process.env.ZSWAP_LAB_CALL_TIMEOUT_MS, 30_000);
const MYOTIS_WAIT_MIN = positiveInteger(process.env.ZSWAP_LAB_MYOTIS_WAIT_MIN, 5);
const MYOTIS_WAIT_MS = MYOTIS_WAIT_MIN * 60_000;
const QUOTE_TIMEOUT_MS = 120_000;

const modulePaths = {
  router: path.join(repoRoot, 'src', 'main', 'networks', 'chain-data-router.js'),
  registry: path.join(repoRoot, 'src', 'main', 'networks', 'network-registry.js'),
  colibri: path.join(repoRoot, 'src', 'main', 'ens', 'colibri-resolver.js'),
  myotis: path.join(repoRoot, 'src', 'main', 'myotis', 'myotis-manager.js'),
};

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeRun(run) {
  const successful = run.calls.filter((call) => call.ok);
  const latencies = successful.map((call) => call.durationMs);
  const errors = {};
  for (const call of run.calls.filter((entry) => !entry.ok)) {
    const key = call.error?.message || 'unknown error';
    errors[key] = (errors[key] || 0) + 1;
  }
  return {
    source: run.source,
    mode: run.mode,
    calls: run.calls.length,
    succeeded: successful.length,
    failed: run.calls.length - successful.length,
    successRate: run.calls.length ? successful.length / run.calls.length : 0,
    elapsedMs: run.elapsedMs,
    throughputPerSecond: run.elapsedMs ? successful.length / (run.elapsedMs / 1000) : 0,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    errors,
  };
}

function addBaselineAgreement(summary, runs) {
  const direct = runs.find((run) => run.source === 'direct');
  const baseline = new Map((direct?.calls || [])
    .filter((call) => call.ok && call.method !== 'eth_blockNumber')
    .map((call) => [call.sequence, call.resultHash]));
  for (let index = 0; index < runs.length; index += 1) {
    const comparable = runs[index].calls.filter((call) =>
      call.ok && call.method !== 'eth_blockNumber' && baseline.has(call.sequence));
    summary[index].agreementWithDirect = {
      comparable: comparable.length,
      matching: comparable.filter((call) =>
        baseline.get(call.sequence) === call.resultHash).length,
    };
  }
}

function formatNumber(value, digits = 1) {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function markdownReport(report) {
  const lines = [
    '# zSwap read lab',
    '',
    `Captured at: ${report.capturedAt}`,
    '',
    `Captured ${report.capture.totalProviderCalls} provider calls; replayed ` +
      `${report.capture.replayedReadCalls} safe read calls (cap: ${report.config.maxCalls}).`,
    '',
    '| Source | Mode | Success | Match Direct | Elapsed | Throughput | p50 | p95 | Max |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of report.summary) {
    lines.push(
      `| ${row.source} | ${row.mode} | ${row.succeeded}/${row.calls} | ` +
      `${row.agreementWithDirect.matching}/${row.agreementWithDirect.comparable} | ` +
      `${formatNumber(row.elapsedMs, 0)} ms | ` +
      `${formatNumber(row.throughputPerSecond, 2)}/s | ` +
      `${formatNumber(row.latencyMs.p50, 0)} ms | ` +
      `${formatNumber(row.latencyMs.p95, 0)} ms | ` +
      `${formatNumber(row.latencyMs.max, 0)} ms |`
    );
  }
  lines.push('', '## Errors', '');
  for (const row of report.summary) {
    lines.push(`### ${row.source} — ${row.mode}`, '');
    const entries = Object.entries(row.errors);
    if (!entries.length) lines.push('None.', '');
    for (const [message, count] of entries) lines.push(`- ${count}× ${message}`);
    if (entries.length) lines.push('');
  }
  lines.push(
    '## Interpretation guardrails',
    '',
    '- `pinned` replays the exact block tags emitted by zSwap.',
    '- `latest-adapted` changes supported state-read block tags to `latest`; it measures ' +
      'Myotis capacity, not equivalent quote reproducibility.',
    '- `rpc-member-*` rows pin one quorum endpoint; `direct` uses Freedom fallback.',
    '- Results are live-network observations, not pass/fail performance assertions.',
    ''
  );
  return lines.join('\n');
}

async function evalInActiveWebview(window, snippet) {
  return window.evaluate(async (source) => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    try {
      return await webview.executeJavaScript(source);
    } catch {
      return null;
    }
  }, snippet);
}

async function setReadOrder(electronApp, order) {
  // eslint-disable-next-line no-empty-pattern
  await electronApp.evaluate(async ({}, options) => {
    const registry = process.mainModule.require(options.registry);
    registry.updateNetwork(1, { access: { readOrder: options.order } });
  }, { registry: modulePaths.registry, order });
}

async function captureZswapReads(window, electronApp) {
  // Loading html() through Direct avoids making the capture dependent on the
  // source under test. The resulting dapp provider calls are captured below.
  await setReadOrder(electronApp, ['direct']);
  await expect
    .poll(() => window.evaluate(() =>
      document.querySelector('webview:not(.hidden)')?.getURL() || ''))
    .toContain('/pages/home.html');

  const input = window.locator('[data-test="address-input"]');
  await input.fill(ZSWAP_URL);
  await input.press('Enter');
  await expect(input).toHaveValue(`${ZSWAP_URL}/`, { timeout: QUOTE_TIMEOUT_MS });
  await expect
    .poll(() => evalInActiveWebview(window, `Boolean(
      document.querySelector('#amt') && document.querySelector('#outAmt')
    )`), {
      message: 'waiting for the real zSwap controls to render',
      timeout: QUOTE_TIMEOUT_MS,
      intervals: [500, 1000, 2000],
    })
    .toBe(true);

  const installed = await evalInActiveWebview(window, `(() => {
    const provider = window.ethereum;
    if (!provider || typeof provider.request !== 'function') return false;
    const original = provider.request.bind(provider);
    const state = {
      records: [],
      active: 0,
      maxActive: 0,
      sequence: 0,
      lastFinishedAt: performance.now()
    };
    provider.request = async (request) => {
      const method = request?.method || '';
      const params = request?.params || [];
      const record = {
        sequence: state.sequence++,
        method,
        params: JSON.parse(JSON.stringify(params)),
        startedAt: performance.now(),
        ok: false
      };
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        const result = await original(request);
        record.ok = true;
        record.resultBytes = JSON.stringify(result)?.length || 0;
        return result;
      } catch (error) {
        record.error = {
          code: error?.code ?? null,
          message: error?.message || String(error)
        };
        throw error;
      } finally {
        record.durationMs = performance.now() - record.startedAt;
        state.active -= 1;
        state.lastFinishedAt = performance.now();
        state.records.push(record);
      }
    };
    window.__freedomZswapReadLab = state;
    return true;
  })()`);
  expect(installed).toBe(true);

  // The document itself is fetched through Direct to keep source comparison
  // reproducible. The actual quote must succeed through Freedom's untouched
  // default policy; this is the user-facing acceptance path for the adaptive
  // fallback behavior exercised by this lab.
  await setReadOrder(electronApp, ORIGINAL_READ_ORDER);
  const quoteStartedAt = Date.now();
  const triggered = await evalInActiveWebview(window, `(() => {
    const amount = document.querySelector('#amt');
    if (!amount) return false;
    amount.value = '1';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    amount.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  expect(triggered).toBe(true);

  await expect
    .poll(() => evalInActiveWebview(window, `(() => {
      const state = window.__freedomZswapReadLab;
      const output = document.querySelector('#outAmt')?.value || '';
      if (!state || !state.records.length || state.active !== 0) return false;
      return performance.now() - state.lastFinishedAt > 2500 && output !== '...';
    })()`), {
      message: 'waiting for the zSwap quote read burst to settle',
      timeout: QUOTE_TIMEOUT_MS,
      intervals: [500, 1000],
    })
    .toBe(true);

  const capture = await evalInActiveWebview(window, `(() => ({
    title: document.title,
    output: document.querySelector('#outAmt')?.value || null,
    status: document.querySelector('#stat')?.textContent?.trim() || null,
    maxActive: window.__freedomZswapReadLab.maxActive,
    records: window.__freedomZswapReadLab.records
  }))()`);
  return { ...capture, quoteElapsedMs: Date.now() - quoteStartedAt };
}

async function replayCorpus(electronApp, corpus, options) {
  // eslint-disable-next-line no-empty-pattern
  return electronApp.evaluate(async ({}, payload) => {
    const crypto = process.mainModule.require('node:crypto');
    const router = process.mainModule.require(payload.paths.router);
    const registry = process.mainModule.require(payload.paths.registry);
    const colibri = process.mainModule.require(payload.paths.colibri);
    const startedAt = Date.now();

    if (payload.clearColibri) colibri.clearColibriClientForTest();
    const isFixedRpc = payload.source.startsWith('rpc-member-');
    if (!isFixedRpc) {
      registry.updateNetwork(1, { access: { readOrder: [payload.source] } });
    }
    const rpcUrls = registry.getEndpoints(1, 'rpc');
    const rpcUrl = isFixedRpc ? rpcUrls[payload.endpointIndex] : rpcUrls[0];

    const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lab timeout after ${timeoutMs}ms`)), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
    const adaptForLatest = (method, params) => {
      const adapted = JSON.parse(JSON.stringify(params));
      if (['eth_call', 'eth_estimateGas', 'eth_getBalance',
        'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt'].includes(method) &&
        adapted.length > 1) {
        adapted[1] = 'latest';
      }
      return adapted;
    };
    const execute = async (entry) => {
      const callStartedAt = Date.now();
      const params = payload.latestAdapted
        ? adaptForLatest(entry.method, entry.params)
        : entry.params;
      try {
        const request = isFixedRpc
          ? router.requestRpcUrl(rpcUrl, entry.method, params, payload.callTimeoutMs)
          : router.request(1, entry.method, params);
        const response = await withTimeout(request, payload.callTimeoutMs);
        const result = isFixedRpc ? response : response.result;
        const stable = JSON.stringify(result);
        return {
          sequence: entry.sequence,
          method: entry.method,
          ok: true,
          durationMs: Date.now() - callStartedAt,
          resultBytes: Buffer.byteLength(stable || ''),
          resultHash: crypto.createHash('sha256').update(stable || '').digest('hex'),
        };
      } catch (error) {
        return {
          sequence: entry.sequence,
          method: entry.method,
          ok: false,
          durationMs: Date.now() - callStartedAt,
          error: {
            name: error?.name || null,
            code: error?.code ?? null,
            message: (error?.message || String(error))
              .replace(/0x[0-9a-fA-F]{128,}/g, (hex) =>
                `${hex.slice(0, 10)}…(${Math.floor((hex.length - 2) / 2)} bytes)`)
              .replace(/\s+/g, ' ')
              .slice(0, 500),
          },
        };
      }
    };

    const calls = new Array(payload.corpus.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= payload.corpus.length) return;
        calls[index] = await execute(payload.corpus[index]);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(payload.concurrency, payload.corpus.length || 1) },
      worker
    ));
    return {
      source: payload.source,
      mode: payload.mode,
      endpoint: isFixedRpc ? new URL(rpcUrl).host : null,
      elapsedMs: Date.now() - startedAt,
      calls,
    };
  }, {
    corpus,
    paths: modulePaths,
    callTimeoutMs: CALL_TIMEOUT_MS,
    concurrency: CONCURRENCY,
    ...options,
  });
}

async function waitForMyotis(electronApp) {
  const deadline = Date.now() + MYOTIS_WAIT_MS;
  let state = { ready: false, status: null };
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-empty-pattern
    state = await electronApp.evaluate(async ({}, managerPath) => {
      const manager = process.mainModule.require(managerPath);
      return { ready: manager.isReady(1), status: manager.getStatus(1) };
    }, modulePaths.myotis);
    if (state.ready) return state;
    console.log('[zswap-read-lab] waiting for Myotis:', JSON.stringify(state.status));
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  return state;
}

test.use({
  seedSettings: {
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    enableRadicleIntegration: false,
    startRadicleAtLaunch: false,
    startTorAtLaunch: false,
    startMyotisAtLaunch: HAS_MYOTIS_ADDON,
  },
  launchEnv: HAS_MYOTIS_ADDON ? { MYOTIS_NODE_PATH: MYOTIS_ADDON } : {},
});

test.describe('zSwap read-source lab', () => {
  test.skip(!LAB_ENABLED, 'set FREEDOM_ZSWAP_READ_LAB=1 to run the live lab');

  test('captures a real quote and replays its safe reads through every source', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(25 * 60_000);
    const capture = await captureZswapReads(window, electronApp);
    expect(capture.title).toMatch(/zswap/i);

    const isSafeRead = await electronApp.evaluate(
      // eslint-disable-next-line no-empty-pattern
      async ({}, payload) => {
        const router = process.mainModule.require(payload.router);
        return payload.methods.map((method) => router.isReadMethod(method));
      },
      { router: modulePaths.router, methods: capture.records.map((entry) => entry.method) }
    );
    const safeReads = capture.records
      .filter((entry, index) => entry.ok && isSafeRead[index])
      .slice(0, MAX_CALLS)
      .map(({ sequence, method, params }) => ({ sequence, method, params }));
    expect(safeReads.length).toBeGreaterThan(0);
    console.log(
      `[zswap-read-lab] captured ${capture.records.length} calls, ` +
      `replaying ${safeReads.length} safe reads; browser max concurrency=${capture.maxActive}`
    );

    const runs = [];
    runs.push(await replayCorpus(electronApp, safeReads, {
      source: 'direct',
      mode: 'pinned / production fallback',
    }));
    for (let endpointIndex = 0; endpointIndex < 3; endpointIndex += 1) {
      runs.push(await replayCorpus(electronApp, safeReads, {
        source: `rpc-member-${endpointIndex + 1}`,
        mode: 'pinned / quorum diagnostic',
        endpointIndex,
      }));
    }
    runs.push(await replayCorpus(electronApp, safeReads, {
      source: 'quorum',
      mode: 'pinned',
    }));
    const coldColibri = await replayCorpus(electronApp, safeReads, {
      source: 'colibri',
      mode: 'pinned / cold client',
      clearColibri: true,
    });
    runs.push(coldColibri);
    const coldTimedOut = coldColibri.calls.some((call) =>
      /lab timeout|interactive deadline|already processing this workload/i
        .test(call.error?.message || ''));
    if (!coldTimedOut) {
      runs.push(await replayCorpus(electronApp, safeReads, {
        source: 'colibri',
        mode: 'pinned / warm client',
      }));
    }

    const myotisState = HAS_MYOTIS_ADDON
      ? await waitForMyotis(electronApp)
      : { ready: false, status: { lastError: 'native addon not installed' } };
    runs.push(await replayCorpus(electronApp, safeReads, {
      source: 'myotis',
      mode: 'pinned',
    }));
    if (myotisState.ready) {
      runs.push(await replayCorpus(electronApp, safeReads, {
        source: 'myotis',
        mode: 'latest-adapted',
        latestAdapted: true,
      }));
    }

    const summary = runs.map(summarizeRun);
    addBaselineAgreement(summary, runs);
    const report = {
      capturedAt: new Date().toISOString(),
      zswap: { address: ZSWAP_ADDRESS, quoteOutput: capture.output, status: capture.status },
      config: {
        maxCalls: MAX_CALLS,
        concurrency: CONCURRENCY,
        callTimeoutMs: CALL_TIMEOUT_MS,
        myotisWaitMinutes: MYOTIS_WAIT_MIN,
      },
      capture: {
        totalProviderCalls: capture.records.length,
        replayedReadCalls: safeReads.length,
        browserMaxConcurrency: capture.maxActive,
        quoteReadOrder: ORIGINAL_READ_ORDER,
        quoteElapsedMs: capture.quoteElapsedMs,
        methods: safeReads.reduce((counts, call) => {
          counts[call.method] = (counts[call.method] || 0) + 1;
          return counts;
        }, {}),
      },
      myotis: myotisState,
      summary,
      runs,
      corpus: safeReads,
    };
    const outputPath = process.env.ZSWAP_LAB_OUTPUT ||
      path.join(os.tmpdir(), `freedom-zswap-read-lab-${Date.now()}.json`);
    const markdownPath = outputPath.replace(/\.json$/i, '') + '.md';
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(markdownPath, markdownReport(report));
    console.log(`[zswap-read-lab] JSON report: ${outputPath}`);
    console.log(`[zswap-read-lab] Markdown report: ${markdownPath}`);
    console.table(summary.map((row) => ({
      source: row.source,
      mode: row.mode,
      success: `${row.succeeded}/${row.calls}`,
      elapsedMs: row.elapsedMs,
      throughput: Number(row.throughputPerSecond.toFixed(2)),
      p50Ms: row.latencyMs.p50,
      p95Ms: row.latencyMs.p95,
      maxMs: row.latencyMs.max,
      matchesDirect: `${row.agreementWithDirect.matching}/` +
        `${row.agreementWithDirect.comparable}`,
    })));
  });
});
