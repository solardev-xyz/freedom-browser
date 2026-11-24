/**
 * The checkpoint check through freedom-colibrid's one-shot process
 * (`checkpoint-colibrid.js`, freedom-core design 0014, COL-5):
 * - the protocol paths, against test/helpers/fake-colibrid.js: the process
 *   and its one call, main's fetches for it (the proof once, HTTP 200 only,
 *   each attempt 20 s at most; the roots from the quorum, memoized per slot,
 *   at most 8; everything else refused, nothing sent), every outcome's
 *   class, the bound of two checks, the 90 s deadline, an abort that
 *   settles once the process has exited, the diagnostics;
 * - the captured proofs (docs/audits/evidence/colibri-v3-2026-09/captures)
 *   through the real binary at each capture's clock, when there is one
 *   (`FREEDOM_COLIBRID_PATH`, or `npm run colibrid:download`'s
 *   freedom-colibrid-bin/; skipped otherwise): the recorded checkpoint, a
 *   flipped proof a mismatch, a stale one stale, a legacy or malformed one
 *   unavailable;
 * - the evidence policy (`checkpoint proof/finality policy`), the quorum's
 *   authorities and the verifier scripted (test/helpers/checkpoint-fixture.js),
 *   which ran on the WASM worker too until COL-6 removed it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeHop } = require('../core/naming-shell');
const { ColibriFetchPool } = require('../ens/colibri-fetch-pool');
const { CHECKPOINT_PROOF_PAYLOAD } = require('../ens/colibri-fetch-contract');
const { getColibridBinaryPath } = require('../ens/colibrid-binary');
const { PINNED_COLIBRID_VERSION } = require('../ens/colibrid-pin');
const { headerRoot } = require('./checkpoint-evidence');
const { CHECKPOINT_NETWORKS, DEADLINE_MS, MAX_AGE_MS } = require('./checkpoint-verifier');
const {
  acquireColibridCheckpoint,
  activeChecks,
  MAX_CHECKS,
} = require('./checkpoint-colibrid');
const { checkpointCheck, helloFor } = require('../../../test/helpers/fake-colibrid');
const { checkpointFixture, NOW, quietLog } = require('../../../test/helpers/checkpoint-fixture');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, what, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 5) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Whether `promise` has settled by now. */
async function settled(promise) {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  await sleep(0);
  return done;
}

/** A check on chain `f.chainId` through a fresh fake process scripted by
 * `script` (the fixture's check by default); `{ promise, fake }`. */
function start(f, { script, options = {}, extra = {} } = {}) {
  const { fake, dependencies } = f.colibrid(extra);
  if (script) Object.assign(fake.script, script);
  const promise = acquireColibridCheckpoint(f.chainId, options, dependencies);
  return { promise, fake, dependencies };
}

/** A scripted check whose `verify` is the test's own. */
function verifying(f, verify, { exit = true } = {}) {
  return {
    checkpoint: (message, child) =>
      checkpointCheck(message, child, {
        decode: (bytes) => f.decodeProof(bytes),
        verify,
        exit,
      }),
  };
}

/** The verified record the fixture's check gives. */
function record(f) {
  return {
    schemaVersion: 2,
    chainId: f.chainId,
    network: f.config.network,
    root: headerRoot(f.header),
    slot: f.slot,
    sources: f.config.sources.slice(0, f.config.participants),
    verifiedAt: NOW,
    finalizedEpoch: f.slot / f.config.slotsPerEpoch,
  };
}

beforeEach(() => {
  // The fake children's PIDs are no processes of ours.
  jest.spyOn(os, 'setPriority').mockImplementation(() => {});
});

afterEach(async () => {
  jest.restoreAllMocks();
  await until(() => activeChecks() === 0, 'every check to settle');
});

describe('the one-shot process and its call', () => {
  test.each([1, 100])(
    'chain %i: `checkpoint --chain`, colibri.checkpoint with the freshness bound and what is left of 90 s, the record verified',
    async (chainId) => {
      const f = checkpointFixture(chainId);
      const { promise, fake } = start(f);

      await expect(promise).resolves.toEqual(record(f));

      const [child] = fake.children;
      expect(fake.spawned[0].command).toBe('freedom-colibrid');
      expect(fake.spawned[0].args).toEqual([
        'checkpoint',
        '--chain',
        String(chainId),
        '--parent-pid',
        '4242',
      ]);
      const [call] = child.sent('colibri.checkpoint');
      expect(call.params.min_latest_block_ts).toBe(Math.floor(NOW / 1000) - 60);
      expect(call.params.deadline_ms).toBeLessThanOrEqual(DEADLINE_MS);
      expect(call.params.deadline_ms).toBeGreaterThan(DEADLINE_MS - 5_000);
      // Settled once the process had exited by itself, after its answer:
      // nothing more was written to it.
      expect(child.exited).toBe(true);
      expect(child.sent('colibri.shutdown')).toEqual([]);
      expect(child.stdinClosed).toBe(false);
      expect(activeChecks()).toBe(0);
    }
  );

  test("the proof is main's own POST to the chain's prover, through the hop: the pinned version, zk_proof, nothing from the service", async () => {
    const f = checkpointFixture(100);
    const { promise, fake } = start(f);
    await promise;

    const proofCalls = f.fetch.mock.calls.filter(([url]) => url === f.config.prover);
    expect(proofCalls).toHaveLength(1);
    const [, init] = proofCalls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(CHECKPOINT_PROOF_PAYLOAD);
    expect(JSON.parse(init.body)).toEqual({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
      version: 196611,
      zk_proof: true,
    });
    expect(init.headers).toEqual({
      Accept: 'application/octet-stream',
      'Content-Type': 'application/json',
    });
    // The service gave main a type and nothing else.
    expect(fake.children[0].fetches[0].params).toEqual({
      request: fake.children[0].sent('colibri.checkpoint')[0].id,
      type: 'checkpoint_proof',
      method: 'post',
      path: '',
      accept: 'ssz',
      exclude_mask: 0,
    });
    // The quorum's own GETs refuse redirects, as the worker's do.
    for (const [url, options] of f.fetch.mock.calls) {
      if (url !== f.config.prover) expect(options.redirect).toBe('error');
    }
  });

  test.each([
    [203, 'HTTP error! Status: 203'],
    [503, 'HTTP error! Status: 503'],
  ])(
    'a proof answered %i is no proof: the service is told, the check is unavailable',
    async (status, text) => {
      const f = checkpointFixture();
      f.fetch.mockImplementation(async (url) =>
        url === f.config.prover
          ? new Response(Buffer.from('bounded test proof'), { status })
          : new Response('{}')
      );
      const { promise, fake } = start(f);

      await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
      const [proof] = fake.children[0].fetches;
      expect(proof.outcome.error).toContain(text);
      expect(f.decodeProof).not.toHaveBeenCalled();
    }
  );

  test('a prover that never answers: the attempt is cut at 20 s, and the check settles unavailable long before its 90 s', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    try {
      const f = checkpointFixture();
      f.fetch.mockImplementation(
        (url, init) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            })
          )
      );
      const started = Date.now();
      const { promise, fake } = start(f);
      let outcome = null;
      promise.then(
        () => (outcome = 'resolved'),
        (error) => (outcome = error.code)
      );
      for (let i = 0; i < 2000 && f.fetch.mock.calls.length === 0; i++) await tick();
      expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([f.config.prover]);

      await jest.advanceTimersByTimeAsync(20_000);
      for (let i = 0; i < 2000 && outcome === null; i++) await tick();

      expect(outcome).toBe('CHECKPOINT_UNAVAILABLE');
      expect(Date.now() - started).toBeLessThan(21_000);
      const [proof] = fake.children[0].fetches;
      expect(proof.outcome.error).toMatch(/^Request to <url> with payload .* failed: fetch failed$/);
      expect(fake.children[0].exited).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a proof over 4 MiB is never read whole: unavailable', async () => {
    const f = checkpointFixture();
    f.fetch.mockImplementation(async () => new Response(Buffer.alloc(4 * 1024 * 1024 + 1)));
    const { promise, fake } = start(f);
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    expect(fake.children[0].fetches[0].outcome.error).toMatch(/response over 4194304 bytes/);
  });
});

describe("main's fetches for the check", () => {
  test('a root comes from the quorum as {"data":{"root"}}, node 0, the quorum asked once per slot', async () => {
    const f = checkpointFixture();
    const answers = [];
    const { promise, fake } = start(f, {
      script: verifying(f, async (lookup) => {
        answers.push(await lookup(f.verifier.rootPath));
        answers.push(await lookup(f.verifier.rootPath));
        return { number: '0x1' };
      }),
    });

    await expect(promise).resolves.toEqual(record(f));
    expect(answers).toEqual([
      { data: { root: headerRoot(f.header) } },
      { data: { root: headerRoot(f.header) } },
    ]);
    const lookups = fake.children[0].fetches.filter((ask) => ask.params.type === 'checkpointz');
    expect(lookups.map((ask) => ask.outcome.node)).toEqual([0, 0]);
    // One quorum: the proof, then two GETs to each of the three seats.
    expect(f.fetch).toHaveBeenCalledTimes(1 + 2 * f.config.participants);
    // Nothing went to the intercepted origin's path as a fetch of its own.
    expect(f.fetch.mock.calls.filter(([url]) => url.endsWith(f.verifier.rootPath))).toHaveLength(
      f.config.participants
    );
  });

  test('every other fetch is refused and nothing is sent: another checkpointz path, beacon_api, prover, eth_rpc, a second proof', async () => {
    const f = checkpointFixture();
    const refusals = [];
    const { promise } = start(f, {
      script: {
        checkpoint: (message, child) =>
          checkpointCheck(message, child, {
            decode: (bytes) => f.decodeProof(bytes),
            verify: async (lookup) => {
              const asks = [
                {
                  type: 'beacon_api',
                  method: 'get',
                  path: `eth/v1/beacon/light_client/bootstrap/0x${'aa'.repeat(32)}`,
                  accept: 'ssz',
                },
                {
                  type: 'prover',
                  method: 'post',
                  path: '',
                  payload: { method: 'eth_blockNumber', params: [], version: 196611 },
                  accept: 'ssz',
                },
                { type: 'eth_rpc', method: 'post', path: '', accept: 'json' },
                { type: 'checkpoint_proof', method: 'post', path: '', accept: 'ssz' },
              ];
              for (const ask of asks) refusals.push(await child.fetch(message.id, ask).done);
              return lookup(f.verifier.rootPath).then(() => ({ number: '0x1' }));
            },
          }),
      },
    });

    // Refusals of other types are the service's failed fetches, no evidence
    // either way: the verified root still decides.
    await expect(promise).resolves.toEqual(record(f));
    expect(refusals).toEqual(Array(4).fill({ error: 'Colibri fetch refused' }));
    expect(f.fetch.mock.calls.filter(([url]) => url === f.config.prover)).toHaveLength(1);
  });

  test("a checkpointz fetch the contract refuses is the check's mismatch, even if the service then claims success", async () => {
    const f = checkpointFixture();
    const { promise, fake } = start(f, {
      script: verifying(f, async (lookup) => {
        await lookup('eth/v1/beacon/states/head/finality_checkpoints').catch(() => {});
        await lookup(f.verifier.rootPath);
        return { number: '0x1' };
      }),
    });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    const [refused] = fake.children[0].fetches.filter((ask) => ask.params.type === 'checkpointz');
    expect(refused.outcome).toEqual({ error: 'Colibri fetch refused' });
    // Nothing was sent for it: the proof and the quorum alone.
    expect(f.fetch).toHaveBeenCalledTimes(1 + 2 * f.config.participants);
  });

  test('at most 8 root lookups: a ninth is refused, and the check is unavailable whatever the service says', async () => {
    const f = checkpointFixture();
    const outcomes = [];
    const { promise } = start(f, {
      script: verifying(f, async (lookup) => {
        for (let i = 0; i < 9; i++) {
          outcomes.push(await lookup(f.verifier.rootPath).then(
            () => 'root',
            (err) => err.message
          ));
        }
        return { number: '0x1' };
      }),
    });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    expect(outcomes).toEqual([...Array(8).fill('root'), 'Colibri fetch refused']);
    // One quorum for the slot, however many lookups.
    expect(f.fetch).toHaveBeenCalledTimes(1 + 2 * f.config.participants);
  });

  test("a quorum failure reaches the service as main's own text, and its class decides the check", async () => {
    const f = checkpointFixture();
    f.fetch.mockImplementation(async (url) => {
      if (url === f.config.prover) return new Response('proof');
      throw new Error('offline https://secret.invalid');
    });
    const seen = [];
    const { promise } = start(f, {
      script: verifying(f, async (lookup) => {
        await lookup(f.verifier.rootPath).catch((err) => {
          seen.push(err.message);
          throw err;
        });
      }),
    });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_UNAVAILABLE' });
    expect(seen).toEqual(['Colibri checkpoint root unavailable']);
  });
});

describe('the outcome', () => {
  test.each([
    ['proof for latest too old', 'CHECKPOINT_STALE'],
    ['Proof for latest too old (by 61 s)', 'CHECKPOINT_STALE'],
    ['invalid zk_proof!', 'CHECKPOINT_MISMATCH'],
    ['checkpoint_proof: merkle proof does not match header.stateRoot', 'CHECKPOINT_MISMATCH'],
  ])('stage verify %p: %s', async (text, code) => {
    const f = checkpointFixture();
    f.failVerification(new Error(text));
    const { promise } = start(f);
    await expect(promise).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining(text),
    });
  });

  test("stage decode, the service's own text whatever it is: unavailable", async () => {
    const f = checkpointFixture();
    f.decodeProof.mockRejectedValue(new Error('Unknown proof format'));
    const { promise, fake } = start(f);
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    // No root was looked up.
    expect(fake.children[0].fetches.map((ask) => ask.params.type)).toEqual(['checkpoint_proof']);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a decoded proof that is no object', { decoded: [1], result: null }],
    ['a decoded proof of null', { decoded: null, result: null }],
    ['a success', { status: 'success', result: '0x1' }],
    ['another stage', { status: 'error', stage: 'commit', error: 'x' }],
    ['text', 'checkpoint verified'],
    ['nothing', null],
  ])('%s is unavailable', async (_name, reply) => {
    const f = checkpointFixture();
    const { promise } = start(f, {
      script: {
        checkpoint: (message, child) =>
          setImmediate(() => {
            child.result(message.id, reply);
            setImmediate(() => child.exit(0));
          }),
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
  });

  test("a verified proof without the quorum's root is an incompatible verifier, as the worker has it", async () => {
    const f = checkpointFixture();
    f.verifier.run = async () => ({ number: '0x1' });
    const { promise } = start(f);
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_INCOMPATIBLE' });
  });

  test.each([
    ['dies mid-check', (message, child) => setImmediate(() => child.exit(70))],
    ['is killed mid-check', (message, child) => setImmediate(() => child.kill('SIGKILL'))],
    [
      'refuses it busy',
      (message, child) =>
        setImmediate(() =>
          child.error(message.id, 'busy', 'the checkpoint process takes one check')
        ),
    ],
    [
      'refuses it otherwise',
      (message, child) => setImmediate(() => child.error(message.id, 'invalid_argument', 'no')),
    ],
  ])('a process that %s: unavailable', async (_name, handler) => {
    const f = checkpointFixture();
    const { promise } = start(f, { script: { checkpoint: handler } });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
  });

  test('a handshake that fails, or a spawn that throws: unavailable, nothing asked', async () => {
    const f = checkpointFixture();
    const { promise, fake } = start(f, {
      script: { hello: (message, child) => child.result(message.id, { protocol: 1 }) },
    });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    expect(fake.children[0].sent('colibri.checkpoint')).toEqual([]);

    const thrown = start(f, {
      extra: {
        spawn: () => {
          throw new Error('private path');
        },
      },
    });
    await expect(thrown.promise).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE',
      message: expect.not.stringContaining('private path'),
    });
  });

  test('wrong chains and signals are refused before anything is spawned', async () => {
    const f = checkpointFixture();
    for (const chainId of ['1', 11155111, null]) {
      const { fake, dependencies } = f.colibrid();
      await expect(acquireColibridCheckpoint(chainId, {}, dependencies)).rejects.toMatchObject({
        code: 'CHECKPOINT_MISMATCH',
      });
      expect(fake.children).toEqual([]);
    }
    const { fake, dependencies } = f.colibrid();
    await expect(
      acquireColibridCheckpoint(1, { signal: { aborted: false } }, dependencies)
    ).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    expect(fake.children).toEqual([]);
  });
});

describe('the bound, the deadline and an abort', () => {
  test(`at most ${MAX_CHECKS} at once: a third is unavailable at once and spawns nothing; a place frees as one settles`, async () => {
    expect(MAX_CHECKS).toBe(2);
    const f = checkpointFixture();
    const releases = [];
    const hold = verifying(f, (lookup) =>
      new Promise((resolve) => releases.push(resolve)).then(() =>
        lookup(f.verifier.rootPath).then(() => ({ number: '0x1' }))
      )
    );
    const first = start(f, { script: hold });
    const second = start(f, { script: hold });
    await until(() => releases.length === 2, 'two checks verifying');
    expect(activeChecks()).toBe(2);

    const third = start(f);
    await expect(third.promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    expect(third.fake.children).toEqual([]);

    releases[0]();
    await expect(first.promise).resolves.toEqual(record(f));
    expect(activeChecks()).toBe(1);
    const fourth = start(f);
    await expect(fourth.promise).resolves.toEqual(record(f));
    releases[1]();
    await expect(second.promise).resolves.toEqual(record(f));
  });

  test('an abort stops the process and settles only once it has exited', async () => {
    const f = checkpointFixture();
    const controller = new AbortController();
    let exitedAt = null;
    const { promise, fake } = start(f, {
      options: { signal: controller.signal },
      script: {
        // A process slow to go: every exit (shutdown's, stdin's end) comes
        // 100 ms late.
        hello: (message, child) => {
          const exit = child.exit.bind(child);
          child.exit = (code, signal) =>
            setTimeout(() => {
              exitedAt = Date.now();
              exit(code, signal);
            }, 100);
          child.result(message.id, helloFor(child.args));
        },
        // The check never replies.
        checkpoint: () => {},
      },
    });
    await until(() => fake.children[0]?.sent('colibri.checkpoint').length === 1, 'the call');
    controller.abort();
    expect(await settled(promise)).toBe(false);
    const error = await promise.catch((err) => err);
    const settledAt = Date.now();
    expect(error).toMatchObject({ name: 'AbortError', code: 'CHECKPOINT_UNAVAILABLE' });
    expect(fake.children[0].exited).toBe(true);
    expect(exitedAt).not.toBeNull();
    expect(settledAt).toBeGreaterThanOrEqual(exitedAt);
    expect(fake.children[0].sent('colibri.shutdown')).toHaveLength(1);
  });

  test('an abort while the quorum is asked: its requests are cut short, and the check settles after them and the exit', async () => {
    const f = checkpointFixture();
    const controller = new AbortController();
    const aborted = [];
    f.fetch.mockImplementation((url, init = {}) => {
      if (url === f.config.prover) return Promise.resolve(new Response('proof'));
      return new Promise((_resolve, reject) => {
        const cut = () => {
          aborted.push(url);
          reject(new Error('aborted'));
        };
        if (init.signal.aborted) cut();
        else init.signal.addEventListener('abort', cut);
      });
    });
    const { promise } = start(f, { options: { signal: controller.signal } });
    await until(() => f.fetch.mock.calls.length === 1 + 2 * f.config.participants, 'the quorum');
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // The seats' requests, and any a reserve made after the cut.
    expect(aborted.length).toBe(f.fetch.mock.calls.length - 1);
    expect(aborted.length).toBeGreaterThanOrEqual(2 * f.config.participants);
  });

  test('a pre-aborted check spawns nothing', async () => {
    const f = checkpointFixture();
    const controller = new AbortController();
    controller.abort();
    const { promise, fake } = start(f, { options: { signal: controller.signal } });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.children).toEqual([]);
  });

  test('the 90 s deadline: unavailable, the process stopped first', async () => {
    const f = checkpointFixture();
    let armed = null;
    const { promise, fake } = start(f, {
      script: { checkpoint: () => {} },
      extra: {
        // The check's own deadline, brought forward.
        setTimer: (fn, ms) => {
          armed = ms;
          return setTimeout(fn, 50);
        },
        clearTimer: clearTimeout,
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    expect(armed).toBe(DEADLINE_MS);
    expect(fake.children[0].exited).toBe(true);
  });
});

describe('diagnostics', () => {
  test("the quorum's, validated as the worker's: allowlisted fields, a throwing listener vetoes nothing, none after the check", async () => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) =>
      url.startsWith(f.config.sources[0])
        ? Promise.resolve(new Response('<html>secret upstream response</html>'))
        : original(url)
    );
    const diagnostics = [];
    const onDiagnostic = (value) => {
      diagnostics.push(value);
      throw new Error('logging failed');
    };
    const { promise } = start(f, { options: { onDiagnostic } });
    await expect(promise).resolves.toMatchObject({ sources: f.config.sources.slice(1) });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        chainId: 100,
        source: f.config.sources[0],
        outcome: 'CHECKPOINT_UNAVAILABLE',
        failure: 'invalid-json',
        stage: 'block-root',
      })
    );
    for (const value of diagnostics) {
      expect(Object.keys(value).every((key) =>
        ['chainId', 'source', 'slot', 'outcome', 'elapsedMs', 'stage', 'failure', 'httpStatus'].includes(key)
      )).toBe(true);
    }
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
  });
});

// The evidence policy, its authorities, prover and verifier scripted
// (test/helpers/checkpoint-fixture.js): each case a check through a fresh
// fake process.
describe('checkpoint proof/finality policy', () => {
  /** One check of `f` on `chainId` through a fresh fake process. */
  const check = (f, chainId = f.chainId) => {
    const { dependencies } = f.colibrid();
    return acquireColibridCheckpoint(
      chainId,
      { onDiagnostic: f.dependencies.onDiagnostic },
      dependencies
    );
  };

  test.each([1, 100])(
    'requires exact checkpoint and explicit finality for chain %i',
    async (chainId) => {
      const f = checkpointFixture(chainId);
      const result = await check(f, chainId);
      expect(result).toEqual({
        schemaVersion: 2,
        chainId,
        network: f.config.network,
        root: headerRoot(f.header),
        slot: f.slot,
        sources: f.config.sources.slice(0, f.config.participants),
        verifiedAt: NOW,
        finalizedEpoch: f.slot / f.config.slotsPerEpoch,
      });
      expect(f.decodeProof).toHaveBeenCalledWith(f.verifyBytes);
      const proofRequest = f.fetch.mock.calls.find(([url]) => url === f.config.prover);
      expect(JSON.parse(proofRequest[1].body)).toEqual({
        method: 'eth_getBlockByNumber',
        params: ['latest', false],
        // The service's pinned version (3.0.3).
        version: 196611,
        zk_proof: true,
      });
      expect(f.fetch).toHaveBeenCalledTimes(1 + 2 * f.config.participants);
      // The quorum's GETs refuse redirects; the proof POST is the
      // executor's, which follows none (`manual`, refused there).
      for (const [url, options] of f.fetch.mock.calls) {
        expect(options.redirect).toBe(url === f.config.prover ? 'manual' : 'error');
      }
    }
  );

  test('a decoded proof with an invalid signature is a mismatch', async () => {
    const f = checkpointFixture();
    f.failVerification(new Error('invalid zk_proof!'));
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
    expect(f.decodeProof).toHaveBeenCalledTimes(1);
  });

  test('service outage remains unavailable even when Colibri wraps the fetch error', async () => {
    const f = checkpointFixture();
    f.fetch.mockImplementation(async (url) => {
      if (url === f.config.prover) return new Response('proof');
      throw new Error('offline');
    });
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test.each(['{"error":"busy"}', '<html>Maintenance</html>', 'malformed proof'])(
    'an undecodable HTTP-200 prover body is unavailable: %s',
    async (body) => {
      const f = checkpointFixture();
      f.fetch.mockResolvedValue(new Response(body));
      f.decodeProof.mockRejectedValue(new Error('Unknown proof format'));
      await expect(check(f, 1)).rejects.toMatchObject({
        code: 'CHECKPOINT_UNAVAILABLE',
      });
      expect(f.verifyBytes).toBeUndefined();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    ['root', '<html>Maintenance</html>'],
    ['root', '{"error":"busy"}'],
    ['root', '{"data":{"root":"truncated"}}'],
    ['finality', '<html>Maintenance</html>'],
    ['finality', 'null'],
    ['finality', '{"data":{"finalized":{"epoch":"bad","root":"bad"}}}'],
  ])('malformed authority %s response is unavailable: %s', async (endpoint, body) => {
    const f = checkpointFixture();
    const originalFetch = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(async (url) => {
      if (url !== f.config.prover && (url.endsWith('finality_checkpoints') === (endpoint === 'finality'))) {
        return new Response(body);
      }
      return originalFetch(url);
    });
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('successful verification without a trust lookup is an incompatible runtime', async () => {
    const f = checkpointFixture();
    f.verifier.run = async () => ({ number: '0x1' });
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_INCOMPATIBLE',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('quorum evidence refused during interception is never verified as success', async () => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(async (url) => {
      if (url !== f.config.prover && !url.endsWith('finality_checkpoints')) {
        return new Response(JSON.stringify({ execution_optimistic: true, data: { root: headerRoot(f.header) } }));
      }
      return original(url);
    });
    // A verifier could swallow the lookup's failure and still report a
    // verified proof; the recorded transport error must still decide.
    f.verifier.run = async (lookup) => {
      try {
        await lookup(`eth/v1/beacon/blocks/${f.slot}/root`);
      } catch {
        /* swallowed by the verifier */
      }
      return { number: '0x1' };
    };
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test('a lookup other than the root is never sent, and is a mismatch', async () => {
    const f = checkpointFixture();
    // The interception admits the root path alone; the service's contract,
    // the `checkpoint_root` variant alone.
    f.verifier.rootPath = 'eth/v1/beacon/states/head/finality_checkpoints';
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('a later finalized root is retryable, not reported as a proof conflict', async () => {
    const f = checkpointFixture();
    f.finality.data.finalized.epoch = String(Number(f.finality.data.finalized.epoch) + 1);
    f.finality.data.finalized.root = '0x' + '99'.repeat(32);
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('conflicting root at the same finalized epoch fails as mismatch', async () => {
    const f = checkpointFixture();
    f.finality.data.finalized.root = '0x' + '99'.repeat(32);
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test.each([[true, 'CHECKPOINT_QUORUM_CONFLICT'], ['false', 'CHECKPOINT_QUORUM_UNAVAILABLE']])(
    'optimistic or mistyped metadata %p is not accepted',
    async (value, code) => {
      const f = checkpointFixture();
      f.finality.execution_optimistic = value;
      await expect(check(f, 1)).rejects.toMatchObject({ code });
    }
  );

  test('missing modern committee-binding variant is rejected', async () => {
    const f = checkpointFixture();
    delete f.decoded.sync_data.checkpoint.aggregate_pubkey;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
  });

  test('a root fetched at a different slot cannot authorize the header', async () => {
    const f = checkpointFixture();
    f.verifier.rootPath = 'eth/v1/beacon/blocks/' + (f.slot - 1) + '/root';
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
  });

  test('one-hour age is enforced even if proof verification succeeds', async () => {
    const f = checkpointFixture();
    f.dependencies.now = () => NOW + MAX_AGE_MS;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_STALE',
    });
  });

  test('a future checkpoint fails as clock mismatch', async () => {
    const f = checkpointFixture();
    f.dependencies.now = () => (f.config.genesis + f.slot * f.config.secondsPerSlot) * 1000 - 1;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_CLOCK',
    });
  });

  test('a finalized epoch in the future is rejected', async () => {
    const f = checkpointFixture();
    f.finality.data.finalized.epoch = String(Number(f.finality.data.finalized.epoch) + 100);
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_CLOCK',
    });
  });


  test.each([0, 1, 2])('Ethereum recovers with authority %i offline', async (index) => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url.startsWith(f.config.sources[index])
      ? Promise.reject(new Error('offline')) : original(url));
    const result = await check(f, 1);
    expect(result.sources).toEqual(f.config.sources.slice(0, 3).filter((_, i) => i !== index));
  });

  test.each([0, 1, 2])('Gnosis verifies with authority %i offline, including historical Beacon votes', async (index) => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    const diagnostics = [];
    f.dependencies.onDiagnostic = value => diagnostics.push(value);
    f.fetch.mockImplementation(url => {
      if (url.startsWith(f.config.sources[index])) return Promise.resolve(new Response('down', { status: 503 }));
      if (url.startsWith(f.config.sources[2]) && url.endsWith('finality_checkpoints')) {
        return Promise.resolve(new Response(JSON.stringify({ finalized: false, execution_optimistic: false,
          data: { finalized: { epoch: String(f.slot / 16 + 1), root: '0x' + '99'.repeat(32) } },
        })));
      }
      return original(url);
    });
    const result = await check(f, 100);
    expect(result.sources).toEqual(f.config.sources.filter((_, i) => i !== index));
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/slots'))).toBe(false);
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: f.config.sources[index],
      outcome: 'CHECKPOINT_UNAVAILABLE', stage: 'block-root', failure: 'http', httpStatus: 503 }));
    expect(diagnostics.filter(value => value.outcome === 'vote')).toHaveLength(2);
  });

  test.each([
    [{}, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: true }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: false, execution_optimistic: false }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: 'true', execution_optimistic: false }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: true, execution_optimistic: true }, 'CHECKPOINT_QUORUM_CONFLICT'],
    [{ finalized: true, execution_optimistic: 'false' }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
  ])('Beacon root flags %j cannot vote without explicit finality and execution verification', async (flags, code) => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(url => {
      if (url.startsWith(f.config.sources[1])) return Promise.reject(new Error('offline'));
      if (url.startsWith(f.config.sources[2]) && url.endsWith('/root')) {
        return Promise.resolve(new Response(JSON.stringify({ ...flags, data: { root: headerRoot(f.header) } })));
      }
      return original(url);
    });
    await expect(check(f, 100)).rejects.toMatchObject({ code });
  });

  test.each(['same-epoch-conflict', 'behind', 'future'])('Beacon finalized flag cannot bypass %s', async variant => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(url => {
      if (url.startsWith(f.config.sources[1])) return Promise.reject(new Error('offline'));
      if (url.startsWith(f.config.sources[2]) && url.endsWith('finality_checkpoints')) {
        return Promise.resolve(new Response(JSON.stringify({ data: { finalized: {
          epoch: String(f.slot / 16 + (variant === 'behind' ? -1 : variant === 'future' ? 100 : 0)),
          root: '0x' + '99'.repeat(32),
        } } })));
      }
      return original(url);
    });
    await expect(check(f, 100)).rejects.toMatchObject({
      code: variant === 'same-epoch-conflict' ? 'CHECKPOINT_QUORUM_CONFLICT' : 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('a Gnosis quorum containing PublicNode cannot bypass an invalid Colibri proof', async () => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(url => url.startsWith(f.config.sources[0])
      ? Promise.reject(new Error('offline')) : original(url));
    f.failVerification(new Error('invalid proof'));
    await expect(check(f, 100)).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
  });

  test('malformed source JSON has bounded diagnostics; diagnostic failure cannot veto other votes', async () => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    const diagnostics = [];
    f.dependencies.onDiagnostic = value => { diagnostics.push(value); throw new Error('logging failed'); };
    f.fetch.mockImplementation(url => url.startsWith(f.config.sources[0])
      ? Promise.resolve(new Response('<html>secret upstream response</html>')) : original(url));
    await expect(check(f, 100)).resolves.toMatchObject({ sources: f.config.sources.slice(1) });
    expect(diagnostics).toContainEqual(expect.objectContaining({ failure: 'invalid-json', stage: 'block-root' }));
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
  });

  test.each([1, 100])('chain %i never accepts one vote', async (chainId) => {
    const f = checkpointFixture(chainId);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url === f.config.prover || url.startsWith(f.config.sources[0])
      ? original(url) : Promise.reject(new Error('offline')));
    await expect(check(f, chainId)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test.each([1, 100])('chain %i distinguishes an actual split from missing votes', async (chainId) => {
    const f = checkpointFixture(chainId);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (url.startsWith(f.config.sources[1])) {
        return Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
          ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32) } } }
          : { data: { root: '0x' + '99'.repeat(32) } })));
      }
      if (f.config.sources.slice(2).some((source) => url.startsWith(source))) return Promise.reject(new Error('offline'));
      return original(url);
    });
    await expect(check(f, chainId)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
  });

  test('two unavailable original candidates are replaced from the wider pool', async () => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => f.config.sources.slice(0, 2).some((source) => url.startsWith(source))
      ? Promise.reject(new Error('offline')) : original(url));
    const result = await check(f, 1);
    expect(result.sources).toEqual(f.config.sources.slice(2, 5));
    const contacted = new Set(f.fetch.mock.calls.filter(([url]) => url !== f.config.prover).map(([url]) => new URL(url).origin));
    expect([...contacted]).toEqual(f.config.sources.slice(0, 5));
  });

  test('exhausts all seven candidates without accepting a lone vote', async () => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url === f.config.prover || url.startsWith(f.config.sources[6])
      ? original(url) : Promise.reject(new Error('offline')));
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_UNAVAILABLE' });
    expect(new Set(f.fetch.mock.calls.filter(([url]) => url !== f.config.prover).map(([url]) => new URL(url).origin)).size).toBe(7);
  });

  test('three disagreeing participants are never replaced by agreeable reserves', async () => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      const index = f.config.sources.findIndex((source) => url.startsWith(source));
      if (index < 0 || index > 2) return original(url);
      const root = '0x' + String(index + 1).repeat(64);
      return Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
        ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root } } }
        : { data: { root } })));
    });
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect(f.fetch.mock.calls.some(([url]) => f.config.sources.slice(3).some((source) => url.startsWith(source)))).toBe(false);
  });

  test('retains a dissenting vote while replacing an unavailable participant', async () => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (url.startsWith(f.config.sources[0])) return Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
        ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32) } } }
        : { data: { root: '0x' + '99'.repeat(32) } })));
      if (url.startsWith(f.config.sources[1])) return Promise.reject(new Error('offline'));
      return original(url);
    });
    expect((await check(f, 1)).sources).toEqual(f.config.sources.slice(2, 4));
    expect(f.fetch).toHaveBeenCalledTimes(9);
  });

  test('contradictory evidence occupies a seat and is not discarded for a reserve', async () => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (f.config.sources.slice(0, 2).some((source) => url.startsWith(source)) && url.endsWith('finality_checkpoints')) {
        return Promise.resolve(new Response(JSON.stringify({ data: { finalized: {
          epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32),
        } } })));
      }
      return original(url);
    });
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  test('two matching Ethereum votes tolerate one dissenting authority', async () => {
    const f = checkpointFixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url.startsWith(f.config.sources[0])
      ? Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
        ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32) } } }
        : { data: { root: '0x' + '99'.repeat(32) } }))) : original(url));
    const result = await check(f, 1);
    expect(result.sources).toEqual(f.config.sources.slice(1, 3));
  });

  test('aligned finalized history permits different latest epochs without comparing unrelated roots', async () => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (!url.startsWith(f.config.sources[1])) return original(url);
      if (url.endsWith('finality_checkpoints')) return Promise.resolve(new Response(JSON.stringify({
        data: { finalized: { epoch: String(f.slot / 16 + 1), root: '0x' + '99'.repeat(32) } },
      })));
      if (url.endsWith('/slots')) return Promise.resolve(new Response(JSON.stringify({ data: { slots: [
        { slot: String(f.slot), block_root: headerRoot(f.header) },
      ] } })));
      return original(url);
    });
    await expect(check(f, 100)).resolves.toMatchObject({ sources: f.config.sources.slice(0, f.config.participants) });
  });

  test.each(['missing', 'conflicting', 'duplicate'])('finalized history %s never supplies a vote', async (variant) => {
    const f = checkpointFixture(100);
    const original = f.fetch.getMockImplementation();
    const entry = { slot: f.slot, block_root: headerRoot(f.header) };
    f.fetch.mockImplementation((url) => {
      if (url.startsWith(f.config.sources[2])) return Promise.reject(new Error('offline'));
      if (!url.startsWith(f.config.sources[1])) return original(url);
      if (url.endsWith('finality_checkpoints')) return Promise.resolve(new Response(JSON.stringify({
        data: { finalized: { epoch: String(f.slot / 16 + 1), root: '0x' + '99'.repeat(32) } },
      })));
      if (url.endsWith('/slots')) return Promise.resolve(new Response(JSON.stringify({ data: { slots:
        variant === 'missing' ? [] : variant === 'duplicate' ? [entry, entry] : [{ ...entry, block_root: '0x' + '99'.repeat(32) }],
      } })));
      return original(url);
    });
    await expect(check(f, 100)).rejects.toMatchObject({
      code: variant === 'missing' ? 'CHECKPOINT_QUORUM_UNAVAILABLE' : 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test('repeated Colibri lookups reuse votes, not extra voter identities', async () => {
    const f = checkpointFixture(100);
    const once = f.verifier.run;
    f.verifier.run = async (lookup) => {
      await once(lookup);
      return once(lookup);
    };
    await check(f, 100);
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  test('all authorities agreeing cannot override invalid Colibri proof', async () => {
    const f = checkpointFixture();
    f.failVerification(new Error('invalid zk proof'));
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  test.each(['1', 11155111])(
    'wrong chain configuration %p is rejected before any fetch',
    async (chainId) => {
      const f = checkpointFixture();
      await expect(check(f, chainId)).rejects.toMatchObject({
        code: 'CHECKPOINT_MISMATCH',
      });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.decodeProof).not.toHaveBeenCalled();
    }
  );
});

// The real binary, at each capture's clock: offline (main answers every
// fetch from the capture), and deterministic.
const realBinary = process.env.FREEDOM_COLIBRID_PATH || getColibridBinaryPath();
const describeReal = fs.existsSync(realBinary) ? describe : describe.skip;

describeReal('captured proofs through the real freedom-colibrid', () => {
  const capture = (network) =>
    path.resolve(__dirname, '../../../docs/audits/evidence/colibri-v3-2026-09/captures', network);
  const legacyProof = (network) =>
    fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../docs/audits/evidence/myotis-recovery-spike-2026-09/captures',
        `${network}-finalized`,
        'proof.ssz'
      )
    );

  beforeEach(() => {
    os.setPriority.mockRestore?.();
  });

  /** A check of `chainId` through the real process: the quorum's GETs from
   * `fetch`, the proof POSTed through the hop answered `bytes`, at `now`;
   * its record, or its error's class. */
  function realCheck(chainId, { bytes, now, fetch }) {
    return acquireColibridCheckpoint(
      chainId,
      {},
      {
        command: realBinary,
        serviceVersion: process.env.FREEDOM_COLIBRID_PATH ? null : PINNED_COLIBRID_VERSION,
        shellVersion: 'test',
        fetch,
        hop: makeHop({
          fetch: async (url, init) => {
            if (init.method !== 'POST') throw new Error(`Unexpected ${init.method} ${url}`);
            return new Response(bytes);
          },
        }),
        fetchPool: new ColibriFetchPool(),
        now: () => now,
        log: quietLog,
      }
    ).then(
      (value) => value,
      (error) => error.code
    );
  }

  test('the Gnosis recovery capture needs PublicNode\'s finality with Gnosis Checkpointz offline; a flipped proof is a mismatch', async () => {
    const dir = path.resolve(__dirname, '../../../docs/audits/evidence/gnosis-recovery-2026-09/capture');
    const original = JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json')));
    const proof = fs.readFileSync(path.join(dir, 'proof.ssz'));
    const responses = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json')));
    const fetch = (stripFinality) => async (url) => {
      if (!responses[url]) throw new Error('Provider offline in capture');
      const body = JSON.parse(responses[url].body);
      if (
        stripFinality &&
        url.startsWith('https://gnosis-beacon-api.publicnode.com/') &&
        url.endsWith('/root')
      ) {
        delete body.finalized;
      }
      return new Response(JSON.stringify(body), { status: responses[url].status });
    };
    const at = { bytes: proof, now: original.verifiedAt };

    expect(await realCheck(100, { ...at, fetch: fetch(false) })).toEqual(original);
    expect(await realCheck(100, { ...at, fetch: fetch(true) })).toBe(
      'CHECKPOINT_QUORUM_UNAVAILABLE'
    );
    const flipped = Buffer.from(proof);
    flipped[flipped.length - 1] ^= 1;
    expect(await realCheck(100, { ...at, bytes: flipped, fetch: fetch(false) })).toBe(
      'CHECKPOINT_MISMATCH'
    );
  }, 60_000);

  test.each(['mainnet', 'gnosis'])(
    '%s: the recorded checkpoint verifies; a flipped proof is a mismatch, a stale one stale, a legacy or malformed one unavailable, another chain refused',
    async (network) => {
      const dir = capture(network);
      const original = JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json')));
      const proof = fs.readFileSync(path.join(dir, 'proof.ssz'));
      const responses = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json')));
      const lookups = [];
      // The quorum's GETs, from the capture; any other is a test failure.
      const captured = async (url) => {
        const response = responses[url];
        if (!response) throw new Error(`Uncaptured request: ${url}`);
        return new Response(response.body, { status: response.status });
      };
      // The same metadata for any chain's authorities: a rejection must not
      // come from a missing fixture.
      const anyChain = async (url) => {
        const entry = Object.entries(responses).find(
          ([recorded]) => new URL(recorded).pathname === new URL(url).pathname
        );
        if (!entry) throw new Error(`Uncaptured request: ${url}`);
        return new Response(entry[1].body, { status: entry[1].status });
      };
      const check = (
        bytes,
        { now = original.verifiedAt, chainId = original.chainId, fetch = captured } = {}
      ) =>
        realCheck(chainId, {
          bytes,
          now,
          fetch: (url, init) => {
            lookups.push(url);
            return fetch(url, init);
          },
        });

      const good = await check(proof);
      expect(good).toEqual({
        schemaVersion: 2,
        chainId: original.chainId,
        network,
        root: original.root,
        slot: original.slot,
        verifiedAt: original.verifiedAt,
        sources: original.sources,
        finalizedEpoch: original.finalizedEpoch,
      });
      expect(lookups.some((url) => url.endsWith(`/eth/v1/beacon/blocks/${original.slot}/root`))).toBe(true);

      const flipped = Buffer.from(proof);
      flipped[flipped.length - 1] ^= 1;
      expect(await check(flipped)).toBe('CHECKPOINT_MISMATCH');
      // Two minutes on, the proof's latest block is past the freshness bound.
      expect(await check(proof, { now: original.verifiedAt + 120_000 })).toBe('CHECKPOINT_STALE');
      expect(await check(legacyProof(network))).toBe('CHECKPOINT_UNAVAILABLE');
      for (const body of ['{"error":"busy"}', '<html>Maintenance</html>', 'malformed proof']) {
        expect(await check(Buffer.from(body))).toBe('CHECKPOINT_UNAVAILABLE');
      }
      // Wrong-network metadata may fail the quorum's clock check first.
      expect(['CHECKPOINT_MISMATCH', 'CHECKPOINT_CLOCK']).toContain(
        await check(proof, { chainId: original.chainId === 1 ? 100 : 1, fetch: anyChain })
      );
      expect(CHECKPOINT_NETWORKS[original.chainId].network).toBe(network);
    },
    120_000
  );
});
