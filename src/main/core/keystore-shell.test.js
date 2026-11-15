/**
 * Main's `shell.keystore` executor (freedom-core design 0013, PRF-2): the
 * request's form, the helper's argv, stdin and environment, its deadlines,
 * one run at a time, and the answer relayed as received within 4 KiB. The
 * helpers here are stand-in scripts: the real one, against a temporary
 * macOS keychain, is keystore.integration.test.js's.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { JsonText, ShellError, scrubbedEnv } = require('./service-client');
const {
  DEADLINES_MS,
  KEYSTORE_PLATFORMS,
  MAX_ANSWER_BYTES,
  answerLine,
  checkRequest,
  createHelperRunner,
  hasKeystoreBackend,
  helperArgs,
  registerKeystoreShell,
} = require('./keystore-shell');

const posix = process.platform === 'win32' ? describe.skip : describe;

const ITEM = '00112233445566778899aabbccddeeff';
const REPLY_KEY = Buffer.alloc(32, 7).toString('base64');
const SEALED_KEY = Buffer.alloc(80, 9).toString('base64');

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ShellError);
    return error.code;
  }
  return null;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('resolved');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the request, as the core sends it', () => {
  const good = {
    create: { op: 'create', policy: 'unattended', item: ITEM, reply_key: REPLY_KEY },
    open: {
      op: 'open',
      policy: 'unattended',
      item: ITEM,
      reply_key: REPLY_KEY,
      reason: 'quick_unlock',
    },
    openExport: {
      op: 'open',
      policy: 'unattended',
      item: ITEM,
      reply_key: REPLY_KEY,
      reason: 'export',
    },
    openNoReason: { op: 'open', policy: 'unattended', item: ITEM, reply_key: REPLY_KEY },
    presence: {
      op: 'open',
      policy: 'user_presence',
      item: ITEM,
      reply_key: REPLY_KEY,
      reason: 'quick_unlock',
    },
    forget: { op: 'forget', policy: 'user_presence', item: ITEM },
  };

  test.each(Object.entries(good))('%s is in form', (_, params) => {
    expect(checkRequest(params)).toEqual({
      op: params.op,
      policy: params.policy,
      item: params.item,
      replyKey: params.reply_key,
      reason: params.reason,
    });
  });

  const lastBitsSet = `${REPLY_KEY.slice(0, 42)}B=`;
  const refused = [
    ['null params', null],
    ['an array', []],
    ['a string', 'create'],
    ['an unknown member', { ...good.forget, serves: 1 }],
    [
      '__proto__ as a member',
      JSON.parse(`{"op":"forget","policy":"unattended","item":"${ITEM}","__proto__":{}}`),
    ],
    ['no op', { policy: 'unattended', item: ITEM }],
    ['an unknown op', { ...good.forget, op: 'delete' }],
    ["an op that isn't a string", { ...good.forget, op: ['forget'] }],
    ['no policy', { op: 'forget', item: ITEM }],
    ['an unknown policy', { ...good.forget, policy: 'biometry' }],
    ['no item', { op: 'forget', policy: 'unattended' }],
    ['an uppercase item', { ...good.forget, item: ITEM.toUpperCase() }],
    ['a short item', { ...good.forget, item: ITEM.slice(1) }],
    ['a long item', { ...good.forget, item: `${ITEM}0` }],
    ['an item with a newline', { ...good.forget, item: `${ITEM}\n` }],
    ["an item that isn't a string", { ...good.forget, item: 1 }],
    ['sealed on an open', { ...good.open, sealed: 'AAAA' }],
    ['sealed as null', { ...good.forget, sealed: null }],
    ['a create without reply_key', { op: 'create', policy: 'unattended', item: ITEM }],
    [
      'an open without reply_key',
      { op: 'open', policy: 'unattended', item: ITEM, reason: 'export' },
    ],
    ['a forget with reply_key', { ...good.forget, reply_key: REPLY_KEY }],
    ['reply_key as null', { ...good.create, reply_key: null }],
    [
      'reply_key of 31 bytes',
      { ...good.create, reply_key: Buffer.alloc(31, 7).toString('base64') },
    ],
    [
      'reply_key of 33 bytes',
      { ...good.create, reply_key: Buffer.alloc(33, 7).toString('base64') },
    ],
    ['reply_key unpadded', { ...good.create, reply_key: REPLY_KEY.slice(0, 43) }],
    ['reply_key not canonical', { ...good.create, reply_key: lastBitsSet }],
    ['reply_key in URL-safe base64', { ...good.create, reply_key: `-${REPLY_KEY.slice(1)}` }],
    ['reply_key with a space', { ...good.create, reply_key: ` ${REPLY_KEY.slice(1)}` }],
    ['a reason on a create', { ...good.create, reason: 'export' }],
    ['a reason on a forget', { ...good.forget, reason: 'quick_unlock' }],
    ['an unknown reason', { ...good.open, reason: 'login' }],
    ['a reason as null', { ...good.open, reason: null }],
    ['a user_presence open without a reason', { ...good.presence, reason: undefined }],
  ];

  test.each(refused)('%s is invalid_argument', (_, params) => {
    expect(codeOf(() => checkRequest(params))).toBe('invalid_argument');
  });

  test('the non-canonical reply_key decodes to 32 bytes: only the round trip refuses it', () => {
    expect(Buffer.from(lastBitsSet, 'base64')).toHaveLength(32);
  });
});

describe("the helper's argv", () => {
  test("each op, in the helper contract's order", () => {
    expect(helperArgs(checkRequest({ op: 'forget', policy: 'unattended', item: ITEM }))).toEqual([
      'keystore',
      '--op',
      'forget',
      '--policy',
      'unattended',
      '--item',
      ITEM,
    ]);
    expect(
      helperArgs(
        checkRequest({ op: 'create', policy: 'user_presence', item: ITEM, reply_key: REPLY_KEY })
      )
    ).toEqual([
      'keystore',
      '--op',
      'create',
      '--policy',
      'user_presence',
      '--item',
      ITEM,
      '--reply-key',
      REPLY_KEY,
    ]);
    expect(
      helperArgs(
        checkRequest({
          op: 'open',
          policy: 'unattended',
          item: ITEM,
          reply_key: REPLY_KEY,
          reason: 'export',
        })
      )
    ).toEqual([
      'keystore',
      '--op',
      'open',
      '--policy',
      'unattended',
      '--item',
      ITEM,
      '--reply-key',
      REPLY_KEY,
      '--reason',
      'export',
    ]);
  });
});

describe('the answer line', () => {
  const line = (text) => answerLine(Buffer.from(text, 'latin1'));

  test('one printable-ASCII JSON object and its newline', () => {
    expect(line('{"ok":true}\n')).toBe('{"ok":true}');
    expect(line('{ "ok" : false, "error":"backend" }\n')).toBe(
      '{ "ok" : false, "error":"backend" }'
    );
    const longest = `{"ok":true,"key":"${'A'.repeat(MAX_ANSWER_BYTES - 20)}"}`;
    expect(longest).toHaveLength(MAX_ANSWER_BYTES);
    expect(line(`${longest}\n`)).toBe(longest);
  });

  test.each([
    ['nothing', ''],
    ['an empty line', '\n'],
    ['no newline', '{"ok":true}'],
    ['two lines', '{"ok":true}\n{"ok":true}\n'],
    ['bytes after the line', '{"ok":true}\nx'],
    ['a carriage return', '{"ok":true}\r\n'],
    ['a tab', '{"ok":\ttrue}\n'],
    ['a byte past ASCII', '{"ok":true,"reason":"\xe9"}\n'],
    ['not JSON', 'ok\n'],
    ['a JSON array', '[{"ok":true}]\n'],
    ['JSON null', 'null\n'],
    ['a JSON string', '"ok"\n'],
    ['one byte past 4 KiB', `{"ok":true,"key":"${'A'.repeat(MAX_ANSWER_BYTES - 19)}"}\n`],
  ])('%s is no answer', (_, text) => {
    expect(line(text)).toBeNull();
  });
});

describe('where the executor runs', () => {
  test('macOS only, until PRF-7', () => {
    expect([...KEYSTORE_PLATFORMS]).toEqual(['darwin']);
    expect(hasKeystoreBackend('darwin')).toBe(true);
    expect(hasKeystoreBackend('linux')).toBe(false);
    expect(hasKeystoreBackend('win32')).toBe(false);
  });

  test.each(['linux', 'win32'])(
    '%s registers no shell.keystore, so the core is answered unknown_method',
    (platform) => {
      const client = { handle: jest.fn() };
      const runner = { run: jest.fn() };
      expect(registerKeystoreShell(client, { runner, platform })).toBe(false);
      expect(client.handle).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    }
  );

  test('macOS registers it; a request out of form runs no helper', async () => {
    const client = { handle: jest.fn() };
    const runner = { run: jest.fn(async () => '{"ok":true}') };
    expect(registerKeystoreShell(client, { runner, platform: 'darwin' })).toBe(true);
    expect(client.handle).toHaveBeenCalledTimes(1);
    const [method, handler] = client.handle.mock.calls[0];
    expect(method).toBe('shell.keystore');

    const signal = new AbortController().signal;
    await expect(
      handler({ op: 'forget', policy: 'unattended', item: ITEM, sealed: 'AAAA' }, { signal })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(runner.run).not.toHaveBeenCalled();

    const result = await handler({ op: 'forget', policy: 'unattended', item: ITEM }, { signal });
    expect(result).toBeInstanceOf(JsonText);
    expect(result.parts).toEqual(['{"ok":true}']);
    expect(runner.run).toHaveBeenCalledWith(
      { op: 'forget', policy: 'unattended', item: ITEM, replyKey: undefined, reason: undefined },
      { signal, fromArrival: true }
    );
  });
});

describe('the deadlines', () => {
  test('60 s for create and open, 10 s for forget', () => {
    expect(DEADLINES_MS).toEqual({ create: 60_000, open: 60_000, forget: 10_000 });
  });

  test("the runner's default deadlines are those", async () => {
    jest.useFakeTimers();
    try {
      const kills = [];
      const spawn = () => {
        const { EventEmitter } = require('events');
        const child = new EventEmitter();
        child.pid = 1;
        child.stdout = new EventEmitter();
        child.kill = (signal) => {
          kills.push(signal);
          setImmediate(() => child.emit('close', null, signal));
        };
        return child;
      };
      const runner = createHelperRunner({ command: 'x', spawn });
      const forget = runner.run({ op: 'forget', policy: 'unattended', item: ITEM });
      const settledForget = forget.catch((error) => error);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(kills).toEqual([]);
      await jest.advanceTimersByTimeAsync(2);
      expect(kills).toEqual(['SIGKILL']);
      expect(await settledForget).toMatchObject({ code: 'timeout' });

      for (const op of ['create', 'open']) {
        kills.length = 0;
        const run = runner.run({ op, policy: 'unattended', item: ITEM, replyKey: REPLY_KEY });
        const settled = run.catch((error) => error);
        await jest.advanceTimersByTimeAsync(59_999);
        expect(kills).toEqual([]);
        await jest.advanceTimersByTimeAsync(2);
        expect(kills).toEqual(['SIGKILL']);
        expect(await settled).toMatchObject({ code: 'timeout' });
      }
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the queue, on fake timers', () => {
  const forget = { op: 'forget', policy: 'unattended', item: ITEM };
  const create = { op: 'create', policy: 'unattended', item: ITEM, replyKey: REPLY_KEY };

  /** A runner whose helpers run until they are killed, and what happened. */
  function heldRunner() {
    const { EventEmitter } = require('events');
    const spawned = [];
    const killed = [];
    const spawn = (_, args) => {
      const child = new EventEmitter();
      child.pid = spawned.length + 1;
      child.stdout = new EventEmitter();
      child.kill = () => {
        killed.push({ pid: child.pid, at: Date.now() });
        // Closed on a later turn, as a killed child is (a promise job:
        // fake timers leave those alone).
        Promise.resolve().then(() => child.emit('close', null, 'SIGKILL'));
      };
      spawned.push({ op: args[2], at: Date.now() });
      return child;
    };
    return { runner: createHelperRunner({ command: 'x', spawn }), spawned, killed };
  }

  /** `promise`'s outcome so far: `{ state, code, at }`. */
  function watch(promise) {
    const seen = { state: 'pending' };
    promise.then(
      () => Object.assign(seen, { state: 'resolved', at: Date.now() }),
      (error) => Object.assign(seen, { state: 'rejected', code: error.code, at: Date.now() })
    );
    return seen;
  }

  beforeEach(() => jest.useFakeTimers({ now: 0 }));
  afterEach(() => jest.useRealTimers());

  test('a core forget queued behind two drain forgets answers timeout at its own 10 s, while the second still runs, and never runs', async () => {
    const { runner, spawned, killed } = heldRunner();
    const drain1 = watch(runner.run(forget));
    const drain2 = watch(runner.run(forget));
    await jest.advanceTimersByTimeAsync(1_000);
    const core = watch(runner.run(forget, { fromArrival: true }));

    // The first drain forget is killed at its 10 s; the second starts then.
    await jest.advanceTimersByTimeAsync(9_000);
    expect(drain1).toMatchObject({ state: 'rejected', code: 'timeout' });
    expect(spawned.map((run) => run.at)).toEqual([0, 10_000]);
    await jest.advanceTimersByTimeAsync(999);
    expect(core.state).toBe('pending');

    // The core's 10 s from its arrival: answered then, the helper still
    // held by the second drain forget.
    await jest.advanceTimersByTimeAsync(1);
    expect(core).toEqual({ state: 'rejected', code: 'timeout', at: 11_000 });
    expect(drain2.state).toBe('pending');
    expect(killed).toHaveLength(1);

    // The second runs its whole 10 s; the core's forget never runs after it.
    await jest.advanceTimersByTimeAsync(9_000);
    expect(drain2).toMatchObject({ state: 'rejected', code: 'timeout', at: 20_000 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(2);

    // The queue is free: the next call starts at once.
    const later = watch(runner.run(forget));
    await jest.advanceTimersByTimeAsync(0);
    expect(spawned).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(later).toMatchObject({ state: 'rejected', code: 'timeout' });
  });

  test("an executor request that gets its turn runs for what's left of its deadline; a drain forget for its whole 10 s", async () => {
    const { runner, spawned, killed } = heldRunner();
    const drain1 = watch(runner.run(forget));
    const core = watch(runner.run(create, { fromArrival: true }));
    const drain2 = watch(runner.run(forget));

    await jest.advanceTimersByTimeAsync(10_000);
    expect(drain1).toMatchObject({ state: 'rejected', code: 'timeout' });
    expect(spawned).toEqual([
      { op: 'forget', at: 0 },
      { op: 'create', at: 10_000 },
    ]);
    // Killed at 60 s from its arrival, not from its start.
    await jest.advanceTimersByTimeAsync(49_999);
    expect(core.state).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(killed.map((kill) => kill.at)).toEqual([10_000, 60_000]);
    await jest.advanceTimersByTimeAsync(0);
    expect(core).toMatchObject({ state: 'rejected', code: 'timeout' });

    // The drain's forget waited 60 s, and still gets its 10 s.
    expect(spawned[2]).toEqual({ op: 'forget', at: 60_000 });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(drain2.state).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(drain2).toMatchObject({ state: 'rejected', code: 'timeout', at: 70_000 });
  });

  test('a waiting call cancelled answers at once, and never runs', async () => {
    const { runner, spawned } = heldRunner();
    const first = watch(runner.run(forget));
    const waiting = new AbortController();
    const second = watch(runner.run(forget, { signal: waiting.signal, fromArrival: true }));
    await jest.advanceTimersByTimeAsync(100);
    waiting.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ state: 'rejected', code: 'cancelled', at: 100 });
    expect(first.state).toBe('pending');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(spawned).toHaveLength(1);
  });
});

posix('the helper run, with stand-in helpers', () => {
  let dir;
  let secretBefore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-shell-'));
    secretBefore = process.env.FREEDOM_TEST_NOT_FOR_THE_HELPER;
    process.env.FREEDOM_TEST_NOT_FOR_THE_HELPER = 'secret';
  });

  afterEach(() => {
    if (secretBefore === undefined) delete process.env.FREEDOM_TEST_NOT_FOR_THE_HELPER;
    else process.env.FREEDOM_TEST_NOT_FOR_THE_HELPER = secretBefore;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in helper: `body` runs after it logs its pid, argv, stdin and
   * environment to `<name>.log`, one JSON line per run. */
  function helper(name, body) {
    const file = path.join(dir, name);
    const log = `${file}.log`;
    fs.writeFileSync(
      file,
      [
        `#!${process.execPath}`,
        "const fs = require('fs');",
        'const stat = fs.fstatSync(0);',
        "const devNull = fs.statSync('/dev/null');",
        'const stdin = { nullDevice: stat.isCharacterDevice() && stat.rdev === devNull.rdev, bytes: fs.readFileSync(0).length };',
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: process.env, stdin, at: Date.now() }) + '\\n');`,
        'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
        body,
      ].join('\n'),
      { mode: 0o755 }
    );
    return {
      command: file,
      runs: () =>
        fs.existsSync(log)
          ? fs
              .readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .map((l) => JSON.parse(l))
          : [],
    };
  }

  const forget = { op: 'forget', policy: 'unattended', item: ITEM };
  const create = { op: 'create', policy: 'unattended', item: ITEM, replyKey: REPLY_KEY };

  test('argv only: stdin is the null device, and the environment the cleared one', async () => {
    const stand = helper('h', 'process.stdout.write(\'{"ok":true}\\n\');');
    const runner = createHelperRunner({ command: stand.command });
    const request = { ...create, op: 'open', reason: 'quick_unlock' };
    await expect(runner.run(request)).resolves.toBe('{"ok":true}');
    const [run] = stand.runs();
    expect(run.argv).toEqual(helperArgs(request));
    expect(run.stdin).toEqual({ nullDevice: true, bytes: 0 });
    expect(run.env.FREEDOM_TEST_NOT_FOR_THE_HELPER).toBeUndefined();
    const allowed = Object.keys(scrubbedEnv());
    expect(Object.keys(run.env).filter((key) => !allowed.includes(key) && key !== '_')).toEqual([]);
  });

  test('the answer is relayed as received, byte for byte, through the executor', async () => {
    // Members in an order the core's own writer doesn't use, and a space:
    // main doesn't rewrite what it relays.
    const answer = `{"key": "${SEALED_KEY}","ok":true}`;
    const stand = helper('h', `process.stdout.write(${JSON.stringify(`${answer}\n`)});`);
    const client = { handle: jest.fn() };
    registerKeystoreShell(client, {
      runner: createHelperRunner({ command: stand.command }),
      platform: 'darwin',
    });
    const handler = client.handle.mock.calls[0][1];
    const result = await handler(
      { op: 'create', policy: 'unattended', item: ITEM, reply_key: REPLY_KEY },
      { signal: new AbortController().signal }
    );
    expect(result).toBeInstanceOf(JsonText);
    const out = Buffer.alloc(result.length);
    expect(result.writeInto(out, 0)).toBe(answer.length);
    expect(out.toString('latin1')).toBe(answer);
  });

  test('4 KiB is relayed; one byte more is too_large', async () => {
    const at = `{"ok":true,"key":"${'A'.repeat(MAX_ANSWER_BYTES - 20)}"}`;
    const past = `{"ok":true,"key":"${'A'.repeat(MAX_ANSWER_BYTES - 19)}"}`;
    const fits = helper('fits', `process.stdout.write(${JSON.stringify(`${at}\n`)});`);
    const over = helper('over', `process.stdout.write(${JSON.stringify(`${past}\n`)});`);
    await expect(createHelperRunner({ command: fits.command }).run(create)).resolves.toBe(at);
    expect(
      await rejection(createHelperRunner({ command: over.command }).run(create))
    ).toMatchObject({
      code: 'too_large',
    });
  });

  test('a helper that keeps writing is killed at once, without waiting for its deadline', async () => {
    const stand = helper(
      'flood',
      "const chunk = 'A'.repeat(1024); (function more() { process.stdout.write(chunk, more); })();"
    );
    const runner = createHelperRunner({ command: stand.command });
    const started = Date.now();
    expect(await rejection(runner.run(forget))).toMatchObject({ code: 'too_large' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(isAlive(stand.runs()[0].pid)).toBe(false);
  });

  test.each([
    ['no line', ''],
    ['a line cut short', 'process.stdout.write(\'{"ok":tr\');'],
    ['a line with no newline', 'process.stdout.write(\'{"ok":true}\');'],
    ['two lines', 'process.stdout.write(\'{"ok":true}\\n{"ok":true}\\n\');'],
    ['not JSON', "process.stdout.write('ok\\n');"],
    ['a byte past ASCII', "process.stdout.write(Buffer.from('7b226f6b223a22e9227d0a', 'hex'));"],
  ])('%s is internal: the core reads it as Backend', async (_, body) => {
    const stand = helper('h', body);
    expect(
      await rejection(createHelperRunner({ command: stand.command }).run(forget))
    ).toMatchObject({
      code: 'internal',
    });
  });

  test("the exit status isn't read: a line and exit 3 is the line", async () => {
    const stand = helper(
      'h',
      'process.stdout.write(\'{"ok":false,"error":"not_found"}\\n\'); process.exit(3);'
    );
    await expect(createHelperRunner({ command: stand.command }).run(forget)).resolves.toBe(
      '{"ok":false,"error":"not_found"}'
    );
  });

  test('a helper past its deadline is killed, and the answer is timeout', async () => {
    const stand = helper('held', 'sleep(30_000); process.stdout.write(\'{"ok":true}\\n\');');
    const runner = createHelperRunner({
      command: stand.command,
      deadlines: { ...DEADLINES_MS, forget: 500 },
    });
    const started = Date.now();
    expect(await rejection(runner.run(forget))).toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(isAlive(stand.runs()[0].pid)).toBe(false);
  });

  test('each op has its own deadline', async () => {
    const stand = helper('slow', 'sleep(800); process.stdout.write(\'{"ok":true}\\n\');');
    const runner = createHelperRunner({
      command: stand.command,
      deadlines: { create: 10_000, open: 10_000, forget: 300 },
    });
    await expect(runner.run(create)).resolves.toBe('{"ok":true}');
    expect(await rejection(runner.run(forget))).toMatchObject({ code: 'timeout' });
  });

  test('one helper at a time', async () => {
    const stand = helper(
      'h',
      `sleep(300); fs.appendFileSync(${JSON.stringify(path.join(dir, 'ends'))}, Date.now() + '\\n'); process.stdout.write('{"ok":true}\\n');`
    );
    const runner = createHelperRunner({ command: stand.command });
    await Promise.all([runner.run(forget), runner.run(forget), runner.run(create)]);
    const starts = stand.runs().map((run) => run.at);
    const ends = fs.readFileSync(path.join(dir, 'ends'), 'utf8').trim().split('\n').map(Number);
    expect(starts).toHaveLength(3);
    for (let i = 1; i < 3; i += 1) expect(starts[i]).toBeGreaterThanOrEqual(ends[i - 1]);
  });

  test("an executor request's deadline counts its wait in the queue; the drain's starts with its run", async () => {
    const held = helper('held', 'sleep(3_000); process.stdout.write(\'{"ok":true}\\n\');');
    const runner = createHelperRunner({
      command: held.command,
      deadlines: { create: 10_000, open: 10_000, forget: 500 },
    });
    const first = runner.run(create);
    let firstDone = false;
    first.then(() => {
      firstDone = true;
    });
    const arrived = Date.now();
    const queued = runner.run(forget, { fromArrival: true });
    // Its 500 ms runs out while the first holds the helper: answered then,
    // not once the first is done, and no run of its own.
    expect(await rejection(queued)).toMatchObject({ code: 'timeout' });
    expect(Date.now() - arrived).toBeGreaterThanOrEqual(450);
    expect(firstDone).toBe(false);
    await expect(first).resolves.toBe('{"ok":true}');
    expect(held.runs()).toHaveLength(1);

    const fast = helper('fast', 'process.stdout.write(\'{"ok":true}\\n\');');
    let calls = 0;
    const both = createHelperRunner({
      command: () => (calls++ === 0 ? held.command : fast.command),
      deadlines: { create: 10_000, open: 10_000, forget: 1_000 },
    });
    const one = both.run(create);
    const drained = both.run(forget);
    await one;
    await expect(drained).resolves.toBe('{"ok":true}');
  }, 20_000);

  test('cancelled while it runs: killed; while it waits, or before: never started', async () => {
    const stand = helper('held', 'sleep(30_000); process.stdout.write(\'{"ok":true}\\n\');');
    const runner = createHelperRunner({ command: stand.command });
    const running = new AbortController();
    const waiting = new AbortController();
    const first = runner.run(create, { signal: running.signal });
    const second = runner.run(forget, { signal: waiting.signal });
    while (stand.runs().length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    waiting.abort();
    // Answered at once, while the first still runs.
    expect(await rejection(second)).toMatchObject({ code: 'cancelled' });
    expect(isAlive(stand.runs()[0].pid)).toBe(true);
    running.abort();
    expect(await rejection(first)).toMatchObject({ code: 'cancelled' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await rejection(runner.run(forget, { signal: aborted.signal }))).toMatchObject({
      code: 'cancelled',
    });
    expect(stand.runs()).toHaveLength(1);
    expect(isAlive(stand.runs()[0].pid)).toBe(false);
  });

  test('a missing binary is internal', async () => {
    const runner = createHelperRunner({ command: path.join(dir, 'missing') });
    expect(await rejection(runner.run(forget))).toMatchObject({ code: 'internal' });
  });
});
