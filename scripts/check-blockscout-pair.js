// Live canary for the core's Blockscout pairing (#529, #596; freedom-core
// design 0005, Logs): Ant's first wallet scan reads a wallet's whole xBZZ
// history as a few Blockscout pages paired with one full-history RPC. A
// Blockscout API change makes every pair fail, and Ant's scans then fall
// back, silently, to reading the history window by window: 49 minutes and
// thousands of requests instead of seconds (#596). Nothing in the app would
// show it, so this runs nightly (.github/workflows/blockscout-canary.yml).
//
// It drives the real freedom-cored (the release scripts/fetch-freedom-cored.js
// pins, or FREEDOM_CORED_PATH) through main's own drivers and executors, with
// Gnosis configured as a fresh profile has it, and scans the way Ant does:
// the `ant_scan` profile, halving a window the core refuses as too wide.
// Each scan below must be answered by the pair (source `blockscout`,
// verified) in a few requests, with Blockscout's pages read and followed,
// and with the transfers the span is known to hold:
// - the xBZZ transfers the PostageStamp contract received in a fixed span of
//   old blocks: an exact count that never changes, over four pages;
// - one Bee node wallet's whole history, sent and received (Blockscout's
//   filter=from and filter=to, which can break separately): at least the
//   transfers it is known to have.
// Every scan is checked even after one fails, so a run names each broken one.
// Read-only, public data; the node's own executors use Node's fetch here
// where the app uses the session's network stack.
//
// Usage: node scripts/check-blockscout-pair.js   (after npm ci and
// node scripts/fetch-freedom-cored.js, or with FREEDOM_CORED_PATH set).
// Its scan loop and judgement are unit-tested offline
// (check-blockscout-pair.test.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const GNOSIS = 100;
const XBZZ = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPLOY_BLOCK = 16_514_506;
const word = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
// Swarm's PostageStamp contract, whose xBZZ comes from batch purchases.
const POSTAGE_STAMP = '0x45a1502382541Cd610CC9068e88727426b696293';
// A Bee node wallet that had sent 11 and received 28 xBZZ transfers by
// 2026-10-07. Its history only grows, so fewer means a provider lost some.
const WALLET = '0x971f31aaeac713b47aa55e50c06409afc1de46b9';
const SCANS = [
  {
    name: 'PostageStamp received',
    topics: [TRANSFER_TOPIC, null, word(POSTAGE_STAMP)],
    fromBlock: 36_000_000,
    toBlock: 36_299_999,
    // Old blocks: the count is exact, and needs four pages of 50.
    transfers: { exactly: 166 },
    pages: 4,
  },
  {
    name: 'wallet sent',
    topics: [TRANSFER_TOPIC, word(WALLET)],
    fromBlock: DEPLOY_BLOCK,
    toBlock: 'head',
    transfers: { atLeast: 11 },
    pages: 1,
  },
  {
    name: 'wallet received',
    topics: [TRANSFER_TOPIC, null, word(WALLET)],
    fromBlock: DEPLOY_BLOCK,
    toBlock: 'head',
    transfers: { atLeast: 28 },
    pages: 1,
  },
];
// A first scan is three requests: the first teaches the core the endpoints'
// range caps and is refused, and each half Ant then asks for is paired
// (docs/ant-chain-bridge.md). Past this many, Ant is reading window by window.
const MAX_REQUESTS = 8;
// The whole run, core start included; the bridge gives one request 120 s.
const RUN_TIMEOUT_MS = 5 * 60_000;

const quiet = () => {};

// main's modules run outside Electron here: a fresh profile in a temporary
// directory stands in for userData, and the log goes to the console. Done
// before any of them loads: `electron` itself would download its binary.
function standInForElectron(userData) {
  const stub = (file, exports) => {
    const module = new Module(file);
    module.filename = file;
    module.loaded = true;
    module.exports = exports;
    require.cache[file] = module;
  };
  stub(require.resolve('electron', { paths: [ROOT] }), {
    app: { isPackaged: false, getPath: () => userData, getName: () => 'Freedom' },
  });
  stub(require.resolve(path.join(ROOT, 'src/main/logger')), {
    info: quiet,
    debug: quiet,
    verbose: quiet,
    warn: (...args) => console.warn('[main]', ...args),
    error: (...args) => console.error('[main]', ...args),
  });
}

function coredBinary() {
  if (process.env.FREEDOM_CORED_PATH) return process.env.FREEDOM_CORED_PATH;
  const platform = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  return path.join(
    ROOT,
    'freedom-cored-bin',
    `${platform || process.platform}-${process.arch}`,
    name
  );
}

const hex = (n) => `0x${n.toString(16)}`;
const hostOf = (url) => new URL(url).host;

let stopping = false;

/**
 * The real core, Gnosis configured from the registry as a fresh profile has
 * it, and main's executors over Node's fetch, which `exchanges` records:
 * each hop's URL, the JSON-RPC method of a POST, and the status.
 */
async function startCore(userData) {
  const registry = require('../src/main/networks/network-registry');
  const { LOG_INDEX_URLS } = require('../src/main/networks/blockscout-logs');
  const { CoreClient } = require('../src/main/core/core-client');
  const { ChainConfig } = require('../src/main/core/chain-config');
  const { BroadcastRecords } = require('../src/main/core/chain-broadcasts');
  const { registerChainShell } = require('../src/main/core/chain-shell');
  const { registerChainVerified } = require('../src/main/core/chain-verified');
  const { ChainDriver } = require('../src/main/core/chain-driver');
  const { makeHop } = require('../src/main/core/naming-shell');
  const command = coredBinary();
  if (!fs.existsSync(command)) {
    throw new Error(`no freedom-cored at ${command}: run scripts/fetch-freedom-cored.js`);
  }
  const client = new CoreClient({
    spawn,
    command,
    args: [
      'serve',
      '--data-dir',
      path.join(userData, 'identity'),
      '--lock-dir',
      path.join(userData, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    // The client reports the pipe closing as the core stops: no news then.
    log: {
      info: quiet,
      warn: quiet,
      error: (...args) => stopping || console.error('[core]', ...args),
    },
    shellVersion: 'blockscout-canary',
  });
  const config = new ChainConfig({
    client,
    // No Myotis: Ant's scans never ask it, nor Colibri, nor Direct.
    sources: {
      registry,
      myotis: { NETWORKS: new Map(), isReady: () => false },
      logIndexUrls: LOG_INDEX_URLS,
    },
    log: { info: quiet, warn: (...args) => console.warn('[chain]', ...args), error: quiet },
  });
  const exchanges = [];
  const fetch = async (url, init = {}) => {
    const entry = { url, method: null, status: null };
    try {
      entry.method = init.body ? JSON.parse(init.body).method : null;
    } catch {
      // not JSON-RPC
    }
    exchanges.push(entry);
    const response = await globalThis.fetch(url, init);
    entry.status = response.status;
    return response;
  };
  const broadcasts = new BroadcastRecords();
  registerChainShell(client, config, { broadcasts, hop: makeHop({ fetch }) });
  registerChainVerified(client, config, { broadcasts, adapters: {} });
  const driver = new ChainDriver({ client, config, broadcasts });
  await client.start();
  await config.whenServing();
  return { client, driver, exchanges, indexUrl: LOG_INDEX_URLS[GNOSIS] };
}

/** One `eth_getLogs` as the bridge sends Ant's: background work, under the
 * `ant_scan` profile. */
const scanRequest = (driver, filter) =>
  driver.request(GNOSIS, 'eth_getLogs', [filter], { background: true, profile: 'ant_scan' });

const isPage = (entry) => entry.method === null && /\/v2\/addresses\//.test(entry.url);

/** What Blockscout was asked during a scan, for a failure's text: the core
 * keeps why a pair failed to itself, and Ant never sees it. */
function pagesSeen(entries) {
  const pages = entries.filter(isPage);
  if (!pages.length) return 'Blockscout not asked (left alone after a failure, or never tried)';
  const statuses = pages.map((entry) => entry.status ?? 'no answer');
  return `Blockscout asked ${pages.length} times (HTTP ${statuses.join(', ')})`;
}

/**
 * Ant's window loop (`scan_logs_with`): asks for [from, to] and, when the
 * reply would make Ant shrink its window (the bridge's reply, Ant's
 * needles), asks for each half instead, oldest first. Gives up past
 * MAX_REQUESTS: that is the window-by-window fallback this canary is for.
 */
async function antScan({ driver, exchanges }, scan, toBlock) {
  const { antErrorReply, antShrinksLogScanOn } = require('../src/main/swarm/ant-chain-bridge');
  const start = exchanges.length;
  const windows = [[scan.fromBlock, toBlock]];
  const answered = [];
  const refused = [];
  let requests = 0;
  while (windows.length) {
    if (requests >= MAX_REQUESTS) {
      const last = refused.at(-1);
      throw new Error(
        `still reading after ${requests} requests, in windows down to ${last?.span ?? '?'} ` +
          `blocks (last refusal: ${last?.message ?? 'none'}): Ant would read this history ` +
          `window by window. ${pagesSeen(exchanges.slice(start))}`
      );
    }
    const [from, to] = windows.shift();
    const filter = { address: XBZZ, fromBlock: hex(from), toBlock: hex(to), topics: scan.topics };
    const before = exchanges.length;
    requests += 1;
    try {
      const reply = await scanRequest(driver, filter);
      answered.push({ from, to, reply, exchanges: exchanges.slice(before) });
    } catch (err) {
      const toAnt = antErrorReply('eth_getLogs', err);
      if (!antShrinksLogScanOn(toAnt.message) || from === to) {
        throw new Error(
          `blocks ${from}..${to} failed: ${toAnt.message}. ${pagesSeen(exchanges.slice(start))}`,
          { cause: err }
        );
      }
      refused.push({ from, to, span: to - from + 1, message: toAnt.message });
      const middle = from + Math.floor((to - from) / 2);
      windows.unshift([from, middle], [middle + 1, to]);
    }
  }
  return { requests, answered, refused };
}

/** What one scan must show: every window it read paired and verified, its
 * pages read, its transfers all there and all Ant's. */
function judge(scan, toBlock, { requests, answered, refused }) {
  const problems = [];
  const logs = answered.flatMap(({ reply }) => (Array.isArray(reply.result) ? reply.result : []));
  for (const { from, to, reply } of answered) {
    if (reply.source !== 'blockscout' || reply.verified !== true) {
      problems.push(
        `blocks ${from}..${to} were answered by ${reply.source} ` +
          `(verified ${reply.verified}), not by Blockscout paired with an RPC`
      );
    }
  }
  const pages = answered.flatMap(({ exchanges }) => exchanges.filter(isPage));
  const pagesRead = pages.filter((entry) => entry.status === 200).length;
  if (pagesRead < scan.pages) {
    problems.push(`${pagesRead} Blockscout pages read, expected at least ${scan.pages}`);
  }
  const { exactly, atLeast } = scan.transfers;
  if (exactly !== undefined && logs.length !== exactly) {
    problems.push(`${logs.length} transfers, expected exactly ${exactly}`);
  }
  if (atLeast !== undefined && logs.length < atLeast) {
    problems.push(`${logs.length} transfers, expected at least ${atLeast}`);
  }
  const seen = new Set();
  for (const log of logs) {
    const block = Number.parseInt(log.blockNumber, 16);
    const key = `${log.transactionHash}:${log.logIndex}`;
    const matches =
      log.address?.toLowerCase() === XBZZ &&
      scan.topics.every((topic, i) => topic === null || log.topics?.[i]?.toLowerCase() === topic) &&
      block >= scan.fromBlock &&
      block <= toBlock &&
      !seen.has(key);
    seen.add(key);
    if (!matches) {
      problems.push(`a transfer outside the scan, or twice: ${key} in block ${block}`);
      break;
    }
  }
  const rpcs = answered
    .flatMap(({ exchanges }) => exchanges.filter((entry) => entry.method === 'eth_getLogs'))
    .map((entry) => hostOf(entry.url));
  const pageHosts = [...new Set(pages.map((entry) => hostOf(entry.url)))];
  console.log(
    `${scan.name}, blocks ${scan.fromBlock}..${toBlock}: ${logs.length} transfers in ${requests} ` +
      `request${requests === 1 ? '' : 's'} ` +
      `(${refused.length} refused as too wide, ${answered.length} answered: ` +
      `${answered.map(({ reply }) => reply.source).join(', ')}); ` +
      `Blockscout pages ${pagesRead} (${pageHosts.join(', ') || 'none'}); ` +
      `RPC getLogs ${rpcs.length} (${[...new Set(rpcs)].join(', ') || 'none'})`
  );
  return problems;
}

async function main(userData) {
  const core = await startCore(userData);
  try {
    const head = Number.parseInt(
      (
        await core.driver.request(GNOSIS, 'eth_blockNumber', [], {
          background: true,
          profile: 'ant_scan',
        })
      ).result,
      16
    );
    console.log(
      `freedom-cored ${core.client.hello?.core_version ?? '?'}; Gnosis head ${head}; ` +
        `Blockscout ${core.indexUrl}`
    );
    const failures = [];
    for (const scan of SCANS) {
      const toBlock = scan.toBlock === 'head' ? head : scan.toBlock;
      try {
        const problems = judge(scan, toBlock, await antScan(core, scan, toBlock));
        if (problems.length) failures.push(`${scan.name}: ${problems.join('; ')}`);
        else console.log(`${scan.name}: paired`);
      } catch (err) {
        failures.push(`${scan.name}: ${err.message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('\n  '));
  } finally {
    stopping = true;
    await core.client.stop();
  }
}

if (require.main === module) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-blockscout-canary-'));
  standInForElectron(userData);
  const timer = setTimeout(() => {
    console.error(`Blockscout pair check failed: no result within ${RUN_TIMEOUT_MS / 1000} s`);
    process.exit(1);
  }, RUN_TIMEOUT_MS);
  main(userData)
    .catch((err) => {
      console.error(`Blockscout pair check failed:\n  ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => {
      clearTimeout(timer);
      fs.rmSync(userData, { recursive: true, force: true });
    });
}

module.exports = { SCANS, MAX_REQUESTS, antScan, judge };
