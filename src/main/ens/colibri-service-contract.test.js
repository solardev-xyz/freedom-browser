/**
 * Colibri's contract on freedom-colibrid (freedom-core design 0014):
 * colibri-service.js on the real binary, against a scripted prover on
 * loopback (test/helpers/colibri-service-harness.js). What the service
 * answers there, and how its processes come and go, is the interface the
 * WASM worker host kept until COL-6 removed it: a chain's lanes, a failed
 * remote proof byte for byte, a refusal, a death, the private session,
 * `destroy`. An expectation that differs from the reference's by design
 * names its deviation, and says what the reference did. The service's own
 * mechanics are colibri-service.test.js's and colibrid-client.test.js's.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

jest.mock('../logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { isColibriFault } = require('../core/chain-verified');
const { ColibriWorkerError } = require('./colibri-outcome');
const {
  PROVER_DOWN,
  describeService,
  outcomeOf,
  proverWorld,
  startService,
} = require('../../../test/helpers/colibri-service-harness');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a promise has come to: its result, its error, or `'open'`. */
const settledOf = (promise) => {
  const state = { value: 'open' };
  promise.then(
    (result) => {
      state.value = { result };
    },
    (err) => {
      state.value = err;
    }
  );
  return state;
};

describeService('the Colibri contract on freedom-colibrid', () => {
  const ACCOUNT = '0x00000000000000000000000000000000000000aa';
  const BALANCE = { method: 'eth_getBalance', params: [ACCOUNT, 'latest'] };
  const CODE = { method: 'eth_getCode', params: [ACCOUNT, 'latest'] };
  /** The prover request the service sends first for BALANCE, as the
   * reference did, with an empty store: the account's proof, at Colibri's
   * version, with ZK. */
  const BALANCE_PROOF =
    `{"method":"eth_getProof","params":["${ACCOUNT}",[],"latest"],` +
    '"version":196611,"zk_proof":true}';
  /** createError's message for a failed remote proof (#1059, #1080). */
  const failedProof = ({ method, params }, text) =>
    `Error in rpc call ${method}${JSON.stringify(params)} : ` +
    `remote proof failed (no local proving): ${text}`;
  const outage = (read, text = 'HTTP error! Status: 503, Details: prover down') => ({
    name: 'ProviderRpcError',
    code: 4900,
    message: failedProof(read, text),
    data: undefined,
  });

  let userData;
  let world;
  let started;
  const config = (extra) => ({ chainId: 1, proverUrl: world.url, zkProof: true, ...extra });
  const client = (extra) => started.host.createClient(config(extra));
  const lanes = () => started.spawned.map((proc) => (proc.private ? 'private' : 'normal'));

  beforeEach(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-contract-'));
    world = await proverWorld();
    started = await startService({ userData });
  });

  afterEach(async () => {
    world.release();
    await started.close();
    await world.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test("a chain's clients share its process; another chain gets its own [deviation storage-per-chain]", async () => {
    await expect(client().request(BALANCE).catch(outcomeOf)).resolves.toEqual(outage(BALANCE));
    await expect(client().request(CODE).catch(outcomeOf)).resolves.toEqual(outage(CODE));
    expect(lanes()).toEqual(['normal']);
    await expect(client({ chainId: 100 }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
      outage(BALANCE)
    );
    // The reference's workers shared `<userData>/colibri`.
    const store = path.join(userData, 'colibri');
    expect(started.spawned.map((proc) => proc.storageDir)).toEqual([
      path.join(store, '1'),
      path.join(store, '100'),
    ]);
    expect(world.requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'POST']);
  });

  // #1059: the prover's error is the whole answer, never a local proof, and
  // the adapter's outcome is the reference's, cut at 2,000 units after
  // createError's prefix.
  test.each([
    ['a short body', 'prover down'],
    ['a body that is not ASCII', 'Überlastet – 稍后再试 🙂'],
    ['a body that takes the message past 2,000 units', 'x'.repeat(1_900)],
    ['a body past 2,000 units of its own', 'y'.repeat(2_500)],
  ])('a failed remote proof with %s reaches the caller byte for byte', async (_label, body) => {
    world.answer = { status: 503, body };
    const message = failedProof(BALANCE, `HTTP error! Status: 503, Details: ${body}`);
    await expect(client().request(BALANCE).catch(outcomeOf)).resolves.toEqual({
      ...outage(BALANCE),
      message: message.slice(0, 2_000),
    });
    expect(world.requests.map(({ body: sent }) => sent)).toEqual([BALANCE_PROOF]);
  });

  test('a transport failure is no HTTP error [deviation fetch-error-text]', async () => {
    world.answer = 'transport';
    const err = await client().request(BALANCE).catch((caught) => caught);
    // The reference named the prover's URL where the service writes `<url>`.
    expect(outcomeOf(err)).toEqual({
      ...outage(BALANCE),
      code: -32603,
      message: failedProof(BALANCE, `Request to <url> with payload ${BALANCE_PROOF} failed: fetch failed`),
    });
    expect(isColibriFault(err)).toBe(false);
  });

  test('a method neither serves is refused before any fetch', async () => {
    const read = { method: 'eth_unknownMethod', params: [{}] };
    await expect(client().request(read).catch(outcomeOf)).resolves.toEqual({
      name: 'ProviderRpcError',
      code: 4200,
      message: 'Error in rpc call eth_unknownMethod[{}] : Method eth_unknownMethod is not supported',
      data: undefined,
    });
    expect(world.requests).toEqual([]);
  });

  test("a store that can't be opened fails the read, as main's own error [deviation storage-per-chain]", async () => {
    fs.writeFileSync(path.join(userData, 'colibri'), 'not a directory');
    const errors = [];
    for (let i = 0; i < 2; i += 1) {
      const err = await client().request(BALANCE).catch((caught) => caught);
      expect(err).toBeInstanceOf(ColibriWorkerError);
      expect(started.host.ColibriWorkerError).toBe(ColibriWorkerError);
      expect(isColibriFault(err)).toBe(false);
      errors.push(err.message);
    }
    expect(world.requests).toEqual([]);
    // The chain directory can't be made: nothing spawns, and the lane stops
    // until a client of another configuration or the next launch. (Each of
    // the reference's reads spawned a worker, whose store failed to open:
    // `Colibri worker failed to start: init failed (EEXIST …)`.)
    expect({ errors, lanes: lanes() }).toEqual({
      errors: new Array(2).fill('Colibri service unavailable'),
      lanes: [],
    });
    // A private read has no store to open.
    await expect(client({ private: true }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
      outage(BALANCE)
    );
  });

  test('eth_getLogs [deviation colibri-unserved]', async () => {
    const read = { method: 'eth_getLogs', params: [{}] };
    // The reference asked the prover, and failed as it did.
    await expect(client().request(read).catch(outcomeOf)).resolves.toEqual({
      name: 'ProviderRpcError',
      code: 4200,
      message: 'Error in rpc call eth_getLogs[{}] : Method eth_getLogs is not supported',
      data: undefined,
    });
    expect(world.requests).toEqual([]);
  });

  test('eth_chainId [deviation colibri-unserved]', async () => {
    const read = { method: 'eth_chainId', params: [] };
    const answer = await client()
      .request(read)
      .then((result) => ({ result }), outcomeOf);
    // The reference answered `0x1` from its configuration.
    expect(answer).toEqual({
      name: 'ProviderRpcError',
      code: 4200,
      message: 'Error in rpc call eth_chainId[] : Method eth_chainId is not supported',
      data: undefined,
    });
    expect(world.requests).toEqual([]);
  });

  test('a request still waiting on the prover at its deadline [deviation colibri-deadline]', async () => {
    world.answer = 'hold';
    const reader = client();
    const state = settledOf(reader.request(BALANCE, { deadlineMs: 300 }));
    await world.until(1);
    // The reference's worker answered its ping, so it kept the request until
    // the prover answered (or 60 s past the deadline).
    while (state.value === 'open') await sleep(5);
    // Two answers race at the deadline: main's cancel (`cancelled`), and the
    // service's own bound on its fetch, whose error the C core gets as the
    // remote proof's and ends the read with. Main decides (design 0014's one
    // outcome at the deadline): any reply but a result read at or after the
    // deadline is the cancel's, no fault, ending nothing else.
    expect(outcomeOf(state.value)).toEqual({
      name: 'ColibriWorkerError',
      code: undefined,
      message: 'Colibri request cancelled at its deadline',
      data: undefined,
    });
    expect(state.value.colibriBystander).toBeUndefined();
    expect(isColibriFault(state.value)).toBe(false);
    // Nothing else ended: the same process serves the next read.
    world.answer = PROVER_DOWN;
    await expect(reader.request(CODE).catch(outcomeOf)).resolves.toEqual(outage(CODE));
    expect(lanes()).toEqual(['normal']);
  }, 15_000);

  test('a process that dies under open requests [deviation colibri-culprit]', async () => {
    world.answer = 'hold';
    const first = settledOf(client().request(BALANCE, { deadlineMs: 20_000 }));
    const second = settledOf(client().request(CODE, { deadlineMs: 20_000 }));
    await world.until(2);
    world.answer = PROVER_DOWN;
    started.spawned[0].kill();
    await started.spawned[0].exited;
    while (first.value === 'open' || second.value === 'open') await sleep(5);
    // Waiting on a fetch, neither was in a step: the death names nobody, and
    // both go once more to the lane's next process. (The reference failed
    // each as its own fault, `Colibri worker replaced: worker exited (1)`.)
    expect(outcomeOf(first.value)).toEqual(outage(BALANCE));
    expect(outcomeOf(second.value)).toEqual(outage(CODE));
    expect([first.value, second.value].map(isColibriFault)).toEqual([false, false]);
    expect(lanes()).toEqual(['normal', 'normal']);
  }, 15_000);

  test('a fourth chain while three are busy [deviation colibri-processes]', async () => {
    world.answer = 'hold';
    const busy = [1, 100, 11155111].map((chainId) =>
      settledOf(client({ chainId }).request(BALANCE, { deadlineMs: 20_000 }))
    );
    await world.until(3);
    const fourth = settledOf(client({ chainId: 10200 }).request(BALANCE, { deadlineMs: 20_000 }));
    // At once, with nothing spawned for it. (The reference started a fourth
    // worker.)
    while (fourth.value === 'open') await sleep(5);
    expect(started.spawned).toHaveLength(3);
    expect(outcomeOf(fourth.value)).toMatchObject({
      name: 'ColibriWorkerError',
      message: 'Colibri service busy',
    });
    expect(isColibriFault(fourth.value)).toBe(false);
    world.release();
    for (const state of busy) {
      while (state.value === 'open') await sleep(5);
    }
    for (const state of busy) expect(outcomeOf(state.value)).toEqual(outage(BALANCE));
  }, 15_000);

  test("a destroyed client's requests are refused", async () => {
    const reader = client();
    await expect(reader.request(BALANCE).catch(outcomeOf)).resolves.toEqual(outage(BALANCE));
    reader.destroy();
    await expect(reader.request(BALANCE)).rejects.toMatchObject({
      name: 'ColibriWorkerError',
      message: 'Colibri client was destroyed',
    });
    expect(world.requests).toHaveLength(1);
  });

  // #1058: Colibri's store names what a read touched, so private windows'
  // reads run on a process of their own whose store is in memory.
  describe('private windows', () => {
    test('a private client runs on the private process, which has no store', async () => {
      await expect(client().request(BALANCE).catch(outcomeOf)).resolves.toEqual(outage(BALANCE));
      await expect(client({ private: true }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
        outage(BALANCE)
      );
      // Every private client of the chain shares it; a normal one keeps the
      // normal process.
      await expect(client({ private: true }).request(CODE).catch(outcomeOf)).resolves.toEqual(
        outage(CODE)
      );
      await expect(client().request(CODE).catch(outcomeOf)).resolves.toEqual(outage(CODE));
      expect(lanes()).toEqual(['normal', 'private']);
      expect(started.spawned[1].storageDir).toBeNull();
    });

    test('ensureWorker readies the private process only when asked for it', async () => {
      await expect(started.host.ensureWorker(1, { private: true })).resolves.toBeUndefined();
      expect(lanes()).toEqual(['private']);
      await expect(started.host.ensureWorker(1)).resolves.toBeUndefined();
      expect(lanes()).toEqual(['private', 'normal']);
    });

    test('the end of the private session ends the private process only', async () => {
      world.answer = 'hold';
      const normal = settledOf(client().request(BALANCE, { deadlineMs: 20_000 }));
      const privateReader = client({ private: true });
      const pending = settledOf(privateReader.request(BALANCE, { deadlineMs: 20_000 }));
      await world.until(2);

      started.host.endPrivateSession();
      await started.spawned[1].exited;
      while (pending.value === 'open') await sleep(5);
      // Nobody's fault: a bystander, which the router's backoff skips.
      expect(pending.value).toMatchObject({
        name: 'ColibriWorkerError',
        message: 'Colibri worker replaced: private session ended',
        colibriBystander: true,
      });
      expect(isColibriFault(pending.value)).toBe(false);
      expect(normal.value).toBe('open');

      // A client of the ended session is refused, and nothing is spawned.
      await expect(privateReader.request(CODE)).rejects.toMatchObject({
        message: 'Colibri private session ended',
        colibriBystander: true,
      });
      expect(lanes()).toEqual(['normal', 'private']);

      world.answer = PROVER_DOWN;
      world.release();
      while (normal.value === 'open') await sleep(5);
      expect(outcomeOf(normal.value)).toEqual(outage(BALANCE));
      // The next private window's first read starts a new private process.
      await expect(client({ private: true }).request(BALANCE).catch(outcomeOf)).resolves.toEqual(
        outage(BALANCE)
      );
      expect(lanes()).toEqual(['normal', 'private', 'private']);
    });

    test('a private process still starting when the session ends fails its waiter as a bystander', async () => {
      const pending = client({ private: true }).request(BALANCE);
      started.host.endPrivateSession();
      await expect(pending).rejects.toMatchObject({
        message: 'Colibri private session ended',
        colibriBystander: true,
      });
      expect(world.requests).toEqual([]);
    });
  });
});
