/**
 * A Swarm node on loopback for the agent's publications (the SWM-6 to SWM-9
 * plan's PR 8.4): what swarm-publication-controller.js and
 * swarm-postage-readiness.js reach, on either backend, answered as Bee and
 * Ant answer, from state a test sets.
 *
 * - `GET /stamps`, `/stamps/<id>`: `state.stamps`, the node's raw batches;
 *   `GET /batches/<id>`: `state.global`; `GET /chainstate`: `state.chain`.
 * - `POST /bzz`: an upload taken whole, its reference derived from what it
 *   carries, so two uploads of the same content get the same reference
 *   whoever wrote the request: for one file, its name, type and bytes; for
 *   a collection, its tar's entries (each name, length and SHA-256), never
 *   the tar's own bytes (its headers' times and modes differ by writer).
 *   `swarm-encrypt: true` gives a 128-hex reference (the root's 64 hex and
 *   a key's), unless `state.ignoreEncrypt`. The answer carries
 *   `swarm-tag: state.tag`; the content is kept for `/bytes` at its
 *   reference unless `state.serveBytes` is false. `state.failUploads`,
 *   while it has entries, answers each next upload with the first one's
 *   `{ status, body }` instead.
 * - `GET /tags/<uid>`: the tag of the last upload, done, its address the
 *   upload's root (the leading 64 hex).
 * - Feeds as the node keeps them: `POST /feeds/<o>/<t>` makes a manifest
 *   (its reference derived from owner and topic); `POST /soc/<o>/<id>`
 *   stores the signed update; `GET /feeds/<o>/<t>` answers the latest
 *   update's index (`swarm-feed-index`, `swarm-feed-index-next`) and its
 *   payload, or 404 when there is none; `GET /chunks/<address>` answers a
 *   stored update.
 *
 * `calls` keeps every request as `METHOD /path`, `uploads` each upload's
 * name, Swarm headers, entries and reference.
 */

const crypto = require('crypto');
const { keccak256 } = require('ethers');
const coreSdk = require('@ethersphere/core-sdk');
const { startFakeHttpNode } = require('./fake-http-node');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The upload headers a writer chooses, in this order.
const SWARM_HEADERS = [
  'content-type',
  'swarm-collection',
  'swarm-postage-batch-id',
  'swarm-pin',
  'swarm-encrypt',
  'swarm-deferred-upload',
  'swarm-index-document',
];

/** A ustar archive's entries: each name, length and SHA-256. */
function tarEntries(tar) {
  const entries = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, ''), 8);
    const start = at + 512;
    entries.push({ name, bytes: size, sha256: sha256(tar.subarray(start, start + size)) });
    at = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** A feed update's SOC address: keccak256(topic ‖ index, 8 bytes BE) under `owner`. */
function updateAddress(owner, topic, index) {
  const at = Buffer.alloc(8);
  at.writeBigUInt64BE(BigInt(index));
  const identifier = keccak256(Buffer.concat([Buffer.from(topic, 'hex'), at])).slice(2);
  return coreSdk
    .makeSOCAddress(new coreSdk.Identifier(identifier), new coreSdk.EthAddress(owner))
    .toHex();
}

const hex16 = (index) => index.toString(16).padStart(16, '0');

async function startAgentNode(initial = {}) {
  const state = {
    stamps: [],
    global: {},
    chain: { block: 100, chainTip: 100, totalAmount: '0', currentPrice: '24000' },
    tag: 41,
    ignoreEncrypt: false,
    serveBytes: true,
    failUploads: [],
    ...initial,
  };
  const calls = [];
  const uploads = [];
  const content = new Map();
  const chunks = new Map();
  let lastRoot = null;

  const send = (res, status, body, headers = {}) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      'content-length': bytes.length,
      ...headers,
    });
    res.end(bytes);
  };
  const notFound = (res) => send(res, 404, { code: 404, message: 'Not Found' });

  function upload(req, url, body, res) {
    const headers = Object.fromEntries(
      SWARM_HEADERS.filter((name) => req.headers[name] !== undefined).map((name) => [name, req.headers[name]])
    );
    const collection = req.headers['swarm-collection'] === 'true';
    const name = url.searchParams.get('name');
    const entries = collection ? tarEntries(body) : null;
    const carried = collection
      ? JSON.stringify(entries)
      : JSON.stringify({ name, type: req.headers['content-type'], sha256: sha256(body) });
    const root = sha256(carried);
    const encrypted = req.headers['swarm-encrypt'] === 'true' && !state.ignoreEncrypt;
    const reference = encrypted ? `${root}${sha256(`key:${root}`)}` : root;
    uploads.push({ name, headers, ...(entries ? { entries } : { sha256: sha256(body) }), reference });
    if (state.failUploads.length) {
      const failure = state.failUploads.shift();
      return send(res, failure.status, failure.body);
    }
    lastRoot = root;
    if (state.serveBytes) content.set(reference, body);
    return send(res, 201, { reference }, { 'swarm-tag': String(state.tag) });
  }

  function latestIndex(owner, topic) {
    let index = -1;
    while (chunks.has(updateAddress(owner, topic, index + 1))) index += 1;
    return index;
  }

  const node = await startFakeHttpNode({
    handler: (req, res) => {
      const parts = [];
      req.on('data', (part) => parts.push(part));
      req.on('end', () => {
        const body = Buffer.concat(parts);
        const url = new URL(req.url, 'http://node');
        const path = url.pathname;
        const [, first, second, third] = path.split('/');
        calls.push(`${req.method} ${path}`);
        if (req.method === 'GET' && path === '/stamps') return send(res, 200, { stamps: state.stamps });
        if (req.method === 'GET' && first === 'stamps') {
          const stamp = state.stamps.find((s) => s.batchID === second);
          return stamp ? send(res, 200, stamp) : notFound(res);
        }
        if (req.method === 'GET' && first === 'batches') {
          return state.global[second] ? send(res, 200, state.global[second]) : notFound(res);
        }
        if (req.method === 'GET' && path === '/chainstate') return send(res, 200, state.chain);
        if (req.method === 'POST' && path === '/bzz') return upload(req, url, body, res);
        if (req.method === 'GET' && first === 'tags' && Number(second) === state.tag && lastRoot) {
          return send(res, 200, {
            uid: state.tag,
            split: 4,
            seen: 0,
            stored: 4,
            sent: 4,
            synced: 4,
            address: lastRoot,
            startedAt: '2026-11-28T00:00:00Z',
          });
        }
        if (req.method === 'GET' && first === 'bytes') {
          const stored = content.get(second);
          return stored ? send(res, 200, stored) : notFound(res);
        }
        if (req.method === 'POST' && first === 'feeds') {
          return send(res, 201, { reference: sha256(`feed:${second.toLowerCase()}:${third}`) });
        }
        if (req.method === 'POST' && first === 'soc') {
          const address = coreSdk
            .makeSOCAddress(new coreSdk.Identifier(third), new coreSdk.EthAddress(second))
            .toHex();
          const signature = Buffer.from(url.searchParams.get('sig'), 'hex');
          chunks.set(address, Buffer.concat([Buffer.from(third, 'hex'), signature, body]));
          return send(res, 201, { reference: address });
        }
        if (req.method === 'GET' && first === 'feeds') {
          const owner = second.toLowerCase();
          const index = latestIndex(owner, third);
          if (index < 0) return notFound(res);
          const chunk = chunks.get(updateAddress(owner, third, index));
          // After the identifier (32), the signature (65) and the span (8).
          return send(res, 200, chunk.subarray(32 + 65 + 8), {
            'swarm-feed-index': hex16(index),
            'swarm-feed-index-next': hex16(index + 1),
          });
        }
        if (req.method === 'GET' && first === 'chunks') {
          const chunk = chunks.get(second);
          return chunk ? send(res, 200, chunk) : notFound(res);
        }
        return send(res, 500, { code: 500, message: `no answer for ${req.method} ${path}` });
      });
    },
  });
  return Object.assign(node, { state, calls, uploads, content, chunks, latestIndex });
}

module.exports = { startAgentNode, tarEntries, updateAddress };
