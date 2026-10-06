/** Synthetic source controls only: no archive, signing, points or native process. */
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(
  path.join(__dirname, 'railgun-relay-quote-native-refusal.js'),
  'utf8'
);
const JOB = '/fixture/quote-job.js';
const bytes = Buffer.from('synthetic source');
const jobSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const guards = { hooks: ['synthetic'], canaries: 1, attempts: 0 };
function failure(code = 'ERR_ASSERTION', line = 7, filename = JOB) {
  return Object.assign(new Error('synthetic failure'), {
    code,
    stack: `Error: synthetic failure\n    at Object.run (${filename}:${line}:9)`,
  });
}
function fixture(options = {}) {
  let calls = 0,
    runtimeChecks = 0;
  const requireStub = (name) => {
    if (name === 'assert/strict') return assert;
    if (name === 'crypto') return crypto;
    if (name === 'fs')
      return {
        readFileSync: () => {
          if (options.sourceFault) throw failure();
          return bytes;
        },
      };
    if (name.endsWith('railgun-relay-quote-data'))
      return {
        shape(value, keys) {
          assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
        },
        normalizeRailgunRelayQuote() {
          if (options.preflightFault) throw failure();
        },
        EXPECTED_GUARDS: guards,
      };
    if (name.endsWith('railgun-engine-runtime'))
      return {
        verifyRailgunEngineRuntime() {
          runtimeChecks++;
          if (options.runtimeFault === runtimeChecks) throw failure();
          return '/fixture/engine.asar';
        },
      };
    if (name.endsWith('railgun-relay-quote-native-pins.json'))
      return { jobSha256, refusalLines: { negative: 7 } };
    if (name === JOB) {
      if (options.importFault) throw failure();
      return {
        async run(input, api) {
          calls++;
          if (options.job) return options.job(api);
          throw failure();
        },
      };
    }
    throw Error('Unexpected import ' + name);
  };
  requireStub.resolve = () => JOB;
  const context = { exports: {}, require: requireStub, Buffer, AbortSignal };
  vm.runInNewContext(source, context, { filename: 'actual-wrapper-source.js' });
  const controller = new AbortController(),
    messages = [];
  const input = JSON.stringify({
    caseId: 'negative',
    productionInput: JSON.stringify({
      archive: '/fixture/engine.asar',
      quote: {},
      gas: {},
    }),
  });
  return {
    calls: () => calls,
    messages,
    run: () =>
      context.exports.run(input, {
        signal: controller.signal,
        guardReport: () => guards,
        async request(wire) {
          messages.push(JSON.parse(wire));
          return '{"id":1,"value":null}';
        },
      }),
    controller,
    assertionAt: context.exports.assertionAt,
  };
}
test('full negative envelope accepts only the intended synthetic assertion and records zero production dispatches', async () => {
  const value = fixture();
  await value.run();
  expect(value.calls()).toBe(1);
  expect(value.messages).toHaveLength(1);
  expect(value.messages[0].value.observedAssertionRefusal).toBe(true);
  expect(value.messages[0].value.productionResultMessages).toBe(0);
  expect(value.messages[0].value.exactCryptographicPredicateIndependentlyAttributed).toBe(false);
});
test.each([
  [
    'arbitrary job error',
    {
      job: async () => {
        throw failure('OTHER');
      },
    },
  ],
  [
    'wrong assertion line',
    {
      job: async () => {
        throw failure('ERR_ASSERTION', 8);
      },
    },
  ],
  [
    'runtime assertion frame',
    {
      job: async () => {
        throw failure('ERR_ASSERTION', 7, '/fixture/runtime.js');
      },
    },
  ],
  [
    'prefixed path lookalike',
    {
      job: async () => {
        throw failure('ERR_ASSERTION', 7, '/else' + JOB);
      },
    },
  ],
  ['job returns without result', { job: async () => {} }],
  ['unexpected production result', { job: async (api) => api.request('{}') }],
  ['source failure', { sourceFault: true }],
  ['normalization failure', { preflightFault: true }],
  ['import failure', { importFault: true }],
  ['runtime precheck failure', { runtimeFault: 1 }],
  ['runtime postcheck failure', { runtimeFault: 2 }],
])('%s does not become an expected refusal record', async (name, options) => {
  const value = fixture(options);
  await expect(value.run()).rejects.toBeDefined();
  expect(value.messages).toHaveLength(0);
});
test('abort during the job cannot become a refusal record', async () => {
  let value;
  value = fixture({
    job: async () => {
      value.controller.abort();
      throw failure();
    },
  });
  await expect(value.run()).rejects.toBeDefined();
  expect(value.messages).toHaveLength(0);
});

test('actual builtin assertion stack is admitted at the bound first frame only', () => {
  const value = fixture();
  const context = { assert };
  const body = '\n'.repeat(6) + 'assert.equal(true, false);';
  let observed;
  try {
    vm.runInNewContext(body, context, { filename: JOB });
  } catch (error) {
    observed = error;
  }
  expect(value.assertionAt(observed, JOB, 7)).toBe(true);
  expect(value.assertionAt(observed, JOB, 8)).toBe(false);
});

// Actual runner body with synthetic IO/processes and a deterministic clock.
// No production job, public-key generation, archive or native process executes.
function runnerFixture(runSource, delayedFinalSnapshot) {
  let clock = 0,
    snapshots = 0,
    loaded;
  const writes = new Map(),
    closures = [];
  const data = {
    shape(value, keys) {
      assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
    },
    normalizeRailgunRelayQuote: () => ({ quoteSha256: 'public-quote-digest' }),
    EXPECTED_GUARDS: guards,
  };
  const roles = ['accepted', 'signature-mismatch', 'wrong-chain', 'identity-key', 'identity-r'];
  const vectors = {
    createdAt: 1,
    publicKey: 'public-key',
    masterPublicKey: '1',
    gas: {},
    cases: roles.map((id) => ({
      id,
      expected: id === 'accepted' ? 'accepted' : 'refused',
      quote: {},
    })),
  };
  const fakeFs = {
    writeFileSync(filename, content) {
      assert.equal(writes.has(filename), false);
      writes.set(filename, Buffer.from(content));
    },
  };
  const load = (name) => {
    if (name === 'assert/strict') return assert;
    if (name === 'fs') return fakeFs;
    if (name === 'path') return path;
    if (name === 'crypto') return crypto;
    if (name === './railgun-relay-retained-run')
      return {
        readBounded(filename) {
          return writes.get(filename) || bytes;
        },
        freshDirectory: () => '/synthetic-output',
        sourceHashes() {
          snapshots++;
          if (snapshots === 2 && delayedFinalSnapshot) clock = 90001;
          return { source: 'unchanged' };
        },
      };
    if (name === './railgun-relay-wire-run')
      return {
        async closedJob(start, options, validate, milliseconds, observations, role) {
          const text =
            role === 'accepted'
              ? options.process.input
              : JSON.parse(options.process.input).productionInput;
          const row = vectors.cases.find((value) => value.id === role);
          const result = loaded.expectedResult(row, text);
          validate(result);
          observations.push({
            role,
            code: 'RAILGUN_PROCESS_CLOSED',
            exitCode: 15,
            escalated: false,
            peerDisconnected: false,
          });
          closures.push(role);
          return result;
        },
      };
    if (name === './railgun-relay-quote-native-vectors')
      return { buildVectors: () => vectors, PUBLIC_KEY: 'public-key', MASTER: '1' };
    if (name.endsWith('railgun-relay-quote-data')) return data;
    if (name.endsWith('railgun-engine-runtime'))
      return { verifyRailgunEngineRuntime: () => '/synthetic-engine.asar' };
    if (name.endsWith('railgun-engine-manifest.json')) return { sha256: 'synthetic-engine-digest' };
    if (name === './railgun-relay-quote-native-pins.json')
      return {
        jobSha256,
        refusalLines: Object.fromEntries(roles.slice(1).map((role) => [role, 7])),
      };
    if (name === 'electron') return { app: { setPath() {}, async whenReady() {} } };
    if (name.endsWith('privacy-context'))
      return { createPrivacyScope: () => ({ getContext: () => ({}), close() {} }) };
    if (name.endsWith('railgun-process'))
      return {
        startRailgunProcess() {
          throw Error('Mock closure must not start a process');
        },
      };
    throw Error('Unexpected runner import ' + name);
  };
  load.resolve = (name) => name;
  const context = {
    module: { exports: {} },
    require: load,
    __dirname: '/synthetic-root/scripts/fixtures',
    Buffer,
    AbortController,
    performance: { now: () => clock },
    process: { versions: {} },
    setTimeout: () => 1,
    clearTimeout() {},
  };
  // Run the trusted checked-in body in this realm so strict array prototypes match.
  new Function(...Object.keys(context), runSource)(...Object.values(context));
  loaded = context.module.exports;
  return {
    execute: () => loaded.execute({ archive: '/synthetic-engine.asar' }, '/synthetic-output'),
    writes,
    closures,
  };
}
const runnerSource = fs.readFileSync(
  path.join(__dirname, 'railgun-relay-quote-native-run.js'),
  'utf8'
);
test('controlled full runner publishes only after five original mock closures and unchanged checks', async () => {
  const value = runnerFixture(runnerSource, false);
  await value.execute();
  expect(value.closures).toHaveLength(5);
  expect([...value.writes.keys()]).toEqual([
    '/synthetic-output/vectors.json',
    '/synthetic-output/report.json',
  ]);
});
test('slow final source snapshot exceeds deadline and publishes no report or vector files', async () => {
  const value = runnerFixture(runnerSource, true);
  await expect(value.execute()).rejects.toBeDefined();
  expect(value.closures).toHaveLength(5);
  expect(value.writes.size).toBe(0);
});
test('deleting the final deadline check distinguishes the formerly accepted overrun', async () => {
  const needle = 'assert.deepEqual(sourceSnapshot(), before);\n    current();';
  expect(runnerSource.split(needle)).toHaveLength(2);
  const mutant = runnerSource.replace(needle, 'assert.deepEqual(sourceSnapshot(), before);');
  const value = runnerFixture(mutant, true);
  await value.execute();
  expect(value.writes.size).toBe(2);
});
