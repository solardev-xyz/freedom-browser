/**
 * The freedom-radicled client against the real binary (freedom-core design
 * 0008, "Process model" and Errors). Skipped unless FREEDOM_RADICLED_PATH
 * points at a build, e.g.
 *   FREEDOM_RADICLED_PATH=freedom-radicled-bin/linux-x64/freedom-radicled npx jest src/main/radicle/radicled-client.integration
 *
 * - **the handshake:** `rad.hello` answers with its confinement (design
 *   0010), the recipient for this start, the libradicle build and the
 *   policy main passed, and the client takes it; the pinned release, when
 *   the binary is the one `npm run radicled:download` fetched;
 * - **the environment:** with main's `HOME` and `USERPROFILE` at a
 *   directory that doesn't exist, and `RAD_*`, `GIT_*`, `SSH_AUTH_SOCK`,
 *   `LISTEN_*` and `XDG_CONFIG_HOME` in main's environment, all of which the
 *   service refuses to start with (64), it starts;
 * - **a start step's error** (`rad.reconcile` before `rad.identity`:
 *   `no_identity`) ends the process with exit 0, and the client doesn't
 *   restart it;
 * - **the start steps before the node:** `rad.identity { ephemeral }` and
 *   `rad.reconcile` on a fresh home, then `rad.shutdown` and exit 0.
 *
 * Nothing here touches the network: `rad.start`, which runs the node, is
 * never sent.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });

const { RadicledClient, validRecipient } = require('./radicled-client');
const { PINNED_RADICLED_VERSION } = require('./radicled-pin');
const { validConfinement } = require('../ipfs/ipfsd-client');

const binary = process.env.FREEDOM_RADICLED_PATH;
const describeIfBinary = binary ? describe : describe.skip;
// The binary `npm run radicled:download` fetched, at the pin.
const pinned =
  Boolean(binary) && path.resolve(binary).includes(`${path.sep}freedom-radicled-bin${path.sep}`);
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const TEST_MS = 60_000;

describeIfBinary('the freedom-radicled client with the real binary', () => {
  let root;
  let client;
  // The variables these tests set in main's environment, restored after each
  // (process.env itself is kept: on Windows its names are case-insensitive).
  const SET = [
    'HOME',
    'USERPROFILE',
    'RAD_PASSPHRASE',
    'RAD_KEYGEN_SEED',
    'RAD_SOCKET',
    'RAD_HOME',
    'GIT_COMMITTER_DATE',
    'GIT_CONFIG_GLOBAL',
    'GIT_DIR',
    'SSH_AUTH_SOCK',
    'LISTEN_FDS',
    'XDG_CONFIG_HOME',
    'FREEDOM_RADICLED_PATH',
    'FREEDOM_RADICLED_RELEASE_TAG',
  ];
  const savedEnv = Object.fromEntries(SET.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-radicled-client-'));
  });

  afterEach(async () => {
    if (client) {
      client.removeAllListeners();
      await client.stop();
      client = null;
    }
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function newClient() {
    client = new RadicledClient({
      spawn,
      command: binary,
      home: path.join(root, 'R', '1'),
      lockDir: path.join(root, 'locks'),
      ownHome: path.join(root, 'radicled-home'),
      log: quietLog,
      shellVersion: '0.0.0-test',
    });
    return client;
  }

  /** The next 'exit' the client reports. */
  const nextExit = () => new Promise((resolve) => client.once('exit', resolve));

  test(
    'rad.hello: its confinement, recipient, build and policy, in an environment the service accepts',
    async () => {
      const nowhere = path.join(root, 'no-such-home');
      Object.assign(process.env, {
        HOME: nowhere,
        USERPROFILE: nowhere,
        RAD_PASSPHRASE: 'secret',
        RAD_HOME: nowhere,
        GIT_COMMITTER_DATE: '0',
        GIT_CONFIG_GLOBAL: nowhere,
        SSH_AUTH_SOCK: path.join(nowhere, 'agent.sock'),
        LISTEN_FDS: '3',
        XDG_CONFIG_HOME: nowhere,
      });
      const hello = await newClient().start();
      expect(hello).toMatchObject({
        protocol: 1,
        network: { mode: 'direct' },
        libradicle: {
          version: expect.any(String),
          git_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        },
      });
      expect(validRecipient(hello.recipient)).toBe(true);
      // design 0010: what the OS gave it, in the report's shape.
      expect(validConfinement(hello.confinement)).toEqual(hello.confinement);
      expect(typeof hello.confinement.mechanism).toBe('string');
      if (pinned) expect(hello.service_version).toBe(PINNED_RADICLED_VERSION);
      // Its own HOME, empty, and nothing made where main's points.
      expect(fs.existsSync(nowhere)).toBe(false);
      expect(fs.statSync(path.join(root, 'radicled-home')).isDirectory()).toBe(true);

      const exited = nextExit();
      await client.stop();
      await expect(exited).resolves.toMatchObject({ code: 0, cause: 'shutdown' });
      expect(client.state).toBe('stopped');
    },
    TEST_MS
  );

  test(
    "a start step's error ends the process with exit 0, and the client doesn't restart it",
    async () => {
      await newClient().start();
      const gen = client.current;
      const exited = nextExit();
      const failed = new Promise((resolve) => client.once('failed', resolve));
      await expect(client.reconcile(gen)).rejects.toMatchObject({ code: 'no_identity' });
      await expect(exited).resolves.toMatchObject({ code: 0, signal: null });
      await expect(failed).resolves.toBe('start step failed');
      // No restart: the restart's first back-off is 0.5 s.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(client.generations).toBe(1);
      expect(client.state).toBe('failed');
    },
    TEST_MS
  );

  test(
    'rad.identity { ephemeral } and rad.reconcile on a fresh home, then rad.shutdown',
    async () => {
      await newClient().start();
      const gen = client.current;
      await expect(client.identity(gen, { ephemeral: true })).resolves.toMatchObject({
        did: expect.stringMatching(/^did:key:z6Mk/),
        nid: expect.stringMatching(/^z6Mk/),
        ephemeral: true,
      });
      await expect(client.reconcile(gen)).resolves.toMatchObject({
        was_dirty: expect.any(Boolean),
        quarantined: { count: 0 },
      });
      const stats = await client.nodeStats(gen);
      expect(stats).toMatchObject({ node: 'waiting', node_alive: false });
      const exited = nextExit();
      await client.stop();
      await expect(exited).resolves.toMatchObject({ code: 0, cause: 'shutdown' });
    },
    TEST_MS
  );
});
