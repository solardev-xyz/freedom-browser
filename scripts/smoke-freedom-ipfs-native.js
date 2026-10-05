#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FreedomIpfsNativeNode } = require('../src/main/ipfs/freedom-ipfs-native-node');

const DEFAULT_LIVE_PATH = '/ipns/ipfs.tech/';
const DEFAULT_LIVE_EXPECT = 'ipfs';
const DEFAULT_LIVE_ATTEMPTS = 3;
const LIVE_TIMEOUT_MS = 45_000;
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

async function loadLivePage(node) {
  if (process.env.FREEDOM_IPFS_NATIVE_SMOKE_LIVE === '0') return null;

  const smokePath = process.env.FREEDOM_IPFS_NATIVE_SMOKE_PATH || DEFAULT_LIVE_PATH;
  const expectedText = process.env.FREEDOM_IPFS_NATIVE_SMOKE_EXPECT || DEFAULT_LIVE_EXPECT;
  const attempts = parsePositiveInt(
    process.env.FREEDOM_IPFS_NATIVE_SMOKE_ATTEMPTS,
    DEFAULT_LIVE_ATTEMPTS
  );

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);

    try {
      const { response, body } = await requestText(node, smokePath, {
        signal: controller.signal,
      });
      const title = extractTitle(body);

      assert(
        response.status >= 200 && response.status < 400,
        `live page returned HTTP ${response.status}`
      );
      assert(body.length > 0, 'live page body is empty');
      if (expectedText) {
        assert(
          body.toLowerCase().includes(expectedText.toLowerCase()),
          `live page did not contain expected text: ${expectedText}`
        );
      }

      return {
        path: smokePath,
        status: response.status,
        bytes: body.length,
        title,
        ms: Date.now() - startedAt,
        attempt,
      };
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const delayMs = 1000 * attempt;
        console.warn(
          `[freedom-ipfs-native-smoke] live page attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function loadIssue102Fanout(node) {
  if (process.env.FREEDOM_IPFS_NATIVE_SMOKE_ISSUE_102 !== '1') return null;

  const startedAt = Date.now();
  const root = await requestText(node, ISSUE_102_PATH);
  assert(
    root.response.status >= 200 && root.response.status < 400,
    `issue #102 root returned HTTP ${root.response.status}`
  );

  const assets = discoverIpfsSubresources(root.body, ISSUE_102_PATH).slice(0, ISSUE_102_MAX_ASSETS);
  assert(assets.length >= 40, `issue #102 expected many subresources, discovered ${assets.length}`);

  const beforeStats = parseJson(
    'native stats before issue #102 fanout',
    node.nativeGatewayStatsJson()
  );
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

  const afterStats = parseJson(
    'native stats after issue #102 fanout',
    node.nativeGatewayStatsJson()
  );
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
  const expectedTarget = process.env.FREEDOM_IPFS_NATIVE_SMOKE_TARGET;
  const actualTarget = `${process.platform}-${process.arch}`;

  if (expectedTarget) {
    assert(
      actualTarget === expectedTarget,
      `native smoke target mismatch: expected ${expectedTarget}, got ${actualTarget}`
    );
  }

  assert(FreedomIpfsNativeNode.isAvailable(), 'freedom-ipfs native addon is not available');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-native-smoke-'));
  const node = new FreedomIpfsNativeNode({ dataDir });
  let started = false;

  try {
    const version = node.version;
    assert(typeof version === 'string' && version.length > 0, 'native version is empty');
    const buildInfo = parseJson('native build info', node.buildInfoJson());

    started = await node.start();
    assert(started, 'native node failed to start');
    assert(node.isHealthy(), 'native node did not become healthy after start');

    const progress = parseJson('progress snapshot', node.progressSnapshotJson());
    const stats = parseJson('native gateway stats', node.nativeGatewayStatsJson());
    const livePage = await loadLivePage(node);
    const issue102Fanout = await loadIssue102Fanout(node);

    assert(progress && Array.isArray(progress.active), 'progress snapshot missing active list');
    assert(stats && typeof stats === 'object' && !Array.isArray(stats), 'stats must be an object');

    console.log(
      JSON.stringify(
        {
          target: actualTarget,
          version,
          buildInfo,
          dataDir,
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

main().catch((err) => {
  console.error(`[freedom-ipfs-native-smoke] ${err.stack || err.message}`);
  process.exit(1);
});
