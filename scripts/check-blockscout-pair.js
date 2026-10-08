// Live canary for the router's blockscout source (#529, #596): reads one known
// Bee node wallet's xBZZ Transfer history from rpc.gnosischain.com and from
// Blockscout, the pair Ant's first wallet scan relies on, and fails unless the
// two agree on at least the transfers the wallet is known to have. Both scan
// shapes the source serves are checked: by sender (Blockscout's filter=from)
// and by recipient (filter=to), since Blockscout can break one without the
// other. A Blockscout API change makes every pair disagree and silently sends
// first scans back to the window-by-window path (#596), so this runs nightly
// (.github/workflows/blockscout-canary.yml). Read-only, public data.
//
// Usage: node scripts/check-blockscout-pair.js
const {
  ERC20_TRANSFER_TOPIC,
  fetchBlockscoutTransferLogs,
  logIndexFilter,
  logsAgree,
} = require('../src/main/networks/blockscout-logs');

const RPC_URL = 'https://rpc.gnosischain.com';
const XBZZ = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const DEPLOY_BLOCK = 16_514_506;
// The wallet of src/main/networks/__fixtures__/blockscout-xbzz-transfers.json,
// which had sent 11 and received 28 xBZZ transfers by 2026-10-07. Its history
// only grows, so fewer means one of the providers lost some, and none would
// let two providers agree on an empty answer.
const WALLET = '0x000000000000000000000000971f31aaeac713b47aa55e50c06409afc1de46b9';
const SIDES = [
  { name: 'sent', topics: [ERC20_TRANSFER_TOPIC, WALLET], knownTransfers: 11 },
  { name: 'received', topics: [ERC20_TRANSFER_TOPIC, null, WALLET], knownTransfers: 28 },
];
// Leaves the newest blocks out, as the router does, so a Blockscout a little
// behind the head still agrees.
const TAIL_BLOCKS = 1000;

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// One side's pair: both providers over the same span, at least the known
// transfers from each, and agreement (logsAgree, as the router requires).
async function checkSide(side, toBlock) {
  const params = [
    {
      address: XBZZ,
      fromBlock: `0x${DEPLOY_BLOCK.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: side.topics,
    },
  ];
  const filter = logIndexFilter(100, params);
  if (!filter) throw new Error(`${side.name}: not a scan the blockscout source serves`);
  const fromRpc = await rpc('eth_getLogs', params);
  const fromBlockscout = await fetchBlockscoutTransferLogs(filter, toBlock, {
    timeoutMs: 30_000,
  });
  console.log(
    `${side.name}, blocks ${DEPLOY_BLOCK}..${toBlock}: ${RPC_URL} ${fromRpc.length} logs, ` +
      `Blockscout ${fromBlockscout.length} transfers`
  );
  if (fromRpc.length < side.knownTransfers || fromBlockscout.length < side.knownTransfers) {
    throw new Error(
      `${side.name}: expected at least ${side.knownTransfers} transfers from each provider`
    );
  }
  if (!logsAgree(fromBlockscout, fromRpc))
    throw new Error(`${side.name}: the two providers disagree`);
  console.log(`${side.name}: they agree`);
}

async function main() {
  const head = Number.parseInt(await rpc('eth_blockNumber', []), 16);
  const toBlock = head - TAIL_BLOCKS;
  // Every side is checked even after one fails, so a run names each broken one.
  const failures = [];
  for (const side of SIDES) {
    try {
      await checkSide(side, toBlock);
    } catch (err) {
      failures.push(err.message);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

main().catch((err) => {
  console.error(`Blockscout pair check failed: ${err.message}`);
  process.exitCode = 1;
});
