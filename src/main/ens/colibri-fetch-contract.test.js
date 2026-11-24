/**
 * The fetch contract (`colibri-fetch-contract.js`, freedom-core design 0014,
 * "The fetch contract"): each variant admitted with its derived fields, for
 * chains 1 and 100, ZK on and off; one refusal test per rule, covering the
 * design's refusal list; and `sameVariant`, which redirects use.
 *
 * The recorded requests themselves are replayed in
 * `colibri-fetch-contract.vectors.test.js`.
 */

const {
  COLIBRI_CLIENT_VERSION,
  COLIBRI_FETCH_RULES,
  COLIBRI_FETCH_VARIANTS,
  CHECKPOINT_PROOF_PAYLOAD,
  MAX_PAYLOAD_BYTES,
  admit,
  sameVariant,
  joinPath,
} = require('./colibri-fetch-contract');
const { COLIBRI_PACKAGE_SERVERS } = require('./colibri-servers');
const { CHECKPOINT_NETWORKS } = require('../myotis/checkpoint-verifier');

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const SLOT = `0x${'00'.repeat(32)}`;
const BLOCK_HASH = '0x894663c507b8442ba56c559c28845c77141736bb91bc031e382d37d467f7f3d4';
const TX = '0x0c13128da2c6f7cb51c325950d65aabd14dd6b556746a9cdf3be566566bf7699';
const OTHER_TX = '0x1a81d62142d40021d6d043b5f80d731b1389e23bffc8d97215903baf29325994';
const ROOT = '0x29a83bd86e77b1cae82c5928dd781ae3a387166d6c574999679ed1aedafe27b2';
const PROVERS = {
  1: 'https://mainnet1.colibri-proof.tech',
  100: 'https://gnosis.colibri-proof.tech',
};
const C4 = { 1: '0x017e070000', 100: '0x01ea0e0000' };
const CHAR = (code) => String.fromCharCode(code);

// The design's limits, written out here rather than read from the module
// (design 0014, "Bounds on free fields" and "Body maximums").
const KIB = 1024;
const MIB = 1024 * KIB;
const PAYLOAD_CAP = 64 * 1024;
const MAX_BODY = {
  lc_updates: 16 * MIB,
  lc_bootstrap: 1 * MIB,
  finality: 64 * KIB,
  block_root: 64 * KIB,
  pap_account: 16 * MIB,
  pap_storage: 16 * MIB,
  code: 16 * MIB,
  block: 16 * MIB,
  tx_cache: 16 * MIB,
  tx_cache_incremental: 16 * MIB,
  tx_fallback: 16 * MIB,
  tx_receipts: 16 * MIB,
  tx_block: 16 * MIB,
  checkpoint_proof: 4 * MIB,
  checkpoint_root: 64 * KIB,
};

/** A `colibri.request` main has open. */
function request(method, params, { chain = 1, zk = true, id = 7, ...rest } = {}) {
  return {
    kind: 'request',
    id,
    chain,
    method,
    params: typeof params === 'string' ? params : JSON.stringify(params),
    zk,
    prover: PROVERS[chain] ?? 'https://prover.example',
    ...rest,
  };
}

/** A `colibri.checkpoint` main has open. */
function checkpoint(chain = 1, rest = {}) {
  return { kind: 'checkpoint', id: 9, chain, ...rest };
}

/** The props enrichment adds, as the C core writes them. */
function props(op, { c4 = C4[op.chain] ?? '0x01', zk = op.zk, lastBlockHash } = {}) {
  return {
    version: COLIBRI_CLIENT_VERSION,
    ...(c4 ? { c4 } : {}),
    ...(zk ? { zk_proof: true } : {}),
    ...(lastBlockHash ? { last_block_hash: lastBlockHash } : {}),
  };
}

/** A prover POST, as the service sends it. */
function post(op, method, params, extra = {}) {
  return {
    request: op.id,
    type: 'prover',
    method: 'post',
    path: '',
    payload: { method, params, ...props(op) },
    accept: 'ssz',
    exclude_mask: 0,
    ...extra,
  };
}

/** A GET, as the service sends it. */
function get(op, type, path, { accept = type === 'checkpointz' ? 'json' : 'ssz', maxAge } = {}) {
  return {
    request: op.id,
    type,
    method: 'get',
    path,
    accept,
    exclude_mask: 0,
    ...(maxAge !== undefined ? { max_age: maxAge } : {}),
  };
}

const SYNC = {
  lc_updates: (op) =>
    get(op, 'beacon_api', 'eth/v1/beacon/light_client/updates?start_period=1917&count=1'),
  lc_bootstrap: (op) => get(op, 'beacon_api', `eth/v1/beacon/light_client/bootstrap/${ROOT}`),
  finality: (op) => get(op, 'checkpointz', 'eth/v1/beacon/states/head/finality_checkpoints'),
  block_root: (op) => get(op, 'checkpointz', 'eth/v1/beacon/blocks/15713472/root'),
};

const txCache = (op) =>
  get(op, 'prover', 'tx_cache?max_blocks=256', { maxAge: op.chain === 100 ? 2 : 6 });
const txCacheFrom = (op, from = '26473703') =>
  get(op, 'prover', `tx_cache?from_block=${from}&max_blocks=256`, {
    maxAge: op.chain === 100 ? 2 : 6,
  });
const cached = (
  op,
  method,
  block = '0x193f4e6',
  { proof = op.zk ? 'zk' : 'std', state = '' } = {}
) => get(op, 'prover', `proof/${method}/${block}/196611/${proof}/0x${state}`);
const proofRequest = (op) => ({
  request: op.id,
  type: 'checkpoint_proof',
  method: 'post',
  path: '',
  accept: 'ssz',
  exclude_mask: 0,
});

/** Each served operation, by name: `(chain, zk) => op`. */
const OPERATIONS = {
  balance: (o) => request('eth_getBalance', [ADDRESS, 'latest'], o),
  nonce: (o) => request('eth_getTransactionCount', [ADDRESS, 'latest'], o),
  storage: (o) => request('eth_getStorageAt', [OTHER_ADDRESS, SLOT, 'latest'], o),
  code: (o) => request('eth_getCode', [OTHER_ADDRESS, 'latest'], o),
  blockNumber: (o) => request('eth_blockNumber', [], o),
  priorityFee: (o) => request('eth_maxPriorityFeePerGas', [], o),
  blockLatest: (o) => request('eth_getBlockByNumber', ['latest', false], o),
  blockNumbered: (o) => request('eth_getBlockByNumber', ['0x193f4e6', false], o),
  blockHashed: (o) => request('eth_getBlockByNumber', [BLOCK_HASH, false], o),
  blockEmpty: (o) => request('eth_getBlockByNumber', [], o),
  blockNull: (o) => request('eth_getBlockByNumber', null, o),
  blockByHash: (o) => request('eth_getBlockByHash', [BLOCK_HASH, false], o),
  tx: (o) => request('eth_getTransactionByHash', [TX], o),
  receipt: (o) => request('eth_getTransactionReceipt', [TX], o),
};

/**
 * Every variant with the fetch that reaches it: `[variant, operation,
 * fetch(op)]`.
 */
const ACCEPTED = [
  ['pap_account', 'balance', (op) => post(op, 'eth_getProof', [ADDRESS, [], 'latest'])],
  ['pap_account', 'nonce', (op) => post(op, 'eth_getProof', [ADDRESS, [], 'latest'])],
  ['pap_storage', 'storage', (op) => post(op, 'eth_getProof', [OTHER_ADDRESS, [SLOT], 'latest'])],
  ['code', 'code', (op) => post(op, 'eth_getCode', [OTHER_ADDRESS, 'latest'])],
  ['block', 'blockNumber', (op) => post(op, 'eth_blockNumber', [])],
  ['block', 'priorityFee', (op) => post(op, 'eth_maxPriorityFeePerGas', [])],
  ['block', 'blockLatest', (op) => post(op, 'eth_getBlockByNumber', ['latest', false])],
  ['block', 'blockNumbered', (op) => post(op, 'eth_getBlockByNumber', ['0x193f4e6', false])],
  ['block', 'blockHashed', (op) => post(op, 'eth_getBlockByNumber', [BLOCK_HASH, false])],
  ['block', 'blockEmpty', (op) => post(op, 'eth_getBlockByNumber', [])],
  // `null` params reach the C core as `[]`.
  ['block', 'blockNull', (op) => post(op, 'eth_getBlockByNumber', [])],
  ['block', 'blockByHash', (op) => post(op, 'eth_getBlockByHash', [BLOCK_HASH, false])],
  ['tx_cache', 'tx', txCache],
  ['tx_cache', 'receipt', txCache],
  ['tx_cache_incremental', 'tx', (op) => txCacheFrom(op)],
  ['tx_cache_incremental', 'receipt', (op) => txCacheFrom(op)],
  ['tx_fallback', 'tx', (op) => post(op, 'eth_getTransactionByHash', [TX])],
  ['tx_fallback', 'receipt', (op) => post(op, 'eth_getTransactionReceipt', [TX])],
  ['tx_block', 'tx', (op) => cached(op, 'eth_getBlockByNumber')],
  ['tx_receipts', 'receipt', (op) => cached(op, 'eth_getBlockReceipts')],
  ...Object.keys(OPERATIONS).flatMap((name) =>
    Object.entries(SYNC).map(([variant, fetch]) => [variant, name, fetch])
  ),
];

const CASES = [1, 100].flatMap((chain) =>
  [true, false].flatMap((zk) =>
    ACCEPTED.map(([variant, operation, fetch]) => [variant, operation, chain, zk, fetch])
  )
);

function serversFor(type, chain) {
  const lists = COLIBRI_PACKAGE_SERVERS[chain];
  return {
    prover: [PROVERS[chain]],
    beacon_api: [...lists.beacon_apis, PROVERS[chain]],
    checkpointz: [...lists.checkpointz, ...lists.beacon_apis, PROVERS[chain]],
  }[type];
}

/** Every server in order, none excluded. */
const everyAttempt = (servers) => servers.map((url, node) => ({ url, node }));

describe('each variant is admitted with its derived fields', () => {
  test.each(CASES)('%s for %s, chain %i, ZK %s', (variant, operation, chain, zk, fetchFor) => {
    const op = OPERATIONS[operation]({ chain, zk });
    const fetch = fetchFor(op);
    const admitted = admit(op, fetch);
    const spec = COLIBRI_FETCH_VARIANTS[variant];
    expect(admitted).toEqual({
      variant,
      type: spec.type,
      verb: spec.verb.toUpperCase(),
      path: fetch.path,
      payload: fetch.payload === undefined ? null : JSON.stringify(fetch.payload),
      accept: spec.encoding === 'json' ? 'application/json' : 'application/octet-stream',
      maxAge: fetch.max_age ?? null,
      maxBody: MAX_BODY[variant],
      attempts: everyAttempt(serversFor(spec.type, chain)),
      fields: expect.any(Object),
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.attempts)).toBe(true);
  });

  test.each([1, 100])("chain %i's checkpoint: the proof once, then roots", (chain) => {
    const op = checkpoint(chain);
    const network = CHECKPOINT_NETWORKS[chain];
    expect(admit(op, proofRequest(op))).toEqual({
      variant: 'checkpoint_proof',
      type: 'checkpoint_proof',
      verb: 'POST',
      path: '',
      payload: CHECKPOINT_PROOF_PAYLOAD,
      accept: 'application/octet-stream',
      maxAge: null,
      maxBody: MAX_BODY.checkpoint_proof,
      attempts: [{ url: network.prover, node: 0 }],
      fields: {},
    });
    expect(admit(op, get(op, 'checkpointz', 'eth/v1/beacon/blocks/15241024/root'))).toEqual({
      variant: 'checkpoint_root',
      type: 'checkpointz',
      verb: 'GET',
      path: 'eth/v1/beacon/blocks/15241024/root',
      payload: null,
      accept: 'application/json',
      maxAge: null,
      maxBody: MAX_BODY.checkpoint_root,
      attempts: [{ url: network.source, node: 0 }],
      fields: { slot: '15241024' },
    });
  });

  test("the checkpoint's proof is today's request: latest, ZK, the pinned version", () => {
    expect(JSON.parse(CHECKPOINT_PROOF_PAYLOAD)).toEqual({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
      version: 196611,
      zk_proof: true,
    });
  });

  test("every variant's body maximum and the payload cap are the design's", () => {
    expect(
      Object.fromEntries(
        Object.entries(COLIBRI_FETCH_VARIANTS).map(([name, spec]) => [name, spec.maxBody])
      )
    ).toEqual(MAX_BODY);
    expect(MAX_PAYLOAD_BYTES).toBe(64 * 1024);
  });

  test('every variant is reached', () => {
    const reached = new Set([
      ...ACCEPTED.map(([variant]) => variant),
      'checkpoint_proof',
      'checkpoint_root',
    ]);
    expect([...reached].sort()).toEqual(Object.keys(COLIBRI_FETCH_VARIANTS).sort());
  });

  test('a ZK client may ask without ZK (the F-4 fallback), with every optional prop', () => {
    const op = OPERATIONS.blockNumber({ zk: true });
    const lastBlockHash = `0x${'93'.repeat(32)}`;
    for (const payload of [
      { method: 'eth_blockNumber', params: [], version: 196611 },
      { method: 'eth_blockNumber', params: [], version: 196611, c4: C4[1] },
      {
        method: 'eth_blockNumber',
        params: [],
        version: 196611,
        c4: C4[1],
        last_block_hash: lastBlockHash,
      },
      {
        method: 'eth_blockNumber',
        params: [],
        version: 196611,
        c4: `0x${'ab'.repeat(41)}`,
        zk_proof: true,
        last_block_hash: lastBlockHash,
      },
    ]) {
      expect(admit(op, { ...post(op, 'eth_blockNumber', []), payload }).variant).toBe('block');
    }
    const tx = OPERATIONS.tx({ zk: true });
    expect(
      admit(tx, cached(tx, 'eth_getBlockByNumber', '0x193f4e6', { proof: 'std' })).variant
    ).toBe('tx_block');
  });

  test('hex in derived fields compares without regard to case', () => {
    const op = OPERATIONS.balance({});
    expect(admit(op, post(op, 'eth_getProof', [ADDRESS.toLowerCase(), [], 'latest'])).variant).toBe(
      'pap_account'
    );
    const tx = OPERATIONS.tx({});
    expect(
      admit(tx, post(tx, 'eth_getTransactionByHash', [TX.toUpperCase().replace('0X', '0x')]))
        .variant
    ).toBe('tx_fallback');
  });

  test('the free fields at their bounds', () => {
    const tx = OPERATIONS.tx({});
    expect(admit(tx, txCacheFrom(tx, '18446744073709551615')).variant).toBe('tx_cache_incremental');
    expect(admit(tx, txCacheFrom(tx, '0')).variant).toBe('tx_cache_incremental');
    expect(admit(tx, cached(tx, 'eth_getBlockByNumber', '0xffffffffffffffff')).variant).toBe(
      'tx_block'
    );
    expect(admit(tx, cached(tx, 'eth_getBlockByNumber', '0x0')).variant).toBe('tx_block');
    expect(
      admit(tx, cached(tx, 'eth_getBlockByNumber', '0x1', { state: '01'.repeat(41) })).variant
    ).toBe('tx_block');
    expect(
      admit(
        tx,
        get(tx, 'beacon_api', 'eth/v1/beacon/light_client/updates?start_period=4294967295&count=0')
      ).variant
    ).toBe('lc_updates');
    expect(
      admit(tx, get(tx, 'checkpointz', 'eth/v1/beacon/blocks/18446744073709551615/root')).variant
    ).toBe('block_root');
    expect(
      admit(
        tx,
        get(
          tx,
          'beacon_api',
          `eth/v1/beacon/light_client/bootstrap/${ROOT.toUpperCase().replace('0X', '0x')}`
        )
      ).variant
    ).toBe('lc_bootstrap');
  });

  test('a payload of exactly 64 KiB is admitted', () => {
    const op = request('eth_blockNumber', ['']);
    const base = JSON.stringify(post(op, 'eth_blockNumber', ['']).payload).length;
    const fill = 'a'.repeat(PAYLOAD_CAP - base);
    const full = request('eth_blockNumber', [fill]);
    const fetch = post(full, 'eth_blockNumber', [fill]);
    expect(Buffer.byteLength(JSON.stringify(fetch.payload))).toBe(PAYLOAD_CAP);
    expect(admit(full, fetch).variant).toBe('block');
  });

  test('exclude_mask skips the servers its bits name, each attempt keeping its node', () => {
    const op = OPERATIONS.blockNumber({});
    const attempts = (fetch) => admit(op, fetch).attempts;
    const prover = PROVERS[1];
    // The one-server prover variant: kept, or excluded.
    expect(attempts(post(op, 'eth_blockNumber', []))).toEqual([{ url: prover, node: 0 }]);
    // Mainnet's checkpointz list: its 7 checkpointz servers, 3 beacon APIs,
    // then the prover (11).
    const list = [
      'https://sync-mainnet.beaconcha.in',
      'https://mainnet.checkpoint.sigp.io',
      'https://mainnet-checkpoint-sync.attestant.io',
      'https://beaconstate-mainnet.chainsafe.io',
      'https://mainnet-checkpoint-sync.stakely.io',
      'https://checkpointz.pietjepuk.net',
      'https://beaconstate.ethstaker.cc',
      'https://mainnet.colibri-proof.tech/consensus',
      'https://gateway.tenderly.co/public/mainnet',
      'https://ethereum-beacon-api.publicnode.com',
      prover,
    ];
    const finality = (mask) => attempts({ ...SYNC.finality(op), exclude_mask: mask });
    expect(finality(0)).toEqual(everyAttempt(list));
    expect(finality(0b1)).toEqual(everyAttempt(list).slice(1));
    expect(finality(0b10000000101)).toEqual([
      { url: list[1], node: 1 },
      { url: list[3], node: 3 },
      { url: list[4], node: 4 },
      { url: list[5], node: 5 },
      { url: list[6], node: 6 },
      { url: list[7], node: 7 },
      { url: list[8], node: 8 },
      { url: list[9], node: 9 },
    ]);
    expect(finality(2 ** 10)).toEqual(everyAttempt(list).slice(0, 10));
  });

  test('a mask that excludes every server is admitted with no attempts', () => {
    // fetch_from_servers skips them all and throws its first lastError, `All
    // nodes failed`: the executor answers that without sending anything.
    const op = OPERATIONS.blockNumber({});
    const all = admit(op, { ...post(op, 'eth_blockNumber', []), exclude_mask: 1 });
    expect(all.variant).toBe('block');
    expect(all.attempts).toEqual([]);
    expect(admit(op, { ...SYNC.finality(op), exclude_mask: 2 ** 11 - 1 }).attempts).toEqual([]);
    expect(admit(op, { ...SYNC.lc_bootstrap(op), exclude_mask: 0b1111 }).attempts).toEqual([]);
    const cp = checkpoint();
    expect(admit(cp, { ...proofRequest(cp), exclude_mask: 1 }).attempts).toEqual([]);
  });

  test('a checkpoint root up to the eighth', () => {
    const op = checkpoint(1, { taken: { checkpoint_root: 7, checkpoint_proof: 1 } });
    expect(admit(op, get(op, 'checkpointz', 'eth/v1/beacon/blocks/1/root')).variant).toBe(
      'checkpoint_root'
    );
  });
});

describe('refusals: one test per rule', () => {
  const hit = new Set();
  function expectRefused(op, fetch, rule) {
    expect(admit(op, fetch)).toEqual({ refused: rule });
    hit.add(rule);
  }
  const balance = OPERATIONS.balance({});
  const tx = OPERATIONS.tx({});

  test('request: no open operation, an ended one, or not its id', () => {
    const fetch = post(balance, 'eth_getProof', [ADDRESS, [], 'latest']);
    // No operation open, or another process's request id: main finds none.
    expectRefused(null, fetch, 'request');
    expectRefused(undefined, fetch, 'request');
    // Replied, cancelled or past its deadline.
    expectRefused({ ...balance, ended: true }, fetch, 'request');
    expectRefused(checkpoint(1, { ended: true }), proofRequest(checkpoint()), 'request');
    // Zero, a negative id, and an id no operation has.
    expectRefused(balance, { ...fetch, request: 0 }, 'request');
    expectRefused(balance, { ...fetch, request: -7 }, 'request');
    expectRefused(balance, { ...fetch, request: 12345 }, 'request');
    // Another open operation's id, with that operation's own shape.
    const other = OPERATIONS.tx({ id: 8 });
    expectRefused(balance, txCache(other), 'request');
    expectRefused(balance, { ...fetch, request: other.id }, 'request');
    expectRefused(other, fetch, 'request');
    const cp = checkpoint(1, { id: 10 });
    expectRefused(cp, { ...proofRequest(cp), request: balance.id }, 'request');
  });

  test("fetch: params that aren't shell.colibri_fetch's", () => {
    const fetch = SYNC.finality(balance);
    for (const bad of [
      null,
      [],
      'finality',
      { ...fetch, url: 'x' },
      { ...fetch, exclude_mask: '0' },
      { ...fetch, exclude_mask: -1 },
      { ...fetch, exclude_mask: 2 ** 32 },
      { ...fetch, exclude_mask: 0.5 },
      { ...fetch, request: '7' },
      { ...fetch, request: undefined },
      { ...fetch, type: 1 },
      { ...fetch, method: null },
      { ...fetch, path: undefined },
      { ...fetch, accept: 0 },
      { ...fetch, max_age: 0 },
      { ...fetch, max_age: '6' },
      { ...fetch, max_age: 1.5 },
    ]) {
      expectRefused(balance, bad, 'fetch');
    }
  });

  test("operation: a form the service doesn't serve admits nothing, the sync variants included", () => {
    for (const op of [
      request('eth_call', [{ to: OTHER_ADDRESS, data: '0x313ce567' }, 'latest']),
      request('eth_estimateGas', [{ to: OTHER_ADDRESS, data: '0x313ce567' }, 'latest']),
      request('eth_gasPrice', []),
      request('eth_feeHistory', ['0x4', 'latest', [25, 75]]),
      request('eth_getLogs', [{}]),
      request('eth_getBalance', [ADDRESS, '0x193f4e6']),
      request('eth_getBalance', [ADDRESS, 'pending']),
      request('eth_getBalance', [ADDRESS]),
      request('eth_getBalance', [ADDRESS, { blockHash: BLOCK_HASH }]),
      request('eth_getBalance', { 0: ADDRESS }),
      request('eth_getBalance', JSON.stringify(ADDRESS)),
      request('eth_getBalance', null),
      request('eth_getBlockByNumber', ['0X10', false]),
      request('eth_getBlockByNumber', ['1x10', false]),
      request('eth_getBlockByNumber', ['safe', false]),
      request('eth_getBlockByHash', ['latest', false]),
      // The transaction variants bind `[h]`.
      request('eth_getTransactionByHash', [TX, 1]),
      request('eth_getTransactionByHash', ['0x1234']),
      request('eth_getTransactionReceipt', []),
      request('eth_getTransactionReceipt', JSON.stringify(TX)),
      request('eth_getTransactionReceipt', [{ hash: TX }]),
      // Params that aren't JSON.
      request('eth_blockNumber', 'not json'),
    ]) {
      for (const fetch of [
        ...Object.values(SYNC).map((sync) => sync(op)),
        post(op, 'eth_getProof', [ADDRESS, [], '0x193f4e6']),
        txCache(op),
      ]) {
        expectRefused(op, fetch, 'operation');
      }
    }
  });

  test('eth_rpc: every eth_rpc request, for every operation', () => {
    const rpc = (op, method, params) => ({
      request: op.id,
      type: 'eth_rpc',
      method: 'post',
      path: '',
      payload: { jsonrpc: '2.0', id: 1, method, params },
      accept: 'json',
      exclude_mask: 0,
    });
    for (const make of Object.values(OPERATIONS)) {
      const op = make({});
      // A storage read, a code read and a pass-through.
      expectRefused(op, rpc(op, 'eth_getStorageAt', [OTHER_ADDRESS, SLOT, 'latest']), 'eth_rpc');
      expectRefused(op, rpc(op, 'eth_getCode', [OTHER_ADDRESS.toLowerCase(), 'latest']), 'eth_rpc');
      expectRefused(op, rpc(op, 'eth_getBalance', [ADDRESS, 'latest']), 'eth_rpc');
      // A proof payload as eth_rpc.
      expectRefused(
        op,
        { ...post(op, 'eth_getProof', [ADDRESS, [], 'latest']), type: 'eth_rpc' },
        'eth_rpc'
      );
    }
    const code = OPERATIONS.code({});
    expectRefused(code, rpc(code, 'eth_getCode', [OTHER_ADDRESS, 'latest']), 'eth_rpc');
    const op = checkpoint();
    expectRefused(op, rpc(op, 'eth_getBlockByNumber', ['latest', false]), 'eth_rpc');
  });

  test("type: a type the process doesn't fetch, or another type's path", () => {
    for (const type of ['beacon', 'PROVER', 'checkpoint_proof', '']) {
      expectRefused(balance, { ...SYNC.finality(balance), type }, 'type');
    }
    const op = checkpoint();
    expectRefused(op, { ...proofRequest(op), type: 'prover' }, 'type');
    // A beacon path as prover, a checkpointz path as beacon_api, a prover
    // path as checkpointz, a POST as a beacon API.
    expectRefused(balance, { ...SYNC.lc_bootstrap(balance), type: 'prover' }, 'type');
    expectRefused(balance, { ...SYNC.finality(balance), type: 'beacon_api' }, 'type');
    expectRefused(tx, { ...txCache(tx), type: 'checkpointz' }, 'type');
    expectRefused(
      balance,
      { ...post(balance, 'eth_getProof', [ADDRESS, [], 'latest']), type: 'beacon_api' },
      'type'
    );
    expectRefused(op, { ...proofRequest(op), path: 'tx_cache?max_blocks=256' }, 'type');
  });

  test("verb: anything but the variant's own", () => {
    const fetch = post(balance, 'eth_getProof', [ADDRESS, [], 'latest']);
    for (const method of ['put', 'delete', 'GET', 'POST', 'get ', ' post', '']) {
      expectRefused(balance, { ...fetch, method }, 'verb');
      expectRefused(balance, { ...SYNC.finality(balance), method }, 'verb');
    }
    expectRefused(balance, { ...fetch, method: 'get' }, 'verb');
    expectRefused(balance, { ...SYNC.finality(balance), method: 'post' }, 'verb');
    expectRefused(tx, { ...txCache(tx), method: 'post' }, 'verb');
    const op = checkpoint();
    expectRefused(op, { ...proofRequest(op), method: 'get' }, 'verb');
  });

  test('path-absolute: absolute and scheme-relative paths', () => {
    for (const path of [
      'https://evil.example/eth/v1/beacon/states/head/finality_checkpoints',
      'http://evil.example',
      'HTTPS://evil.example/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '//evil.example/eth/v1/beacon/states/head/finality_checkpoints',
    ]) {
      expectRefused(balance, { ...SYNC.finality(balance), path }, 'path-absolute');
    }
  });

  test('path-leading-slash', () => {
    expectRefused(
      balance,
      { ...SYNC.finality(balance), path: '/eth/v1/beacon/states/head/finality_checkpoints' },
      'path-leading-slash'
    );
  });

  test('path-backslash', () => {
    expectRefused(
      balance,
      { ...SYNC.finality(balance), path: 'eth\\v1\\beacon\\states\\head\\finality_checkpoints' },
      'path-backslash'
    );
  });

  test('path-percent: %2f, %2e and any other escape', () => {
    for (const path of [
      'eth/v1/beacon/light_client/bootstrap%2f..%2f..',
      '%2e%2e/eth/v1/beacon/states/head/finality_checkpoints',
      'eth/v1/beacon/blocks/1%30/root',
    ]) {
      expectRefused(balance, { ...SYNC.finality(balance), path }, 'path-percent');
    }
  });

  test('path-double-slash', () => {
    expectRefused(
      balance,
      { ...SYNC.finality(balance), path: 'eth//v1/beacon/states/head/finality_checkpoints' },
      'path-double-slash'
    );
  });

  test('path-dot-segment', () => {
    for (const path of [
      'eth/v1/beacon/../beacon/states/head/finality_checkpoints',
      './eth/v1/beacon/states/head/finality_checkpoints',
      'eth/v1/beacon/light_client/bootstrap/..',
      'eth/v1/beacon/light_client/bootstrap/.',
      '..',
    ]) {
      expectRefused(balance, { ...SYNC.finality(balance), path }, 'path-dot-segment');
    }
  });

  test('path-control: any control character', () => {
    for (const code of [0, 9, 10, 13, 27, 31, 127]) {
      const path = `eth/v1/beacon/states/head/finality_checkpoints${CHAR(code)}`;
      expectRefused(balance, { ...SYNC.finality(balance), path }, 'path-control');
    }
  });

  test('payload: over 64 KiB, on a variant without one, or not an object', () => {
    const op = request('eth_blockNumber', ['']);
    const base = JSON.stringify(post(op, 'eth_blockNumber', ['']).payload).length;
    const fill = 'a'.repeat(PAYLOAD_CAP - base + 1);
    const over = request('eth_blockNumber', [fill]);
    expectRefused(over, post(over, 'eth_blockNumber', [fill]), 'payload');
    // Counted in bytes: two-byte characters.
    const wide = 'é'.repeat(Math.floor((PAYLOAD_CAP - base) / 2) + 1);
    const wideOp = request('eth_blockNumber', [wide]);
    expectRefused(wideOp, post(wideOp, 'eth_blockNumber', [wide]), 'payload');
    expectRefused(tx, { ...txCache(tx), payload: { method: 'x' } }, 'payload');
    expectRefused(balance, { ...SYNC.finality(balance), payload: null }, 'payload');
    const cp = checkpoint();
    // Nothing is taken from the service for the checkpoint's proof.
    expectRefused(
      cp,
      { ...proofRequest(cp), payload: JSON.parse(CHECKPOINT_PROOF_PAYLOAD) },
      'payload'
    );
    for (const payload of [null, [], 'eth_getProof', 1]) {
      expectRefused(balance, { ...post(balance, 'eth_getProof', []), payload }, 'payload');
    }
  });

  test("query: a query that isn't the variant's own, in its order", () => {
    for (const path of [
      'tx_cache?max_blocks=256&x=1',
      'tx_cache?max_blocks=256&from_block=5',
      'tx_cache?from_block=5',
      'tx_cache?max_blocks',
      'tx_cache?',
      'tx_cache?max_blocks=256&max_blocks=256',
    ]) {
      expectRefused(tx, { ...txCache(tx), path }, 'query');
    }
    // A signer set, which no configuration main runs sets.
    expectRefused(
      tx,
      cached(tx, 'eth_getBlockByNumber', '0x193f4e6', { state: `01?signers=0x${'ab'.repeat(20)}` }),
      'query'
    );
    expectRefused(
      balance,
      { ...SYNC.finality(balance), path: `${SYNC.finality(balance).path}?x=1` },
      'query'
    );
    expectRefused(
      balance,
      {
        ...SYNC.lc_updates(balance),
        path: 'eth/v1/beacon/light_client/updates?count=1&start_period=1917',
      },
      'query'
    );
    expectRefused(
      balance,
      { ...post(balance, 'eth_getProof', [ADDRESS, [], 'latest']), path: '?x=1' },
      'query'
    );
  });

  test('variant: a shape no variant of this operation has', () => {
    // Request A's id with request B's variant.
    expectRefused(balance, txCache(balance), 'variant');
    expectRefused(balance, cached(balance, 'eth_getBlockByNumber'), 'variant');
    expectRefused(OPERATIONS.receipt({}), cached(tx, 'eth_getBlockByNumber'), 'variant');
    expectRefused(tx, cached(tx, 'eth_getBlockReceipts'), 'variant');
    // A call's header sub-proof, for every operation.
    for (const make of Object.values(OPERATIONS)) {
      const op = make({});
      expectRefused(
        op,
        get(op, 'prover', 'proof/eth_getBlockHeader/latest/196611/zk/0x', { maxAge: 6 }),
        'variant'
      );
    }
    // Paths no variant has.
    expectRefused(balance, get(balance, 'beacon_api', 'eth/v1/node/version'), 'variant');
    expectRefused(balance, get(balance, 'prover', 'unverified_rpc'), 'variant');
    expectRefused(balance, get(balance, 'checkpointz', 'checkpointz/v1/beacon/slots'), 'variant');
    // A checkpoint process has no sync or prover variant.
    const op = checkpoint();
    expectRefused(op, SYNC.lc_updates(op), 'variant');
    expectRefused(op, SYNC.finality(op), 'variant');
  });

  test("accept: not the variant's encoding", () => {
    expectRefused(tx, { ...txCache(tx), accept: 'json' }, 'accept');
    expectRefused(balance, { ...SYNC.finality(balance), accept: 'ssz' }, 'accept');
    expectRefused(balance, { ...SYNC.lc_bootstrap(balance), accept: 'octet' }, 'accept');
    expectRefused(
      balance,
      { ...post(balance, 'eth_getProof', [ADDRESS, [], 'latest']), accept: '' },
      'accept'
    );
    const op = checkpoint();
    expectRefused(op, { ...proofRequest(op), accept: 'json' }, 'accept');
  });

  test('field: a free field out of bounds', () => {
    for (const from of ['0123', '-1', '+1', '18446744073709551616', '1e3', '0x10', '', ' 1']) {
      expectRefused(tx, txCacheFrom(tx, from), 'field');
    }
    for (const block of [
      '0x0193f4e6',
      '0x',
      '0X1',
      'latest',
      'finalized',
      '0x1ffffffffffffffff',
      `0x${'ab'.repeat(32)}`,
    ]) {
      expectRefused(tx, cached(tx, 'eth_getBlockByNumber', block), 'field');
    }
    // An over-long or odd client state.
    expectRefused(
      tx,
      cached(tx, 'eth_getBlockByNumber', '0x1', { state: '01'.repeat(42) }),
      'field'
    );
    expectRefused(tx, cached(tx, 'eth_getBlockByNumber', '0x1', { state: 'abc' }), 'field');
    for (const query of [
      'start_period=4294967296&count=1',
      'start_period=1&count=01',
      'start_period=&count=1',
    ]) {
      expectRefused(
        balance,
        get(balance, 'beacon_api', `eth/v1/beacon/light_client/updates?${query}`),
        'field'
      );
    }
    for (const root of [
      `0x${'ab'.repeat(31)}`,
      `0x${'ab'.repeat(33)}`,
      'ab'.repeat(32),
      `0x${'gg'.repeat(32)}`,
    ]) {
      expectRefused(
        balance,
        get(balance, 'beacon_api', `eth/v1/beacon/light_client/bootstrap/${root}`),
        'field'
      );
    }
    for (const slot of ['18446744073709551616', '01', 'head', '0x10']) {
      expectRefused(
        balance,
        get(balance, 'checkpointz', `eth/v1/beacon/blocks/${slot}/root`),
        'field'
      );
      const op = checkpoint();
      expectRefused(op, get(op, 'checkpointz', `eth/v1/beacon/blocks/${slot}/root`), 'field');
    }
  });

  test('derived: a field main derives, different', () => {
    // eth_getBalance sent as itself instead of as eth_getProof.
    expectRefused(balance, post(balance, 'eth_getBalance', [ADDRESS, 'latest']), 'derived');
    // Another address, another block, another slot.
    expectRefused(balance, post(balance, 'eth_getProof', [OTHER_ADDRESS, [], 'latest']), 'derived');
    expectRefused(balance, post(balance, 'eth_getProof', [ADDRESS, [], 'pending']), 'derived');
    // A state read at another block.
    expectRefused(balance, post(balance, 'eth_getProof', [ADDRESS, [], '0x193f4e6']), 'derived');
    expectRefused(balance, post(balance, 'eth_getProof', [ADDRESS, [SLOT], 'latest']), 'derived');
    const storage = OPERATIONS.storage({});
    expectRefused(
      storage,
      post(storage, 'eth_getProof', [OTHER_ADDRESS, [`0x${'01'.repeat(32)}`], 'latest']),
      'derived'
    );
    expectRefused(
      storage,
      post(storage, 'eth_getStorageAt', [OTHER_ADDRESS, SLOT, 'latest']),
      'derived'
    );
    // eth_getCode's proof, not a code read through the prover.
    const code = OPERATIONS.code({});
    expectRefused(code, post(code, 'eth_getProof', [OTHER_ADDRESS, [], 'latest']), 'derived');
    // Another block, another hash.
    const block = OPERATIONS.blockNumbered({});
    expectRefused(block, post(block, 'eth_getBlockByNumber', ['0x193f4e7', false]), 'derived');
    expectRefused(block, post(block, 'eth_getBlockByNumber', ['0x193f4e6', true]), 'derived');
    expectRefused(block, post(block, 'eth_getBlockByNumber', ['0x193f4e6']), 'derived');
    expectRefused(tx, post(tx, 'eth_getTransactionByHash', [OTHER_TX]), 'derived');
    expectRefused(tx, post(tx, 'eth_getTransactionReceipt', [TX]), 'derived');
    // A call's proof request, as a POST variant.
    expectRefused(
      block,
      post(block, 'colibri_proofCall', [{ to: OTHER_ADDRESS, data: '0x' }, 'latest']),
      'derived'
    );
    // No method or no params.
    const { method: _method, ...noMethod } = post(balance, 'eth_getProof', [
      ADDRESS,
      [],
      'latest',
    ]).payload;
    expectRefused(balance, { ...post(balance, 'eth_getProof', []), payload: noMethod }, 'derived');
    // A cached GET with another version or proof kind; tx_cache with
    // another max_blocks.
    expectRefused(tx, get(tx, 'prover', 'proof/eth_getBlockByNumber/0x1/196610/zk/0x'), 'derived');
    expectRefused(tx, get(tx, 'prover', 'proof/eth_getBlockByNumber/0x1/196611/ZK/0x'), 'derived');
    expectRefused(tx, { ...txCache(tx), path: 'tx_cache?max_blocks=257' }, 'derived');
    expectRefused(
      tx,
      { ...txCacheFrom(tx), path: 'tx_cache?from_block=5&max_blocks=1024' },
      'derived'
    );
  });

  test("props: the props wrong, out of order, or an option main's configuration doesn't set", () => {
    const base = post(balance, 'eth_getProof', [ADDRESS, [], 'latest']);
    const withPayload = (payload) => ({ ...base, payload });
    const { method, params } = base.payload;
    for (const payload of [
      { method, params, version: 196610 },
      { method, params, version: '196611' },
      { method, params },
      { method, params, version: 196611, c4: `0x${'ab'.repeat(42)}` },
      { method, params, version: 196611, c4: '0x' },
      { method, params, version: 196611, c4: '0xabc' },
      { method, params, version: 196611, c4: 'ab' },
      { method, params, version: 196611, zk_proof: false },
      { method, params, version: 196611, last_block_hash: `0x${'ab'.repeat(31)}` },
      // Out of order.
      { method, version: 196611, params },
      { params, method, version: 196611 },
      { method, params, version: 196611, zk_proof: true, c4: C4[1] },
      // Options the configuration doesn't set.
      { method, params, version: 196611, include_code: true },
      { method, params, version: 196611, logs_completeness: true },
      { method, params, version: 196611, signers: `0x${'ab'.repeat(20)}` },
      { method, params, version: 196611, rpc: 'https://rpc.example' },
      { method, params, version: 196611, beacon: 'https://beacon.example' },
      { jsonrpc: '2.0', id: 1, method, params, version: 196611 },
    ]) {
      expectRefused(balance, withPayload(payload), 'props');
    }
    // zk_proof or zk on a client without ZK.
    const plain = OPERATIONS.balance({ zk: false });
    expectRefused(
      plain,
      {
        ...post(plain, 'eth_getProof', [ADDRESS, [], 'latest']),
        payload: { method, params, version: 196611, zk_proof: true },
      },
      'props'
    );
    const plainTx = OPERATIONS.tx({ zk: false });
    expectRefused(
      plainTx,
      cached(plainTx, 'eth_getBlockByNumber', '0x193f4e6', { proof: 'zk' }),
      'props'
    );
  });

  test('max_age: only where the variant has one, and only its derived age', () => {
    expectRefused(tx, { ...txCache(tx), max_age: 5 }, 'max_age');
    const { max_age: _age, ...noAge } = txCache(tx);
    expectRefused(tx, noAge, 'max_age');
    // Gnosis's age on mainnet, and mainnet's on Gnosis.
    expectRefused(tx, { ...txCacheFrom(tx), max_age: 2 }, 'max_age');
    const gnosis = OPERATIONS.tx({ chain: 100 });
    expectRefused(gnosis, { ...txCache(gnosis), max_age: 6 }, 'max_age');
    // A block number's cached GET has no TTL.
    expectRefused(tx, { ...cached(tx, 'eth_getBlockByNumber'), max_age: 6 }, 'max_age');
    expectRefused(
      balance,
      { ...post(balance, 'eth_getProof', [ADDRESS, [], 'latest']), max_age: 6 },
      'max_age'
    );
    expectRefused(balance, { ...SYNC.finality(balance), max_age: 192 }, 'max_age');
    const op = checkpoint();
    expectRefused(op, { ...proofRequest(op), max_age: 6 }, 'max_age');
  });

  test('servers: a type with no server', () => {
    // A checkpoint on a chain main has no checkpoint network for.
    const op = checkpoint(11155111);
    expectRefused(op, proofRequest(op), 'servers');
    expectRefused(op, get(op, 'checkpointz', 'eth/v1/beacon/blocks/1/root'), 'servers');
  });

  test('exclude_mask: a bit past the list', () => {
    expectRefused(
      balance,
      { ...post(balance, 'eth_getProof', [ADDRESS, [], 'latest']), exclude_mask: 2 },
      'exclude_mask'
    );
    expectRefused(
      balance,
      { ...SYNC.lc_bootstrap(balance), exclude_mask: 0b10000 },
      'exclude_mask'
    );
    expectRefused(balance, { ...SYNC.finality(balance), exclude_mask: 2 ** 11 }, 'exclude_mask');
    expectRefused(
      balance,
      { ...SYNC.finality(balance), exclude_mask: 2 ** 32 - 1 },
      'exclude_mask'
    );
    const op = checkpoint();
    expectRefused(op, { ...proofRequest(op), exclude_mask: 2 }, 'exclude_mask');
  });

  test("count: the checkpoint's proof once, its roots eight times", () => {
    const op = checkpoint(1, { taken: { checkpoint_proof: 1, checkpoint_root: 8 } });
    expectRefused(op, proofRequest(op), 'count');
    expectRefused(op, get(op, 'checkpointz', 'eth/v1/beacon/blocks/1/root'), 'count');
  });

  test('every rule has its refusal test', () => {
    expect([...hit].sort()).toEqual([...COLIBRI_FETCH_RULES].sort());
  });
});

describe("main's own operation is checked, not refused", () => {
  test.each([
    // Every operation carries main's id, a positive integer.
    [{ kind: 'checkpoint', chain: 1 }],
    [{ kind: 'checkpoint', id: 0, chain: 1 }],
    [{ kind: 'checkpoint', id: -1, chain: 1 }],
    [{ kind: 'checkpoint', id: 1.5, chain: 1 }],
    [{ kind: 'checkpoint', id: '9', chain: 1 }],
    [{ kind: 'checkpoint', id: 2 ** 53, chain: 1 }],
    [{ kind: 'request', chain: 1, method: 'eth_blockNumber', params: '[]', zk: true, prover: 'x' }],
    [{ kind: 'stream', id: 1, chain: 1 }],
    [
      {
        kind: 'request',
        id: 1,
        chain: 0,
        method: 'eth_blockNumber',
        params: '[]',
        zk: true,
        prover: 'x',
      },
    ],
    [
      {
        kind: 'request',
        id: 1,
        chain: 1,
        method: 'eth_blockNumber',
        params: [],
        zk: true,
        prover: 'x',
      },
    ],
    [{ kind: 'request', id: 1, chain: 1, method: 'eth_blockNumber', params: '[]', prover: 'x' }],
    [{ kind: 'request', id: 1, chain: 1, method: 'eth_blockNumber', params: '[]', zk: true }],
    [{ kind: 'checkpoint', id: 1, chain: '1' }],
  ])('%j', (op) => {
    expect(() => admit(op, SYNC.finality({ id: 1 }))).toThrow(TypeError);
  });
});

describe('sameVariant: a redirect stays the fetch it redirects', () => {
  const op = OPERATIONS.receipt({});
  const same = (a, b) => sameVariant(admit(op, a), admit(op, b));

  test('the same variant with the same fields', () => {
    expect(same(SYNC.lc_bootstrap(op), SYNC.lc_bootstrap(op))).toBe(true);
    // Hex fields compare without regard to case.
    expect(
      same(SYNC.lc_bootstrap(op), {
        ...SYNC.lc_bootstrap(op),
        path: `eth/v1/beacon/light_client/bootstrap/${ROOT.toUpperCase().replace('0X', '0x')}`,
      })
    ).toBe(true);
    expect(same(txCacheFrom(op, '5'), txCacheFrom(op, '5'))).toBe(true);
    expect(
      same(
        post(op, 'eth_getTransactionReceipt', [TX]),
        post(op, 'eth_getTransactionReceipt', [TX.toUpperCase().replace('0X', '0x')])
      )
    ).toBe(true);
  });

  test('another variant or another bound field is not', () => {
    expect(same(txCache(op), txCacheFrom(op))).toBe(false);
    expect(same(txCacheFrom(op, '5'), txCacheFrom(op, '6'))).toBe(false);
    expect(
      same(
        SYNC.lc_bootstrap(op),
        get(op, 'beacon_api', `eth/v1/beacon/light_client/bootstrap/0x${'11'.repeat(32)}`)
      )
    ).toBe(false);
    expect(
      same(SYNC.block_root(op), get(op, 'checkpointz', 'eth/v1/beacon/blocks/15713473/root'))
    ).toBe(false);
    expect(
      same(cached(op, 'eth_getBlockReceipts', '0x1'), cached(op, 'eth_getBlockReceipts', '0x2'))
    ).toBe(false);
    expect(
      same(
        cached(op, 'eth_getBlockReceipts', '0x1'),
        cached(op, 'eth_getBlockReceipts', '0x1', { proof: 'std' })
      )
    ).toBe(false);
    expect(
      same(post(op, 'eth_getTransactionReceipt', [TX]), {
        ...post(op, 'eth_getTransactionReceipt', [TX]),
        payload: { method: 'eth_getTransactionReceipt', params: [TX], version: 196611 },
      })
    ).toBe(false);
  });

  test('a refusal is never the same', () => {
    const admitted = admit(op, txCache(op));
    expect(sameVariant(admitted, { refused: 'variant' })).toBe(false);
    expect(sameVariant({ refused: 'variant' }, { refused: 'variant' })).toBe(false);
    expect(sameVariant(admitted, null)).toBe(false);
  });
});

describe('joinPath', () => {
  test('joins as fetch_from_servers joins', () => {
    expect(joinPath('https://a.example', '')).toBe('https://a.example');
    expect(joinPath('https://a.example', 'x/y')).toBe('https://a.example/x/y');
    expect(joinPath('https://a.example/', 'x/y')).toBe('https://a.example/x/y');
    expect(joinPath('https://a.example/public/mainnet', 'eth/v1')).toBe(
      'https://a.example/public/mainnet/eth/v1'
    );
  });
});
