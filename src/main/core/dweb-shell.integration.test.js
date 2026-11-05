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
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoreClient } = require('./core-client');
const { registerDwebShell } = require('./dweb-shell');

const binary = process.env.FREEDOM_CORED_PATH;
const vectorsDir = process.env.FREEDOM_CORE_DWEB_VECTORS;
const describeIfCore = binary && vectorsDir ? describe : describe.skip;
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

// freedom-core's tests/dweb.rs: a site's manifest and a site's CID, with
// their index documents.
const SITE_A = '3c8b9184787f719e7184f51b5c595a950d8cec49c765dc0e5a8f1c253e54591c';
const SITE_V1 = 'bafybeiguwjmddvr4iiah6ekgvrovb5zfb6eg5c6loikxvxlxzlwea5dabm';
const INDEX_HTML = '<!doctype html><title>site</title><p>index</p>\n';

/** The vectors' content: SHA-256(seed ‖ u64_be(i)), concatenated, cut. */
function content(seed, n) {
  const parts = [];
  let length = 0;
  for (let i = 0n; length < n; i++) {
    const index = Buffer.alloc(8);
    index.writeBigUInt64BE(i);
    const digest = crypto.createHash('sha256').update(seed).update(index).digest();
    parts.push(digest);
    length += digest.length;
  }
  return Buffer.concat(parts).subarray(0, n);
}

function readVectors(name) {
  return JSON.parse(fs.readFileSync(path.join(vectorsDir, name), 'utf8'));
}

/** The honest nodes, as freedom-core's binary tests read them. */
function honest() {
  const d = readVectors('dweb-verify.json');
  const chunks = new Map();
  for (const [address, wire] of Object.entries(d.swarm.chunks)) {
    chunks.set(address, Buffer.from(wire, 'base64'));
  }
  const files = new Map();
  for (const f of d.swarm.files) files.set(f.root, content(f.seed, f.size));
  for (const m of d.swarm.manifests) {
    for (const e of m.entries) {
      if (e.data_ref && e.seed) files.set(e.data_ref, content(e.seed, e.size));
    }
  }
  const blocks = new Map();
  for (const [cid, block] of Object.entries(d.ipfs.blocks)) {
    blocks.set(cid, Buffer.from(block, 'base64'));
  }
  for (const dir of d.ipfs.directories) {
    for (const e of dir.entries) {
      let bytes;
      if (typeof e.text === 'string') bytes = Buffer.from(e.text);
      else if (e.seed) bytes = content(e.seed, e.size);
      else continue;
      for (const leaf of e.leaves) {
        if (!blocks.has(leaf.cid)) {
          blocks.set(leaf.cid, bytes.subarray(leaf.from, leaf.from + leaf.length));
        }
      }
    }
  }
  return { chunks, files, blocks };
}

/** A local Ant and gateway serving `world`, recording what they are asked. */
function fakeNode(world) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push({ method: req.method, url: req.url, headers: req.headers });
    const send = (status, headers, body) => {
      res.writeHead(status, { ...headers, 'content-length': body.length });
      res.end(body);
    };
    const url = req.url;
    if (url.startsWith('/chunks/')) {
      const chunk = world.chunks.get(url.slice('/chunks/'.length));
      return chunk ? send(200, {}, chunk) : send(404, {}, Buffer.from('{}'));
    }
    if (url.startsWith('/bytes/')) {
      const file = world.files.get(url.slice('/bytes/'.length));
      if (!file) return send(404, {}, Buffer.alloc(0));
      const [from, to] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).slice(1).map(Number);
      const last = Math.min(to, file.length - 1);
      return send(
        206,
        { 'content-range': `bytes ${from}-${last}/${file.length}` },
        file.subarray(from, last + 1)
      );
    }
    if (url.includes('format=car')) {
      return send(200, { 'content-type': 'text/html' }, Buffer.from('<p>not a CAR</p>'));
    }
    if (url.startsWith('/ipfs/')) {
      const block = world.blocks.get(url.slice('/ipfs/'.length).split('?')[0]);
      return block
        ? send(200, { 'content-type': 'application/vnd.ipld.raw' }, block)
        : send(404, {}, Buffer.alloc(0));
    }
    return send(404, {}, Buffer.alloc(0));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, asked, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** A backend as the loopback transport dials one: undici, no redirects. */
function loopbackBackend(ref, url) {
  return {
    ref,
    url,
    request: ({ path: target, method, headers, signal }) =>
      fetch(`${url}${target}`, { method, headers, signal, redirect: 'manual' }),
  };
}

async function readAll(body) {
  const parts = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(Buffer.from(value));
  }
}

describeIfCore('dweb-shell.js with the real freedom-cored at protocol 2', () => {
  let root;
  let core;
  let shell;
  let node;
  let world;
  let plans;

  beforeAll(() => {
    world = honest();
    plans = readVectors('dweb-verify-plans.json');
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
      protocol: 2,
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
