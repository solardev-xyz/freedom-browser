// Execute only the actual pure baseline broker/report declarations. Avoid
// importing its production policy/crypto leaves in this structural suite.
jest.mock('../qualify-railgun-relay-proof', () => {
  const fs = require('fs'),
    vm = require('vm');
  const source = fs.readFileSync(require.resolve('../qualify-railgun-relay-proof'), 'utf8');
  return vm.runInNewContext(
    source.slice(
      source.indexOf('const EXPECTED_GUARDS ='),
      source.indexOf('async function main()')
    ) + '\n({createResultBroker,assertProducerResult,assertVerification,EXPECTED_GUARDS})',
    {
      assert: require('assert/strict'),
      Buffer,
      assertPublicShape: (v) =>
        require('./railgun-relay-wire-composition').readPublicCase(Buffer.from(JSON.stringify(v))),
    }
  );
});
const { closedJob, selectedConfig, pipeline, CHECKS } = require('./railgun-relay-wire-run');
const { EXPECTED_GUARDS } = require('../qualify-railgun-relay-proof');
const data = require('./railgun-relay-wire-composition');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const observation = {
  code: 'RAILGUN_PROCESS_CLOSED',
  exitCode: 15,
  escalated: false,
  peerDisconnected: false,
  peakRssBytes: 1000,
};
function taskFixture(controller = new AbortController()) {
  const ready = deferred(),
    closed = deferred(),
    close = jest.fn();
  let options;
  const start = jest.fn((input) => {
    options = input;
    return { ready: ready.promise, closed: closed.promise, close };
  });
  const rows = [],
    validate = jest.fn();
  const promise = closedJob(
    start,
    { signal: controller.signal, process: { binaryKey: false } },
    validate,
    1000,
    rows,
    'quote',
    () => 0
  );
  const send = (value) =>
    options.broker.dispatch(JSON.stringify({ id: 1, method: 'result', value }));
  return { ready, closed, close, start, rows, validate, promise, send, controller };
}
test('original ready/result is insufficient: no outward result before original closed observation', async () => {
  const f = taskFixture();
  let settled = false;
  f.promise.then(() => {
    settled = true;
  });
  await f.send({ bounded: true });
  f.ready.resolve();
  await tick();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  expect(f.rows).toEqual([]);
  f.closed.resolve(observation);
  expect(await f.promise).toEqual({ bounded: true });
  expect(f.rows).toEqual([{ role: 'quote', ...observation }]);
});
test('cancellation withholds result while awaiting original closure', async () => {
  const f = taskFixture();
  let settled = false;
  const result = f.promise.catch((error) => {
    settled = true;
    return error;
  });
  await f.send({ bounded: true });
  f.controller.abort();
  await tick();
  expect(settled).toBe(false);
  expect(f.close).toHaveBeenCalledTimes(1);
  f.closed.resolve(observation);
  expect(await result).toBeInstanceOf(Error);
  expect(f.rows).toHaveLength(1);
});
test('close failure still observes original closed and preserves first failure', async () => {
  const f = taskFixture(),
    first = new Error('ready failure');
  f.close.mockImplementation(() => {
    throw new Error('cleanup failure');
  });
  const result = f.promise.catch((error) => error);
  f.ready.reject(first);
  await tick();
  expect(f.close).toHaveBeenCalled();
  f.closed.resolve(observation);
  expect(await result).toBe(first);
});
test('rejected original closed is observed even when readiness fails', async () => {
  const f = taskFixture(),
    first = new Error('first');
  const result = f.promise.catch((error) => error);
  f.closed.reject(new Error('close rejected'));
  f.ready.reject(first);
  expect(await result).toBe(first);
  expect(f.rows).toEqual([]);
});
test.each(['', '0', 'true', '2'])(
  'unknown opt-in %s refuses before config/filesystem work',
  (mode) => expect(() => selectedConfig({ FREEDOM_RAILGUN_RELAY_WIRE: mode })).toThrow()
);
test('default has no input config; stale input without explicit opt-in refuses', () => {
  expect(selectedConfig({})).toBe(null);
  expect(() => selectedConfig({ FREEDOM_RAILGUN_RELAY_WIRE_INPUTS: '/not/read' })).toThrow();
});
function publicCase() {
  const field = (n) => '0x' + n.toString(16).padStart(64, '0');
  return {
    domain: 'public-fixture-relay-pre-poi-v1',
    minGasPrice: 1,
    transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data: '0x01020304' },
    poi: {
      proof: {
        pi_a: ['1', '2'],
        pi_b: [
          ['3', '4'],
          ['5', '6'],
        ],
        pi_c: ['7', '8'],
      },
      txidMerkleroot: field(1),
      poiMerkleroots: [field(2)],
      blindedCommitmentsOut: [field(3), field(4)],
      railgunTxidIfHasUnshield: '0x00',
    },
  };
}
function selection() {
  const now = Date.now(),
    recipient = {
      address: '0zk1' + 'q'.repeat(123),
      viewingPublicKey: '0a'.repeat(32),
      masterPublicKey: '23',
    };
  const quote = {
    fees: { [pins.wrappedNative]: '0x' + (10n ** 18n).toString(16) },
    feeExpiration: now + 240000,
    feesID: 'public',
    railgunAddress: recipient.address,
    identifier: 'public fixture',
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: [data.LIST],
    reliability: 0.95,
  };
  return data.selectRelayWireInput(
    Buffer.from(
      JSON.stringify({
        data: Buffer.from(JSON.stringify(quote)).toString('hex'),
        signature: '01'.repeat(64),
      })
    ),
    recipient,
    now,
    '100'
  );
}
const verification = {
  minGasPrice: 1,
  transactionVerified: true,
  prePoiVerified: true,
  feeAndSelfCommitmentsMatched: true,
  sameTransactionPrePoiRootMatched: true,
  syntheticListRootMatched: true,
  productionPolicyRefused: true,
  productionPayloadRefused: true,
  changedSignalsRefused: 13,
  authorityGranted: false,
  serviceAcceptanceQualified: false,
  guards: EXPECTED_GUARDS,
};
function fakePipeline(change = () => {}) {
  const selected = selection(),
    produced = publicCase(),
    reconstructed = JSON.parse(JSON.stringify(produced)),
    roles = [];
  const run = jest.fn(async (role, filename, input, validate) => {
    roles.push(role);
    if (role === 'producer') {
      expect(roles).toEqual(['quote', 'producer']);
      expect(input.selection).toBe(selected);
    }
    if (role === 'verifier') expect(input.publicCase).toBe(reconstructed);
    const values = {
      quote: {
        selection: selected,
        originalByteSignaturesVerified: true,
        independentRecipientMatched: true,
        sourceFeeEquals100: true,
        authorityGranted: false,
        guards: EXPECTED_GUARDS,
      },
      producer: { publicCase: produced, guards: EXPECTED_GUARDS },
      wire: { publicCase: reconstructed, checks: CHECKS, guards: EXPECTED_GUARDS },
      verifier: verification,
    };
    change(role, values[role]);
    validate(values[role]);
    return values[role];
  });
  const promise = pipeline({
    config: {},
    inputs: {},
    signal: new AbortController().signal,
    run,
    current: () => {},
  });
  return { promise, roles, run, reconstructed };
}
test('closed quote admission precedes producer and verifier consumes decrypted reconstruction identity', async () => {
  const f = fakePipeline();
  const result = await f.promise;
  expect(f.roles).toEqual(['quote', 'producer', 'wire', 'verifier']);
  expect(result.publicCase).toBe(f.reconstructed);
});
test('failed quote verification cannot admit producer', async () => {
  const f = fakePipeline((role, v) => {
    if (role === 'quote') v.originalByteSignaturesVerified = false;
  });
  await expect(f.promise).rejects.toThrow();
  expect(f.roles).toEqual(['quote']);
});
test('changed decrypted case cannot be hidden by original-case fallback', async () => {
  const f = fakePipeline((role, v) => {
    if (role === 'wire') v.publicCase.poi.proof.pi_a[0] = '9';
  });
  await expect(f.promise).rejects.toThrow();
  expect(f.roles).toEqual(['quote', 'producer', 'wire']);
});
test('monotonic elapsed deadline catches delayed timer independently of wall clock', async () => {
  const ready = deferred(),
    closed = deferred();
  let elapsed = 0;
  const promise = closedJob(
    () => ({
      ready: ready.promise,
      closed: closed.promise,
      close() {
        closed.resolve(observation);
      },
    }),
    { signal: new AbortController().signal, process: {} },
    () => {},
    1000,
    [],
    'quote',
    () => elapsed
  );
  elapsed = 1001;
  ready.resolve();
  await expect(promise).rejects.toThrow();
});
