/**
 * Local IPFS content for tests that drive a real IPFS node (the freedom-ipfs
 * add-on today, freedom-ipfsd later: freedom-core design 0007, "Tests
 * first") with no public network.
 *
 * - **Content:** UnixFS DAGs built here, with no dependency: raw leaves,
 *   dag-pb files over raw leaves, and dag-pb directories, every block
 *   addressed by a CIDv1 (base32, SHA-256).
 * - **The fixture:** loopback HTTP servers only.
 *   - The node's delegated router: `GET /routing/v1/providers/<cid>` answers
 *     a known CID with one HTTP provider (`/ip4/127.0.0.1/tcp/<port>/http`),
 *     and an unknown one with 404, as the Routing V1 API does.
 *   - The providers: `GET /ipfs/<cid>?format=raw` answers a block's bytes,
 *     as a trustless gateway does. A default one serves every block; a test
 *     that needs faults takes one of its own (`isolate()`), and makes it
 *     fail a block (`fail(cid, status)`) or hold it open until released
 *     (`stall(cid)`). Routing can be held the same way (`stallRouting()`).
 *   - Every request is recorded (`requests`), so a test can tell what the
 *     node asked for.
 */

const crypto = require('crypto');
const http = require('http');

const CODEC_RAW = 0x55;
const CODEC_DAG_PB = 0x70;
const MULTIHASH_SHA2_256 = 0x12;

/** UnixFS `Data.Type`. */
const UNIXFS_DIRECTORY = 1;
const UNIXFS_FILE = 2;

/** The leaf size the usual importers chunk files at. */
const CHUNK_BYTES = 256 * 1024;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function varint(value) {
  const out = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Buffer.from(out);
}

/** RFC 4648 base32, lower case, no padding: multibase `b`. */
function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function cidOf(codec, bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  const binary = Buffer.concat([
    varint(1),
    varint(codec),
    varint(MULTIHASH_SHA2_256),
    varint(digest.length),
    digest,
  ]);
  return { cid: `b${base32(binary)}`, binary };
}

// Protobuf, as dag-pb and UnixFS use it: varint (0) and length-delimited (2)
// fields only.
const key = (field, wire) => varint((field << 3) | wire);
const bytesField = (field, bytes) => Buffer.concat([key(field, 2), varint(bytes.length), bytes]);
const varintField = (field, value) => Buffer.concat([key(field, 0), varint(value)]);

/** A UnixFS `Data` message. */
function unixfsData(type, { filesize = null, blocksizes = [] } = {}) {
  return Buffer.concat([
    varintField(1, type),
    ...(filesize === null ? [] : [varintField(3, filesize)]),
    ...blocksizes.map((size) => varintField(4, size)),
  ]);
}

/** A dag-pb `PBNode`: its links first, then its data, as dag-pb's canonical
 * form orders them. */
function pbNode(links, data) {
  const encoded = links.map((link) =>
    bytesField(
      2,
      Buffer.concat([
        bytesField(1, link.block.binary),
        ...(link.name === null ? [] : [bytesField(2, Buffer.from(link.name, 'utf8'))]),
        varintField(3, link.block.dagSize),
      ])
    )
  );
  return Buffer.concat([...encoded, bytesField(1, data)]);
}

/**
 * Builds UnixFS content and keeps every block it made, by CID.
 */
class IpfsContent {
  constructor() {
    this.blocks = new Map();
  }

  add(codec, bytes, dagSize) {
    const { cid, binary } = cidOf(codec, bytes);
    const block = { cid, binary, bytes, dagSize };
    this.blocks.set(cid, block);
    return block;
  }

  /** A raw leaf: the block is the content. */
  raw(content) {
    const bytes = Buffer.from(content);
    return this.add(CODEC_RAW, bytes, bytes.length);
  }

  /**
   * A file: one raw leaf when it fits in `chunkBytes`, otherwise a dag-pb
   * file node over raw leaves of `chunkBytes` each (its `leaves`).
   */
  file(content, { chunkBytes = CHUNK_BYTES } = {}) {
    const bytes = Buffer.from(content);
    if (bytes.length <= chunkBytes) return this.raw(bytes);
    const leaves = [];
    for (let at = 0; at < bytes.length; at += chunkBytes) {
      leaves.push(this.raw(bytes.subarray(at, at + chunkBytes)));
    }
    const node = pbNode(
      leaves.map((block) => ({ block, name: null })),
      unixfsData(UNIXFS_FILE, {
        filesize: bytes.length,
        blocksizes: leaves.map((leaf) => leaf.bytes.length),
      })
    );
    const children = leaves.reduce((sum, leaf) => sum + leaf.dagSize, 0);
    return Object.assign(this.add(CODEC_DAG_PB, node, node.length + children), { leaves });
  }

  /** A directory of `entries` (`{ name: block }`), its links sorted by name. */
  dir(entries) {
    const links = Object.entries(entries)
      .map(([name, block]) => ({ block, name }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const node = pbNode(links, unixfsData(UNIXFS_DIRECTORY));
    const children = links.reduce((sum, link) => sum + link.block.dagSize, 0);
    return this.add(CODEC_DAG_PB, node, node.length + children);
  }
}

/** A peer ID of the usual form (an Ed25519 key's identity multihash, in
 * base58btc), unique per provider: the node keeps track of failing
 * providers, so each provider needs its own. */
function peerId(index) {
  const key = crypto.createHash('sha256').update(`ipfs-fixture-provider-${index}`).digest();
  const bytes = Buffer.concat([Buffer.from([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]), key]);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Starts a loopback HTTP server, tracking its sockets so it closes at once. */
async function listen(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * One HTTP provider: the trustless gateway's raw blocks, from `content`,
 * with its own faults. Its requests are pushed to `requests`.
 */
async function startProvider(content, index, requests) {
  const failing = new Map(); // cid -> status
  const stalled = new Map(); // cid -> responses held open

  const send = (res, cid) => {
    if (res.destroyed) return;
    const found = content.blocks.get(cid);
    if (!found) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res
      .writeHead(200, {
        'content-type': 'application/vnd.ipld.raw',
        'content-length': found.bytes.length,
      })
      .end(found.bytes);
  };

  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const block = url.pathname.match(/^\/ipfs\/([a-z2-7]+)$/);
    if (!block || req.method !== 'GET') {
      requests.push({ kind: 'other', provider: index, method: req.method, path: url.pathname });
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const cid = block[1];
    requests.push({ kind: 'block', provider: index, cid });
    if (failing.has(cid)) {
      res.writeHead(failing.get(cid), { 'content-type': 'text/plain' }).end('failed');
    } else if (stalled.has(cid)) {
      stalled.get(cid).push(res);
    } else {
      send(res, cid);
    }
  });

  return {
    record: {
      Schema: 'peer',
      ID: peerId(index),
      Addrs: [`/ip4/127.0.0.1/tcp/${server.port}/http`],
      Protocols: ['transport-ipfs-gateway-http'],
    },
    /** Answers `cid`'s block with `status` from now on. */
    fail(cid, status = 500) {
      failing.set(cid, status);
    },
    /** Holds `cid`'s block requests open from now on, until `release`. */
    stall(cid) {
      if (!stalled.has(cid)) stalled.set(cid, []);
    },
    /** Answers the held requests for `cid`, and later ones at once. */
    release(cid) {
      const held = stalled.get(cid) || [];
      stalled.delete(cid);
      for (const res of held) send(res, cid);
    },
    reset() {
      failing.clear();
      for (const cid of [...stalled.keys()]) this.release(cid);
    },
    async close() {
      this.reset();
      await server.close();
    },
  };
}

/**
 * Starts the fixture for `content`: the delegated router, and the default
 * provider it names for every known block.
 *
 * A test that makes a provider fail or stall takes a provider of its own
 * (`isolate(blocks)`): the node remembers a failing provider, and would
 * otherwise skip the default one for every later test.
 *
 * @param {IpfsContent} content
 * @returns {Promise<object>} `router` (the delegated router's endpoint),
 *   `requests`, `isolate()`, routing's faults, `reset()` and `close()`
 */
async function startIpfsFixture(content) {
  const requests = [];
  const providers = [await startProvider(content, 0, requests)];
  const assigned = new Map(); // cid -> provider
  let routingHeld = null; // lookups held open, when routing stalls

  const router = await listen((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const routing = url.pathname.match(/^\/routing\/v1\/providers\/([a-z2-7]+)$/);
    if (!routing) {
      requests.push({ kind: 'other', method: req.method, path: url.pathname });
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const cid = routing[1];
    requests.push({ kind: 'providers', cid });
    if (routingHeld) {
      routingHeld.push(res);
    } else if (!content.blocks.has(cid)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } else {
      const provider = assigned.get(cid) ?? providers[0];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ Providers: [provider.record] }));
    }
  });

  return {
    router: `http://127.0.0.1:${router.port}/routing/v1`,
    requests,
    /** Whether the node has asked for `cid`'s block. */
    asked(cid) {
      return requests.some((request) => request.kind === 'block' && request.cid === cid);
    },
    /**
     * A provider of its own for `blocks` (each one's CID, and a file's
     * leaves): the router names it, not the default one, for them.
     */
    async isolate(...blocks) {
      const provider = await startProvider(content, providers.length, requests);
      providers.push(provider);
      for (const block of blocks) {
        assigned.set(block.cid, provider);
        for (const leaf of block.leaves || []) assigned.set(leaf.cid, provider);
      }
      return provider;
    },
    /** Holds every provider lookup open from now on, until `releaseRouting`. */
    stallRouting() {
      routingHeld ??= [];
    },
    releaseRouting() {
      const held = routingHeld || [];
      routingHeld = null;
      for (const res of held) {
        if (!res.destroyed) res.writeHead(404).end();
      }
    },
    /** Clears every fault. */
    reset() {
      for (const provider of providers) provider.reset();
      this.releaseRouting();
    },
    async close() {
      this.releaseRouting();
      await Promise.all(providers.map((provider) => provider.close()));
      await router.close();
    },
  };
}

module.exports = {
  IpfsContent,
  startIpfsFixture,
  CHUNK_BYTES,
  CODEC_RAW,
  CODEC_DAG_PB,
};
