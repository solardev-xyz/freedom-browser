/**
 * The Swarm node a window.swarm contract case scripts
 * (src/main/page/page-swarm.contract.test.js; freedom-core design 0015,
 * SWM-7, and its 2026-11-28 amendment): freedom-core's
 * `vectors/generator/swarm-node.js` and `swarm-run.js`'s `nodeWorld`, the
 * fake node the vectors were recorded against, on test/helpers/
 * fake-http-node.js, so both backends dial the same loopback node: the JS
 * backend over global fetch and `http.request` (bee-js, page-upload.js),
 * the core's through main's executor (core/swarm-shell.js, the node's
 * transport).
 *
 * A case's `node` is declarative: `stamps` (or `stamps_label_bytes`),
 * `addresses`, `tags` and `node` are JSON answers; `data` is stored as its
 * whole chunk tree (core-sdk's ChunkSplitter) and served joined from
 * `/bytes/<root>`; `chunks` are raw bytes at an address; `entries` are feed
 * updates, each a SOC signed with keys.json's test key (`wrap` stores the
 * data's tree and wraps its root chunk); `latest` are `GET /feeds`'
 * answers; `probes` name the feed updates a probe may ask for (`head`: the
 * updates 0 to `head` exist); `rules` are answers tried first, each with
 * the world change its request makes as it arrives. What the node computes
 * (content and SOC addresses, trees) is core-sdk's, the reference's own:
 * nothing either backend is tested on is computed here.
 *
 * Every request is recorded as it reached the node: its method, path,
 * query, body, the status it was answered with, and its headers: on the JS
 * backend as the caller set them (the fetch and `http.request` wrappers,
 * `install()`, tag each request with a sequence number, as the generator
 * did), on the core's as main's transport sent them, without the
 * transport's own. Global WebSocket is a fake that records the URL it was
 * opened for.
 */

const crypto = require('crypto');
const http = require('http');
const { startFakeHttpNode } = require('./fake-http-node');
const { dataOf } = require('./swarm-vectors');

const SEQ_HEADER = 'x-swarm-contract-seq';
// Header names a transport adds on its own, never a caller's.
const TRANSPORT_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'user-agent',
  'accept-language',
  'sec-fetch-mode',
  SEQ_HEADER,
]);
// The node's URL in every recorded text.
const NODE_URL = 'http://127.0.0.1:1633';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The usable batch the vectors' cases use (swarm-cases.js `batch`). */
function batch(over = {}) {
  return {
    batchID: 'a1'.repeat(32),
    utilization: 0,
    usable: true,
    label: 'freedom',
    depth: 22,
    amount: '100000000000',
    bucketDepth: 16,
    blockNumber: 1000,
    immutableFlag: true,
    exists: true,
    batchTTL: 864000,
    ...over,
  };
}

/**
 * A tar the core wrote, with its clock's mtimes as the reference's fixed
 * clock wrote them: each ustar header whose mtime is at or past `from`
 * (seconds, the run's start: only the core's own clock writes one there)
 * gets `seconds`, in the same width, and its checksum again. Anything else
 * is left as it came.
 */
function retimeTar(body, { seconds, from }) {
  const out = Buffer.from(body);
  for (let at = 0; at + 512 <= out.length; ) {
    const header = out.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = header.subarray(136, 148);
    const digits = field.indexOf(0) === -1 ? 11 : field.indexOf(0);
    const mtime = parseInt(field.subarray(0, digits).toString('latin1'), 8);
    if (Number.isFinite(mtime) && mtime >= from) {
      field.write(seconds.toString(8).padStart(digits, '0'), 0, digits, 'latin1');
      const sum = header.subarray(148, 156);
      const sumDigits = sum.indexOf(0) === -1 ? 6 : sum.indexOf(0);
      sum.fill(0x20);
      let total = 0;
      for (const byte of header) total += byte;
      sum.write(total.toString(8).padStart(sumDigits, '0'), 0, sumDigits, 'latin1');
      sum[sumDigits] = 0;
      sum[sumDigits + 1] = 0x20;
    }
    const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, ''), 8) || 0;
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A headers value as fetch or http.request take it, as `[name, value]` pairs, names lower-cased. */
function headerPairs(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function' && !Array.isArray(headers)) {
    return [...headers.entries()].map(([name, value]) => [name.toLowerCase(), String(value)]);
  }
  if (Array.isArray(headers)) return headers.map(([name, value]) => [String(name).toLowerCase(), String(value)]);
  return Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]);
}

/** A scripted reply from its JSON form. */
function replyOf(reply) {
  if (!reply || typeof reply === 'function') return reply;
  const out = { ...reply };
  if (reply.body_utf8 !== undefined) out.body = Buffer.from(reply.body_utf8, 'utf8');
  if (reply.body_hex !== undefined) out.body = Buffer.from(reply.body_hex, 'hex');
  if (reply.body_base64 !== undefined) out.body = Buffer.from(reply.body_base64, 'base64');
  if (reply.body_data !== undefined) out.body = dataOf(reply.body_data);
  if (reply.pieces_hex) out.pieces = reply.pieces_hex.map((p) => Buffer.from(p, 'hex'));
  if (reply.pieces_data) out.pieces = reply.pieces_data.map(dataOf);
  for (const key of ['body_utf8', 'body_hex', 'body_base64', 'body_data', 'pieces_hex', 'pieces_data']) delete out[key];
  return out;
}

/**
 * The libraries the node world is computed with, the reference's own:
 * bee-js 13.2.0's Topic and FeedIndex, core-sdk's chunks and SOCs.
 */
function libraries() {
  const beeJs = require('@ethersphere/bee-js');
  const core = require('@ethersphere/core-sdk');
  return { beeJs, core };
}

/**
 * The chunk tree of `data` as core-sdk's ChunkSplitter builds it, each
 * chunk as a node stores it (span ‖ unpadded payload).
 */
async function splitTree(core, data, piece = 4096) {
  const chunks = [];
  const wire = (chunk) => {
    const span = Buffer.alloc(8);
    span.writeBigUInt64LE(chunk.span);
    const payload = Buffer.from(chunk.writer.buffer.subarray(0, chunk.writer.cursor));
    return { address: chunk.hash().toHex(), span: chunk.span, payload, wire: Buffer.concat([span, payload]) };
  };
  const splitter = new core.ChunkSplitter(async (batched) => {
    for (const { chunk } of batched) chunks.push(wire(chunk));
    return [];
  });
  for (let offset = 0; offset < data.length; offset += piece) {
    await splitter.append(data.subarray(offset, Math.min(data.length, offset + piece)));
  }
  if (data.length === 0) await splitter.append(data);
  const root = wire(await splitter.finalize());
  return { root, chunks: [...chunks, root] };
}

/** The feed identifier keccak256(topic ‖ index as 8 bytes big-endian), by bee-js's FeedIndex. */
function feedIdentifier(libs, topic, index) {
  const feedIndex = libs.beeJs.FeedIndex.fromBigInt(BigInt(index));
  return new libs.core.Identifier(
    libs.core.keccak256(Buffer.concat([Buffer.from(topic.toUint8Array()), Buffer.from(feedIndex.toUint8Array())]))
  );
}

/** The indexes a feed's probes may ask for (swarm-run.js `candidateIndexes`). */
function candidateIndexes(targets) {
  const set = new Set();
  for (let i = 0; i <= 300; i++) set.add(i);
  for (let j = 0; j <= 41; j++) set.add(2 ** j);
  for (const t of targets) {
    for (let j = 0; j <= 41; j++) {
      const base = Math.floor(t / 2 ** j) * 2 ** j;
      set.add(base);
      if (j > 0) set.add(base + 2 ** (j - 1));
      set.add(t + 1);
    }
  }
  return [...set].filter((i) => Number.isSafeInteger(i) && i >= 0).sort((a, b) => a - b);
}

/**
 * The node's world from a case's declarative `node`, as swarm-run.js's
 * `nodeWorld` builds it. `keyOf(name)` is keys.json's test key (`bee`,
 * `publisher:<n>`); `trees` caches trees by their data's SHA-256.
 */
async function nodeWorld(spec = {}, { keyOf, trees }) {
  const libs = libraries();
  const { core, beeJs } = libs;
  const world = {
    stamps: spec.stamps_label_bytes ? { stamps: [batch({ label: 'l'.repeat(spec.stamps_label_bytes) })] } : spec.stamps,
    addresses: spec.addresses,
    tags: spec.tags,
    node: spec.node,
    chunks: new Map(),
    blobs: new Map(),
    feeds: [],
    feedIndex: new Map(),
    rules: (spec.rules || []).map((rule) => ({ ...rule, reply: replyOf(rule.reply), left: rule.times ?? Infinity })),
  };
  const treeOf = async (bytes) => {
    const key = sha256(bytes);
    if (!trees.has(key)) trees.set(key, await splitTree(core, bytes));
    return trees.get(key);
  };
  for (const d of spec.data || []) {
    const bytes = dataOf(d);
    const tree = await treeOf(bytes);
    for (const chunk of tree.chunks) world.chunks.set(chunk.address, chunk.wire);
    world.blobs.set(tree.root.address, bytes);
  }
  for (const c of spec.chunks || []) world.chunks.set(c.address, dataOf(c));
  for (const e of spec.entries || []) {
    const key = keyOf(e.key);
    const topic = beeJs.Topic.fromString(e.topic);
    const identifier = feedIdentifier(libs, topic, e.index);
    let cac;
    if (e.wrap) {
      const bytes = dataOf(e.data);
      const tree = await treeOf(bytes);
      for (const chunk of tree.chunks) world.chunks.set(chunk.address, chunk.wire);
      world.blobs.set(tree.root.address, bytes);
      cac = core.makeContentAddressedChunk(tree.root.payload, tree.root.span);
    } else {
      cac = core.makeContentAddressedChunk(dataOf(e.data));
    }
    const soc = cac.toSingleOwnerChunk(identifier, key.privateKey.replace(/^0x/, ''));
    world.chunks.set(soc.address.toHex(), Buffer.from(soc.data));
  }
  for (const l of spec.latest || []) {
    const owner = keyOf(l.key).address.slice(2).toLowerCase();
    const topic = beeJs.Topic.fromString(l.topic).toHex();
    world.feeds.push({ owner, topic, latest: replyOf(l.reply) });
  }
  for (const p of spec.probes || []) {
    const ownerHex = keyOf(p.key).address.slice(2).toLowerCase();
    const topic = beeJs.Topic.fromString(p.topic);
    const table = new Map();
    for (const index of candidateIndexes(p.targets || [])) {
      const id = feedIdentifier(libs, topic, index);
      const address = core.makeSOCAddress(id, new core.EthAddress(ownerHex)).toHex();
      world.feedIndex.set(address, { owner: ownerHex, index });
      table.set(address, index);
    }
    // A feed whose updates 0 to `head` exist: the probe reads only the
    // status, so a hit answers 105 zero bytes. `probeFail` answers one index
    // with its status.
    if (p.head !== undefined) {
      world.rules.push({
        match: { method: 'GET', prefix: '/chunks/' },
        left: Infinity,
        reply: (request, node) => {
          const index = table.get(request.path.slice('/chunks/'.length));
          if (index === undefined) return node.own(request);
          if (spec.probeFail && spec.probeFail.index === index) {
            return { status: spec.probeFail.status, json: { code: spec.probeFail.status, message: 'read chunk failed' } };
          }
          if (p.head !== null && index <= p.head) {
            return { status: 200, headers: { 'content-type': 'binary/octet-stream' }, body: Buffer.alloc(105) };
          }
          return node.own(request);
        },
      });
    }
  }
  return world;
}

function matches(match, request) {
  if (match.method && match.method !== request.method) return false;
  if (match.path && match.path !== request.path) return false;
  if (match.prefix && !request.path.startsWith(match.prefix)) return false;
  return true;
}

/**
 * The node: started on loopback over `world` (nodeWorld's), its requests
 * in `requests`. `onWorld(change)` hears a rule's world change as its
 * request arrives (awaited before the reply); `abortPage()` is called for
 * a reply marked `abortPage`.
 */
class ContractNode {
  constructor(world, { trees }) {
    this.libs = libraries();
    this.trees = trees;
    this.rules = world.rules;
    this.chunks = world.chunks;
    this.blobs = world.blobs;
    this.feeds = world.feeds;
    this.stamps = world.stamps;
    this.addresses = world.addresses;
    this.tags = world.tags || {};
    this.nodeInfo = world.node || { beeMode: 'light', chequebookEnabled: true, swapEnabled: true };
    this.feedIndex = world.feedIndex;
    this.requests = [];
    this.client = new Map();
    this.frames = new Map();
    this.seq = 0;
    this.websockets = [];
    this.bzzTag = 101;
    this.onWorld = null;
    this.abortPage = null;
    this.alias = null;
    // `{ seconds, from }`: the case's clock and the run's start, for a tar
    // the core's clock wrote (`retimeTar`).
    this.retime = null;
  }

  async start() {
    this.http = await startFakeHttpNode({ handler: (req, res) => this.handle(req, res) });
    this.port = this.http.port;
    this.url = this.http.origin;
    return this.url;
  }

  async stop() {
    await this.http?.close();
  }

  /** `text` with the node's port replaced by the vectors' fixed URL. */
  normalize(text) {
    if (typeof text !== 'string' || !this.port) return text;
    return text.split(`127.0.0.1:${this.port}`).join(NODE_URL.slice('http://'.length));
  }

  noteClient(via, method, url, headers) {
    this.seq += 1;
    const pairs = headerPairs(headers).filter(([name]) => !TRANSPORT_HEADERS.has(name));
    this.client.set(this.seq, { via, method, headers: pairs, url: String(url) });
    return this.seq;
  }

  /**
   * The JS backend's transports, wrapped as the generator wrapped them:
   * global fetch and `http.request` note the headers the caller set; a node
   * the world places elsewhere than loopback reaches this one. Global
   * WebSocket records the URL it is opened for, on both backends. Returns
   * the undo.
   */
  install({ wrapTransports }) {
    const node = this;
    const realFetch = globalThis.fetch;
    const realRequest = http.request;
    const realWebSocket = globalThis.WebSocket;
    if (wrapTransports) {
      globalThis.fetch = function fetch(input, init = {}) {
        let url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        if (node.alias && url.startsWith(`${node.alias.from}/`)) url = node.alias.to + url.slice(node.alias.from.length);
        const method = (init.method || 'GET').toUpperCase();
        const seq = node.noteClient('fetch', method, url, init.headers);
        const headers = [...headerPairs(init.headers), [SEQ_HEADER, String(seq)]];
        return realFetch(url, { ...init, headers }).then((response) => node.reframe(seq, response));
      };
      http.request = function request(url, options, callback) {
        const seq = node.noteClient('http', (options?.method || 'GET').toUpperCase(), url, options?.headers);
        return realRequest.call(http, url, { ...options, headers: { ...options?.headers, [SEQ_HEADER]: String(seq) } }, callback);
      };
    }
    globalThis.WebSocket = class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        node.websockets.push(node.normalize(String(url)));
        setImmediate(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.onopen?.({});
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type, fn) {
        this[`on${type}`] = fn;
      }

      removeEventListener() {}
    };
    return () => {
      globalThis.fetch = realFetch;
      http.request = realRequest;
      globalThis.WebSocket = realWebSocket;
    };
  }

  /** A chunked reply's body as the caller reads it: one frame per scripted piece (swarm-node.js `reframe`). */
  reframe(seq, response) {
    const lengths = (this.frames.get(seq) || []).filter((n) => n > 0);
    if (!lengths.length || !response.body) return response;
    const reader = response.body.getReader();
    let held = Buffer.alloc(0);
    let failure = null;
    const body = new ReadableStream(
      {
        async pull(controller) {
          if (failure) return controller.error(failure.err);
          for (;;) {
            if (lengths.length && held.length >= lengths[0]) {
              const n = lengths.shift();
              controller.enqueue(new Uint8Array(held.subarray(0, n)));
              held = held.subarray(n);
              return undefined;
            }
            let read;
            try {
              read = await reader.read();
            } catch (err) {
              if (!held.length) return controller.error(err);
              failure = { err };
              controller.enqueue(new Uint8Array(held));
              held = Buffer.alloc(0);
              return undefined;
            }
            if (read.done) {
              if (held.length) {
                controller.enqueue(new Uint8Array(held));
                held = Buffer.alloc(0);
                return undefined;
              }
              return controller.close();
            }
            held = Buffer.concat([held, Buffer.from(read.value)]);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  handle(req, res) {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('error', () => {});
    req.on('end', async () => {
      let body = Buffer.concat(parts);
      const tar = /application\/x-tar/.test(String(req.headers['content-type'] || ''));
      if (tar && req.method === 'POST' && this.retime) body = retimeTar(body, this.retime);
      const seq = Number(req.headers[SEQ_HEADER]);
      const client = this.client.get(seq);
      const url = new URL(req.url, this.url);
      const request = {
        seq,
        via: client ? client.via : 'main',
        method: req.method,
        path: url.pathname,
        query: [...url.searchParams.entries()],
        // The caller's headers on the JS backend; main's transport's on the
        // core's, without the transport's own.
        headers: client
          ? client.headers
          : headerPairs(req.rawHeaders.reduce((out, v, i, all) => (i % 2 ? out : [...out, [v, all[i + 1]]]), [])).filter(
              ([name]) => !TRANSPORT_HEADERS.has(name)
            ),
        body,
      };
      if (request.method === 'POST' && request.path.startsWith('/soc/')) request.socValid = this.socValid(request);
      this.requests.push(request);
      let reply;
      try {
        reply = await this.answer(request);
      } catch (err) {
        reply = { status: 599, statusText: 'Fake node failed', json: { message: String(err.stack || err) } };
      }
      this.send(res, reply, request);
    });
  }

  send(res, reply, request) {
    if (reply.abortPage) {
      this.abortPage?.();
      const { abortPage: _abort, ...rest } = reply;
      reply = rest;
    }
    if (reply.delayMs) {
      const { delayMs, ...rest } = reply;
      setTimeout(() => this.send(res, rest, request), delayMs).unref?.();
      return;
    }
    request.reply = { status: reply.status };
    if (reply.hangUp) {
      res.socket.destroy();
      return;
    }
    let body = reply.body ?? Buffer.alloc(0);
    if (reply.json !== undefined) body = Buffer.from(JSON.stringify(reply.json));
    if (typeof body === 'string') body = Buffer.from(body, 'utf8');
    const headers = { ...(reply.headers || {}) };
    if (reply.json !== undefined && !headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
    if (reply.chunked) {
      this.frames.set(request.seq, (reply.pieces || [body]).map((piece) => piece.length));
      res.writeHead(reply.status, reply.statusText || http.STATUS_CODES[reply.status] || '', headers);
      for (const piece of reply.pieces || [body]) res.write(piece);
      if (reply.cutAfterPieces) {
        res.socket.destroy();
        return;
      }
      res.end();
      return;
    }
    headers['content-length'] = String(reply.declare ?? body.length);
    res.writeHead(reply.status, reply.statusText ?? (http.STATUS_CODES[reply.status] || ''), headers);
    if (reply.declare !== undefined && reply.declare > body.length) {
      res.write(body);
      res.socket.destroy();
      return;
    }
    res.end(body);
  }

  async answer(request) {
    for (const rule of this.rules) {
      if (rule.left <= 0 || !matches(rule.match, request)) continue;
      rule.left -= 1;
      if (rule.world) await this.onWorld?.(rule.world);
      return typeof rule.reply === 'function' ? rule.reply(request, this) : rule.reply;
    }
    return this.own(request);
  }

  /** Whether a SOC upload's signature is its owner's, as a node checks it before anything else. */
  socValid(request) {
    const { core } = this.libs;
    try {
      const [, , owner, identifier] = request.path.split('/');
      const signature = new URLSearchParams(request.query).get('sig');
      const address = core.makeSOCAddress(new core.Identifier(identifier), new core.EthAddress(owner)).toHex();
      const data = Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(signature, 'hex'), request.body]);
      return core.unmarshalSingleOwnerChunk(data, address).owner.toHex() === owner.toLowerCase();
    } catch {
      return false;
    }
  }

  /** The node's own answers, over what it stores (swarm-node.js `own`). */
  async own(request) {
    const { core } = this.libs;
    const { method, path } = request;
    const notFound = { status: 404, statusText: 'Not Found', json: { code: 404, message: 'Not Found' } };
    if (method === 'GET' && path === '/node') return { status: 200, json: this.nodeInfo };
    if (method === 'GET' && path === '/stamps') return { status: 200, json: this.stamps ?? { stamps: [] } };
    if (method === 'GET' && path === '/addresses' && this.addresses) return { status: 200, json: this.addresses };
    if (method === 'GET' && path.startsWith('/tags/')) {
      const tag = this.tags[path.slice('/tags/'.length)];
      return tag ? { status: 200, json: tag } : notFound;
    }
    if (method === 'GET' && path.startsWith('/chunks/')) {
      const chunk = this.chunks.get(path.slice('/chunks/'.length));
      return chunk ? { status: 200, headers: { 'content-type': 'binary/octet-stream' }, body: chunk } : notFound;
    }
    if (method === 'GET' && path.startsWith('/bytes/')) {
      const blob = this.blobs.get(path.slice('/bytes/'.length));
      return blob ? { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: blob } : notFound;
    }
    if (method === 'GET' && path.startsWith('/feeds/')) {
      const [, , owner, topic] = path.split('/');
      const feed = this.feeds.find((f) => f.owner === owner && f.topic === topic);
      return feed?.latest ?? notFound;
    }
    if (method === 'POST' && path === '/chunks') {
      const span = request.body.subarray(0, 8);
      const payload = request.body.subarray(8);
      const address = core.makeContentAddressedChunk(payload, span.readBigUInt64LE(0)).address.toHex();
      this.chunks.set(address, request.body);
      return { status: 201, headers: { 'swarm-tag': '0' }, json: { reference: address } };
    }
    if (method === 'POST' && path.startsWith('/soc/')) {
      const [, , owner, identifier] = path.split('/');
      const signature = new URLSearchParams(request.query).get('sig');
      const address = core.makeSOCAddress(new core.Identifier(identifier), new core.EthAddress(owner)).toHex();
      const data = Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(signature, 'hex'), request.body]);
      this.chunks.set(address, data);
      return { status: 201, json: { reference: address } };
    }
    if (method === 'POST' && path === '/bytes') {
      const key = sha256(request.body);
      if (!this.trees.has(key)) this.trees.set(key, await splitTree(core, request.body));
      const tree = this.trees.get(key);
      for (const chunk of tree.chunks) this.chunks.set(chunk.address, chunk.wire);
      this.blobs.set(tree.root.address, Buffer.from(request.body));
      return { status: 201, headers: { 'swarm-tag': String(this.bzzTag++) }, json: { reference: tree.root.address } };
    }
    if (method === 'POST' && path === '/bzz') {
      return { status: 201, headers: { 'swarm-tag': String(this.bzzTag++) }, json: { reference: sha256(request.body) } };
    }
    if (method === 'POST' && path.startsWith('/feeds/')) {
      return { status: 201, json: { reference: sha256(Buffer.from(`feed manifest ${path}`)) } };
    }
    if (method === 'POST' && path.startsWith('/pss/send/')) return { status: 201, body: Buffer.alloc(0) };
    return {
      status: 500,
      statusText: 'Internal Server Error',
      json: { code: 500, message: `fake node: no answer for ${method} ${path}` },
    };
  }
}

/** A request as the vectors write it (swarm-run.js `requestRecord`), its body whole up to 8 KiB. */
function requestRecord(r, node) {
  const out = { via: r.via, method: r.method, path: r.path };
  if (r.query.length) out.query = r.query;
  if (r.headers.length) out.headers = r.headers;
  if (r.body.length) {
    out.body = r.body.length <= 8192 ? { bytes: r.body.length, base64: r.body.toString('base64') } : { bytes: r.body.length, sha256: sha256(r.body) };
  }
  out.status = r.reply?.status ?? null;
  const feed = r.method === 'GET' && r.path.startsWith('/chunks/') ? node.feedIndex.get(r.path.slice(8)) : undefined;
  if (feed) out.feed = feed;
  if (r.socValid !== undefined) out.soc_valid = r.socValid;
  return out;
}

/** keys.json's `abandon-12`: the Bee wallet's and the publishers' test keys, by name. */
function testKeys(keysJson) {
  const vector = keysJson.vectors.find((v) => v.id === 'abandon-12');
  if (!vector) throw new Error('keys.json lacks abandon-12');
  const publishers = new Map(vector.publisherKeys.map((k) => [k.originIndex, k]));
  const keyOf = (name) => {
    if (name === 'bee') return vector.beeWallet;
    const key = publishers.get(Number(name.split(':')[1]));
    if (!key) throw new Error(`no test key ${name}`);
    return key;
  };
  return { bee: vector.beeWallet, publishers, keyOf, mnemonic: vector.mnemonic };
}

module.exports = {
  ContractNode,
  nodeWorld,
  requestRecord,
  splitTree,
  testKeys,
};
