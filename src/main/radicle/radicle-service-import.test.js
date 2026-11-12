/**
 * The GitHub bridge's import on freedom-radicled (freedom-core design 0010,
 * D5 and its Tests; design 0008, Writes "Import"; the radicled step-5
 * plan's B14), main's side end to end.
 *
 * Main's own modules run here, under FREEDOM_RADICLE_BACKEND=service: the
 * GitHub bridge's IPC handlers, radicle-manager.js with a real RadicledNode,
 * radicle-embedded.js, radicle/radicled-import.js and main's real checks
 * (service-grant.js's working-copy check and protected roots), over one
 * in-process fake freedom-radicled (fake-radicled.js) that is the serve
 * process and the import process by its arguments. Only the core (its
 * vault, unlocked, and the seal), git and GitHub are faked.
 *
 * - **the flow:** the node stopped and its process gone, then the import
 *   process on the bridge's clone, then the node started again, its start
 *   reconciling the home;
 * - **the clone** is outside every protected root (the OS's temporary
 *   directory), named by its real path, and not refused; main leaves the
 *   working copy as git made it;
 * - **each answer mapped:** `{ rid }`, "already exists in storage" as
 *   already bridged, every other refusal as the import's failure with its
 *   message;
 * - **a kill or the deadline** with the import sent: the outcome is
 *   unknown, never retried, and the next start reconciles;
 * - **refused before anything runs:** a throwaway key, a private window, a
 *   node that isn't running; the bridge's check doesn't require the node
 *   running while an import runs;
 * - **a stop** before the import is sent ends it and the node stays
 *   stopped; once it is sent, it is answered.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { fakeRadicled, IMPORT_RID } = require('../../../test/helpers/fake-radicled');

const DID = 'did:key:z6MkderivedFromTheVaultMnemonic00000000000000';
const NID = 'z6MkderivedFromTheVaultMnemonic00000000000000';
const SEALED = Object.freeze({
  enc: Buffer.alloc(32, 0xa5).toString('base64'),
  ciphertext: Buffer.alloc(48, 0x5a).toString('base64'),
});
const URL = 'https://github.com/solardev-xyz/freedom-browser';
const OUTCOME_UNKNOWN_TEXT =
  'The Radicle import stopped before it was confirmed; the repository may have been imported.';

let root;
let saved;
let service;
let manager;
let handlers;
let vault;
/** How the import process answers `rad.import_repo`, in order: each
 * `(message, child)`; with none left, `{ rid }`. */
let importAnswers;
/** How the serve process answers `rad.identity`: its `ephemeral`. */
let ephemeral;
/** The clones git made: their directory, and their files once made. */
let clones;
/** The working copy as the import process found it. */
let seenByImport;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  if (!predicate()) throw new Error('timed out waiting');
}

/** The serve processes and import processes the fake spawned, in order. */
const serves = () => service.children.filter((child) => child.args[0] === 'serve');
const imports = () => service.children.filter((child) => child.args[0] === 'import');

/** Every file under `dir` with its content, relative. */
function snapshot(dir) {
  const out = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** git, as the bridge runs it: `--version`, a clone that makes a working
 * copy, and the default branch. */
function fakeGit(command, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  let stdout = '';
  if (args[0] === '--version') stdout = 'git version 2.50.0\n';
  if (args[0] === 'clone') {
    const dir = args[2];
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# freedom-browser\n');
    clones.push({ dir, files: snapshot(dir) });
  }
  if (args[0] === 'symbolic-ref') stdout = 'main\n';
  setImmediate(() => cb(null, { stdout, stderr: '' }));
}

function fakeHttps() {
  return {
    request: (_url, _opts, callback) => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      setImmediate(() => callback(response));
      return Object.assign(new EventEmitter(), { end() {}, destroy() {} });
    },
    get: (_url, _opts, callback) => {
      const response = new EventEmitter();
      setImmediate(() => {
        callback(response);
        response.emit('data', JSON.stringify({ description: 'A browser.' }));
        response.emit('end');
      });
      return Object.assign(new EventEmitter(), { destroy() {} });
    },
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-service-import-')));
  const home = path.join(root, 'R');
  fs.mkdirSync(home, { recursive: true });
  saved = {
    backend: process.env.FREEDOM_RADICLE_BACKEND,
    data: process.env.FREEDOM_RADICLE_DATA,
    identity: process.env.FREEDOM_IDENTITY_DATA,
    addon: process.env.FREEDOM_RADICLE_ADDON,
  };
  process.env.FREEDOM_RADICLE_BACKEND = 'service';
  process.env.FREEDOM_RADICLE_DATA = home;
  process.env.FREEDOM_IDENTITY_DATA = path.join(root, 'identity');
  // An add-on that must never load.
  process.env.FREEDOM_RADICLE_ADDON = path.join(root, 'no-such', 'libradicle.node');
  importAnswers = [];
  ephemeral = false;
  clones = [];
  seenByImport = null;
  load();
});

afterEach(async () => {
  await manager?.stopRadicle();
  manager = null;
  for (const [key, name] of [
    ['backend', 'FREEDOM_RADICLE_BACKEND'],
    ['data', 'FREEDOM_RADICLE_DATA'],
    ['identity', 'FREEDOM_IDENTITY_DATA'],
    ['addon', 'FREEDOM_RADICLE_ADDON'],
  ]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  require('../github-bridge').cleanupTempDirs();
  for (const { dir } of clones) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

/** Main's modules over the fake core, git, GitHub and service. */
function load() {
  vault = {
    status: jest.fn(async () => ({ exists: true, unlocked: true, epoch: null, fingerprint: null })),
    sealRadicleKey: jest.fn(async () => ({ ...SEALED })),
    writeNodeIdentity: jest.fn(async () => ({ status: 'installed' })),
    onVaultEvent: jest.fn(() => () => {}),
  };
  service = fakeRadicled({
    identity: (message, child) =>
      child.result(message.id, {
        did: DID,
        nid: NID,
        ephemeral: child.args[0] === 'serve' ? ephemeral : false,
      }),
    start: (message, child) =>
      child.result(message.id, { did: DID, nid: NID, alias: message.params?.alias ?? null }),
    import_repo: (message, child) => {
      seenByImport = snapshot(message.params.path);
      const answer = importAnswers.shift();
      if (answer) answer(message, child);
      else child.result(message.id, { rid: IMPORT_RID });
    },
  });
  const nodePath = require.resolve('./radicled-node');
  const importPath = require.resolve('./radicled-import');
  const grantPath = require.resolve('../service-grant');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const ipcMain = { handle: jest.fn(), on: jest.fn(), removeHandler: jest.fn() };
  loadMainModule(require.resolve('../radicle-manager'), {
    userDataDir: userData,
    appPaths: { appData: path.join(root, 'AppData') },
    ipcMain,
    extraMocks: {
      [require.resolve('../logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      child_process: () => ({ ...jest.requireActual('child_process'), execFile: fakeGit }),
      https: () => fakeHttps(),
      [require.resolve('../core/vault-backend')]: () => ({ vaultBackend: vault }),
      // The serve process's own grant check is radicled-client.test.js's;
      // the import's checks are the real ones.
      [grantPath]: () => ({ ...jest.requireActual(grantPath), radicleGrantRefusal: () => null }),
      [require.resolve('../private/private-sender')]: () => ({
        isPrivateSender: (event) => event?.private === true,
      }),
      [nodePath]: () => {
        const actual = jest.requireActual(nodePath);
        class TestRadicledNode extends actual.RadicledNode {
          static isAvailable() {
            return true;
          }
          constructor(options) {
            super({
              ...options,
              command: 'freedom-radicled',
              spawn: service.spawn,
              removeStaleSocket: async () => false,
              guard: { blockReason: () => null, block: () => {}, unblock: () => {} },
            });
          }
        }
        return { ...actual, RadicledNode: TestRadicledNode };
      },
      [importPath]: () => {
        const actual = jest.requireActual(importPath);
        return {
          ...actual,
          runRadicledImport: (options) =>
            actual.runRadicledImport({
              ...options,
              command: 'freedom-radicled',
              spawn: service.spawn,
            }),
        };
      },
    },
  });
  require('../core/node-identity-guard').setStartupRecovery(null);
  manager = require('../radicle-manager');
  require('../github-bridge').registerGithubBridgeIpc();
  handlers = new Map(ipcMain.handle.mock.calls.map(([channel, fn]) => [channel, fn]));
}

const IPC = require('../../shared/ipc-channels');

async function startNode() {
  await expect(manager.startRadicle()).resolves.toEqual({ status: 'running', error: null });
}

/** The bridge's import, as the renderer asks for it: its result and the
 * progress it sent. */
async function bridgeImport({ url = URL, sender = null } = {}) {
  const progress = [];
  const event = {
    ...(sender ?? {}),
    sender: { isDestroyed: () => false, send: (_channel, data) => progress.push(data) },
  };
  const result = await handlers.get(IPC.GITHUB_BRIDGE_IMPORT)(event, url);
  return { result, progress };
}

describe('the import through the import process', () => {
  test('stops the node, imports the clone from outside every protected root, and starts the node again', async () => {
    await startNode();
    const { result } = await bridgeImport();
    expect(result).toEqual({
      success: true,
      rid: IMPORT_RID.slice(4),
      name: 'freedom-browser',
      owner: 'solardev-xyz',
      description: 'A browser.',
    });

    // serve, then import, then serve again: each after the last exited.
    expect(service.children.map((child) => child.args[0])).toEqual(['serve', 'import', 'serve']);
    const [first, again] = serves();
    const [importer] = imports();
    expect(first.sent('rad.shutdown')).toHaveLength(1);
    expect(first.exited).toBe(true);
    expect(importer.exited).toBe(true);
    // The node is running again, and its start reconciled the home.
    expect(manager.getCurrentStatus()).toEqual({ status: 'running', error: null });
    expect(again.sent('rad.reconcile')).toHaveLength(1);

    // The clone: in the OS's temporary directory, by its real path.
    expect(clones).toHaveLength(1);
    const source = clones[0].dir;
    expect(path.dirname(path.dirname(source))).toBe(fs.realpathSync.native(os.tmpdir()));
    expect(path.basename(path.dirname(source))).toMatch(/^freedom-github-bridge-/);
    expect(source.startsWith(path.join(root, 'userData'))).toBe(false);
    const args = importer.args;
    expect(args.slice(0, 7)).toEqual([
      'import',
      '--home',
      path.join(root, 'R'),
      '--lock-dir',
      path.join(root, 'AppData', 'Freedom', 'locks'),
      '--source',
      source,
    ]);
    // Main's protected roots, resolved: this profile's directory's entries
    // and the lock directory among them; never the clone's.
    const roots = args.flatMap((arg, i) => (args[i - 1] === '--protected' ? [arg] : []));
    expect(roots).toContain(path.join(root, 'AppData', 'Freedom', 'locks'));
    expect(roots).toContain(path.join(root, 'userData', 'identity'));
    for (const r of roots) expect(source.startsWith(r) || r.startsWith(source)).toBe(false);
    expect(args.slice(-2)).toEqual(['--parent-pid', String(process.pid)]);
    // `path` is `--source`, and the import process found the working copy
    // as git made it.
    expect(importer.sent('rad.import_repo')[0].params).toEqual({
      path: source,
      name: 'freedom-browser',
      description: 'A browser.',
      default_branch: 'main',
    });
    expect(seenByImport).toEqual(clones[0].files);
    // The clone is removed after the import.
    expect(fs.existsSync(path.dirname(source))).toBe(false);
  });

  test("'already exists in storage' is a repository already bridged; the node starts again", async () => {
    await startNode();
    importAnswers.push((message, child) =>
      child.error(message.id, 'failed', `${IMPORT_RID} already exists in storage`)
    );
    const { result, progress } = await bridgeImport();
    expect(result).toEqual({
      success: false,
      error: {
        code: 'ALREADY_BRIDGED',
        message: 'This GitHub repository is already bridged to Radicle.',
        details: { rid: IMPORT_RID.slice(4) },
      },
      step: 'initializing',
      rid: IMPORT_RID.slice(4),
    });
    expect(progress.map((p) => p.step)).not.toContain('error');
    expect(manager.getCurrentStatus().status).toBe('running');
  });

  test.each([
    [
      'unsupported_layout',
      "the repository is, contains, or lies inside a directory of Freedom's own",
    ],
    ['invalid_argument', 'the working copy has no branch main'],
    ['needs_vault', 'the node runs with a throwaway key: publishing needs a vault'],
    // Its own words for a timeout or a network error reach the user as they are.
    ['failed', 'the import timed out: could not resolve host'],
  ])("%s: the import's failure with the service's message", async (code, message) => {
    await startNode();
    importAnswers.push((request, child) => child.error(request.id, code, message));
    const { result, progress } = await bridgeImport();
    expect(result).toEqual({ success: false, error: { code: 'IMPORT_FAILED', message } });
    expect(progress.at(-1)).toEqual({ step: 'error', message });
    expect(imports()[0].sent('rad.import_repo')).toHaveLength(1);
    expect(manager.getCurrentStatus().status).toBe('running');
  });
});

describe('a kill or the deadline with the import sent', () => {
  test.each([
    ['a kill', (child) => child.exit(null, 'SIGKILL')],
    ["the process's deadline (exit 70)", (child) => child.exit(70)],
  ])('%s: outcome unknown, never sent again, and the next start reconciles', async (_, end) => {
    await startNode();
    importAnswers.push((message, child) => setImmediate(() => end(child)));
    const { result } = await bridgeImport();
    expect(result).toEqual({
      success: false,
      error: { code: 'IMPORT_FAILED', message: OUTCOME_UNKNOWN_TEXT },
    });
    expect(imports()).toHaveLength(1);
    expect(imports()[0].sent('rad.import_repo')).toHaveLength(1);
    // The node is started again, and that start reconciles the home.
    expect(serves()).toHaveLength(2);
    expect(serves()[1].sent('rad.reconcile')).toHaveLength(1);
    expect(manager.getCurrentStatus().status).toBe('running');
  });
});

describe('refused before anything runs', () => {
  test('a node running with a throwaway key: nothing is cloned, stopped or spawned', async () => {
    ephemeral = true;
    vault.sealRadicleKey.mockRejectedValue(Object.assign(new Error('none'), { code: 'no_vault' }));
    vault.status.mockResolvedValue({ exists: false, unlocked: false });
    await startNode();
    const { result } = await bridgeImport();
    expect(result).toMatchObject({ success: false, error: { code: 'RADICLE_NEEDS_VAULT' } });
    expect(clones).toEqual([]);
    expect(imports()).toEqual([]);
    expect(serves()[0].sent('rad.shutdown')).toEqual([]);
  });

  test('a private window: refused, nothing cloned', async () => {
    await startNode();
    const { result } = await bridgeImport({ sender: { private: true } });
    expect(result).toEqual({
      success: false,
      error: {
        code: 'RADICLE_PRIVATE_WINDOW',
        message: 'Importing is not available in private windows',
      },
    });
    await expect(
      handlers.get(IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES)({ private: true })
    ).resolves.toMatchObject({ success: false, error: { code: 'RADICLE_PRIVATE_WINDOW' } });
    expect(clones).toEqual([]);
    expect(imports()).toEqual([]);
  });

  test('a node that is not running: refused by the manager, and nothing is spawned', async () => {
    const embedded = require('../radicle-embedded');
    await expect(embedded.importRepo(root, 'x', 'y', 'main')).rejects.toMatchObject({
      code: 'RADICLE_NOT_RUNNING',
    });
    expect(service.children).toEqual([]);
    const { result } = await bridgeImport();
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RADICLE_NOT_RUNNING' },
      step: 'checking-radicle',
    });
  });
});

describe('while an import runs', () => {
  test("the bridge's check doesn't require the node running, and the node comes back after", async () => {
    await startNode();
    let answer;
    importAnswers.push((message, child) => {
      answer = () => child.result(message.id, { rid: IMPORT_RID });
    });
    const imported = bridgeImport();
    await waitUntil(() => Boolean(answer));
    expect(manager.getCurrentStatus().status).toBe('stopped');
    expect(manager.radicleImportPending()).toBe(true);
    await expect(handlers.get(IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES)({})).resolves.toMatchObject({
      success: true,
    });
    answer();
    await expect(imported).resolves.toMatchObject({ result: { success: true } });
    expect(manager.radicleImportPending()).toBe(false);
    expect(manager.getCurrentStatus().status).toBe('running');
  });

  test('a stop before the import is sent ends it with nothing imported, and the node stays stopped', async () => {
    await startNode();
    service.script.reconcile = (message, child) => {
      if (child.args[0] === 'serve') {
        child.result(message.id, {
          was_dirty: false,
          repaired: {},
          quarantined: { count: 0, first: [] },
        });
      }
      // The import process's reconciliation runs on until the stop.
    };
    const imported = bridgeImport();
    await waitUntil(() => imports()[0]?.sent('rad.reconcile').length === 1);
    await manager.stopRadicle();
    const { result } = await imported;
    expect(result).toEqual({
      success: false,
      error: {
        code: 'IMPORT_FAILED',
        message: 'Radicle was stopped before the import started; nothing was imported.',
      },
    });
    expect(imports()[0].sent('rad.import_repo')).toEqual([]);
    expect(imports()[0].exited).toBe(true);
    expect(serves()).toHaveLength(1);
    expect(manager.getCurrentStatus().status).toBe('stopped');
  });

  test('a stop once the import is sent waits for its answer, and the node stays stopped', async () => {
    await startNode();
    let answer;
    importAnswers.push((message, child) => {
      answer = () => child.result(message.id, { rid: IMPORT_RID });
    });
    const imported = bridgeImport();
    await waitUntil(() => Boolean(answer));
    const stopped = manager.stopRadicle();
    await sleep(20);
    expect(imports()[0].exited).toBe(false);
    answer();
    await expect(imported).resolves.toMatchObject({ result: { success: true } });
    await stopped;
    expect(serves()).toHaveLength(1);
    expect(manager.getCurrentStatus().status).toBe('stopped');
  });
});
