/**
 * freedom-core's `vectors/radicle-stats.json` through the node on the
 * service (the radicled step-5 plan's B6, and its Parity table: "readiness
 * from `node`/`node_alive`", and "the same count from the service" as
 * `getConnections` gives from the add-on's `status`). Each case's
 * `result_text`, the `rad.stats` result the service writes in that state,
 * is the first stats reply a fake service gives after `rad.start`:
 *
 * - **readiness** (0008, Main's side): the node is up, and running, exactly
 *   when the reply says `node_alive`; before the first count, with its
 *   thread ended, down and stopped, it isn't;
 * - **the count main shows**: for each `connections` case, the node's peer
 *   count is the one main showed over the add-on's `status` (its recorded
 *   `main`), which the manager's `getConnections` gives on the service.
 *
 * The vectors are read as radicle-vectors.test.js reads them:
 * FREEDOM_CORE_RADICLE_VECTORS (CI names it, and then the file must be
 * there), FREEDOM_CORE_VECTORS's directory, or the freedom-core checkout
 * FREEDOM_CORED_PATH was built in; otherwise the suite is skipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-grant', () => ({ radicleGrantRefusal: jest.fn(() => null) }));

const { RadicledNode } = require('./radicled-node');
const { fakeRadicled } = require('../../../test/helpers/fake-radicled');

const FILE = 'radicle-stats.json';

function vectorsDir() {
  if (process.env.FREEDOM_CORE_RADICLE_VECTORS) return process.env.FREEDOM_CORE_RADICLE_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) return path.dirname(process.env.FREEDOM_CORE_VECTORS);
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors');
    if (fs.existsSync(path.join(candidate, FILE))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const dir = vectorsDir();
const file = dir && path.join(dir, FILE);
const vectors = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

(process.env.FREEDOM_CORE_RADICLE_VECTORS ? test : test.skip)(
  'the stats vectors FREEDOM_CORE_RADICLE_VECTORS names are there',
  () => {
    expect(vectors).not.toBeNull();
  }
);

/** Lets the pipes and promises run. */
async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

(vectors ? describe : describe.skip)(`${FILE} through the node on the service`, () => {
  let root;
  let node;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicled-node-vectors-'));
  });

  afterEach(async () => {
    await node?.stop();
    node = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A node whose service answers every `rad.stats` with `result`: the
   * node after its first reply. */
  async function nodeAnswering(result) {
    const service = fakeRadicled({ stats: (m, c) => c.result(m.id, result) });
    node = new RadicledNode({
      home: path.join(root, 'home'),
      lockDir: path.join(root, 'locks'),
      ownHome: path.join(root, 'radicled-home'),
      keys: {
        status: async () => ({ exists: true, unlocked: true }),
        seal: async () => ({ enc: 'ZW5j', ciphertext: 'Y2lwaGVydGV4dA==' }),
        switchHome: async () => ({ status: 'installed' }),
        onVaultEvent: () => () => {},
      },
      guard: { blockReason: () => null, block() {}, unblock() {} },
      removeStaleSocket: async () => false,
      spawn: service.spawn,
      log: { info() {}, warn() {}, error() {} },
      shellVersion: 'jest',
      // Inert: the replies come from the start alone.
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    void node.start();
    await settle();
    expect(service.children).toHaveLength(1);
    expect(service.children[0].sent('rad.stats')).toHaveLength(1);
    return node;
  }

  const cases = vectors?.cases ?? [];
  test.each(cases.map((c) => [c.id, c.result_text]))(
    '%s: up exactly when the reply says node_alive',
    async (_id, text) => {
      const result = JSON.parse(text);
      await nodeAnswering(result);
      const alive = result.node_alive === true;
      expect(node.isUp()).toBe(alive);
      expect(node.state).toBe(alive ? 'running' : 'starting');
      expect(node.connectedPeers()).toBe(
        Number.isInteger(result.connected_peers) ? result.connected_peers : null
      );
    }
  );

  const connections = vectors?.connections ?? [];
  test.each(connections.map((c) => [c.id, c.result_text, c.main.connections.count]))(
    "%s: the count main shows is the add-on's",
    async (_id, text, count) => {
      await nodeAnswering(JSON.parse(text));
      expect(node.isUp()).toBe(true);
      // radicle-manager.js's getConnections on the service: the count, or
      // 0 before the first.
      expect(node.connectedPeers() ?? 0).toBe(count);
    }
  );
});
