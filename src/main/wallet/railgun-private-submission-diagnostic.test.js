/** Preflight refusal diagnostics at the production boundary: the real submission
 * core, private and deployment preflights, privacy contexts, ABI and intent
 * binding. Only RPC replies, local artifact files, the completion claim, the
 * proof verifier and EOA work are simulated. */
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mock.enrollment,
  assertRailgunFencedAccountEnrollment: () => {
    throw Error('fence');
  },
}));
jest.mock('./railgun-shield-pins.json', () => {
  const pins = jest.requireActual('./railgun-shield-pins.json');
  const { keccak256 } = require('ethers');
  return {
    ...pins,
    codeHashes: Object.fromEntries(
      Object.keys(pins.codeHashes).map((name) => [name, keccak256('0x6001')])
    ),
  };
});
jest.mock('./railgun-private-operation', () => ({
  claimRailgunPrivateCompletion: (receipt, identity, enrollment) => {
    if (
      receipt !== mock.receipt ||
      identity !== mock.identity ||
      enrollment !== mock.enrollment ||
      mock.claimed
    )
      throw Error('completion');
    mock.claimed = true;
    return mock.claim;
  },
}));
jest.mock('./railgun-private-proof', () => ({
  verifyRailgunPrivateProof: async () => mock.proof,
  assertRailgunPrivateProof: () => {},
}));
jest.mock('./railgun-artifacts', () => ({
  loadRailgunArtifacts: async (options) => mock.loadArtifacts(options),
  assertRailgunArtifactVerifier: (artifacts, encoded) => mock.verifyArtifacts(artifacts, encoded),
}));
// The network boundary: one client per privacy context, validated like the real one.
jest.mock('../networks/private-rpc', () => ({
  createPrivateRpc: (handle) => {
    const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
    const context = getPrivacyContext(handle);
    const operation = context.subject.operation;
    return {
      signal: AbortSignal.any([context.signal, mock.endpoint.signal]),
      assertActive() {
        getPrivacyContext(handle);
        if (mock.endpoint.signal.aborted)
          throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private RPC lifetime ended');
      },
      release() {},
      async request(method, params, validate) {
        const result = await mock.reply(operation, method, params);
        if (!validate(result))
          throw privacyError('PRIVATE_RPC_INVALID', 'Invalid private RPC result');
        return { result };
      },
    };
  },
}));
jest.mock('./signers', () => ({ getSigner: () => mock.signer }));
jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: () => {
    mock.eoa.push('network');
    if (mock.networkFailure) throw mock.networkFailure;
    return mock.network;
  },
}));
jest.mock('./transaction-service', () => ({
  signAndSendTransaction: async () => {
    mock.eoa.push('send');
    return { hash: '0x' + 'c'.repeat(64) };
  },
}));
const { Interface, id, toBeHex } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const { extractRailgunTransactIntent } = require('./railgun-transact-intent');
const {
  submitRailgunPrivateTransaction: submit,
  getRailgunPrivateSubmissionDiagnostic: diagnosticOf,
} = require('./railgun-private-submission');
const live = require('../../../scripts/qualify-railgun-private-live');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([
  'function railgun() view returns (address)',
  'function wBase() view returns (address)',
  'function shieldFee() view returns (uint120)',
  'function tokenBlocklist(address) view returns (bool)',
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function unshieldFee() view returns (uint120)',
  'function getVerificationKey(uint256,uint256)',
]);
const SECRET_PATH = '/Users/someone/identity-data/vault';
const PAUSED_SLOT = toBeHex(BigInt(id('eip1967.proxy.paused')) - 1n, 32);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
// Distinguishing failures carry text, hex and paths that must never surface.
const hostile = (code) => {
  const error = Object.assign(
    Error(`secret ${SECRET_PATH} ${word(10)} ${'0x' + 'ab'.repeat(32)}`),
    { ...(code === undefined ? {} : { code }), data: '0x' + 'de'.repeat(40), path: SECRET_PATH }
  );
  error.stack = `Error: secret\n    at ${SECRET_PATH}/x.js:1:1`;
  return error;
};
const callName = (method, params) =>
  method === 'eth_call' ? abi.parseTransaction(params[0]).name : method;
function honest(method, params) {
  if (method === 'eth_getBlockByNumber') return { ...mock.header };
  if (method === 'eth_getCode') return '0x6001';
  if (method === 'eth_getStorageAt')
    return params[1] === PAUSED_SLOT
      ? word(0)
      : '0x' + pins.implementation.slice(2).padStart(64, '0');
  const name = callName(method, params);
  if (name === 'getVerificationKey') return '0x1234';
  const value = {
    railgun: pins.proxy,
    wBase: pins.wrappedNative,
    shieldFee: 25n,
    tokenBlocklist: false,
    rootHistory: true,
    unshieldFee: 25n,
    nullifiers: false,
  }[name];
  return abi.encodeFunctionResult(name, [value]).toLowerCase();
}
let scope, options;
function setup({ checkpointHash = 'b'.repeat(64), intentDigest } = {}) {
  const f = fixture(),
    tx = f.transaction(),
    parsed = extractRailgunTransactIntent(tx);
  const owner = tx.from;
  delete tx.from;
  scope = createPrivacyScope({
    profileId: 'diagnostic-unit',
    signal: new AbortController().signal,
  });
  mock = {
    receipt: {},
    identity: {},
    requests: [],
    eoa: [],
    endpoint: new AbortController(),
    header: {
      number: '0xb4f9a0',
      hash: '0x' + 'a1'.repeat(32),
      timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
    },
    fault: () => undefined,
  };
  mock.reply = async (operation, method, params) => {
    const name = callName(method, params);
    mock.requests.push(`${operation}:${name}`);
    const value = await mock.fault({ operation, method, name, params });
    return value === undefined ? honest(method, params) : value;
  };
  mock.loadArtifacts = async ({ variant }) => ({
    variant,
    wasm: Buffer.alloc(4, 1),
    zkey: Buffer.alloc(4, 2),
  });
  mock.verifyArtifacts = (_artifacts, encoded) => {
    if (encoded !== '0x1234') throw hostile('RAILGUN_ARTIFACTS_REFUSED');
  };
  const snapshot = {
    minimumBlock: 11859803,
    entry: {
      id: 'a'.repeat(64),
      state: 'signing',
      signing: { submitter: owner },
      facts: {
        intentDigest: intentDigest ?? parsed.intentDigest,
        nullifier: parsed.expected.nullifier,
        checkpointHash,
      },
    },
    stored: {
      capsule: {
        version: 1,
        selection: { kind: parsed.expected.kind, tree: 0 },
        preparation: { transaction: parsed.intent, expected: parsed.expected },
      },
      provedTransaction: tx,
    },
  };
  const records = [{ receipt: {}, entry: JSON.parse(JSON.stringify(snapshot.entry)) }];
  mock.claim = { signal: scope.signal, close() {}, assertCurrent: () => snapshot };
  mock.enrollment = {
    signal: scope.signal,
    openReservations: async () => ({
      withSigningRecovery: async (use) =>
        use(records, { signal: scope.signal, assertCurrent() {} }),
      assertReceiptContext() {},
      assertReceipt: async () => records[0].entry,
    }),
    openPrivateCapsules: async () => ({
      get: async () => JSON.parse(JSON.stringify(snapshot.stored)),
    }),
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        ...(operation === undefined ? {} : { operation }),
      }),
  };
  mock.proof = { receipt: {}, signal: scope.signal, close() {} };
  mock.signer = { getAddress: async () => owner, signTransaction() {} };
  mock.network = {
    assertCanSubmit: async () => mock.eoa.push('journal'),
    request: async (_chain, method) => {
      mock.eoa.push(method);
      return {
        result: {
          eth_getCode: '0x',
          eth_estimateGas: '0x100',
          eth_call: '0x',
        }[method],
      };
    },
  };
  options = {
    identity: mock.identity,
    enrollment: mock.enrollment,
    completion: mock.receipt,
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    gasLimit: 100000n,
    maxGasFee: 10000000n,
    review: async () => true,
  };
}
afterEach(() => scope.close());

const shield = (method, test) => (r) =>
  r.operation === 'shield-preflight' && r.method === method && test(r);
const privateCall = (name) => (r) => r.operation === 'private-preflight' && r.name === name;
const fail = (code) => () => {
  throw hostile(code);
};
// Injects one reply or transport failure at the RPC boundary.
const at = (matches, effect) => () => {
  mock.fault = (request) => (matches(request) ? effect(request) : undefined);
};
const PREFLIGHT = { code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED', stage: 'preflight' };
// [name, injection, expected diagnostic beyond PREFLIGHT, nullifier queried]
const MATRIX = [
  [
    'deployment header transport failure',
    at(
      shield('eth_getBlockByNumber', (r) => r.params[0] === 'latest'),
      fail('PRIVATE_RPC_INVALID')
    ),
    {
      reason: 'rpc',
      step: 'deployment',
      deploymentStep: 'anchor',
      causeCode: 'PRIVATE_RPC_INVALID',
    },
    false,
  ],
  [
    'deployment header outside the wall-clock window',
    at(
      shield('eth_getBlockByNumber', (r) => r.params[0] === 'latest'),
      () => ({
        ...mock.header,
        timestamp: '0x' + (Math.floor(Date.now() / 1000) - 1000).toString(16),
      })
    ),
    { reason: 'stale', step: 'deployment', deploymentStep: 'anchor' },
    false,
  ],
  [
    'anchored code read refused by the provider',
    at(
      shield('eth_getCode', () => true),
      fail('PRIVATE_RPC_INVALID')
    ),
    {
      reason: 'rpc',
      step: 'deployment',
      deploymentStep: 'code-proxy',
      causeCode: 'PRIVATE_RPC_INVALID',
    },
    false,
  ],
  [
    'changed implementation code',
    at(
      shield('eth_getCode', (r) => r.params[0] === pins.implementation),
      () => '0x6002'
    ),
    { reason: 'mismatch', step: 'deployment', deploymentStep: 'code-implementation' },
    false,
  ],
  [
    'paused proxy',
    at(
      shield('eth_getStorageAt', (r) => r.params[1] === PAUSED_SLOT),
      () => word(1)
    ),
    { reason: 'mismatch', step: 'deployment', deploymentStep: 'slot-paused' },
    false,
  ],
  [
    'changed shield fee',
    at(
      (r) => r.operation === 'shield-preflight' && r.name === 'shieldFee',
      () => abi.encodeFunctionResult('shieldFee', [26n])
    ),
    { reason: 'mismatch', step: 'deployment', deploymentStep: 'getter-shieldFee' },
    false,
  ],
  [
    'blocklisted wrapped token',
    at(
      (r) => r.operation === 'shield-preflight' && r.name === 'tokenBlocklist',
      () => abi.encodeFunctionResult('tokenBlocklist', [true])
    ),
    { reason: 'mismatch', step: 'deployment', deploymentStep: 'getter-tokenBlocklist' },
    false,
  ],
  [
    'deployment anchor replaced',
    at(
      shield('eth_getBlockByNumber', (r) => r.params[0] !== 'latest'),
      () => ({ ...mock.header, hash: '0x' + 'b2'.repeat(32) })
    ),
    { reason: 'stale', step: 'deployment', deploymentStep: 'anchor-recheck' },
    false,
  ],
  [
    'unreadable local artifacts',
    () => {
      mock.loadArtifacts = fail('RAILGUN_ARTIFACTS_REFUSED');
    },
    { reason: 'refused', step: 'artifacts' },
    false,
  ],
  [
    'root not in history',
    at(privateCall('rootHistory'), () => abi.encodeFunctionResult('rootHistory', [false])),
    { reason: 'mismatch', step: 'rootHistory' },
    false,
  ],
  [
    'root read transport failure',
    at(privateCall('rootHistory'), fail('ECONNRESET')),
    { reason: 'rpc', step: 'rootHistory', causeCode: 'ECONNRESET' },
    false,
  ],
  [
    'changed unshield fee',
    at(privateCall('unshieldFee'), () => abi.encodeFunctionResult('unshieldFee', [26n])),
    { reason: 'mismatch', step: 'unshieldFee' },
    false,
  ],
  [
    'different verification key',
    at(privateCall('getVerificationKey'), () => '0xabcd'),
    { reason: 'mismatch', step: 'verifier' },
    false,
  ],
  [
    'selected input already spent',
    at(privateCall('nullifiers'), () => abi.encodeFunctionResult('nullifiers', [true])),
    { reason: 'mismatch', step: 'nullifiers' },
    true,
  ],
  [
    'private anchor replaced',
    at(
      (r) => r.operation === 'private-preflight' && r.method === 'eth_getBlockByNumber',
      () => ({ ...mock.header, hash: '0x' + 'b3'.repeat(32) })
    ),
    { reason: 'stale', step: 'anchor-recheck' },
    true,
  ],
  [
    'transport lost during a read',
    at(privateCall('unshieldFee'), () => {
      mock.endpoint.abort();
      throw hostile('TOR_REQUEST_FAILED');
    }),
    { reason: 'inactive', step: 'unshieldFee' },
    false,
  ],
  [
    'hex-shaped cause code',
    at(privateCall('rootHistory'), fail('E' + 'ABCDEF0123456789'.repeat(2))),
    { reason: 'rpc', step: 'rootHistory', causeCode: 'UNCLASSIFIED' },
    false,
  ],
];
const ALLOWED = ['stage', 'substage', 'code', 'reason', 'step', 'deploymentStep', 'causeCode'];
function assertBounded(result, diagnostic) {
  // The returned value keeps its closed shape for every existing caller.
  expect(Reflect.ownKeys(result)).toEqual(['status', 'stage']);
  expect(Object.isFrozen(diagnostic)).toBe(true);
  expect(Object.keys(diagnostic).every((key) => ALLOWED.includes(key))).toBe(true);
  const text = JSON.stringify(diagnostic);
  expect(text).not.toMatch(/secret|Users|identity-data|[0-9a-f]{16}/i);
  // The qualifier's aggregate summary keeps it whole and its redaction passes.
  const summary = live.summarizeSubmissionDiagnostic(diagnostic);
  expect(summary).toEqual({ ...diagnostic });
  const report = {
    journey: live.JOURNEY,
    version: 1,
    mode: 'transfer',
    passed: false,
    submission: {
      status: 'refused',
      stage: result.stage,
      diagnostic: summary,
      reviews: 0,
      elapsedMs: 1,
    },
  };
  expect(live.assertAggregateReport(report)).toBe(true);
  expect(JSON.parse(live.renderReport(report))).toEqual(report);
}

test.each(MATRIX)(
  '%s reaches the result diagnostic and the qualifier report',
  async (_name, inject, expected, nullifierQueried) => {
    setup();
    inject();
    const result = await submit(options);
    expect(result).toEqual({ status: 'recovery-required', stage: 'preflight' });
    const diagnostic = diagnosticOf(result);
    expect(diagnostic).toEqual({ ...PREFLIGHT, substage: 'acquire', ...expected });
    assertBounded(result, diagnostic);
    // Refusal stays a value: no EOA work, and the nullifier only after the
    // deployment, root, fee and verifier checks passed.
    expect(mock.eoa).toEqual([]);
    expect(mock.requests.includes('private-preflight:nullifiers')).toBe(nullifierQueried);
  }
);

test('construction refusal is distinguished from the anchored reads', async () => {
  setup({ checkpointHash: 'B'.repeat(64) });
  const result = await submit(options);
  const diagnostic = diagnosticOf(result);
  expect(diagnostic).toEqual({ ...PREFLIGHT, substage: 'open', reason: 'refused' });
  assertBounded(result, diagnostic);
  expect(mock.requests).toEqual([]);
  expect(mock.eoa).toEqual([]);
});

test('an admission refusal after a passing preflight names its own code', async () => {
  setup({ intentDigest: word(1) });
  const result = await submit(options);
  expect(result).toEqual({ status: 'recovery-required', stage: 'preflight' });
  const diagnostic = diagnosticOf(result);
  expect(diagnostic).toEqual({ stage: 'preflight', substage: 'admission', code: 'ERR_ASSERTION' });
  assertBounded(result, diagnostic);
  expect(mock.requests).toContain('private-preflight:nullifiers');
  expect(mock.eoa).toEqual(['network']);
});

test('other refusals cannot borrow preflight reason, step or cause fields', async () => {
  setup();
  mock.networkFailure = Object.assign(hostile('PRIVATE_RPC_DESTINATION_REFUSED'), {
    reason: 'rpc',
    step: 'deployment',
    deploymentStep: 'anchor',
    causeCode: 'TOR_REQUEST_FAILED',
  });
  const result = await submit(options);
  const diagnostic = diagnosticOf(result);
  expect(diagnostic).toEqual({
    stage: 'preflight',
    substage: 'admission',
    code: 'PRIVATE_RPC_DESTINATION_REFUSED',
  });
  assertBounded(result, diagnostic);
});

test('a passing preflight leaves no diagnostic on the acknowledged send', async () => {
  setup();
  const result = await submit(options);
  expect(result).toEqual({ hash: '0x' + 'c'.repeat(64) });
  expect(diagnosticOf(result)).toBeNull();
  expect(mock.requests.filter((v) => v.startsWith('private-preflight:'))).toEqual([
    'private-preflight:rootHistory',
    'private-preflight:unshieldFee',
    'private-preflight:getVerificationKey',
    'private-preflight:nullifiers',
    'private-preflight:eth_getBlockByNumber',
  ]);
  expect(mock.eoa).toContain('send');
});

test('the probe helper returns the same closed tuple for one preflight run', () => {
  const { getRailgunPrivatePreflightDiagnostic: probeOf } = require('./railgun-private-submission');
  const refusal = Object.assign(hostile('RAILGUN_PRIVATE_PREFLIGHT_REFUSED'), {
    reason: 'rpc',
    step: 'rootHistory',
    causeCode: 'TOR_REQUEST_FAILED',
  });
  const tuple = probeOf('acquire', refusal);
  expect(tuple).toEqual({
    ...PREFLIGHT,
    substage: 'acquire',
    reason: 'rpc',
    step: 'rootHistory',
    causeCode: 'TOR_REQUEST_FAILED',
  });
  expect(Object.isFrozen(tuple)).toBe(true);
  expect(JSON.stringify(tuple)).not.toMatch(/secret|Users|[0-9a-f]{16}/i);
  expect(probeOf('retry', refusal)).not.toHaveProperty('substage');
  // Other codes cannot borrow preflight fields; unreadable errors stay closed.
  const borrowed = Object.assign(hostile('PRIVATE_RPC_DESTINATION_REFUSED'), {
    reason: 'rpc',
    step: 'deployment',
  });
  expect(probeOf('admission', borrowed)).toEqual({
    stage: 'preflight',
    substage: 'admission',
    code: 'PRIVATE_RPC_DESTINATION_REFUSED',
  });
  for (const value of [null, new Proxy(refusal, {})])
    expect(probeOf('open', value)).toEqual({
      stage: 'preflight',
      substage: 'open',
      code: 'UNCLASSIFIED',
    });
});

test('only genuine refusal results carry a diagnostic', async () => {
  setup();
  mock.fault = (r) =>
    privateCall('nullifiers')(r) ? abi.encodeFunctionResult('nullifiers', [true]) : undefined;
  const result = await submit(options);
  expect(diagnosticOf({ ...result })).toBeNull();
  expect(
    diagnosticOf(Object.freeze({ status: 'recovery-required', stage: 'preflight' }))
  ).toBeNull();
  for (const value of [undefined, null, 'preflight', 1]) expect(diagnosticOf(value)).toBeNull();
  // A second completion use is refused before stores; its diagnostic is its own.
  const again = await submit(options);
  expect(again).toEqual({ status: 'recovery-required', stage: 'completion' });
  expect(diagnosticOf(again)).toEqual({ stage: 'completion', code: 'UNCLASSIFIED' });
});
