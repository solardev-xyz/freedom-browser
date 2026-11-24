/**
 * The checkpoint check through freedom-colibrid's one-shot process
 * (`checkpoint-colibrid.js`, freedom-core design 0014, COL-5):
 * - the protocol paths, against test/helpers/fake-colibrid.js: the process
 *   and its one call, main's fetches for it (the proof once, HTTP 200 only;
 *   the roots from the quorum, memoized per slot, at most 8; everything
 *   else refused, nothing sent), every outcome's class, the bound of two
 *   checks, the 90 s deadline, an abort that settles once the process has
 *   exited, the diagnostics;
 * - the captured proofs (docs/audits/evidence/colibri-v3-2026-09/captures)
 *   through the real binary at each capture's clock, when there is one
 *   (`FREEDOM_COLIBRID_PATH`, or `npm run colibrid:download`'s
 *   freedom-colibrid-bin/; skipped otherwise): the recorded checkpoint, a
 *   flipped proof a mismatch, a stale one stale, a legacy or malformed one
 *   unavailable.
 * The evidence cases run on both paths in checkpoint-verifier-worker.test.js.
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
const { CHECKPOINT_NETWORKS, DEADLINE_MS } = require('./checkpoint-verifier');
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
        decode: (bytes) => f.runtime.decode_proof(bytes),
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
      expect(f.runtime.decode_proof).not.toHaveBeenCalled();
    }
  );

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
            decode: (bytes) => f.runtime.decode_proof(bytes),
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
    f.runtime.decode_proof.mockRejectedValue(new Error('Unknown proof format'));
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
