/**
 * Runs CoreClient against the real freedom-cored binary. Skipped unless
 * FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/core
 * The fragments test calls the core's `test.*` methods, which only a debug
 * build with the `testhooks` feature has (freedom-core #241, from 0.9.0):
 *   cargo build -p freedom-cored --features testhooks
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoreClient } = require('./core-client');
const { encodeCredit, MAX_MESSAGE, MAX_PAYLOAD } = require('./frame');

const binary = process.env.FREEDOM_CORED_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };

const MIB = 1024 * 1024;

/** What freedom-cored's `test.large` answers: `bytes` letters, a to z
 * repeating. */
function letters(bytes) {
  return 'abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(bytes / 26)).slice(0, bytes);
}

function client(dataDir, lockDir, spawnFn = spawn) {
  return new CoreClient({
    spawn: spawnFn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      dataDir,
      '--lock-dir',
      lockDir,
      '--parent-pid',
      String(process.pid),
    ],
    log: quietLog,
    shellVersion: 'jest',
  });
}

describeIfBinary('CoreClient with the real freedom-cored', () => {
  let root;
  // Stopped after each test, even one that times out.
  let running = null;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-core-client-'));
  });
  afterEach(async () => {
    await running?.stop();
    running = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('handshake, status, shutdown', async () => {
    const core = client(path.join(root, 'identity'), path.join(root, 'locks'));
    const hello = await core.start();
    expect(hello.protocol).toBe(1);
    expect(hello.capabilities).toContain('vault.status');
    await expect(core.request('vault.status')).resolves.toEqual({
      exists: false,
      unlocked: false,
      epoch: null,
      fingerprint: null,
    });
    await expect(core.request('vault.nope')).rejects.toMatchObject({ code: 'unknown_method' });
    await core.stop();
    expect(core.state).toBe('stopped');
  });

  test('protocol 2: a core that speaks it says streams; one that speaks only 1 refuses it, without a restart', async () => {
    // The pinned core (0.9.1) speaks protocol 1 only (design 0009, step 5
    // moves the core to 2), so main asks it for 1.
    let spawned = 0;
    const core = new CoreClient({
      spawn: (...args) => {
        spawned += 1;
        return spawn(...args);
      },
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
        '--lock-dir',
        path.join(root, 'locks'),
        '--parent-pid',
        String(process.pid),
      ],
      log: quietLog,
      shellVersion: 'jest',
      protocol: 2,
    });
    running = core;
    const hello = await core.start().catch((error) => ({ error }));
    if (hello.error) {
      expect(hello.error.code).toBe('core_unavailable');
      expect(core.state).toBe('failed');
      expect(spawned).toBe(1);
      return;
    }
    expect(hello.protocol).toBe(2);
    expect(hello.capabilities).toContain('streams');
    expect(core.streamStats()).toMatchObject({ outstanding: 0, pieces: 0, sending: 0 });
    await expect(core.request('vault.status')).resolves.toMatchObject({ exists: false });
  });

  test('stop() racing the handshake settles without a restart', async () => {
    let spawned = 0;
    const core = new CoreClient({
      spawn: (...args) => {
        spawned += 1;
        return spawn(...args);
      },
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
        '--lock-dir',
        path.join(root, 'locks'),
      ],
      log: quietLog,
    });
    const started = core.start().catch((e) => e);
    await core.stop();
    expect(core.state).toBe('stopped');
    expect((await started).code).toBe('core_unavailable');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(spawned).toBe(1);
  });

  test('a core whose stdin closes is supervised and restarted', async () => {
    const core = client(path.join(root, 'identity'), path.join(root, 'locks'));
    await core.start();
    // Close stdin behind the client's back: the core exits on EOF, and the
    // next request fails cleanly instead of raising an uncaught EPIPE.
    core.current.child.stdin.end();
    await expect(core.request('vault.status')).rejects.toMatchObject({ code: 'core_unavailable' });
    await core.whenReady();
    await expect(core.request('vault.status')).resolves.toMatchObject({ exists: false });
    await core.stop();
  }, 20_000);

  test('a second core on the same identity directory fails without retrying', async () => {
    const first = client(path.join(root, 'identity'), path.join(root, 'locks'));
    await first.start();
    const second = client(path.join(root, 'identity'), path.join(root, 'locks'));
    await expect(second.start()).rejects.toMatchObject({ code: 'core_unavailable' });
    expect(second.state).toBe('failed');
    await first.stop();
  }, 20_000);

  test("the core's large responses arrive in fragments, and each credit goes back", async () => {
    // The test methods answer only with their hook (a debug build with the
    // `testhooks` feature), which the client's scrubbed environment would
    // drop.
    const credits = [];
    const withTestMethods = (command, args, options) => {
      const env = { ...options.env, FREEDOM_CORED_TEST_METHODS: '1' };
      const child = spawn(command, args, { ...options, env });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        if (Buffer.isBuffer(chunk) && chunk.equals(encodeCredit())) credits.push(chunk);
        return write(chunk, ...rest);
      };
      return child;
    };
    const core = client(path.join(root, 'identity'), path.join(root, 'locks'), withTestMethods);
    running = core;
    const hello = await core.start();
    expect(hello.capabilities).toContain('fragments');

    expect(await core.request('test.large', { bytes: 4 * MIB })).toBe(letters(4 * MIB));
    expect(credits).toHaveLength(1);
    // Several at once: each begins only once main has returned the credit
    // for the one before, while whole replies go between.
    const sizes = [3 * MIB, MAX_PAYLOAD + 1, 2 * MIB, 1000];
    const [results, status] = await Promise.all([
      Promise.all(sizes.map((bytes) => core.request('test.large', { bytes }))),
      core.request('vault.status'),
    ]);
    expect(results).toEqual(sizes.map(letters));
    expect(status).toMatchObject({ exists: false });
    expect(credits).toHaveLength(4);
    // One over the message cap is never begun.
    await expect(core.request('test.large', { bytes: MAX_MESSAGE })).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(core.state).toBe('ready');
  }, 30_000);
});
