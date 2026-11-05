/**
 * The honest nodes of freedom-core's `vectors/dweb-verify.json` (design
 * 0009), for the integration tests that drive the real freedom-cored at
 * protocol 2: Ant's chunks and files, and the gateway's raw blocks, served
 * by a local fake node that records what it is asked. It serves no CARs, so
 * a CAR request falls back to raw blocks, as in freedom-core's own binary
 * tests.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

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

function readVectors(vectorsDir, name) {
  return JSON.parse(fs.readFileSync(path.join(vectorsDir, name), 'utf8'));
}

/** The honest nodes, as freedom-core's binary tests read them. */
function honest(vectorsDir) {
  const d = readVectors(vectorsDir, 'dweb-verify.json');
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

module.exports = {
  SITE_A,
  SITE_V1,
  INDEX_HTML,
  content,
  readVectors,
  honest,
  fakeNode,
  loopbackBackend,
  readAll,
};
