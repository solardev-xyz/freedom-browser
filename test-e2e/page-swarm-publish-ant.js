// A fake Ant for page-swarm-publish.spec.js, run as its own process (forked
// from main with ELECTRON_RUN_AS_NODE), so that the bytes it receives are
// never counted in main's memory, which the spec measures.
//
// It answers `/node`, `/stamps` (one usable batch) and `/tags/<uid>`, and
// takes uploads on `POST /bzz`: it reads each body to its end, keeping only
// its length and first bytes, and answers `{ reference }` with a tag, or
// holds the answer while `hold` is on, until the parent says `release`.
// While `stall` is on it takes an upload's connection and never reads it.
// The parent hears each upload as it starts and as it ends.

const http = require('http');
const crypto = require('crypto');

let hold = false;
let stall = false;
const held = [];
let nextTag = 40;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/node') return json(200, { beeMode: 'light' });
  if (req.method === 'GET' && url.pathname === '/stamps') {
    return json(200, {
      stamps: [
        {
          batchID: 'e2'.repeat(32),
          utilization: 0,
          usable: true,
          label: 'e2e',
          depth: 24,
          amount: '100000000000',
          bucketDepth: 16,
          blockNumber: 1,
          immutableFlag: true,
          batchTTL: 365 * 24 * 3600,
        },
      ],
    });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/tags/')) {
    const uid = Number(url.pathname.slice('/tags/'.length));
    return json(200, { uid, split: 4, seen: 0, stored: 0, sent: 4, synced: 4, address: '', startedAt: new Date(0).toISOString() });
  }
  if (req.method === 'POST' && url.pathname === '/bzz') {
    const id = crypto.randomBytes(4).toString('hex');
    const upload = { id, query: url.search, headers: req.headers, length: 0, head: '' };
    process.send?.({ kind: 'upload-started', id });
    if (stall) {
      req.pause();
      return undefined;
    }
    req.on('data', (chunk) => {
      if (upload.head.length < 64) upload.head += chunk.subarray(0, 64 - upload.head.length).toString('latin1');
      upload.length += chunk.length;
    });
    req.on('end', () => {
      const tag = ++nextTag;
      const answer = () => json(201, { reference: crypto.createHash('sha256').update(id).digest('hex') }, { 'swarm-tag': String(tag) });
      process.send?.({ kind: 'upload-received', upload: { ...upload, tag } });
      if (hold) held.push(answer);
      else answer();
    });
    return undefined;
  }
  return json(404, { code: 404, message: 'Not Found' });
});

process.on('message', (message) => {
  if (message?.kind === 'hold') hold = message.on === true;
  if (message?.kind === 'stall') stall = message.on === true;
  if (message?.kind === 'release') {
    const count = Number.isInteger(message.count) ? message.count : held.length;
    for (const answer of held.splice(0, count)) answer();
  }
  if (message?.kind === 'stop') {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
});

server.listen(0, '127.0.0.1', () => process.send?.({ kind: 'listening', port: server.address().port }));
