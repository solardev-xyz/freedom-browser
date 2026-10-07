/** Real-boundary qualification of the recovered review budget (offline),
 * for a Shield input only: no TXID mirror, creator, note provenance or TXID
 * root receipt runs, so the Transact branch is not covered here.
 *
 * Production modules run unmodified (the mutation controls at the end load
 * one edited copy each): the recovered submission and its final core, the
 * private preflight, the transaction service, the private transaction
 * network, private RPC and its destination constraints, privacy contexts and
 * scopes, the account phase claim, the encrypted submission journal, its
 * reconciler and privacy storage (real files and real fsync in a temporary
 * directory).
 *
 * Faked: the enrollment (an object over real privacy contexts); its signing
 * recovery store, whose withSigningRecovery claims the real account phase
 * but supplies its own context.deadline (start + timeoutMs) and context
 * checks, with in-memory receipt and capsule reads; the scan coordinator (a
 * fixed completed snapshot); the completed account wallet (open, private
 * input, close); identity, public identity and destination checks; runtime
 * archive verification; the Tor HTTP transport (per-request latency,
 * delivery, response loss, abort and its 30 s timeout); the EOA signer
 * (latency around real ethers signing); fsync latency; and the
 * worker/service receipt producers (verifier, POI source and membership,
 * deployment reads, local artifacts), modelled as time-based receipts with
 * their genuine 60 s ages and, for the proof, its genuine expiry timer.
 *
 * One simulated clock drives every timer, production timers included, in due
 * order. Synchronous work (fsync) advances that clock without running
 * timers, as the event loop would. No timer is disabled or skipped. The wall
 * clock follows it unless a scenario steps it (wallStep). */
let mock;
jest.mock('./railgun-private-operation', () => ({
  claimRailgunPrivateCompletion: () => {
    throw Error('cold must not mint completion');
  },
}));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mock.enrollment,
  assertRailgunFencedAccountEnrollment: () => {
    throw Error('not a relay enrollment');
  },
}));
jest.mock('./railgun-identity', () => ({
  quarantineRailgunIdentityCredentials: () => {},
  assertRailgunIdentity: (v, h) => {
    mock.kit.privacy.getPrivacyContext(h);
    if (v !== mock.identity) throw Error('identity');
    return v.descriptor;
  },
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'public-policy' }));
jest.mock('./railgun-txid-policy', () => ({ getRailgunTxidPolicy: () => 'txid-policy' }));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: () => mock.publicIdentity,
  assertRailgunAccountPublicDestination: (_c, _e, d) => {
    if (d !== mock.destination) throw Error('destination');
  },
}));
jest.mock('./railgun-account-wallet', () => ({
  getRailgunAccountWalletPolicy: () => 'composite-policy',
  openRailgunCompletedAccountWallet: async () => ({ close: async () => {} }),
  readRailgunCompletedAccountPrivateInput: () => mock.owned,
}));
jest.mock('./railgun-wallet-coverage', () => ({ checkpointHash: (v) => v.digest }));
jest.mock('./railgun-scan-coordinator', () => ({
  getRailgunCompletedSnapshotOutcome: () => {
    throw Error('no source failure in this suite');
  },
}));
jest.mock('./railgun-private-proof', () => ({
  verifyRailgunPrivateProof: (input) => mock.verifyProof(input),
  assertRailgunPrivateProof: (receipt, enrollment, _evidence, margin = 0) =>
    mock.assertProof(receipt, enrollment, margin),
}));
jest.mock('./railgun-poi-source', () => ({
  MAX_AGE_MS: 60000,
  createRailgunPoiSource: (options) => mock.openPoi(options),
}));
jest.mock('./railgun-poi-membership', () => ({
  verifyRailgunPoiMembership: (options) => mock.verifyMembership(options),
  assertRailgunPoiMembership: (receipt, _handle, margin) => mock.assertMembership(receipt, margin),
}));
jest.mock('./railgun-txid-root', () => ({
  MAX_AGE_MS: 60000,
  createRailgunTxidRootSource: () => {
    throw Error('a Shield input needs no TXID root');
  },
}));
jest.mock('./railgun-shield-preflight', () => ({
  MAX_AGE_MS: 60000,
  createRailgunShieldPreflight: () => mock.openDeployment(),
  assertRailgunShieldPreflight: (source, receipt) => source.assertResult(receipt),
}));
jest.mock('./railgun-artifacts', () => ({
  loadRailgunArtifacts: (options) => mock.loadArtifacts(options),
  assertRailgunArtifactVerifier: (_artifacts, encoded) => {
    if (encoded !== '0x1234') throw Error('verifier');
  },
}));
jest.mock('../identity-manager', () => ({
  getWalletRecord: () => ({ index: 0, type: 'mnemonic', address: mock.wallet.address }),
  WALLET_TYPES: { MNEMONIC: 'mnemonic' },
}));
jest.mock('./signers', () => ({ getSigner: () => mock.signer }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
// Every private RPC activity check reads the endpoint, so a scenario can
// place synchronous work inside the RPC's own admission path.
jest.mock('../tor-manager', () => ({
  getWalletSocksEndpoint: () => {
    mock.onEndpoint?.();
    return mock.endpoint;
  },
}));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => ['https://rpc.example'],
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: 'https://rpc.example' } }],
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({
    request: (...args) => mock.transport(...args),
    release: () => {},
  }),
}));
jest.mock('../networks/chain-data-router', () => ({}));
// The real journal, on a temporary directory instead of the profile vault.
// Its writes are labelled only so that the fsync edge can apply latency.
jest.mock('./private-submission-journal', () => {
  const actual = jest.requireActual('./private-submission-journal');
  const journals = new WeakMap();
  // Each write is synchronous inside its call, so start and end bracket it.
  const label =
    (name, run) =>
    (...args) => {
      mock.writing = name;
      mock.marks.push([name + '-start', performance.now()]);
      try {
        return run(...args);
      } finally {
        mock.marks.push([name + '-end', performance.now()]);
        mock.writing = null;
      }
    };
  return {
    ...actual,
    getPrivateSubmissionJournal: (handle) => {
      if (!journals.has(handle)) {
        const journal = actual.createSubmissionJournal({
          handle,
          directory: mock.journalDirectory,
          key: Buffer.alloc(32, 9),
        });
        journals.set(
          handle,
          Object.freeze({
            ...journal,
            begin: label('begin', journal.begin),
            markSubmitted: label('submitted', journal.markSubmitted),
            observe: label('observe', journal.observe),
          })
        );
      }
      return journals.get(handle);
    },
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Interface, Transaction, Wallet } = require('ethers');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const BUDGET = require('./railgun-recovered-review-budget.json');
const {
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const live = require('../../../scripts/qualify-railgun-private-live');

const realFsync = fs.fsyncSync;
const WALLET = new Wallet(`0x${'1'.repeat(64)}`); // Public synthetic fixture only.
const JOURNAL_KEY = Buffer.alloc(32, 9);
const HEAD = 6000100;
const ANCHOR_NUMBER = 6000050;
const hex = (n) => '0x' + BigInt(n).toString(16);
const blockHash = (n) => '0x' + (BigInt(n) * 7919n + 1n).toString(16).padStart(64, '0');
const ANCHOR = Object.freeze({
  number: hex(ANCHOR_NUMBER),
  hash: blockHash(ANCHOR_NUMBER),
  timestamp: '0x6500',
});
const preflightAbi = new Interface([
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function unshieldFee() view returns (uint120)',
  'function getVerificationKey(uint256,uint256)',
]);
const copy = (v) => JSON.parse(JSON.stringify(v));

// A mutation control's edited copy of one production module, evaluated with
// this suite's own require: the test sits beside the module, so its relative
// requires resolve to the same registry. Never writes a file.
const MUTABLE = Object.freeze({
  submission: './railgun-private-submission',
  network: './private-transaction-network',
});
let mutant = null;
function loadVariant(name, source) {
  const filename = require.resolve(name);
  const variant = { exports: {} };
  new Function('exports', 'require', 'module', '__filename', '__dirname', source)(
    variant.exports,
    require,
    variant,
    filename,
    path.dirname(filename)
  );
  return variant.exports;
}

// One module registry per budget (and mutant): the policy file is read once,
// at module load, and production code requires lazily, so a variant replaces
// the whole registry rather than isolating a copy of it.
let loaded = null;
function kitFor(budget) {
  if (loaded?.budget !== budget || loaded?.mutant !== mutant) {
    jest.resetModules();
    jest.doMock('./railgun-recovered-review-budget.json', () => budget);
    for (const name of Object.values(MUTABLE)) jest.dontMock(name);
    for (const [name, source] of Object.entries(mutant ?? {}))
      jest.doMock(name, () => loadVariant(name, source));
    loaded = {
      budget,
      mutant,
      kit: {
        submission: require('./railgun-private-submission'),
        privacy: require('../networks/privacy-context'),
        rpc: require('../networks/private-rpc'),
        phase: require('./railgun-account-phase'),
        transactIntent: require('./railgun-transact-intent'),
        journal: jest.requireActual('./private-submission-journal'),
      },
    };
  }
  return loaded.kit;
}

// A discrete-event clock. Every setTimeout runs at its due time, in due
// order, once the program is idle; block() is synchronous work during which
// no timer can run, after which overdue timers run late, as in Node.
function createClock() {
  const timers = new Map();
  const WALL = 1790000000000;
  let now = 1000,
    wallOffset = 0,
    sequence = 0;
  class Timeout {
    constructor(id) {
      this.id = id;
    }
    unref() {
      return this;
    }
    ref() {
      return this;
    }
    hasRef() {
      return true;
    }
    [Symbol.toPrimitive]() {
      return this.id;
    }
  }
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  jest.spyOn(Date, 'now').mockImplementation(() => WALL + now + wallOffset);
  jest.spyOn(global, 'setTimeout').mockImplementation((run, ms, ...args) => {
    const id = ++sequence;
    timers.set(id, { id, at: now + Math.max(1, Math.floor(Number(ms) || 0)), run, args });
    return new Timeout(id);
  });
  jest.spyOn(global, 'clearTimeout').mockImplementation((value) => {
    timers.delete(value instanceof Timeout ? value.id : Number(value));
  });
  return {
    WALL,
    now: () => now,
    block(ms) {
      now += ms;
    },
    // A wall-clock step (an NTP correction, say): Date.now() jumps, the
    // monotonic clock and every pending timer do not.
    stepWall(ms) {
      wallOffset += ms;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async run(promise) {
      let settled = false;
      promise.then(
        () => (settled = true),
        () => (settled = true)
      );
      for (;;) {
        for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
        if (settled) return promise;
        let next;
        for (const timer of timers.values()) if (!next || timer.at < next.at) next = timer;
        if (!next) throw Error('simulation stalled with no pending timer');
        timers.delete(next.id);
        now = Math.max(now, next.at);
        next.run(...next.args);
      }
    },
  };
}

// Measured and adverse inputs. Sources: d1b/report.json poi.elapsedMs (the
// POI source plus membership over Tor; its split is not recorded), the 3b
// preflight (about 150 ms per read when healthy) and probe-1 (a 14.5 s
// preflight ending in TOR_REQUEST_FAILED). Everything else is a stated model.
const D1B_POI_MS = 18587;
const HEALTHY_READ_MS = 150;
const poiPhase = (total) => {
  const source = Math.min(14000, Math.round(total * 0.65));
  return { poiSourceMs: source, membershipMs: total - source };
};
const uniform = (ms) => () => ms;
const BASE = Object.freeze({
  ...poiPhase(D1B_POI_MS),
  verifierMs: 800,
  artifactsMs: 200,
  read: uniform(HEALTHY_READ_MS),
  send: { ms: 300, deliverMs: 150 },
  signMs: 50,
  fsyncMs: () => 4,
  resolved: 0,
  approve: { afterMs: 3000 },
});

function mark(name) {
  mock.marks.push([name, mock.clock.now()]);
  stepWallAt(name);
}
// A scenario's one wall-clock step, at a named mark or request.
function stepWallAt(name) {
  const step = mock.scenario.wallStep;
  if (!step || mock.wallStepped || step.on !== name) return;
  mock.wallStepped = true;
  mock.clock.stepWall(step.ms);
  mark('wall-step');
}
const at = (name) => mock.marks.find(([key]) => key === name)?.[1];
const lastAt = (name) => mock.marks.findLast(([key]) => key === name)?.[1];

function wire(entry, signal, plan, settle) {
  mock.requests.push(entry);
  entry.roleIndex = mock.requests.filter((v) => v.role === entry.role).length - 1;
  const { ms, deliverMs = Math.floor(ms / 2), lost = false } = plan(entry);
  const { privacyError } = mock.kit.privacy;
  return new Promise((resolve, reject) => {
    const timers = [];
    const finish = (code) => {
      if (entry.outcome) return;
      entry.outcome = code || 'ok';
      entry.end = mock.clock.now();
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code) reject(privacyError(code, 'Private HTTP request failed'));
      else resolve(settle());
    };
    const abort = () => finish('PRIVACY_REQUEST_ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    if (entry.timeoutMs)
      timers.push(setTimeout(() => finish('TOR_REQUEST_TIMEOUT'), entry.timeoutMs));
    timers.push(
      setTimeout(() => {
        entry.delivered = mock.clock.now();
        if (entry.method === 'eth_sendRawTransaction') mock.chain.accepted.push(entry.hash);
      }, deliverMs)
    );
    if (!lost) timers.push(setTimeout(() => finish(), ms));
  });
}

function answer(role, call) {
  const [first] = call.params;
  switch (call.method) {
    case 'eth_chainId':
      return '0xaa36a7';
    case 'eth_call':
      if (role === 'transaction-rpc') return '0x';
      return {
        rootHistory: () => preflightAbi.encodeFunctionResult('rootHistory', [true]),
        unshieldFee: () => preflightAbi.encodeFunctionResult('unshieldFee', [25n]),
        getVerificationKey: () => '0x1234',
        nullifiers: () => preflightAbi.encodeFunctionResult('nullifiers', [false]),
      }[preflightAbi.parseTransaction(first).name]();
    case 'eth_getBlockByNumber':
      return { number: first, hash: blockHash(BigInt(first)), timestamp: ANCHOR.timestamp };
    case 'eth_blockNumber':
      return hex(HEAD);
    case 'eth_getCode':
      return '0x';
    case 'eth_getBalance':
      return '0x10000000';
    case 'eth_estimateGas':
      return '0x100';
    case 'eth_gasPrice':
      return '0x64';
    case 'eth_getTransactionCount':
      return hex(mock.scenario.resolved);
    case 'eth_sendRawTransaction':
      return Transaction.from(first).hash;
  }
  throw Error('unexpected ' + call.method);
}

async function transport(handle, _url, options) {
  const { getPrivacyContext, privacyError } = mock.kit.privacy;
  if (options.signal?.aborted)
    throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled');
  const role = getPrivacyContext(handle).subject.role;
  const call = JSON.parse(options.body);
  const entry = { role, method: call.method, at: mock.clock.now(), timeoutMs: options.timeoutMs };
  entry.name =
    call.method === 'eth_call'
      ? role === 'protocol-rpc'
        ? preflightAbi.parseTransaction(call.params[0]).name
        : 'simulate'
      : call.method;
  if (call.method === 'eth_sendRawTransaction')
    entry.hash = Transaction.from(call.params[0]).hash.toLowerCase();
  stepWallAt(entry.name);
  const s = mock.scenario;
  // A transport failure, shaped as the Tor transport rejects: no response.
  const failure = s.fail?.(entry);
  if (failure) {
    mock.requests.push({ ...entry, outcome: failure.code, end: mock.clock.now() });
    throw failure;
  }
  return wire(
    entry,
    options.signal,
    (value) => (value.method === 'eth_sendRawTransaction' ? s.send : { ms: s.read(value) }),
    () => ({
      status: 200,
      body: Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: call.id, result: answer(role, call) })
      ),
    })
  );
}

let fixtureSequence = 0;
async function setup(kit, overrides = {}) {
  const s = { ...BASE, ...overrides };
  const f = createRailgunLegacyCapsuleData('railgun-private-transfer');
  f.inner.proof.a.x = 1;
  const capsule = f.capsule;
  const proved = { ...capsule.preparation.transaction, data: f.encode() };
  const owner = WALLET.address.toLowerCase();
  const intent = kit.transactIntent.railgunTransactJournalIntent({ ...proved, from: owner });
  const root = kit.privacy.createPrivacyScope({
    profileId: 'boundary-' + ++fixtureSequence,
    signal: new AbortController().signal,
  });
  mock = {
    kit,
    scenario: s,
    root,
    owner,
    intent,
    wallet: WALLET,
    marks: [],
    requests: [],
    chain: { accepted: [] },
    writing: null,
    endpoint: { signal: new AbortController().signal },
    journalDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recovered-boundary-')),
    publicIdentity: {
      generationId: 'a'.repeat(64),
      sourceId: 'b'.repeat(64),
      publicId: 'c'.repeat(64),
    },
    generation: { id: 'd'.repeat(64) },
    token: {},
    receipt: {},
    attestReads: 0,
  };
  // The retained scan source: a genuine destination observation, no request.
  const sourceHandle = root.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
    operation: 'retained-source',
  });
  mock.destination = kit.rpc.getPrivateRpcDestination(
    kit.rpc.createPrivateRpc(sourceHandle, 'protocol-rpc'),
    sourceHandle
  );
  mock.identity = {
    descriptor: { walletId: capsule.walletId, accountIndex: 0 },
    signal: root.signal,
  };
  mock.enrollment = {
    directory: '/recovered-boundary-' + fixtureSequence,
    descriptor: mock.identity.descriptor,
    signal: root.signal,
    getContext: (role, operation) =>
      root.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        ...(operation ? { operation } : {}),
      }),
    catalog: { activeFor: (policy) => (policy === 'composite-policy' ? mock.generation : null) },
    openPrivateRecoveryStores: async () => ({
      reservations: mock.reservations,
      capsules: mock.capsules,
    }),
  };
  mock.entry = {
    id: 'e'.repeat(64),
    state: 'signing',
    signing: { submitter: owner },
    facts: {
      intentDigest: intent.intentDigest,
      nullifier: capsule.preparation.expected.nullifier,
      checkpointHash: 'f'.repeat(64),
    },
  };
  mock.stored = {
    holdId: mock.entry.id,
    capsule,
    signature: { R8: ['1', '2'], S: '3' },
    provedTransaction: proved,
  };
  mock.reservations = {
    withSigningRecovery: async (use, { timeoutMs }) => {
      const phase = kit.phase.claimRailgunAccountPhase(mock.enrollment, 'recovery');
      const deadline = performance.now() + timeoutMs;
      try {
        return await use([{ entry: copy(mock.entry), receipt: mock.receipt }], {
          signal: root.signal,
          deadline,
          assertCurrent: () => {
            phase.assertCurrent();
            if (performance.now() >= deadline) throw Error('expired recovery');
          },
        });
      } finally {
        phase.release();
      }
    },
    assertReceiptContext: (r, k) => {
      if (r !== mock.receipt || k !== 'recovery') throw Error('receipt');
    },
    assertReceipt: async () => copy(mock.entry),
  };
  mock.capsules = {
    readSigned: async (r) => {
      if (r !== mock.receipt) throw Error('receipt');
      return copy(mock.stored);
    },
    // Optional latency on the Nth capsule read after the approval (the
    // attestations in the review callback, then in signing).
    get: async () => {
      const slow = s.attestDelay;
      if (slow && at('approve') !== undefined && ++mock.attestReads === slow.read)
        await mock.clock.sleep(slow.ms);
      return copy(mock.stored);
    },
  };
  mock.checkpoint = { digest: '1'.repeat(64), to: { number: 6000001, hash: blockHash(6000001) } };
  mock.owned = {
    binding: {
      id: '0:1',
      type: 'Shield',
      txid: hex(11).padEnd(66, '0'),
      noteHash: capsule.noteHash,
      nullifier: capsule.preparation.expected.nullifier,
      amount: '1000',
      checkpointHash: mock.checkpoint.digest,
    },
    ownedRecord: {
      id: '0:1',
      type: 'Shield',
      txid: hex(11).padEnd(66, '0'),
      hash: capsule.noteHash,
      nullifier: capsule.preparation.expected.nullifier,
      npk: '0x' + '15'.repeat(32),
      blindedCommitment: '0x' + '16'.repeat(32),
      blockNumber: 6000000,
    },
    publicThrough: copy(mock.checkpoint.to),
    generationId: mock.generation.id,
  };
  mock.coordinator = {
    signal: root.signal,
    withCompletedPublicSnapshot: async (_options, use) => ({
      value: await use({
        checkpoint: mock.checkpoint,
        signal: root.signal,
        visitSource: async () => {},
      }),
      evidence: mock.token,
    }),
    assertSnapshot: (token) => {
      if (token !== mock.token) throw Error('snapshot');
      return mock.checkpoint;
    },
  };
  // Receipt producers. Ages run from acquisition start (POI, deployment) or
  // from the verifier's exit (C, whose genuine timer then closes it at 60 s).
  mock.verifyProof = async ({ signal }) => {
    mark('verifier-start');
    await mock.clock.sleep(s.verifierMs);
    const scope = kit.privacy.createPrivacyScope({ profileId: 'proof-receipt', signal });
    const deadline = performance.now() + 60000;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      scope.close();
      mark('C-closed');
    };
    const timer = setTimeout(close, 60000);
    mock.proof = { receipt: {}, deadline, open: () => !closed && !scope.signal.aborted };
    mark('verifier-exit');
    return { receipt: mock.proof.receipt, observation: {}, close, signal: scope.signal };
  };
  mock.assertProof = (receipt, enrollment, margin) => {
    if (
      receipt !== mock.proof.receipt ||
      enrollment !== mock.enrollment ||
      !mock.proof.open() ||
      !(margin >= 0 && margin < 60000) ||
      performance.now() + margin >= mock.proof.deadline
    )
      throw Error('C');
  };
  mock.openPoi = ({ handle, notes }) => {
    let started, receipt, observation, finish;
    let closed = false;
    const drained = new Promise((resolve) => (finish = resolve));
    mock.poi = {
      closed: drained,
      close: () => {
        closed = true;
        finish();
      },
      acquire: async ({ timeoutMs }) => {
        started = performance.now();
        mark('poi-start');
        if (s.poiSourceMs >= timeoutMs) throw Error('POI acquisition budget');
        await mock.clock.sleep(s.poiSourceMs);
        observation = {
          listKey: REQUIRED_LIST,
          statuses: notes.map((v) => ({ ...v, status: 'Valid' })),
          rootsAccepted: true,
        };
        return { receipt: (receipt = {}) };
      },
      assertResult: (value, margin = 0) => {
        kit.privacy.getPrivacyContext(handle);
        if (
          value !== receipt ||
          closed ||
          !(margin >= 0 && margin < 60000) ||
          performance.now() + margin >= started + 60000
        )
          throw Error('POI');
        return observation;
      },
    };
    return mock.poi;
  };
  mock.verifyMembership = async ({ source, receipt, timeoutMs }) => {
    if (s.membershipMs >= timeoutMs) throw Error('membership budget');
    await mock.clock.sleep(s.membershipMs);
    mark('poi-end');
    mock.membership = {
      receipt: {},
      sourceReceipt: receipt,
      observation: { ...source.assertResult(receipt), membershipVerified: true },
    };
    return mock.membership;
  };
  mock.assertMembership = (receipt, margin) => {
    if (receipt !== mock.membership.receipt) throw Error('membership');
    mock.poi.assertResult(mock.membership.sourceReceipt, margin);
    return mock.membership.observation;
  };
  // The deployment module's own private RPC (a chain-ID check and 12 anchored
  // reads) at the same transport latency; public data, no account input.
  mock.openDeployment = () => {
    const controller = new AbortController();
    let started, receipt;
    return {
      signal: controller.signal,
      close: () => controller.abort(),
      acquire: async () => {
        started = performance.now();
        for (let n = 0; n < 13; n++)
          await wire(
            {
              role: 'protocol-rpc',
              method: 'deployment',
              name: n ? 'deployment' : 'eth_chainId',
              at: mock.clock.now(),
            },
            controller.signal,
            (entry) => ({ ms: s.read(entry) }),
            () => undefined
          );
        return { receipt: (receipt = {}) };
      },
      assertResult: (value) => {
        if (value !== receipt || controller.signal.aborted || performance.now() - started >= 60000)
          throw Error('deployment');
        // The preflight re-asserts the deployment in each read, after its
        // own checks; after the verifier reply this is the nullifier read.
        const last = mock.requests.at(-1);
        if (s.cross && !mock.crossing && last?.name === 'getVerificationKey' && last.outcome)
          crossAfterNullifierCheck(s.cross);
        return { anchor: ANCHOR };
      },
    };
  };
  // Synchronous work (clock.block, no timer runs) at one point between the
  // preflight's own nullifier deadline check and transport admission: in the
  // preflight's read path, after the RPC's awaited chain-check promise
  // (ready(), second activity check), or at the RPC's last activity check
  // after serialization (raw(), fourth).
  const crossAfterNullifierCheck = ({ at: where, ms }) => {
    const block = () => {
      mark('crossing');
      mock.clock.block(ms);
    };
    mock.crossing = true;
    if (where === 'read') return block();
    const target = { ready: 2, raw: 4 }[where];
    let checks = 0;
    mock.onEndpoint = () => {
      if (++checks !== target) return;
      mock.onEndpoint = null;
      block();
    };
  };
  mock.loadArtifacts = async ({ variant }) => {
    await mock.clock.sleep(s.artifactsMs);
    return { variant, wasm: Buffer.alloc(4, 1), zkey: Buffer.alloc(4, 2) };
  };
  mock.signer = {
    getAddress: async () => WALLET.address,
    signTransaction: async (tx) => {
      mark('sign-start');
      await mock.clock.sleep(s.signMs);
      mark('sign-end');
      return WALLET.signTransaction(tx);
    },
  };
  mock.transport = transport;
  // Resolved history (no intent: an earlier ordinary send), through the real
  // journal API, so each assertCanSubmit refreshes it over the transport.
  mock.seedHandle = root.getContext({
    kind: 'public-address',
    principal: owner,
    chainId: 11155111,
    role: 'transaction-rpc',
  });
  mock.journal = kit.journal.createSubmissionJournal({
    handle: mock.seedHandle,
    directory: mock.journalDirectory,
    key: JOURNAL_KEY,
  });
  for (let n = 0; n < s.resolved; n++) {
    const hash = '0x' + (n + 1).toString(16).padStart(64, 'a');
    const number = HEAD - 40 + n;
    await mock.journal.begin(hash, n);
    const observed = await mock.journal.observe(
      hash,
      {
        status: 'included',
        blockNumber: number,
        blockHash: blockHash(number),
        confirmations: 41 - n,
        observedAt: 1,
        trust: 'unverified',
      },
      0
    );
    await mock.journal.resolve(hash, observed.revision, 1);
  }
  mock.clock = createClock();
  jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    realFsync(fd);
    mock.clock.block(s.fsyncMs(mock.writing));
  });
  const label =
    (name, run) =>
    async (...args) => {
      mark(name + '-start');
      try {
        return await run(...args);
      } finally {
        mark(name + '-end');
      }
    };
  return {
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    destination: mock.destination,
    archive: '/engine.tgz',
    proverArchive: '/prover.tgz',
    artifactDirectory: '/artifacts',
    holdId: mock.entry.id,
    signal: new AbortController().signal,
    gasLimit: 1000n,
    maxGasFee: 200000n,
    reviewDisclosures: async () => true,
    reviewTransaction: label('review', async (request) => {
      mock.review = {
        at: mock.clock.now(),
        expiresAt: request.expiresAt,
        window: request.expiresAt - Date.now(),
      };
      // beforeMs is measured against H on the monotonic clock: H was fixed
      // on both clocks together, before any scenario wall step.
      const wait = Object.hasOwn(s.approve, 'afterMs')
        ? s.approve.afterMs
        : request.expiresAt - mock.clock.WALL - mock.clock.now() - s.approve.beforeMs;
      await mock.clock.sleep(wait);
      mark('approve');
      return true;
    }),
  };
}

async function run(budget, overrides) {
  if (mock?.root) {
    mock.root.close();
    jest.restoreAllMocks();
  }
  const kit = kitFor(budget);
  const options = await setup(kit, overrides);
  const before = await mock.journal.readSnapshot();
  const result = await mock.clock.run(
    kit.submission.submitRailgunRecoveredPrivateTransaction(options)
  );
  const after = await mock.journal.readSnapshot();
  const { records } = after;
  const attempts = records.filter((v) => v.intent?.kind === 'railgun-transact');
  const named = (name) => mock.requests.filter((v) => v.name === name);
  const outcome = result.hash
    ? 'acknowledged'
    : attempts.length
      ? 'journaled-uncertain'
      : named('nullifiers').length
        ? 'refused-after-nullifier'
        : at('poi-start') !== undefined
          ? 'refused-after-POI'
          : 'refused-before-disclosure';
  return {
    result,
    outcome,
    before,
    after,
    diagnostic: kit.submission.getRailgunPrivateSubmissionDiagnostic(result),
    attempts,
    sends: named('eth_sendRawTransaction'),
    nullifier: named('nullifiers')[0],
    calldata: named('eth_estimateGas').length > 0,
    signed: at('sign-end') !== undefined,
    review: mock.review,
  };
}

const DEFAULT = BUDGET;
afterEach(() => {
  mock?.root.close();
  jest.restoreAllMocks();
});

describe('where the recovered send actually begins (production service, network and journal)', () => {
  test('healthy measured timeline: request order, three history checks and a durable begin before transport', async () => {
    const seen = await run(DEFAULT, { resolved: 4 });
    expect(seen.outcome).toBe('acknowledged');
    expect(seen.result.hash).toBe(seen.sends[0].hash);
    const tx = mock.requests.filter((v) => v.role === 'transaction-rpc').map((v) => v.name);
    // Each assertCanSubmit with four resolved records: one head read, then two
    // rounds of two parallel block reads (three round trips), then four writes.
    const refresh = ['eth_blockNumber', ...Array(4).fill('eth_getBlockByNumber')];
    expect(tx).toEqual([
      'eth_chainId',
      ...refresh, // EOA stage, before the code read
      'eth_getCode',
      'eth_estimateGas',
      'simulate',
      ...refresh, // transaction service, before fee reads
      'eth_gasPrice',
      'eth_getTransactionCount',
      'eth_getTransactionCount',
      'eth_getTransactionCount',
      'eth_getBalance',
      ...refresh, // broadcast, after signing and before journal begin
      'eth_sendRawTransaction',
    ]);
    // 13 deployment reads, then the preflight's own chain-ID check and five reads.
    const protocol = mock.requests.filter((v) => v.role === 'protocol-rpc').map((v) => v.name);
    expect(protocol.slice(13)).toEqual([
      'eth_chainId',
      'rootHistory',
      'unshieldFee',
      'getVerificationKey',
      'nullifiers',
      'eth_getBlockByNumber',
    ]);
    // The journal record is durable before any byte reaches the transport,
    // and the send begins only after signing and the third history refresh.
    const send = seen.sends[0];
    expect(lastAt('begin-end')).toBeLessThanOrEqual(send.at);
    expect(at('sign-end')).toBeLessThan(lastAt('begin-start'));
    const lastRefresh = mock.requests.filter(
      (v) => v.role === 'transaction-rpc' && v.name === 'eth_getBlockByNumber'
    );
    expect(lastRefresh.at(-1).end).toBeLessThanOrEqual(lastAt('begin-start'));
    expect(seen.attempts).toEqual([expect.objectContaining({ state: 'submitted' })]);
    // From approval: 50 ms signing, three round trips and four 8 ms writes,
    // then an 8 ms begin: the send starts 540 ms after approval.
    expect(send.at - at('approve')).toBe(50 + 3 * HEALTHY_READ_MS + 4 * 8 + 8);
  });

  test('an empty journal adds no history reads and the send starts 58 ms after approval', async () => {
    const seen = await run(DEFAULT, { resolved: 0 });
    expect(seen.outcome).toBe('acknowledged');
    expect(mock.requests.filter((v) => v.name === 'eth_getBlockByNumber')).toHaveLength(1);
    // Signing, then the initial journal write is already done; only begin.
    expect(seen.sends[0].at - at('approve')).toBe(50 + 8);
  });
});

// With four resolved records, 200 ms reads, 400 ms signing and 10 ms per
// fsync (20 ms per journal write), everything after an approval at A is:
// signing until A + 400, the broadcast history refresh until A + 400 + 600 +
// 80 = A + 1,080 (the check before begin), begin until A + 1,100 (the check
// after begin), then the raw send. F is the service's expiry.
const near = (beforeMs) => ({
  resolved: 4,
  read: uniform(200),
  signMs: 400,
  fsyncMs: () => 10,
  approve: { beforeMs },
});
describe('approval close to the admission deadline F', () => {
  test('approval 1,101 ms before F sends: the send begins 1 ms before F', async () => {
    const seen = await run(DEFAULT, near(1101));
    expect(seen.outcome).toBe('acknowledged');
    expect(seen.sends[0].at).toBe(mock.review.expiresAt - mock.clock.WALL - 1);
  });
  test('approval 1,100 to 1,081 ms before F: begin straddles F, journaled and never sent', async () => {
    for (const beforeMs of [1100, 1081]) {
      const seen = await run(DEFAULT, near(beforeMs));
      expect(seen.outcome).toBe('journaled-uncertain');
      expect(seen.sends).toEqual([]);
      expect(seen.attempts).toEqual([expect.objectContaining({ state: 'attempted' })]);
      expect(seen.result).toEqual({
        transactionHash: seen.attempts[0].hash,
        submissionStatus: 'unknown',
      });
    }
  });
  test('approval 1,080 to 401 ms before F: signed, refused before begin, no journal', async () => {
    for (const beforeMs of [1080, 401]) {
      const seen = await run(DEFAULT, near(beforeMs));
      expect(seen.outcome).toBe('refused-after-nullifier');
      expect(seen.signed).toBe(true);
      expect(seen.attempts).toEqual([]);
      expect(seen.sends).toEqual([]);
      expect(seen.diagnostic).toEqual({ stage: 'submission', code: 'PRIVATE_REVIEW_EXPIRED' });
    }
  });
  test('signing that crosses F is aborted by the service review timer, before any journal', async () => {
    const seen = await run(DEFAULT, near(400));
    expect(seen.outcome).toBe('refused-after-nullifier');
    expect(seen.diagnostic).toEqual({ stage: 'submission', code: 'PRIVACY_REQUEST_ABORTED' });
    // The borrowed signer finished after F and its signature was discarded.
    expect(at('sign-end')).toBeGreaterThanOrEqual(mock.review.expiresAt - mock.clock.WALL);
    expect(seen.attempts).toEqual([]);
    expect(seen.sends).toEqual([]);
  });
});

describe('journal begin and the raw send against F and the evidence lifetime E', () => {
  test('a slow begin write that crosses F is durable and never sent', async () => {
    const seen = await run(DEFAULT, {
      resolved: 4,
      read: uniform(200),
      signMs: 400,
      fsyncMs: (writing) => (writing === 'begin' ? 300 : 10),
      approve: { beforeMs: 1500 },
    });
    expect(seen.outcome).toBe('journaled-uncertain');
    expect(seen.sends).toEqual([]);
    expect(mock.chain.accepted).toEqual([]);
    // Begin was admitted before F and finished after it; the check after
    // begin then refuses the send it has just made durable.
    expect(lastAt('begin-start')).toBeLessThan(mock.review.expiresAt - mock.clock.WALL);
    expect(lastAt('begin-end')).toBeGreaterThan(mock.review.expiresAt - mock.clock.WALL);
  });
  test('a begin fsync that crosses E as well is refused before its rename: no record', async () => {
    const seen = await run(DEFAULT, {
      resolved: 0,
      fsyncMs: (writing) => (writing === 'begin' ? 40000 : 4),
    });
    expect(seen.outcome).toBe('refused-after-nullifier');
    expect(seen.attempts).toEqual([]);
    expect(seen.sends).toEqual([]);
    expect(seen.diagnostic).toEqual({ stage: 'submission', code: 'PRIVACY_CONTEXT_REVOKED' });
  });
  test('an accepted send whose response is lost stays uncertain: bytes may have left', async () => {
    const seen = await run(DEFAULT, { send: { ms: 300, deliverMs: 150, lost: true } });
    expect(seen.outcome).toBe('journaled-uncertain');
    expect(seen.result).toEqual({
      transactionHash: seen.sends[0].hash,
      submissionStatus: 'unknown',
    });
    expect(seen.attempts).toEqual([expect.objectContaining({ state: 'attempted' })]);
    // The node accepted it; only the transport's own 30 s timeout ended the wait.
    expect(mock.chain.accepted).toEqual([seen.sends[0].hash]);
    expect(seen.sends[0].outcome).toBe('TOR_REQUEST_TIMEOUT');
    expect(seen.sends[0].end - seen.sends[0].at).toBe(30000);
  });
  test.each([
    ['after the node accepted it', 2000, true],
    ['before any byte was accepted', 20000, false],
  ])(
    'E aborts a send in flight %s: journaled and uncertain either way',
    async (_name, deliverMs, accepted) => {
      const seen = await run(DEFAULT, {
        resolved: 0,
        send: { ms: 25000, deliverMs },
        approve: { beforeMs: 100 },
      });
      expect(seen.outcome).toBe('journaled-uncertain');
      expect(seen.sends[0].outcome).toBe('PRIVACY_REQUEST_ABORTED');
      // The genuine proof receipt's own timer closed the submission scope.
      expect(seen.sends[0].end).toBe(at('C-closed'));
      expect(mock.chain.accepted.length > 0).toBe(accepted);
      expect(seen.attempts).toEqual([expect.objectContaining({ state: 'attempted' })]);
    }
  );
});

// Each monotonic check of F, alone. A scenario steps the wall clock 10 s
// back after H and F were fixed on both clocks: the service's review timer
// (armed from Date.now()) then fires 10 s late and every wall-clock
// comparison with H or F passes for 10 s after them, so only the monotonic
// checks remain. H and F below are monotonic instants.
const BACK = -10000;
const SPLIT = Object.freeze({ ...BUDGET, admissionMs: 5000, sendReserveMs: 5000 });
const monoH = () => mock.review.expiresAt - mock.clock.WALL;
const transactionAfter = (instant) =>
  mock.requests.filter((v) => v.role === 'transaction-rpc' && v.at >= instant);
const refusedBeforeJournal = (seen) => {
  expect(seen.outcome).toBe('refused-after-nullifier');
  expect(seen.attempts).toEqual([]);
  expect(at('begin-start')).toBeUndefined();
  expect(seen.sends).toEqual([]);
  expect(mock.chain.accepted).toEqual([]);
  expect(seen.diagnostic).toEqual({ stage: 'submission', code: 'PRIVATE_TRANSACTION_FAILED' });
};
const MONOTONIC = Object.freeze({
  // Approval 2 ms before F; the signing attestation then takes 5 ms. Only
  // the check before the signer refuses: the borrowed key is never used.
  'pre-sign': async () => {
    const seen = await run(DEFAULT, {
      wallStep: { on: 'eth_getCode', ms: BACK },
      approve: { beforeMs: 2 },
      attestDelay: { read: 2, ms: 5 },
    });
    expect(at('approve')).toBe(monoH() - 2);
    expect(at('sign-start')).toBeUndefined();
    refusedBeforeJournal(seen);
  },
  // Signing ends 100 ms after F. The check after the signer and the
  // network's entry check both refuse before any further request.
  'signing-crosses-F': async () => {
    const seen = await run(DEFAULT, {
      resolved: 4,
      wallStep: { on: 'eth_getCode', ms: BACK },
      signMs: 400,
      approve: { beforeMs: 300 },
    });
    expect(at('sign-end')).toBe(monoH() + 100);
    expect(seen.signed).toBe(true);
    expect(transactionAfter(monoH())).toEqual([]);
    refusedBeforeJournal(seen);
  },
  // A split policy: approval 2 ms after H, well before F = H + 5 s. Only
  // the approval check refuses; signing, begin and the send would all
  // still precede F.
  'approval-after-H': async () => {
    const seen = await run(SPLIT, {
      wallStep: { on: 'eth_getCode', ms: BACK },
      approve: { beforeMs: -2 },
    });
    expect(at('approve')).toBe(monoH() + 2);
    expect(at('approve')).toBeLessThan(monoH() + SPLIT.admissionMs);
    expect(at('sign-start')).toBeUndefined();
    refusedBeforeJournal(seen);
  },
  // H = F: approval 2 ms after F. The approval check refuses; without it,
  // the check before the signer refuses at the same instant.
  'approval-after-F': async () => {
    const seen = await run(DEFAULT, {
      wallStep: { on: 'eth_getCode', ms: BACK },
      approve: { beforeMs: -2 },
    });
    expect(at('sign-start')).toBeUndefined();
    refusedBeforeJournal(seen);
  },
  // The wall clock steps back as signing ends, before F; the broadcast
  // history refresh then crosses F. The network's check before journal
  // begin refuses: no record, no send.
  'refresh-crosses-F': async () => {
    for (const beforeMs of [1080, 401]) {
      const seen = await run(DEFAULT, {
        ...near(beforeMs),
        wallStep: { on: 'sign-end', ms: BACK },
      });
      expect(at('wall-step')).toBeLessThan(monoH());
      expect(seen.signed).toBe(true);
      refusedBeforeJournal(seen);
    }
  },
  // The same step; begin is admitted before F and its write crosses it.
  // The network's check before the raw send refuses: durable, never sent.
  'begin-crosses-F': async () => {
    for (const beforeMs of [1100, 1081]) {
      const seen = await run(DEFAULT, {
        ...near(beforeMs),
        wallStep: { on: 'sign-end', ms: BACK },
      });
      expect(lastAt('begin-start')).toBeLessThan(monoH());
      expect(lastAt('begin-end')).toBeGreaterThanOrEqual(monoH());
      expect(seen.outcome).toBe('journaled-uncertain');
      expect(seen.sends).toEqual([]);
      expect(mock.chain.accepted).toEqual([]);
      expect(seen.result).toEqual({
        transactionHash: seen.attempts[0].hash,
        submissionStatus: 'unknown',
      });
    }
  },
  // A send admitted 1 ms before F and acknowledged after it stays
  // acknowledged: F is no part of the submission scope's isCurrent.
  'ack-after-F': async () => {
    const seen = await run(DEFAULT, near(1101));
    expect(seen.outcome).toBe('acknowledged');
    expect(seen.sends[0].at).toBe(monoH() - 1);
    expect(seen.sends[0].end).toBeGreaterThan(monoH());
  },
});
describe('the monotonic admission deadline F against a backward wall-clock step', () => {
  test.each(Object.keys(MONOTONIC))('%s', (name) => MONOTONIC[name]());
});

describe('the nullifier disclosure boundary', () => {
  test('a stalled deployment read refuses immediately before the nullifier query', async () => {
    // probe-1 shape: the seventh deployment read stalls 10 s but completes.
    const seen = await run(DEFAULT, {
      resolved: 4,
      read: (entry) => (entry.role === 'protocol-rpc' && entry.roleIndex === 6 ? 10000 : 150),
    });
    expect(seen.outcome).toBe('refused-after-POI');
    expect(seen.nullifier).toBeUndefined();
    expect(seen.diagnostic).toEqual({
      stage: 'preflight',
      substage: 'acquire',
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
      reason: 'stale',
      step: 'nullifiers',
    });
    expect(mock.requests.filter((v) => v.role === 'transaction-rpc')).toEqual([]);
  });
  // The preflight receives the conservative estimate minus the floor, the
  // send reserve, admission, the EOA allowance and the disclosure tail.
  const before =
    BUDGET.reviewMinMs +
    BUDGET.admissionMs +
    BUDGET.sendReserveMs +
    BUDGET.eoaAllowanceMs +
    BUDGET.disclosureTailMs;
  const stall = (extra) => (entry) =>
    entry.role === 'protocol-rpc' && entry.roleIndex === 6 ? 150 + extra : 150;
  // A run whose preflight nullifier check happens exactly `offset` ms before
  // the deadline: with no work in between, the check and the transport share
  // one instant, so the baseline request time is the check time.
  async function slackFor() {
    const baseline = await run(DEFAULT, { read: stall(0) });
    const deadline = at('verifier-start') + 60000 - before;
    return { deadline, slack: deadline - baseline.nullifier.at };
  }
  test('the deadline is exact at the request: one millisecond later refuses it', async () => {
    const { deadline, slack } = await slackFor();
    const sent = await run(DEFAULT, { read: stall(slack - 1) });
    expect(sent.nullifier.at).toBe(deadline - 1);
    const refused = await run(DEFAULT, { read: stall(slack) });
    expect(refused.nullifier).toBeUndefined();
    expect(refused.outcome).toBe('refused-after-POI');
    expect(refused.diagnostic).toMatchObject({ step: 'nullifiers', reason: 'stale' });
  });
  // The preflight's check passes 1 ms before the deadline; synchronous work
  // then crosses it before the transport sees the request. The private RPC
  // enforces the same deadline again at its last admission gate.
  test.each([
    ['in the preflight read path', 'read'],
    ["after the RPC's awaited chain-check promise", 'ready'],
    ["at the RPC's last activity check, after serialization", 'raw'],
  ])('a deadline crossed %s refuses at transport admission', async (_name, where) => {
    const { deadline, slack } = await slackFor();
    const control = await run(DEFAULT, { read: stall(slack - 1), cross: { at: where, ms: 0 } });
    expect(at('crossing')).toBe(deadline - 1);
    expect(control.nullifier.at).toBe(deadline - 1);
    expect(control.outcome).toBe('acknowledged');
    const crossed = await run(DEFAULT, { read: stall(slack - 1), cross: { at: where, ms: 1 } });
    expect(at('crossing')).toBe(deadline - 1);
    expect(crossed.nullifier).toBeUndefined();
    expect(mock.requests.filter((v) => v.at >= deadline && v.role === 'protocol-rpc')).toEqual([]);
    expect(crossed.outcome).toBe('refused-after-POI');
    expect(crossed.diagnostic).toEqual({
      stage: 'preflight',
      substage: 'acquire',
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
      reason: 'stale',
      step: 'nullifiers',
    });
    expect(mock.requests.filter((v) => v.role === 'transaction-rpc')).toEqual([]);
  });
});

// The bounded refusal tuple end to end: the real recovered submission, private
// preflight and private RPC produce it; the live qualifier's own allowlist,
// nullifier classification and redaction turn it into the publishable report.
describe('the refusal tuple through the live qualifier report', () => {
  function qualifierReport(seen) {
    const diagnostic = live.summarizeSubmissionDiagnostic(seen.diagnostic);
    const report = {
      journey: live.JOURNEY,
      version: 1,
      mode: 'recover-submit',
      passed: false,
      submission: {
        status: 'refused',
        stage: seen.result.stage,
        diagnostic,
        reviews: { disclosure: 1, transaction: 0 },
        elapsedMs: 1,
      },
    };
    expect(live.assertAggregateReport(report)).toBe(true);
    expect(JSON.parse(live.renderReport(report))).toEqual(report);
    return { report, nullifierQuery: live.nullifierQuery({ passed: false, diagnostic }) };
  }
  const rootHistoryFailure = (stage) => (entry) =>
    entry.role === 'protocol-rpc' && entry.name === 'rootHistory'
      ? Object.assign(
          mock.kit.privacy.privacyError('TOR_REQUEST_FAILED', 'Private HTTP request failed'),
          { stage }
        )
      : undefined;
  test.each(live.DIAGNOSTIC_CAUSE_STAGES)(
    'a rootHistory transport failure at stage %s reaches the result and the report',
    async (causeStage) => {
      const seen = await run(DEFAULT, { resolved: 4, fail: rootHistoryFailure(causeStage) });
      const tuple = {
        stage: 'preflight',
        substage: 'acquire',
        code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
        reason: 'rpc',
        step: 'rootHistory',
        causeCode: 'TOR_REQUEST_FAILED',
        causeStage,
      };
      expect(seen.result).toEqual({ status: 'recovery-required', stage: 'preflight' });
      expect(seen.diagnostic).toEqual(tuple);
      // The failed read reached the transport once; nothing after it did.
      expect(mock.requests.filter((v) => v.name === 'rootHistory')).toHaveLength(1);
      expect(seen.nullifier).toBeUndefined();
      expect(mock.requests.filter((v) => v.role === 'transaction-rpc')).toEqual([]);
      expect(seen.attempts).toEqual([]);
      const { report, nullifierQuery } = qualifierReport(seen);
      expect(report.submission.diagnostic).toEqual(tuple);
      expect(nullifierQuery).toBe('not-queried');
    }
  );
  test('an unlisted transport stage is dropped from the result and the report', async () => {
    const seen = await run(DEFAULT, { resolved: 4, fail: rootHistoryFailure('socket-maybe') });
    const tuple = {
      stage: 'preflight',
      substage: 'acquire',
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
      reason: 'rpc',
      step: 'rootHistory',
      causeCode: 'TOR_REQUEST_FAILED',
    };
    expect(seen.diagnostic).toEqual(tuple);
    expect(qualifierReport(seen).report.submission.diagnostic).toEqual(tuple);
  });
  test('a nullifier-deadline refusal is stale at nullifiers and never requests the nullifier', async () => {
    const seen = await run(DEFAULT, {
      resolved: 4,
      read: (entry) => (entry.role === 'protocol-rpc' && entry.roleIndex === 6 ? 10000 : 150),
    });
    const tuple = {
      stage: 'preflight',
      substage: 'acquire',
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
      reason: 'stale',
      step: 'nullifiers',
    };
    expect(seen.result).toEqual({ status: 'recovery-required', stage: 'preflight' });
    expect(seen.diagnostic).toEqual(tuple);
    // The root, fee and verifier reads ran; the nullifier never reached the transport.
    const names = mock.requests.filter((v) => v.role === 'protocol-rpc').map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['rootHistory', 'unshieldFee']));
    expect(names).not.toContain('nullifiers');
    expect(seen.nullifier).toBeUndefined();
    expect(mock.requests.filter((v) => v.role === 'transaction-rpc')).toEqual([]);
    const { report, nullifierQuery } = qualifierReport(seen);
    expect(report.submission.diagnostic).toEqual(tuple);
    // The report stays conservative: a stale refusal at this step cannot by
    // itself show whether the query left, though here the transport shows it did not.
    expect(nullifierQuery).toBe('possibly-queried');
  });
});

describe('the conservative proof estimate', () => {
  // The estimate starts before the verifier runs; the genuine receipt starts
  // at its exit. H is anchored at the estimate, so a longer verifier shortens
  // the offered review by exactly its duration, and the genuine proof then
  // outlives F by the send reserve plus that same duration.
  test('verifiers of 0, 2 and 4 s: the review shrinks and the genuine slack grows by their duration', async () => {
    const seen = [];
    for (const verifierMs of [0, 2000, 4000]) {
      const value = await run(DEFAULT, { verifierMs });
      expect(value.outcome).toBe('acknowledged');
      const H = value.review.expiresAt - mock.clock.WALL;
      const verifier = at('verifier-exit') - at('verifier-start');
      expect(H - at('verifier-start')).toBe(60000 - BUDGET.sendReserveMs - BUDGET.admissionMs - 1);
      expect(mock.proof.deadline - (H + BUDGET.admissionMs)).toBe(
        BUDGET.sendReserveMs + 1 + verifier
      );
      seen.push({ window: value.review.window, verifier });
    }
    for (const value of seen.slice(1))
      expect(value.window).toBe(seen[0].window - (value.verifier - seen[0].verifier));
  });
});

// The smallest policy change first: the adaptive review with the existing
// 20 s post-review reserve against the 10 s candidate, both with one
// deadline (H = F), then the same two totals split into a 5 s admission
// allowance after H and the rest as the send reserve after F.
const VARIANTS = Object.freeze({
  'H = F, 20 s': { ...BUDGET, admissionMs: 0, sendReserveMs: 20000 },
  'H = F, 20 s, no allowances': {
    ...BUDGET,
    admissionMs: 0,
    sendReserveMs: 20000,
    preflightAllowanceMs: 0,
    disclosureTailMs: 0,
    eoaAllowanceMs: 0,
  },
  'H = F, 10 s': { ...BUDGET, admissionMs: 0, sendReserveMs: 10000 },
  'split 5 + 15 s': { ...BUDGET, admissionMs: 5000, sendReserveMs: 15000 },
  'split 5 + 5 s': { ...BUDGET, admissionMs: 5000, sendReserveMs: 5000 },
});
const tail = (ms, slowMs) => (entry) => (entry.roleIndex % 8 === 7 ? slowMs : ms);
const stall = (ms, stallMs) => (entry) =>
  entry.role === 'protocol-rpc' && entry.roleIndex === 6 ? stallMs : ms;
const SCENARIOS = Object.freeze({
  'd1b POI 18.6 s, 150 ms reads, empty journal': {},
  'd1b POI, 150 ms reads, 4 resolved records': { resolved: 4 },
  'd1b POI, 4 resolved, approval 500 ms before shown deadline': {
    resolved: 4,
    approve: { beforeMs: 500 },
  },
  'd1b POI, every 8th read 1.5 s, 4 resolved': { resolved: 4, read: tail(150, 1500) },
  'd1b POI, 400 ms reads, 4 resolved': { resolved: 4, read: uniform(400) },
  'POI 22 s, 150 ms reads, 4 resolved': { ...poiPhase(22000), resolved: 4 },
  'POI 25 s, 150 ms reads, 4 resolved': { ...poiPhase(25000), resolved: 4 },
  'd1b POI, one 10 s deployment read (probe-1 shape)': { resolved: 4, read: stall(150, 10000) },
  'd1b POI, 5 s verifier, 4 resolved': { resolved: 4, verifierMs: 5000 },
  'd1b POI, approval 1 s before shown deadline, 13 s send': {
    approve: { beforeMs: 1000 },
    send: { ms: 13000, deliverMs: 6500 },
  },
  'd1b POI, approval 2 s before shown deadline, 2 s begin write': {
    approve: { beforeMs: 2000 },
    fsyncMs: (writing) => (writing === 'begin' ? 1000 : 4),
  },
  'd1b POI, 400 ms reads, 4 resolved, approval 300 ms before shown deadline': {
    resolved: 4,
    read: uniform(400),
    approve: { beforeMs: 300 },
  },
  'same, and the send is delivered after 9.5 s': {
    resolved: 4,
    read: uniform(400),
    approve: { beforeMs: 300 },
    send: { ms: 12000, deliverMs: 9500 },
  },
  'd1b POI, send accepted, response lost': { send: { ms: 300, deliverMs: 150, lost: true } },
});
// Outcome per variant, in VARIANTS order. after-POI: the blinded commitment
// went to the POI aggregator, the nullifier never left (membership: refused
// before the preflight; nullifiers: refused by the preflight at that
// request). after-nullifier: the nullifier left; eoa: refused before the
// calldata simulation; submission: calldata simulated and signed, no
// journal record. uncertain: a durable attempt with an unknown outcome;
// accepted or unsent is the simulated node's ground truth, not the wallet's.
const B1 = 'after-POI:membership';
const AT_NULLIFIER = 'after-POI:nullifiers';
const EXPECTED = Object.freeze({
  'd1b POI 18.6 s, 150 ms reads, empty journal': [[B1, 'ack', 'ack', B1, 'ack'], 26204],
  'd1b POI, 150 ms reads, 4 resolved records': [[B1, 'ack', 'ack', B1, 'ack'], 25248],
  'd1b POI, 4 resolved, approval 500 ms before shown deadline': [
    [B1, 'after-nullifier:submission', 'after-nullifier:submission', B1, 'ack'],
    25248,
  ],
  'd1b POI, every 8th read 1.5 s, 4 resolved': [
    [B1, 'after-nullifier:eoa', 'ack', B1, 'ack'],
    19848,
  ],
  'd1b POI, 400 ms reads, 4 resolved': [[B1, AT_NULLIFIER, 'ack', B1, 'ack'], 16748],
  'POI 22 s, 150 ms reads, 4 resolved': [[B1, AT_NULLIFIER, 'ack', B1, 'ack'], 21835],
  'POI 25 s, 150 ms reads, 4 resolved': [[B1, B1, B1, B1, B1], null],
  'd1b POI, one 10 s deployment read (probe-1 shape)': [
    [B1, AT_NULLIFIER, AT_NULLIFIER, B1, AT_NULLIFIER],
    null,
  ],
  'd1b POI, 5 s verifier, 4 resolved': [[B1, AT_NULLIFIER, 'ack', B1, 'ack'], 21048],
  'd1b POI, approval 1 s before shown deadline, 13 s send': [
    [B1, 'ack', 'uncertain:accepted', B1, 'uncertain:accepted'],
    26204,
  ],
  'd1b POI, approval 2 s before shown deadline, 2 s begin write': [
    [B1, 'uncertain:unsent', 'uncertain:unsent', B1, 'ack'],
    26204,
  ],
  'd1b POI, 400 ms reads, 4 resolved, approval 300 ms before shown deadline': [
    [B1, AT_NULLIFIER, 'after-nullifier:submission', B1, 'ack'],
    16748,
  ],
  'same, and the send is delivered after 9.5 s': [
    [B1, AT_NULLIFIER, 'after-nullifier:submission', B1, 'uncertain:accepted'],
    16748,
  ],
  'd1b POI, send accepted, response lost': [
    [B1, 'uncertain:accepted', 'uncertain:accepted', B1, 'uncertain:accepted'],
    26204,
  ],
});
function outcomeCode(seen) {
  switch (seen.outcome) {
    case 'acknowledged':
      return 'ack';
    case 'journaled-uncertain':
      return mock.chain.accepted.length ? 'uncertain:accepted' : 'uncertain:unsent';
    case 'refused-after-nullifier':
      return 'after-nullifier:' + seen.diagnostic.stage;
    case 'refused-after-POI':
      return 'after-POI:' + (seen.diagnostic.step ?? seen.diagnostic.stage);
  }
  return seen.outcome;
}
describe('policy comparison under real boundaries', () => {
  test.each(Object.keys(VARIANTS).map((name, column) => [name, column]))(
    '%s',
    async (name, column) => {
      const actual = {},
        expected = {};
      for (const [scenario, overrides] of Object.entries(SCENARIOS)) {
        const seen = await run(VARIANTS[name], overrides);
        actual[scenario] = outcomeCode(seen);
        expected[scenario] = EXPECTED[scenario][0][column];
        // The shown review under the 10 s candidate, for the design table.
        if (name === 'H = F, 10 s') expect(seen.review?.window ?? null).toBe(EXPECTED[scenario][1]);
        // Never more than the existing 30 s review, never below the floor.
        if (seen.review) {
          expect(seen.review.window).toBeLessThanOrEqual(30000);
          expect(seen.review.window).toBeGreaterThanOrEqual(BUDGET.reviewMinMs);
        }
      }
      expect(actual).toEqual(expected);
    },
    60000
  );
});

// Mutation controls: each monotonic F check removed (or F added to the scope)
// in an edited copy of one production module, run through the probes above.
// A row that survives is redundant by construction, and says why.
const SUBMISSION = MUTABLE.submission,
  NETWORK = MUTABLE.network;
const MUTATIONS = [
  [
    'the check before the signer',
    {
      [SUBMISSION]: [
        'if (lifetimeEnd) assert.ok(performance.now() < admissionEnd);\n        const signed',
        'const signed',
      ],
    },
    'pre-sign',
    'caught',
  ],
  // The network's entry check follows it with no event-loop turn between.
  [
    'the check after the signer',
    {
      [SUBMISSION]: [
        'if (lifetimeEnd) assert.ok(performance.now() < admissionEnd);\n        return signed;',
        'return signed;',
      ],
    },
    'signing-crosses-F',
    'survives',
  ],
  // The check after the signer precedes it with no event-loop turn between.
  [
    "the network's entry check",
    {
      [NETWORK]: [
        "assertAdmitted();\n    if (intent.kind === 'railgun-native-shield')",
        "if (intent.kind === 'railgun-native-shield')",
      ],
    },
    'signing-crosses-F',
    'survives',
  ],
  [
    "both the check after the signer and the network's entry check",
    {
      [SUBMISSION]: [
        'if (lifetimeEnd) assert.ok(performance.now() < admissionEnd);\n        return signed;',
        'return signed;',
      ],
      [NETWORK]: [
        "assertAdmitted();\n    if (intent.kind === 'railgun-native-shield')",
        "if (intent.kind === 'railgun-native-shield')",
      ],
    },
    'signing-crosses-F',
    'caught',
  ],
  [
    'the approval check, split policy',
    { [SUBMISSION]: ['if (lifetimeEnd) assert.ok(performance.now() < reviewEnd);', 'void 0;'] },
    'approval-after-H',
    'caught',
  ],
  // H = F: the check before the signer refuses at the same instant.
  [
    'the approval check, H = F',
    { [SUBMISSION]: ['if (lifetimeEnd) assert.ok(performance.now() < reviewEnd);', 'void 0;'] },
    'approval-after-F',
    'survives',
  ],
  [
    'the monotonic clause of the submission entry',
    {
      [SUBMISSION]: [
        'assertCurrent();\n        if (lifetimeEnd) assert.ok(performance.now() < admissionEnd);\n      },',
        'assertCurrent();\n      },',
      ],
    },
    'refresh-crosses-F',
    'caught',
  ],
  [
    "the network's check before journal begin",
    { [NETWORK]: ['assertDeadline();\n    assertAdmitted();\n', 'assertDeadline();\n'] },
    'refresh-crosses-F',
    'caught',
  ],
  [
    "the network's check before the raw send",
    { [NETWORK]: ['assertDeadline();\n      assertAdmitted();\n', 'assertDeadline();\n'] },
    'begin-crosses-F',
    'caught',
  ],
  [
    "F added to the submission scope's isCurrent",
    {
      [SUBMISSION]: [
        '        try {\n          assertCurrent();\n          return true;',
        '        try {\n          (submissions.get(handle)?.assertCurrent ?? assertCurrent)();\n          return true;',
      ],
    },
    'ack-after-F',
    'caught',
  ],
];
describe('mutation controls: the monotonic F checks', () => {
  const sources = Object.fromEntries(
    Object.values(MUTABLE).map((name) => [name, fs.readFileSync(require.resolve(name), 'utf8')])
  );
  afterEach(() => {
    mutant = null;
  });
  test.each(MUTATIONS)('%s', async (_name, edits, probe, expected) => {
    const variant = {};
    for (const [name, [from, to]] of Object.entries(edits)) {
      expect(sources[name].split(from)).toHaveLength(2);
      variant[name] = sources[name].split(from).join(to);
    }
    mutant = variant;
    let failure = null;
    try {
      await MONOTONIC[probe]();
    } catch (error) {
      failure = error;
    }
    if (expected === 'survives') expect(failure).toBeNull();
    // Caught by a probe expectation, never by a load or harness error.
    else expect(failure?.matcherResult).toBeDefined();
  });
});
