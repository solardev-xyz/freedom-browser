/**
 * `shell.dweb_get` against the real freedom-cored at protocol 2 (design
 * 0009, step 5c): main sends `dweb.verify` as the handler for `{ verify }`
 * plans will, the core walks the content and asks main for its pieces, and
 * dweb-shell.js fetches each from a local fake node, the honest nodes of
 * freedom-core's `vectors/dweb-verify.json` (Ant's chunks and files, the
 * gateway's raw blocks; it serves no CARs, so a CAR request falls back to
 * raw blocks, as in freedom-core's own binary tests). The verified bodies
 * are checked byte for byte.
 *
 * Skipped unless FREEDOM_CORED_PATH names a core that speaks protocol 2 and
 * FREEDOM_CORE_DWEB_VECTORS names freedom-core's `vectors` directory, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored \
 *   FREEDOM_CORE_DWEB_VECTORS=…/freedom-core/vectors \
 *   npx jest src/main/core/dweb-shell.integration.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoreClient } = require('./core-client');
const { registerDwebShell } = require('./dweb-shell');
const {
  SITE_A,
  SITE_V1,
  INDEX_HTML,
  content,
  readVectors,
  honest,
  fakeNode,
  loopbackBackend,
  readAll,
} = require('../../../test/helpers/dweb-verify-world');

const binary = process.env.FREEDOM_CORED_PATH;
const vectorsDir = process.env.FREEDOM_CORE_DWEB_VECTORS;
const describeIfCore = binary && vectorsDir ? describe : describe.skip;
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

describeIfCore('dweb-shell.js with the real freedom-cored at protocol 2', () => {
  let root;
  let core;
  let shell;
  let node;
  let world;
  let plans;

  beforeAll(() => {
    world = honest(vectorsDir);
    plans = readVectors(vectorsDir, 'dweb-verify-plans.json');
  });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dweb-shell-'));
    node = await fakeNode(world);
    core = new CoreClient({
      spawn,
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
      grantRoot: root,
    });
    shell = registerDwebShell(core, { log: quietLog });
    const hello = await core.start();
    expect(hello.protocol).toBe(2);
    expect(hello.capabilities).toEqual(expect.arrayContaining(['streams', 'dweb.verify']));
  });

  afterEach(async () => {
    await core?.stop();
    core = null;
    await new Promise((resolve) => node.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The vectors' verify plan for `nodeName`, aimed at `root` and `path`. */
  function plan(rootRef, target, headers = []) {
    const nodeName = rootRef.swarm ? 'ant' : 'ipfs';
    const vector = plans.requests.find((r) => r.plan?.verify?.node === nodeName);
    const out = structuredClone(vector.plan);
    Object.assign(out.verify, { root: rootRef, path: target, query: '', headers });
    return out;
  }

  /**
   * `dweb.verify` as the handler for `{ verify }` plans sends it: its
   * pieces' context opened under the ID and generation `onSent` reports,
   * and closed once its body has been read. The verified head and body.
   */
  async function verify(verifyPlan, { method = 'GET', car = null, backend } = {}) {
    let handle = null;
    const params = {
      plan: verifyPlan,
      method,
      partition: null,
      private: false,
      deadline_ms: 360_000,
    };
    if (car !== null) params.car = car;
    try {
      const { result, body } = await core.callStream(
        'dweb.verify',
        params,
        { caller: 'shell' },
        {
          onSent: (id, generation) => {
            handle = shell.open({ id, generation }, { backend, plan: verifyPlan });
          },
        }
      );
      return { result, bytes: body ? await readAll(body) : null };
    } finally {
      handle?.close();
    }
  }

  const ant = () => loopbackBackend({ ant: 'external', up: true }, node.url);
  const gateway = () => loopbackBackend({ ipfs: 'gateway', up: true }, node.url);

  test('Swarm: a verified GET and HEAD, every piece one of the forms main admits', async () => {
    const got = await verify(plan({ swarm: SITE_A }, '/index.html'), { backend: ant() });
    expect(got.result).toMatchObject({ status: 200, body: true, trust: { content: 'verified' } });
    expect(got.bytes.equals(content('site-index', 300))).toBe(true);

    const style = await verify(plan({ swarm: SITE_A }, '/style.css'), { backend: ant() });
    expect(style.bytes.equals(content('site-style', 5000))).toBe(true);

    const head = await verify(plan({ swarm: SITE_A }, '/style.css'), {
      method: 'HEAD',
      backend: ant(),
    });
    expect(head.result).toMatchObject({ status: 200, body: false });
    expect(head.bytes).toBeNull();

    expect(node.asked.length).toBeGreaterThan(0);
    for (const asked of node.asked) {
      expect(asked.method).toBe('GET');
      expect(asked.url).toMatch(/^\/(chunks|bytes)\/[0-9a-f]{64}$/);
      expect(asked.headers['swarm-redundancy-strategy']).toBe('3');
    }
    expect(shell.stats()).toEqual({ verifies: 0, pieces: 0 });
  });

  test('Swarm: a range is an exact 206 from a ranged /bytes stream', async () => {
    const got = await verify(plan({ swarm: SITE_A }, '/style.css', [['range', 'bytes=100-199']]), {
      backend: ant(),
    });
    expect(got.result.status).toBe(206);
    expect(got.bytes.equals(content('site-style', 5000).subarray(100, 200))).toBe(true);
  });

  test('IPFS: raw blocks, and a CAR the gateway does not serve falling back to them', async () => {
    for (const car of [false, true]) {
      node.asked.length = 0;
      const got = await verify(plan({ ipfs: SITE_V1 }, '/index.html'), { car, backend: gateway() });
      expect(got.result).toMatchObject({ status: 200, body: true, trust: { content: 'verified' } });
      expect(got.bytes.toString()).toBe(INDEX_HTML);
      const cars = node.asked.filter(({ url }) => url.includes('format=car'));
      expect(cars.length).toBe(car ? 1 : 0);
      for (const asked of node.asked) {
        expect(asked.method).toBe('GET');
        expect(asked.url).toMatch(
          /^\/ipfs\/[a-zA-Z0-9]+(\/[^?]*)?\?format=(raw|car&dag-scope=entity)/
        );
      }
    }
  });

  test('a node that is down: each piece fails unreachable, and the core answers its error plan', async () => {
    const down = await fakeNode(world);
    const downUrl = down.url;
    await new Promise((resolve) => down.server.close(resolve));
    const verifyPlan = plan({ ipfs: SITE_V1 }, '/index.html');
    const got = await verify(verifyPlan, {
      car: false,
      backend: loopbackBackend({ ipfs: 'gateway', up: true }, downUrl),
    });
    expect(got.result.error).toMatchObject({ status: expect.any(Number) });
    // The connection is intact: main broke no rule.
    await expect(core.request('vault.status')).resolves.toMatchObject({ exists: false });
  });
});
