/**
 * The bundled antd, offline, for the e2e suites that drive window.swarm
 * against it (src/main/page/page-swarm-node.integration.test.js; freedom-core
 * design 0015, SWM-7's Done-when; the SWM-6 to SWM-9 plan's PR 7.7).
 *
 * - **The node** (`startAntd`): the antd `npm run ant:download` fetched, its
 *   API on a loopback port, its one bootnode a closed loopback port, no
 *   peerstore and no control socket, so nothing leaves the machine. Its log
 *   is kept: with `ant_gateway=debug` each `/bzz` upload it takes logs the
 *   manifest root it assembled (`manifestRoots`) before it pushes.
 * - **Postage** (`startFakeGnosis`): antd reads its batch's owner, depth,
 *   bucket depth and immutability from the PostageStamp contract at start.
 *   A loopback JSON-RPC answers those reads for one batch owned by the key
 *   antd is given, so antd lists the batch usable and stamps what it is
 *   sent. It has no peers, so every push fails ("no peers available"):
 *   antd answers an upload 502 after it has read and assembled the whole
 *   body.
 * - **Its chunk cache** (`seedChunks`): Ant's own `chunks.sqlite`
 *   (ant-retrieval's `disk_cache.rs`), which it serves a read from with no
 *   peer. What the network would store is put there: a feed's entries, and
 *   the chunks of an upload antd couldn't push (`collectionManifest`).
 * - **A tap** (`startTap`) in front of it, on loopback: every connection's
 *   bytes relayed untouched both ways, each request read as it crosses
 *   (its head, framing, body bytes, whether it came whole, the node's
 *   status, an upgrade), and a request's body held after a number of bytes
 *   (its client's socket paused) until it is let go.
 * - **Swarm's trees** as antd builds them: `swarmTree` (leaves of 4096
 *   bytes, intermediate chunks of up to 128 references, no erasure coding,
 *   no encryption), `feedEntry` (a sequence feed's SOC at an index, signed
 *   by a test key, wrapping the root chunk of its data), and
 *   `collectionManifest`: the mantaray manifest antd's tar upload writes
 *   (ant-retrieval `manifest_writer.rs` at v0.5.77, `build_collection_trie`
 *   and `serialize_node`), for files of at most one chunk each, so a
 *   manifest root antd logged can be checked against the files it names and
 *   its chunks put in the cache.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const core = require('@ethersphere/core-sdk');

const PLATFORM = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
const ANTD = path.join(
  __dirname,
  '..',
  '..',
  'ant-bin',
  `${PLATFORM}-${process.arch}`,
  process.platform === 'win32' ? 'antd.exe' : 'antd'
);
// A peer that can't be dialled: the node's one bootnode, a closed port.
const BOOTNODE = '/ip4/127.0.0.1/tcp/9/p2p/16Uiu2HAm4v86W3bmT1BiH6oSPzcsSr24iDQpSN5Qa992BCjjwgrD';
// PostageStamp's getters antd calls at start (its upload runtime), by selector.
const POSTAGE_GETTERS = {
  batchOwner: '0x2182ddb1',
  batchDepth: '0x44beae8e',
  batchBucketDepth: '0x32ac57dd',
  batchImmutableFlag: '0xd968f44b',
  batchNormalisedBalance: '0xdf674385',
  batchLastUpdatedBlockNumber: '0x81e508b9',
  remainingBalance: '0xd71ba7c4',
  currentTotalOutPayment: '0x51b17cd0',
  lastPrice: '0x053f14da',
};

/** A free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A loopback Gnosis JSON-RPC answering PostageStamp's batch getters for one
 * batch, owned by `owner` (an address), at depth 22 and bucket depth 16,
 * immutable and funded; anything else is an RPC error. `calls` holds each
 * method asked.
 */
async function startFakeGnosis({ owner }) {
  const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const num = (n) => word(BigInt(n).toString(16));
  const answers = {
    [POSTAGE_GETTERS.batchOwner]: word(owner),
    [POSTAGE_GETTERS.batchDepth]: num(22),
    [POSTAGE_GETTERS.batchBucketDepth]: num(16),
    [POSTAGE_GETTERS.batchImmutableFlag]: num(1),
    [POSTAGE_GETTERS.batchNormalisedBalance]: num(10n ** 15n),
    [POSTAGE_GETTERS.batchLastUpdatedBlockNumber]: num(1000),
    [POSTAGE_GETTERS.remainingBalance]: num(10n ** 15n),
    [POSTAGE_GETTERS.currentTotalOutPayment]: num(0),
    [POSTAGE_GETTERS.lastPrice]: num(24000),
  };
  const calls = [];
  const answer = (message) => {
    calls.push(message?.method);
    const data = message?.method === 'eth_call' ? String(message.params?.[0]?.data || '') : '';
    const result = answers[data.slice(0, 10)];
    if (result) return { jsonrpc: '2.0', id: message.id, result: `0x${result}` };
    return {
      jsonrpc: '2.0',
      id: message?.id ?? null,
      error: { code: -32000, message: 'not served here' },
    };
  };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('end', () => {
      let message = null;
      try {
        message = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        // Answered as an error below.
      }
      const out = JSON.stringify(Array.isArray(message) ? message.map(answer) : answer(message));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(out),
      });
      res.end(out);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Puts `chunks` (`[addressHex, wire bytes]`) in antd's chunk cache at
 * `file` (`chunks.sqlite`, Ant's own table), each served as stored.
 */
function seedChunks(file, chunks) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    // antd holds the cache open (WAL): wait out its write lock.
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      address BLOB PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL,
      last_access INTEGER NOT NULL, inserted_at INTEGER NOT NULL,
      pin_count INTEGER NOT NULL DEFAULT 0)`);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO chunks (address, data, size, last_access, inserted_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Math.floor(Date.now() / 1000);
    for (const [address, wire] of chunks) {
      const data = Buffer.from(wire);
      insert.run(Buffer.from(address, 'hex'), data, data.length, now, now);
    }
  } finally {
    db.close();
  }
}

/**
 * Starts antd on `dir` with its API on a free loopback port, offline; with
 * `postage` (`{ batch, ownerKey, rpcUrl }`), the batch bound for uploads
 * and read from `rpcUrl`. Resolves once its API answers (and lists the
 * batch usable). Its log (stdout and stderr, without colour) is kept.
 */
async function startAntd({ dir, postage = null, logLevel = 'warn,ant_gateway=debug' }) {
  if (!fs.existsSync(ANTD)) throw new Error(`antd is missing at ${ANTD}: run npm run ant:download`);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const args = [
    '--data-dir',
    dir,
    '--api-addr',
    `127.0.0.1:${port}`,
    '--no-control-socket',
    '--no-peerstore',
    '--bootnodes',
    BOOTNODE,
    // No on-chain recovery scans, and no chequebook spending.
    '--gnosis-logs-rpc-url=',
    '--no-auto-chequebook',
    '--log-level',
    logLevel,
  ];
  if (postage) {
    args.push(
      '--gnosis-rpc-url',
      postage.rpcUrl,
      '--postage-batch',
      `0x${postage.batch}`,
      '--postage-owner-key',
      `0x${postage.ownerKey.replace(/^0x/, '')}`
    );
  }
  const child = spawn(ANTD, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GNOSIS_RPC_URL: '', NO_COLOR: '1', RUST_LOG_STYLE: 'never' },
    windowsHide: true,
  });
  const node = { child, origin, port, dir, log: '' };
  const keep = (chunk) => {
    // eslint-disable-next-line no-control-regex
    node.log += String(chunk).replace(/\u001b\[[0-9;]*m/g, '');
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  node.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
  };
  /** Each manifest root antd logged assembling a `/bzz` upload, in order. */
  node.manifestRoots = () =>
    [...node.log.matchAll(/bzz upload assembled[^\n]*manifest_root=([0-9a-f]{64})/g)].map(
      (m) => m[1]
    );
  for (let waited = 0; ; waited += 200) {
    try {
      const res = await fetch(`${origin}/${postage ? 'stamps' : 'node'}`);
      const text = await res.text();
      if (
        res.ok &&
        (!postage || JSON.parse(text).stamps?.some((s) => s.batchID === postage.batch && s.usable))
      )
        break;
    } catch {
      // Not yet listening.
    }
    if (waited > 30_000 || child.exitCode !== null) {
      await node.stop();
      throw new Error(`antd did not start (exit ${child.exitCode}):\n${node.log.slice(-8192)}`);
    }
    await sleep(200);
  }
  return node;
}

/**
 * Reads one direction of an HTTP/1.1 connection as messages, as they cross
 * it: each one's first line and headers, its framing (`chunked`, `length`
 * or `none`), its body's bytes, and whether it came whole (a chunked body's
 * last chunk and trailer, a length's last byte). After a message with an
 * `upgrade` header the rest of the connection is the upgraded protocol's,
 * read no further.
 */
class MessageReader {
  constructor(onHead, onBody = () => {}) {
    this.onHead = onHead;
    this.onBody = onBody;
    this.buf = Buffer.alloc(0);
    this.state = 'head';
    this.message = null;
    this.left = 0;
  }

  take(bytes) {
    this.message.bytes += bytes.length;
    this.onBody(this.message, bytes.length);
  }

  finish() {
    this.message.whole = true;
    this.state = this.message.upgrade ? 'upgraded' : 'head';
  }

  push(data) {
    if (this.state === 'upgraded') return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    for (;;) {
      if (this.state === 'upgraded') return;
      if (this.state === 'head') {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [first, ...lines] = this.buf.subarray(0, end).toString('latin1').split('\r\n');
        this.buf = this.buf.subarray(end + 4);
        const headers = {};
        for (const line of lines) {
          const colon = line.indexOf(':');
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        const chunked = /chunked/i.test(headers['transfer-encoding'] ?? '');
        const length = headers['content-length'];
        this.message = {
          first,
          headers,
          framing: chunked ? 'chunked' : length !== undefined ? 'length' : 'none',
          bytes: 0,
          whole: false,
          upgrade: Boolean(headers.upgrade) || /^HTTP\/1\.1 101/.test(first),
        };
        this.onHead(this.message);
        if (chunked) this.state = 'size';
        else if (length !== undefined && Number(length) > 0) {
          this.left = Number(length);
          this.state = 'fixed';
        } else this.finish();
      } else if (this.state === 'fixed' || this.state === 'data') {
        const k = Math.min(this.left, this.buf.length);
        if (k) this.take(this.buf.subarray(0, k));
        this.buf = this.buf.subarray(k);
        this.left -= k;
        if (this.left) return;
        if (this.state === 'fixed') this.finish();
        else this.state = 'crlf';
      } else if (this.state === 'crlf') {
        if (this.buf.length < 2) return;
        this.buf = this.buf.subarray(2);
        this.state = 'size';
      } else if (this.state === 'size' || this.state === 'trailer') {
        const end = this.buf.indexOf('\r\n');
        if (end < 0) return;
        const line = this.buf.subarray(0, end).toString('latin1');
        this.buf = this.buf.subarray(end + 2);
        if (this.state === 'trailer') {
          if (!line) this.finish();
          continue;
        }
        this.left = parseInt(line.split(';')[0], 16);
        this.state = this.left ? 'data' : 'trailer';
      }
    }
  }
}

/**
 * A loopback relay in front of the node at `upstreamPort`. `requests` holds
 * every request in order: `{ method, target, headers, framing, bytes,
 * whole, upgrade, status, clientEnded }`, `status` the node's answer
 * (null until it comes) and `clientEnded` set once the client's side of
 * the connection closed. `holdBody(match, after)` pauses the client's
 * socket once the next request `match(request)` takes has sent `after`
 * body bytes; `held` then names it, and `letGo()` resumes it.
 */
async function startTap(upstreamPort) {
  const requests = [];
  const connections = new Set();
  const tap = { requests, hold: null, held: null };
  const server = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    const connection = { client, upstream };
    connections.add(connection);
    const unanswered = [];
    const mine = [];
    const asked = new MessageReader(
      (message) => {
        const [method, target] = message.first.split(' ');
        const request = Object.assign(message, {
          method,
          target,
          status: null,
          clientEnded: false,
        });
        requests.push(request);
        mine.push(request);
        unanswered.push(request);
      },
      (request) => {
        const { hold } = tap;
        if (!hold || tap.held || !hold.match(request) || request.bytes < hold.after) return;
        tap.held = { request, client };
        client.pause();
        hold.reached();
      }
    );
    const answers = new MessageReader((message) => {
      const request = unanswered.shift();
      if (request) request.status = Number(message.first.split(' ')[1]);
    });
    client.on('data', (data) => {
      asked.push(data);
      upstream.write(data);
    });
    upstream.on('data', (data) => {
      answers.push(data);
      client.write(data);
    });
    const clientGone = () => {
      for (const request of mine) request.clientEnded = true;
    };
    client.on('end', () => {
      clientGone();
      upstream.end();
    });
    client.on('close', () => {
      clientGone();
      connections.delete(connection);
      upstream.destroy();
    });
    upstream.on('end', () => client.end());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  tap.port = server.address().port;
  tap.url = `http://127.0.0.1:${tap.port}`;
  tap.holdBody = (match, after) =>
    new Promise((reached) => {
      tap.held = null;
      tap.hold = { match, after, reached };
    });
  tap.letGo = () => {
    const held = tap.held;
    tap.hold = null;
    tap.held = null;
    held?.client.resume();
  };
  tap.close = async () => {
    tap.letGo();
    for (const { client, upstream } of connections) {
      client.destroy();
      upstream.destroy();
    }
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return tap;
}

// ---------------------------------------------------------------------------
// Swarm's trees, as antd builds and reads them.

const CHUNK = 4096;
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** A content-addressed chunk of `payload` with `span`: `[addressHex, wire]`. */
function cac(payload, span = payload.length) {
  const chunk = core.makeContentAddressedChunk(payload, BigInt(span));
  return {
    address: chunk.address.toHex(),
    wire: Buffer.from(chunk.data),
    payload: Buffer.from(payload),
    span,
  };
}

/**
 * `data` as Swarm's chunk tree: leaves of 4096 bytes, intermediate chunks of
 * up to 128 references, each span the length below it. `{ root, chunks }`,
 * `root` the root chunk (its address, wire, payload and span) and `chunks`
 * every chunk as `[addressHex, wire]`, the root's included.
 */
function swarmTree(data) {
  const bytes = Buffer.from(data);
  const chunks = [];
  let level = [];
  for (let at = 0; at < bytes.length || at === 0; at += CHUNK) {
    const leaf = cac(bytes.subarray(at, Math.min(at + CHUNK, bytes.length)));
    chunks.push([leaf.address, leaf.wire]);
    level.push(leaf);
    if (bytes.length === 0) break;
  }
  while (level.length > 1) {
    const up = [];
    for (let i = 0; i < level.length; i += 128) {
      const group = level.slice(i, i + 128);
      const node = cac(
        Buffer.concat(group.map((c) => Buffer.from(c.address, 'hex'))),
        group.reduce((sum, c) => sum + c.span, 0)
      );
      chunks.push([node.address, node.wire]);
      up.push(node);
    }
    level = up;
  }
  return { root: level[0], chunks };
}

/** A sequence feed's identifier at `index`: keccak256(topic ‖ index, 8 bytes big-endian). */
function feedIdentifier(topicHex, index) {
  const at = Buffer.alloc(8);
  at.writeBigUInt64BE(BigInt(index));
  return hex(core.keccak256(Buffer.concat([Buffer.from(topicHex, 'hex'), at])));
}

/**
 * A sequence feed's entry at `index`, signed by `privateKey`: a SOC wrapping
 * the root chunk of `data` (its span the data's length), with every chunk
 * of the data. `{ owner, socAddress, root, chunks }`.
 */
function feedEntry({ privateKey, topic, index, data }) {
  const tree = swarmTree(data);
  const wrapped = core.makeContentAddressedChunk(tree.root.payload, BigInt(tree.root.span));
  const soc = wrapped.toSingleOwnerChunk(
    new core.Identifier(feedIdentifier(topic, index)),
    privateKey.replace(/^0x/, '')
  );
  return {
    owner: soc.owner.toHex(),
    socAddress: soc.address.toHex(),
    root: tree.root.address,
    chunks: [...tree.chunks, [soc.address.toHex(), Buffer.from(soc.data)]],
  };
}

// The mantaray manifest antd's tar upload writes (manifest_writer.rs).
const VERSION_HASH_31 = Buffer.from(core.keccak256(Buffer.from('mantaray:0.2'))).subarray(0, 31);
const NODE_TYPE_VALUE = 2;
const NODE_TYPE_EDGE = 4;
const NODE_TYPE_PATH_SEPARATOR = 8;
const NODE_TYPE_WITH_METADATA = 16;
const MAX_PREFIX = 30;
// antd's `content_type_from_extension` (Go's builtin table), for the
// extensions the suites use; any other is the empty string, as Go's
// `mime.TypeByExtension` gives and antd stores.
const CONTENT_TYPES = {
  css: 'text/css; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
};

/** The Content-Type antd stores for a tar entry at `filePath`. */
function contentTypeOf(filePath) {
  const base = filePath.split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : (CONTENT_TYPES[base.slice(dot + 1).toLowerCase()] ?? '');
}

const newNode = () => ({ ref: null, metadata: null, forks: new Map() });
const pathSeparator = (bytes) => {
  const at = bytes.indexOf(0x2f);
  return at > 0;
};

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.subarray(0, n);
}

/** `trie_insert`: `rest` → `ref` under `node`. */
function trieInsert(node, rest, ref, metadata) {
  if (rest.length === 0) {
    node.ref = ref;
    node.metadata = metadata;
    return;
  }
  const first = rest[0];
  const fork = node.forks.get(first);
  if (fork) {
    const lcp = commonPrefix(fork.prefix, rest);
    if (lcp.length === fork.prefix.length) {
      fork.separator = pathSeparator(rest);
      trieInsert(fork.child, rest.subarray(lcp.length), ref, metadata);
    } else {
      const oldSuffix = fork.prefix.subarray(lcp.length);
      const intermediate = newNode();
      intermediate.forks.set(oldSuffix[0], {
        prefix: oldSuffix,
        child: fork.child,
        override: fork.override,
        separator: pathSeparator(oldSuffix),
      });
      trieInsert(intermediate, rest.subarray(lcp.length), ref, metadata);
      node.forks.set(first, {
        prefix: Buffer.from(lcp),
        child: intermediate,
        override: null,
        separator: pathSeparator(rest),
      });
    }
    return;
  }
  const head = rest.subarray(0, Math.min(rest.length, MAX_PREFIX));
  const tail = rest.subarray(head.length);
  const child = newNode();
  if (tail.length === 0) {
    child.ref = ref;
    child.metadata = metadata;
  } else {
    trieInsert(child, tail, ref, metadata);
  }
  node.forks.set(first, {
    prefix: Buffer.from(head),
    child,
    override: null,
    separator: pathSeparator(head),
  });
}

/** Go's `encoding/json` of a flat string map: keys sorted, HTML-escaped. */
function goJson(metadata) {
  const escape = (text) =>
    JSON.stringify(text)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  const keys = Object.keys(metadata).sort();
  return `{${keys.map((key) => `${escape(key)}:${escape(metadata[key])}`).join(',')}}`;
}

/** `serialize_fork_to_bytes`. */
function forkBytes(prefix, childRef, metadata, type) {
  const head = Buffer.alloc(2 + MAX_PREFIX);
  head[0] = type;
  head[1] = prefix.length;
  prefix.copy(head, 2);
  const parts = [head, childRef];
  if (metadata) {
    const json = Buffer.from(goJson(metadata), 'utf8');
    const withSize = json.length + 2;
    const pad = withSize < 32 ? 32 - withSize : withSize === 32 ? 0 : 32 - (withSize % 32);
    const padded = Buffer.concat([json, Buffer.alloc(pad, 0x0a)]);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(padded.length);
    parts.push(size, padded);
  }
  return Buffer.concat(parts);
}

/** `serialize_node`: post-order, each node one chunk; its reference. */
function serializeNode(node, chunks) {
  const childRefs = new Map();
  for (const key of [...node.forks.keys()].sort((a, b) => a - b)) {
    childRefs.set(key, serializeNode(node.forks.get(key).child, chunks));
  }
  const parts = [Buffer.alloc(32), VERSION_HASH_31];
  if (node.ref || node.forks.size) parts.push(Buffer.from([32]), node.ref || Buffer.alloc(32));
  else parts.push(Buffer.from([0]));
  const bitmap = Buffer.alloc(32);
  for (const key of node.forks.keys()) bitmap[key >> 3] |= 1 << (key & 7);
  parts.push(bitmap);
  for (const [key, ref] of childRefs) {
    const fork = node.forks.get(key);
    const metadata = fork.override || (fork.child.ref ? fork.child.metadata : null);
    let type = 0;
    if (fork.child.ref) type |= NODE_TYPE_VALUE;
    if (fork.child.forks.size) type |= NODE_TYPE_EDGE;
    if (metadata && Object.keys(metadata).length) type |= NODE_TYPE_WITH_METADATA;
    if (fork.separator) type |= NODE_TYPE_PATH_SEPARATOR;
    parts.push(
      forkBytes(fork.prefix, ref, metadata && Object.keys(metadata).length ? metadata : null, type)
    );
  }
  const payload = Buffer.concat(parts);
  if (payload.length > CHUNK) throw new Error(`a manifest node of ${payload.length} bytes`);
  const chunk = cac(payload);
  chunks.push([chunk.address, chunk.wire]);
  return Buffer.from(chunk.address, 'hex');
}

/**
 * The manifest antd writes for a tar of `files` (`{ path, bytes }`, each of
 * at most one chunk) with `swarm-index-document: indexDocument`: `{ root,
 * chunks }`, `chunks` the files' and the manifest's, as `[addressHex,
 * wire]`. `typeOf(filePath)` is each file's `Content-Type`: antd's table
 * (`contentTypeOf`) unless given. Bee's writer is the same, but it takes a
 * file's type from Go's `mime.TypeByExtension`, which reads the host's own
 * table too (the Windows registry, macOS's `/etc/apache2/mime.types`): there
 * a `.js` file is `application/javascript`, not antd's
 * `text/javascript; charset=utf-8`.
 */
function collectionManifest(files, indexDocument = null, typeOf = contentTypeOf) {
  const chunks = [];
  const root = newNode();
  for (const { path: filePath, bytes } of files) {
    if (bytes.length > CHUNK) throw new Error(`${filePath}: only files of one chunk here`);
    const data = cac(Buffer.from(bytes));
    chunks.push([data.address, data.wire]);
    trieInsert(root, Buffer.from(filePath, 'utf8'), Buffer.from(data.address, 'hex'), {
      'Content-Type': typeOf(filePath),
      Filename: filePath.split('/').pop(),
    });
  }
  if (indexDocument) {
    const anchor = newNode();
    anchor.ref = Buffer.alloc(32);
    anchor.metadata = {};
    root.forks.set(0x2f, {
      prefix: Buffer.from('/'),
      child: anchor,
      override: { 'website-index-document': indexDocument },
      separator: false,
    });
  }
  return { root: serializeNode(root, chunks).toString('hex'), chunks };
}

/** A fresh random hex string of `bytes` bytes. */
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

module.exports = {
  ANTD,
  collectionManifest,
  contentTypeOf,
  feedEntry,
  feedIdentifier,
  freePort,
  randomHex,
  seedChunks,
  sleep,
  startAntd,
  startFakeGnosis,
  startTap,
  swarmTree,
};
