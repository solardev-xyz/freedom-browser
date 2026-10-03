/** Read-only public-contract research. Captures agreeing raw log ranges from
 * genesis to a previously captured finalized anchor. No wallet/engine, private
 * nullifier, signing or enrollment path. Agreement is not a chain proof.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { keccak256 } = require('ethers');
const deployment = require('../docs/qualification/railgun-sepolia-deployment-2026-10-02.json');
const endpoints = ['https://sepolia.rpc.sentio.xyz', 'https://gateway.tenderly.co/public/sepolia'];
const proxy = '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea';
const tag = (n) => '0x' + n.toString(16);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (code, reason, metadata = {}) =>
  Object.assign(new Error('Public RPC capture unavailable'), {
    code,
    evidence: { classification: code, reason, ...metadata },
  });
const quantity = (value) => {
  assert.ok(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value));
  const n = Number(BigInt(value));
  assert.ok(Number.isSafeInteger(n));
  return n;
};
function normalizeLogs(logs, from, to) {
  assert.ok(Array.isArray(logs) && logs.length <= 4096);
  const normalized = logs.map((log) => {
    assert.equal(log?.address?.toLowerCase(), proxy);
    assert.equal(log.removed, false);
    const blockNumber = quantity(log.blockNumber),
      transactionIndex = quantity(log.transactionIndex),
      logIndex = quantity(log.logIndex);
    assert.ok(blockNumber >= from && blockNumber <= to);
    for (const key of ['blockHash', 'transactionHash']) assert.match(log[key], /^0x[0-9a-f]{64}$/);
    assert.ok(Array.isArray(log.topics) && log.topics.length >= 1 && log.topics.length <= 4);
    for (const topic of log.topics) assert.match(topic, /^0x[0-9a-f]{64}$/);
    assert.ok(
      typeof log.data === 'string' &&
        log.data.startsWith('0x') &&
        log.data.length % 2 === 0 &&
        log.data.length <= 2 * 1024 * 1024 &&
        !/[^0-9a-f]/.test(log.data.slice(2))
    );
    return {
      address: proxy,
      blockNumber,
      blockHash: log.blockHash,
      transactionIndex,
      transactionHash: log.transactionHash,
      logIndex,
      topics: log.topics,
      data: log.data,
    };
  });
  normalized.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const seen = new Set(),
    blocks = new Map();
  for (const log of normalized) {
    const key = log.blockNumber + ':' + log.logIndex;
    assert.ok(!seen.has(key), 'Duplicate log position');
    seen.add(key);
    if (blocks.has(log.blockNumber)) assert.equal(blocks.get(log.blockNumber), log.blockHash);
    blocks.set(log.blockNumber, log.blockHash);
  }
  return normalized;
}
async function rpc(url, calls) {
  assert.ok(calls.length >= 1 && calls.length <= 4);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        calls.map(([method, params], n) => ({ jsonrpc: '2.0', id: n + 1, method, params }))
      ),
    });
  } catch {
    throw failure('CAPTURE_TRANSIENT', 'fetch-or-timeout');
  }
  if (response.status === 429 || response.status >= 500)
    throw failure('CAPTURE_TRANSIENT', 'http-status', { status: response.status });
  if (response.status === 413)
    throw failure('CAPTURE_RANGE', 'http-body-limit', { status: response.status });
  assert.equal(response.status, 200, 'RPC HTTP refusal');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw failure('CAPTURE_RANGE', 'local-body-cap');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error.code === 'CAPTURE_RANGE') throw error;
    throw failure('CAPTURE_TRANSIENT', 'body-stream-or-timeout');
  }
  const result = JSON.parse(Buffer.concat(chunks));
  assert.ok(Array.isArray(result) && result.length === calls.length);
  return calls.map((_, n) => {
    const matches = result.filter((item) => item?.id === n + 1);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].jsonrpc, '2.0');
    if (matches[0].error) {
      const message = String(matches[0].error.message ?? '');
      // Store classification and a digest, not arbitrary provider error text
      // which can echo identifiers, URLs or internal service details.
      const detail = {
        rpcCode: Number.isSafeInteger(matches[0].error.code) ? matches[0].error.code : null,
        messageSha256: hash(message),
        provider: new URL(url).hostname,
      };
      if (/\brate\b|\btoo many requests\b|\btemporar\w*|\btimeout\b|\btimed out\b/i.test(message))
        throw failure('CAPTURE_TRANSIENT', 'rpc-transient-pattern', detail);
      if (
        /\blimit\w*|\brange\b|\btoo many\b|\bexceed\w*|\bsize\b|\bmore than \d+ results\b/i.test(
          message
        )
      )
        throw failure('CAPTURE_RANGE', 'rpc-range-pattern', detail);
      throw failure('CAPTURE_REFUSED', 'rpc-other-refusal', detail);
    }
    assert.ok(Object.hasOwn(matches[0], 'result'));
    return matches[0].result;
  });
}
function block(value, number) {
  assert.equal(quantity(value?.number), number);
  assert.match(value.hash, /^0x[0-9a-f]{64}$/);
  return { number, hash: value.hash };
}
async function capture({
  directory,
  baseline = deployment,
  request = rpc,
  sleep = pause,
  now = Date.now,
  maxSpan = 100000,
  progress = (value) => console.log(JSON.stringify(value)),
}) {
  assert.ok(directory && path.isAbsolute(directory));
  assert.ok(Number.isInteger(maxSpan) && maxSpan >= 1 && maxSpan <= 100000);
  fs.mkdirSync(directory, { mode: 0o700 });
  const sourceSha256 = hash(fs.readFileSync(__filename));
  const deadline = now() + 30 * 60000;
  const anchor = baseline.anchor;
  assert.ok(Number.isSafeInteger(anchor.number) && anchor.number >= 0);
  assert.match(anchor.hash, /^0x[0-9a-f]{64}$/);
  const pair = async (calls) => {
    assert.ok(now() < deadline, 'Capture deadline');
    const settled = await Promise.allSettled(endpoints.map((url) => request(url, calls)));
    assert.ok(now() < deadline, 'Capture deadline');
    const errors = settled
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length)
      throw (
        errors.find((error) => !['CAPTURE_RANGE', 'CAPTURE_TRANSIENT'].includes(error.code)) ??
        errors.find((error) => error.code === 'CAPTURE_RANGE') ??
        errors[0]
      );
    return settled.map((result) => result.value);
  };
  const anchorTag = { blockHash: anchor.hash, requireCanonical: true };
  const startChecks = await pair([
    ['eth_chainId', []],
    ['eth_getBlockByNumber', ['finalized', false]],
    ['eth_getBlockByNumber', [tag(anchor.number), false]],
    ['eth_getCode', [proxy, anchorTag]],
  ]);
  for (const [chain, head, selected, code] of startChecks) {
    assert.equal(chain, '0xaa36a7');
    assert.ok(quantity(head.number) >= anchor.number);
    assert.deepEqual(block(selected, anchor.number), anchor);
    assert.equal(keccak256(code), baseline.code.proxy.keccak256);
  }
  const pages = [];
  const failures = [];
  let from = 0,
    span = maxSpan,
    totalLogs = 0,
    totalBytes = 0,
    failedRequests = 0;
  while (from <= anchor.number) {
    assert.ok(now() < deadline, 'Capture deadline');
    const to = Math.min(anchor.number, from + span - 1);
    let values,
      split = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        values = await pair([
          ['eth_getBlockByNumber', [tag(from), false]],
          ['eth_getLogs', [{ address: proxy, fromBlock: tag(from), toBlock: tag(to) }]],
          ['eth_getBlockByNumber', [tag(to), false]],
        ]);
        for (const [, logs] of values) {
          assert.ok(Array.isArray(logs), 'Invalid log result');
          if (logs.length > 4096) throw failure('CAPTURE_RANGE', 'local-log-count-cap');
        }
        break;
      } catch (error) {
        failedRequests++;
        if (failures.length < 1000)
          failures.push({
            from,
            to,
            attempt,
            ...(error.evidence ?? { classification: error.code ?? 'invalid' }),
          });
        if (error.code === 'CAPTURE_RANGE') {
          split = true;
          break;
        }
        if (error.code !== 'CAPTURE_TRANSIENT' || attempt === 2) throw error;
        await sleep((attempt + 1) * 1500);
      }
    }
    if (split) {
      assert.ok(span > 1, 'Cannot capture a complete single-block response');
      span = Math.max(1, Math.floor(span / 2));
      continue;
    }
    // Agreement or schema failure is terminal; never split away a disagreement.
    const normalized = values.map(([first, logs, last]) => ({
      from: block(first, from),
      to: block(last, to),
      logs: normalizeLogs(logs, from, to),
    }));
    assert.deepEqual(normalized[0], normalized[1], 'RPC range disagreement');
    totalLogs += normalized[0].logs.length;
    const encoded = JSON.stringify(normalized[0]) + '\n';
    totalBytes += Buffer.byteLength(encoded);
    assert.ok(
      totalLogs <= 100000 && totalBytes <= 128 * 1024 * 1024 && pages.length < 10000,
      'Capture capacity'
    );
    const filename = String(pages.length).padStart(5, '0') + '.json';
    fs.writeFileSync(path.join(directory, filename), encoded, { flag: 'wx', mode: 0o600 });
    pages.push({ filename, from, to, logs: normalized[0].logs.length, sha256: hash(encoded) });
    progress({ from, to, logs: normalized[0].logs.length, totalLogs, failedRequests });
    from = to + 1;
    span = Math.min(maxSpan, span * 2);
    await sleep(500);
  }
  const endChecks = await pair([['eth_getBlockByNumber', [tag(anchor.number), false]]]);
  for (const [selected] of endChecks) assert.deepEqual(block(selected, anchor.number), anchor);
  const report = {
    observedAt: new Date().toISOString(),
    chainId: 11155111,
    proxy,
    endpoints,
    anchor,
    fromBlock: 0,
    route: 'direct-https-public-contract-research',
    trust: 'two-rpc-agreement-unverified',
    rangeBoundaryHashesCompared: true,
    anchorRechecked: true,
    individualEventBlocksVerified: false,
    rootsRecomputed: false,
    walletScanned: false,
    privateNullifierQueries: 0,
    submissions: 0,
    totalLogs,
    totalBytes,
    failedRequests,
    failures,
    sourceSha256,
    deploymentReportSha256: hash(
      fs.readFileSync(
        require.resolve('../docs/qualification/railgun-sepolia-deployment-2026-10-02.json')
      )
    ),
    pages,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  progress({ complete: true, pages: pages.length, totalLogs, totalBytes });
  return report;
}
module.exports = { normalizeLogs, capture, rpc };
if (require.main === module)
  capture({ directory: process.argv[2] }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
