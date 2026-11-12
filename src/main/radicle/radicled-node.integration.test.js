/**
 * The Radicle node on the real freedom-radicled, its key from the real
 * freedom-cored (freedom-core design 0008, "Keys", "The switch" and "When
 * the node can start"). Skipped unless both binaries are named, e.g.
 *   FREEDOM_RADICLED_PATH=freedom-radicled-bin/linux-x64/freedom-radicled \
 *   FREEDOM_CORED_PATH=freedom-cored-bin/linux-x64/freedom-cored \
 *     npx jest src/main/radicle/radicled-node.integration
 *
 * On a named catalog profile laid out as a packaged build lays it out, with
 * a test vault whose derived Radicle key is known (the `abandon … about`
 * mnemonic):
 * - **the switch, from a home the add-on used:** the core's derived key
 *   file in `keys/`, and a control socket a killed add-on left. The start
 *   removes the socket under the real `hold-lock`, the service answers
 *   `key_file_present`, the core switches the home (no key file left), and
 *   the start runs once more, as the vault's identity; then a stop, proved
 *   by the exit;
 * - **ciphertext only through main:** a recorder on both pipes of each
 *   process (main ⇄ freedom-radicled, main ⇄ freedom-cored) and on main's
 *   log never finds the key's 32 bytes, raw, in hex or in base64;
 * - **an identity change** (0008, "Identity changes"): the core's sealed
 *   write with `wipe`, as main sends it, answers `lock_held` and touches
 *   nothing while a running service holds the home's gate; once the service
 *   has stopped, it wipes `node/`, `cobs/` and `storage/` and removes the key
 *   files, writes no key, and the next start runs with no switch;
 * - **a locked vault:** nothing is spawned until the core's
 *   `vault.unlocked`, then the node starts, with no switch;
 * - **no vault:** after the vault's deletion, a throwaway key, and no key
 *   file is written.
 *
 * Off the network: the home names no peer (static peers, no seeds, no
 * `connect`), and the process runs under `--network socks5:` at a closed
 * loopback port, so nothing it could dial leaves the machine. The
 * manager's background `connect_seeds` and clone aren't run.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const mockApp = { isPackaged: false, paths: {}, getPath: (name) => mockApp.paths[name] };
let mockProfile = null;
let mockCore = null;
jest.mock('electron', () => ({ app: mockApp }), { virtual: true });
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('../core/core-process', () => ({ getCoreClient: () => mockCore }));

const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('../core/core-client');
const { vaultBackend } = require('../core/vault-backend');
const guard = require('../core/node-identity-guard');
const { getLockDir } = require('../service-locks');
const { RadicledNode } = require('./radicled-node');

const radicled = process.env.FREEDOM_RADICLED_PATH;
const cored = process.env.FREEDOM_CORED_PATH;
const describeIfBinaries =
  radicled && cored && process.platform !== 'win32' ? describe : describe.skip;
const TEST_MS = 180_000;
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testpass1';
const ALIAS = 'FreedomTest';

/** A port nothing listens on: bound, then closed. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * The Radicle key the core derives from `mnemonic` (freedom-core design
 * 0008, "Keys"): SLIP-0010's Ed25519 key at m/44'/73404'/0'/0'/0' of its
 * BIP-39 seed. Derived here with Node's own primitives (src/ doesn't use the
 * legacy JS identity stack), and checked against the core's public key.
 */
function radicleSeed(mnemonic) {
  const seed = crypto.pbkdf2Sync(
    Buffer.from(mnemonic.normalize('NFKD')),
    Buffer.from('mnemonic'),
    2048,
    64,
    'sha512'
  );
  let digest = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  for (const index of [44, 73404, 0, 0, 0]) {
    const data = Buffer.alloc(37);
    digest.copy(data, 1, 0, 32);
    data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
    digest = crypto.createHmac('sha512', digest.subarray(32)).update(data).digest();
  }
  return digest.subarray(0, 32);
}

/** The Ed25519 public key of a 32-byte seed. */
function publicKeyOf(seed) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
}

/** Every pattern the key's bytes could take in text or bytes: raw, hex and
 * base64 at each alignment. */
function keyPatterns(key) {
  const patterns = [
    key,
    Buffer.from(key.toString('hex')),
    Buffer.from(key.toString('hex').toUpperCase()),
  ];
  for (let pad = 0; pad < 3; pad++) {
    const text = Buffer.concat([Buffer.alloc(pad), key]).toString('base64');
    // The characters the key's bytes alone decide.
    const start = Math.ceil((pad * 8) / 6);
    const end = Math.floor(((pad + key.length) * 8) / 6);
    const stable = text.slice(start, end);
    patterns.push(Buffer.from(stable));
    patterns.push(Buffer.from(stable.replace(/\+/g, '-').replace(/\//g, '_')));
  }
  return patterns;
}

describeIfBinaries('the Radicle node on the real freedom-radicled and freedom-cored', () => {
  let root;
  let appRoot;
  let userData;
  let recorded;
  let logs;
  let radicledSpawns;
  let socksPort;
  const nodes = [];

  const home = () => path.join(appRoot, 'R', '1');
  const ownHome = () => path.join(userData, 'radicled-home');
  const record = (...args) => logs.push(args);
  const log = { info: record, warn: record, error: record, debug: record };

  /** child_process.spawn, with both pipes recorded. */
  function recordingSpawn(command, args, options) {
    const child = spawn(command, args, options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      recorded.push(Buffer.from(chunk));
      return write(chunk, ...rest);
    };
    child.stdout.on('data', (chunk) => recorded.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => recorded.push(Buffer.from(chunk)));
    return child;
  }

  function radicledSpawn(command, args, options) {
    if (args[0] === 'serve') radicledSpawns += 1;
    return recordingSpawn(command, args, options);
  }

  function newNode() {
    const node = new RadicledNode({
      home: home(),
      lockDir: getLockDir(),
      ownHome: ownHome(),
      alias: ALIAS,
      switchAlias: () => ALIAS,
      network: { mode: 'socks5', ip: '127.0.0.1', port: socksPort },
      command: radicled,
      spawn: radicledSpawn,
      log,
      shellVersion: 'jest',
    });
    nodes.push(node);
    return node;
  }

  beforeAll(async () => {
    // Short on macOS: the stale control socket's path has a 104-byte bound.
    const tmp = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'rnode-')));
    appRoot = path.join(root, 'Freedom');
    userData = path.join(appRoot, 'Profiles', 'work');
    fs.mkdirSync(userData, { recursive: true });
    mockApp.paths = { appData: root, userData };
    mockProfile = {
      source: 'catalog',
      appRoot,
      userDataDir: userData,
      isDev: false,
      metadata: { slot: 1 },
    };
    recorded = [];
    logs = [];
    radicledSpawns = 0;
    socksPort = await closedPort();
    mockCore = new CoreClient({
      spawn: recordingSpawn,
      command: cored,
      args: ['serve', '--data-dir', path.join(userData, 'identity'), '--lock-dir', getLockDir()],
      log,
      shellVersion: 'jest',
      protocol: PROTOCOL_VERSION_STREAMS,
    });
    mockCore.on('ready', (hello) => guard.setStartupRecovery(hello.node_recovery));
    await mockCore.start();
    await vaultBackend.importVault(PASSWORD, ABANDON);
  }, TEST_MS);

  afterEach(async () => {
    for (const node of nodes.splice(0)) await node.stop();
  }, TEST_MS);

  afterAll(async () => {
    await mockCore?.stop();
    mockCore = null;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, TEST_MS);

  test(
    "a home the add-on used: the socket goes under the gate, the core switches it once, and the node runs as the vault's identity; the key crosses no pipe and no log",
    async () => {
      const derived = await vaultBackend.addresses();
      // The add-on's home: a configuration that names no peer, the core's
      // derived key file (today's form of nodes.write_identity), and the
      // control socket of an add-on that was killed.
      fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(home(), 'config.json'),
        JSON.stringify({
          preferredSeeds: [],
          node: { alias: ALIAS, connect: [], peers: { type: 'static' } },
        })
      );
      const written = await vaultBackend.writeNodeIdentity(
        { node: 'radicle', home: home(), alias: ALIAS },
        crypto.randomUUID()
      );
      expect(written.status).toBe('installed');
      expect(fs.existsSync(path.join(home(), 'keys', 'radicle'))).toBe(true);
      fs.mkdirSync(path.join(home(), 'node'), { recursive: true });
      const socket = path.join(home(), 'node', 'control.sock');
      spawnSync(
        process.execPath,
        [
          '-e',
          "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
          socket,
        ],
        { stdio: 'ignore' }
      );
      expect(fs.lstatSync(socket).isSocket()).toBe(true);

      const node = newNode();
      await expect(node.start()).resolves.toBe(true);
      expect(node.failureReason).toBeNull();
      // The socket is gone, and so are the key files; the alias stays.
      expect(fs.existsSync(socket)).toBe(false);
      expect(fs.existsSync(path.join(home(), 'keys', 'radicle'))).toBe(false);
      expect(fs.existsSync(path.join(home(), 'keys', 'radicle.pub'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).node.alias).toBe(
        ALIAS
      );
      // key_file_present, the switch, then the start once more: two processes.
      expect(radicledSpawns).toBe(2);
      expect(node.activeIdentity()).toEqual({
        did: derived.radicle.did,
        nid: derived.radicle.did.slice('did:key:'.length),
        alias: ALIAS,
        ephemeral: false,
      });
      expect(node.isUp()).toBe(true);
      expect(node.confinement).toMatchObject({ mechanism: expect.any(String) });
      expect(node.buildInfo().service).toMatchObject({
        name: 'freedom-radicled',
        network: { mode: 'socks5', ip: '127.0.0.1', port: socksPort },
      });

      await node.stop();
      expect(node.state).toBe('stopped');
      expect(node.isUp()).toBe(false);

      // The key the core released: the vault's derived Radicle key.
      const key = radicleSeed(ABANDON);
      expect(key).toHaveLength(32);
      expect(publicKeyOf(key).toString('hex')).toBe(derived.radicle.public_key);
      // The recorder heard the start (a control), and never the key.
      const heard = Buffer.concat(recorded);
      expect(heard.includes(Buffer.from('rad.identity'))).toBe(true);
      expect(heard.includes(Buffer.from('"ciphertext"'))).toBe(true);
      const logged = Buffer.from(JSON.stringify(logs));
      for (const pattern of keyPatterns(key)) {
        expect(heard.includes(pattern)).toBe(false);
        expect(logged.includes(pattern)).toBe(false);
      }
    },
    TEST_MS
  );

  // 0008, "Identity changes" (the step-5 plan's B12): the core's write that
  // identity-manager.js sends under the service, against the real core.
  test(
    "an identity change: while a service holds the home's gate the core answers lock_held and touches nothing; once it has stopped, the core wipes the node's state and removes the key files, writes no key, and the next start runs as the vault's identity with no switch",
    async () => {
      const derived = await vaultBackend.addresses();
      const change = () =>
        vaultBackend.writeNodeIdentity(
          { node: 'radicle', home: home(), alias: ALIAS, custody: 'sealed', wipe: true },
          crypto.randomUUID()
        );
      const state = ['node', 'cobs', 'storage'].map((dir) => path.join(home(), dir));
      const keys = path.join(home(), 'keys');
      fs.mkdirSync(path.join(home(), 'cobs'), { recursive: true });
      fs.writeFileSync(path.join(home(), 'cobs', 'mark'), 'cobs');

      // A running service holds the gate: the core waits its 5 s, then
      // refuses, and the node runs on.
      const running = newNode();
      await expect(running.start()).resolves.toBe(true);
      for (const dir of state) expect(fs.existsSync(dir)).toBe(true);
      await expect(change()).rejects.toMatchObject({ code: 'lock_held' });
      for (const dir of state) expect(fs.existsSync(dir)).toBe(true);
      expect(running.isUp()).toBe(true);

      // Stopped: its exit frees the gate. An add-on's key pair is back in
      // keys/ (today's form of the write), for the change to remove.
      await running.stop();
      await expect(
        vaultBackend.writeNodeIdentity(
          { node: 'radicle', home: home(), alias: ALIAS },
          crypto.randomUUID()
        )
      ).resolves.toMatchObject({ status: 'installed' });
      expect(fs.existsSync(path.join(keys, 'radicle'))).toBe(true);
      expect(fs.existsSync(path.join(keys, 'radicle.pub'))).toBe(true);

      await expect(change()).resolves.toEqual({ status: 'installed' });
      for (const dir of state) expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(keys) ? fs.readdirSync(keys) : []).toEqual([]);
      const config = JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8'));
      expect(config.node).toMatchObject({ alias: ALIAS, connect: [] });
      expect(guard.nodeBlockReason('radicle')).toBeNull();

      // No key file, so no switch: one process, as the vault's identity.
      const before = radicledSpawns;
      const next = newNode();
      await expect(next.start()).resolves.toBe(true);
      expect(radicledSpawns).toBe(before + 1);
      expect(next.activeIdentity()).toMatchObject({ did: derived.radicle.did, ephemeral: false });
      expect(fs.existsSync(path.join(keys, 'radicle'))).toBe(false);
    },
    TEST_MS
  );

  test(
    'a locked vault: nothing spawns until vault.unlocked, then the node starts, with no switch',
    async () => {
      await vaultBackend.lock();
      const before = radicledSpawns;
      const node = newNode();
      const started = node.start();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(radicledSpawns).toBe(before);
      expect(node.state).toBe('starting');

      await vaultBackend.unlock(PASSWORD);
      await expect(started).resolves.toBe(true);
      expect(radicledSpawns).toBe(before + 1);
      const derived = await vaultBackend.addresses();
      expect(node.activeIdentity()).toMatchObject({ did: derived.radicle.did, ephemeral: false });
    },
    TEST_MS
  );

  test(
    'no vault: a throwaway key, a new one at each start, and no key file written',
    async () => {
      await vaultBackend.deleteVault(PASSWORD);
      const first = newNode();
      await expect(first.start()).resolves.toBe(true);
      const throwaway = first.activeIdentity();
      expect(throwaway.ephemeral).toBe(true);
      await first.stop();

      const second = newNode();
      await expect(second.start()).resolves.toBe(true);
      expect(second.activeIdentity().ephemeral).toBe(true);
      expect(second.activeIdentity().did).not.toBe(throwaway.did);
      await second.stop();
      expect(fs.existsSync(path.join(home(), 'keys', 'radicle'))).toBe(false);
      expect(fs.existsSync(path.join(home(), 'keys', 'radicle.pub'))).toBe(false);
    },
    TEST_MS
  );
});
