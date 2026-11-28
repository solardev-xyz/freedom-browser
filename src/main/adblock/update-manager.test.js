const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Wallet } = require('ethers');

jest.mock('../settings-store', () => ({ loadSettings: jest.fn() }));
jest.mock('./service', () => ({
  refreshEngine: jest.fn(() => Promise.resolve()),
  getEnabledFeedCategories: jest.fn(() => ['ads', 'privacy']),
}));
// The node the default IO reads (ant-storage-api.js, on its transport): a
// loopback one here, over real HTTP. A remote one's dials are in
// update-manager.transport.test.js.
const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'bundled' }),
}));

const { loadSettings } = require('../settings-store');
const { getEnabledFeedCategories } = require('./service');
const { canonicalManifestForSigning } = require('./update-manifest');
const { runUpdateOnce } = require('./update-manager');

const SIGNER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const ADS = Buffer.from('||ads.example^\n');
const PRIV = Buffer.from('||track.example^\n');
// Well-formed bzz refs (64 hex chars); the injected downloadBlob keys on them.
const REF_ADS = 'aa'.repeat(32);
const REF_PRIV = 'bb'.repeat(32);

function manifest(version = 1) {
  return {
    schema: 1,
    version,
    generated_at: '2026-07-06T03:00:00Z',
    engines: { adblock_rs: '0.12.3' },
    platforms: {
      desktop: {
        lists: [
          {
            category: 'ads',
            list_id: 'easylist',
            title: 'EasyList',
            source_url: 'u',
            license: 'l',
            ref: REF_ADS,
            sha256: sha256(ADS),
            bytes: ADS.length,
            rule_count: 1,
          },
          {
            category: 'privacy',
            list_id: 'easyprivacy',
            title: 'EasyPrivacy',
            source_url: 'u',
            license: 'l',
            ref: REF_PRIV,
            sha256: sha256(PRIV),
            bytes: PRIV.length,
            rule_count: 1,
          },
        ],
      },
      ios: { lists: [] },
    },
  };
}

async function signedManifest(version) {
  const m = manifest(version);
  m.sig = await SIGNER.signMessage(canonicalManifestForSigning(m));
  return m;
}

const blobFor = (ref) => (ref === REF_ADS ? ADS : ref === REF_PRIV ? PRIV : Buffer.from('x'));

let root;

// Seed updated/ as if `feedVersion` had been applied while only `categories`
// were enabled (that's all the update-manager downloads).
function seedApplied(feedVersion, categories) {
  const updated = path.join(root, 'updated');
  fs.mkdirSync(updated, { recursive: true });
  const entries = {};
  for (const category of categories) entries[category] = { file: `${category}.txt` };
  fs.writeFileSync(
    path.join(updated, 'manifest.json'),
    JSON.stringify({ feedVersion, categories: entries })
  );
}

function io(overrides = {}) {
  return {
    root,
    trustConfigured: true,
    sigAddress: SIGNER.address,
    downloadBlob: jest.fn(async (ref) => blobFor(ref)),
    activate: jest.fn(() => Promise.resolve()),
    ...overrides,
  };
}

beforeEach(() => {
  loadSettings.mockReturnValue({ adblockEnabled: true });
  getEnabledFeedCategories.mockReturnValue(['ads', 'privacy']);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-update-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('runUpdateOnce', () => {
  test('applies a valid update: writes lists + browser manifest, activates', async () => {
    const opts = io({ readFeed: async () => signedManifest(3) });
    const result = await runUpdateOnce(opts);
    expect(result).toEqual({ status: 'applied', version: 3 });

    const updated = path.join(root, 'updated');
    expect(fs.readFileSync(path.join(updated, 'easylist.txt'))).toEqual(ADS);
    expect(fs.readFileSync(path.join(updated, 'easyprivacy.txt'))).toEqual(PRIV);
    const local = JSON.parse(fs.readFileSync(path.join(updated, 'manifest.json'), 'utf-8'));
    expect(local.feedVersion).toBe(3);
    expect(local.categories.ads.file).toBe('easylist.txt');
    expect(local.categories.ads.ruleCount).toBe(1);
    expect(opts.activate).toHaveBeenCalledTimes(1);
  });

  test('only downloads enabled categories', async () => {
    getEnabledFeedCategories.mockReturnValue(['ads']);
    const opts = io({ readFeed: async () => signedManifest(1) });
    await runUpdateOnce(opts);
    expect(opts.downloadBlob).toHaveBeenCalledTimes(1);
    expect(opts.downloadBlob).toHaveBeenCalledWith(REF_ADS, expect.anything());
    expect(fs.existsSync(path.join(root, 'updated', 'easyprivacy.txt'))).toBe(false);
  });

  test('rejects an unsigned/invalid manifest without touching disk', async () => {
    const m = manifest(2); // no sig
    const result = await runUpdateOnce(io({ readFeed: async () => m }));
    expect(result.status).toBe('rejected');
    expect(fs.existsSync(path.join(root, 'updated'))).toBe(false);
  });

  test('rejects a correctly-signed manifest whose list_id path-escapes, writing nothing', async () => {
    // A compromised publisher key must still not get an arbitrary file write:
    // `<list_id>.txt` would resolve outside updated.next/ for this list_id.
    const m = manifest(2);
    m.platforms.desktop.lists[0].list_id = '../../escape';
    m.sig = await SIGNER.signMessage(canonicalManifestForSigning(m));
    // The traversal target (root/updated.next/../../escape.txt) resolves to
    // the tmpdir; make sure nothing pre-exists there, then assert no write.
    const escaped = path.resolve(root, '..', 'escape.txt');
    fs.rmSync(escaped, { force: true });
    const opts = io({ readFeed: async () => m });
    const result = await runUpdateOnce(opts);
    expect(result).toEqual({ status: 'rejected', reason: 'bad_list_entry' });
    expect(fs.existsSync(path.join(root, 'updated'))).toBe(false);
    expect(fs.existsSync(escaped)).toBe(false);
    expect(opts.activate).not.toHaveBeenCalled();
  });

  test('rejects a downgrade (version <= applied)', async () => {
    // Seed an applied version of 5 covering everything enabled.
    seedApplied(5, ['ads', 'privacy']);
    const result = await runUpdateOnce(io({ readFeed: async () => signedManifest(4) }));
    expect(result).toEqual({ status: 'rejected', reason: 'not_newer' });
  });

  test('re-applying the current version is a no-op when nothing is missing', async () => {
    seedApplied(5, ['ads', 'privacy']);
    const opts = io({ readFeed: async () => signedManifest(5) });
    const result = await runUpdateOnce(opts);
    expect(result).toEqual({ status: 'rejected', reason: 'not_newer' });
    expect(opts.downloadBlob).not.toHaveBeenCalled();
  });

  test('backfills a category enabled after the update landed, at the same version', async () => {
    // v3 lands while only ads is on, so updated/ carries ads alone.
    getEnabledFeedCategories.mockReturnValue(['ads']);
    await runUpdateOnce(io({ readFeed: async () => signedManifest(3) }));
    expect(fs.existsSync(path.join(root, 'updated', 'easyprivacy.txt'))).toBe(false);

    // The user turns privacy on. The feed hasn't bumped its version, but the
    // missing list must still be fetched instead of waiting for a republish.
    getEnabledFeedCategories.mockReturnValue(['ads', 'privacy']);
    const opts = io({ readFeed: async () => signedManifest(3) });
    expect(await runUpdateOnce(opts)).toEqual({ status: 'applied', version: 3 });
    expect(fs.readFileSync(path.join(root, 'updated', 'easyprivacy.txt'))).toEqual(PRIV);
    expect(opts.activate).toHaveBeenCalledTimes(1);

    // Backfilled: replay protection is back in force on the next tick.
    const settled = io({ readFeed: async () => signedManifest(3) });
    expect(await runUpdateOnce(settled)).toEqual({ status: 'rejected', reason: 'not_newer' });
    expect(settled.downloadBlob).not.toHaveBeenCalled();
    expect(settled.activate).not.toHaveBeenCalled();
  });

  test('backfill reuses applied copies and downloads only the missing list', async () => {
    // v3 lands with ads only; enabling privacy backfills at the same version.
    getEnabledFeedCategories.mockReturnValue(['ads']);
    await runUpdateOnce(io({ readFeed: async () => signedManifest(3) }));

    getEnabledFeedCategories.mockReturnValue(['ads', 'privacy']);
    const opts = io({ readFeed: async () => signedManifest(3) });
    expect(await runUpdateOnce(opts)).toEqual({ status: 'applied', version: 3 });
    // Only the missing privacy list is fetched — the applied ads copy is
    // reused after hash verification, not re-downloaded.
    expect(opts.downloadBlob).toHaveBeenCalledTimes(1);
    expect(opts.downloadBlob).toHaveBeenCalledWith(REF_PRIV, expect.anything());
    expect(fs.readFileSync(path.join(root, 'updated', 'easylist.txt'))).toEqual(ADS);
    expect(fs.readFileSync(path.join(root, 'updated', 'easyprivacy.txt'))).toEqual(PRIV);
  });

  test('a backfill apply retains still-valid applied categories that are disabled', async () => {
    // v3 applied with ads+privacy; user disables privacy and enables ads only
    // — then a backfill (cookies-style scenario via re-apply) must not throw
    // away the still-valid privacy copy from updated/.
    getEnabledFeedCategories.mockReturnValue(['ads', 'privacy']);
    await runUpdateOnce(io({ readFeed: async () => signedManifest(3) }));

    // Force a rewrite of updated/ while privacy is disabled: bump to v4.
    getEnabledFeedCategories.mockReturnValue(['ads']);
    const opts = io({ readFeed: async () => signedManifest(4) });
    expect(await runUpdateOnce(opts)).toEqual({ status: 'applied', version: 4 });

    // The disabled privacy list rides along (same hashes at v4), so
    // re-enabling it serves the fresh copy instead of the bundled floor.
    expect(fs.readFileSync(path.join(root, 'updated', 'easyprivacy.txt'))).toEqual(PRIV);
    const staged = JSON.parse(
      fs.readFileSync(path.join(root, 'updated', 'manifest.json'), 'utf-8')
    );
    expect(Object.keys(staged.categories).sort()).toEqual(['ads', 'privacy']);
  });

  test('does not re-download every tick when the feed has no list for the new category', async () => {
    await runUpdateOnce(io({ readFeed: async () => signedManifest(3) }));

    // 'cookies' is enabled but this feed version carries no cookies list, so
    // the backfill path opens and finds nothing new: no rewrite, no rebuild.
    getEnabledFeedCategories.mockReturnValue(['ads', 'privacy', 'cookies']);
    const opts = io({ readFeed: async () => signedManifest(3) });
    expect(await runUpdateOnce(opts)).toEqual({ status: 'up_to_date', version: 3 });
    expect(opts.downloadBlob).not.toHaveBeenCalled();
    expect(opts.activate).not.toHaveBeenCalled();
  });

  test('backfilling never accepts an older version', async () => {
    // Applied v5 without privacy: a backfill is wanted, but only from v5+.
    seedApplied(5, ['ads']);
    const result = await runUpdateOnce(io({ readFeed: async () => signedManifest(4) }));
    expect(result).toEqual({ status: 'rejected', reason: 'not_newer' });
  });

  test('aborts on a blob whose hash does not match, leaving prior state', async () => {
    const opts = io({
      readFeed: async () => signedManifest(2),
      downloadBlob: async () => Buffer.from('tampered'),
    });
    const result = await runUpdateOnce(opts);
    expect(result.status).toBe('hash_mismatch');
    expect(fs.existsSync(path.join(root, 'updated'))).toBe(false);
    expect(opts.activate).not.toHaveBeenCalled();
  });

  test('a feed read that never answers ends the cycle as feed_unavailable', async () => {
    const opts = io({ readFeed: () => new Promise(() => {}), timeoutMs: 20 });
    const result = await runUpdateOnce(opts);
    expect(result).toEqual({ status: 'feed_unavailable' });
    expect(opts.downloadBlob).not.toHaveBeenCalled();
  });

  test('a feed read past the timeout has its signal aborted', async () => {
    let signal;
    const opts = io({
      readFeed: jest.fn((ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      }),
      timeoutMs: 20,
    });
    expect(await runUpdateOnce(opts)).toEqual({ status: 'feed_unavailable' });
    expect(signal.aborted).toBe(true);
  });

  test('a list download that never answers ends the cycle, leaving prior state', async () => {
    const opts = io({
      readFeed: async () => signedManifest(2),
      downloadBlob: jest.fn(() => new Promise(() => {})),
      timeoutMs: 20,
    });
    const result = await runUpdateOnce(opts);
    expect(result).toEqual({ status: 'download_failed', reason: 'ads' });
    expect(fs.existsSync(path.join(root, 'updated'))).toBe(false);
    expect(opts.activate).not.toHaveBeenCalled();
  });

  test('a slow list download that keeps making progress is not cut off', async () => {
    // Each list takes 3x the timeout in total, but never goes 20 ms silent.
    const opts = io({
      readFeed: async () => signedManifest(2),
      downloadBlob: jest.fn(async (ref, { progress }) => {
        for (let i = 0; i < 6; i += 1) {
          await new Promise((r) => setTimeout(r, 10));
          progress();
        }
        return blobFor(ref);
      }),
      timeoutMs: 20,
    });
    const result = await runUpdateOnce(opts);
    expect(result).toEqual({ status: 'applied', version: 2 });
  });

  test('a download that goes quiet after some progress is aborted', async () => {
    let signal;
    const opts = io({
      readFeed: async () => signedManifest(2),
      downloadBlob: jest.fn((ref, ctx) => {
        signal = ctx.signal;
        ctx.progress();
        return new Promise(() => {});
      }),
      timeoutMs: 20,
    });
    const result = await runUpdateOnce(opts);
    expect(result).toEqual({ status: 'download_failed', reason: 'ads' });
    expect(signal.aborted).toBe(true);
  });

  test('rolls back to last-known-good when the engine rebuild fails', async () => {
    // First: a good apply at version 2.
    await runUpdateOnce(io({ readFeed: async () => signedManifest(2) }));
    const goodManifest = fs.readFileSync(path.join(root, 'updated', 'manifest.json'), 'utf-8');

    // Second: version 3 downloads fine but activation throws — must roll back.
    const failing = io({
      readFeed: async () => signedManifest(3),
      activate: jest.fn(() => Promise.reject(new Error('bad engine'))),
    });
    const result = await runUpdateOnce(failing);
    expect(result.status).toBe('activate_failed');
    // Rolled back to the version-2 manifest.
    expect(fs.readFileSync(path.join(root, 'updated', 'manifest.json'), 'utf-8')).toBe(
      goodManifest
    );
  });

  test('is dormant when the trust anchor is unconfigured', async () => {
    const result = await runUpdateOnce(
      io({ trustConfigured: false, readFeed: async () => signedManifest(1) })
    );
    expect(result).toEqual({ status: 'dormant' });
  });

  test('skips when adblock is disabled', async () => {
    loadSettings.mockReturnValue({ adblockEnabled: false });
    const result = await runUpdateOnce(io({ readFeed: async () => signedManifest(1) }));
    expect(result).toEqual({ status: 'disabled' });
  });
});

describe('default list download (the node’s transport)', () => {
  const http = require('http');
  const { _defaultDownloadBlob } = require('./update-manager');

  // Serves /bytes/<ref> as `chunks` pieces, `gapMs` apart; with `stallAfter`,
  // stops writing (keeps the connection open) after that many pieces.
  async function trickleServer({ chunks, gapMs, stallAfter = Infinity }) {
    const closed = [];
    const urls = [];
    const server = http.createServer((req, res) => {
      urls.push(req.url);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let sent = 0;
      const tick = () => {
        if (sent >= chunks) return res.end();
        if (sent >= stallAfter) return;
        res.write(Buffer.from(`chunk${sent}\n`));
        sent += 1;
        setTimeout(tick, gapMs);
      };
      tick();
      res.on('close', () => closed.push(res.writableEnded));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    mockRegistry.url = `http://127.0.0.1:${server.address().port}`;
    return { closed, urls, close: () => new Promise((r) => server.close(r)) };
  }

  // Mirrors runUpdateOnce: an inactivity timer reset by progress().
  function watch(ms) {
    const controller = new AbortController();
    let timer;
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('idle')), ms);
    };
    progress();
    return { signal: controller.signal, progress, stop: () => clearTimeout(timer) };
  }

  // The transport's modules load on its first call; load them before any
  // inactivity window starts, as main has by then.
  beforeAll(() => require('../swarm/bzz-protocol'));
  afterEach(() => {
    mockRegistry.url = null;
  });

  test('streams a slow-but-steady body past the timeout', async () => {
    const srv = await trickleServer({ chunks: 8, gapMs: 25 });
    const w = watch(100); // whole body takes ~200 ms
    try {
      const blob = await _defaultDownloadBlob(REF_ADS, w);
      expect(blob.toString()).toBe([...Array(8).keys()].map((i) => `chunk${i}\n`).join(''));
      expect(srv.urls).toEqual([`/bytes/${REF_ADS}`]);
    } finally {
      w.stop();
      await srv.close();
    }
  });

  test('an abort mid-body rejects and closes the connection', async () => {
    const srv = await trickleServer({ chunks: 8, gapMs: 10, stallAfter: 2 });
    const w = watch(80);
    try {
      await expect(_defaultDownloadBlob(REF_ADS, w)).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      expect(srv.closed).toEqual([false]); // closed by us, before the server ended it
    } finally {
      w.stop();
      await srv.close();
    }
  });
});

describe('the default feed read and list download, over a loopback node', () => {
  const {
    startFakeHttpNode,
    streamBody,
    waitFor,
  } = require('../../../test/helpers/fake-http-node');
  const { FEED_TOPIC } = require('./feed-config');
  const {
    _defaultReadFeed,
    _defaultDownloadBlob,
    _feedTopicHex,
    MANIFEST_MAX_BYTES,
  } = require('./update-manager');
  const CID_FIXTURE = require('../../../test/fixtures/swarm-cid/bee-js-13.2.0.json');

  // The production publisher's address, as bee-js's EthAddress writes it.
  const OWNER = 'b818ff019bc15bc3dfbdad4ce0ab66a6f74e8f1e';
  // bee-js 13.2.0's Topic.fromString(FEED_TOPIC), recorded in the fixture.
  const TOPIC = CID_FIXTURE.topics.find((t) => t.value === FEED_TOPIC).hex;
  const FEED_PATH = `/feeds/${OWNER}/${TOPIC}`;
  const INDEX_HEADERS = {
    'swarm-feed-index': '0000000000000003',
    'swarm-feed-index-next': '0000000000000004',
  };

  let node;
  let feed; // (req, res, entry) => void, for FEED_PATH
  let blobs; // ref → Buffer, for /bytes/<ref>

  const json = (res, status, value, headers = {}) => {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': body.length,
      ...headers,
    });
    res.end(body);
  };
  const entryReply =
    (payload, headers = INDEX_HEADERS) =>
    (_req, res) => {
      const body = Buffer.from(payload);
      res.writeHead(200, { 'content-length': body.length, ...headers });
      res.end(body);
    };

  beforeAll(async () => {
    node = await startFakeHttpNode({
      handler(req, res, entry) {
        if (req.url === FEED_PATH && feed) return feed(req, res, entry);
        const blob = req.url.match(/^\/bytes\/([0-9a-f]+)$/);
        if (blob && blobs.has(blob[1])) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(blobs.get(blob[1]));
          return;
        }
        json(res, 404, { code: 404, message: 'Not Found' });
      },
    });
  });
  afterAll(() => node.close());
  beforeEach(() => {
    mockRegistry.url = node.origin;
    node.requests.length = 0;
    feed = null;
    blobs = new Map([
      [REF_ADS, ADS],
      [REF_PRIV, PRIV],
    ]);
  });
  afterEach(() => {
    mockRegistry.url = null;
  });

  test('the feed topic is bee-js’s: keccak256 of the UTF-8, for the list’s topic and others', () => {
    expect(_feedTopicHex(FEED_TOPIC)).toBe(
      '96741f799248290fa67445649f572f1c773238c1f07e2e98643c625370f9bc15'
    );
    for (const { value, hex } of CID_FIXTURE.topics) expect(_feedTopicHex(value)).toBe(hex);
  });

  test('reads the manifest from the feed’s latest entry: one GET, as bee-js asked', async () => {
    feed = entryReply(JSON.stringify({ schema: 1, version: 7 }));
    await expect(_defaultReadFeed()).resolves.toEqual({ schema: 1, version: 7 });
    expect(node.requests.map((r) => [r.method, r.url])).toEqual([['GET', FEED_PATH]]);
    expect(node.requests[0].headers).toMatchObject({
      accept: 'application/json, text/plain, */*',
      'accept-encoding': 'identity',
    });
  });

  test('a body with no declared length is read to its end', async () => {
    feed = (_req, res) => {
      res.writeHead(200, INDEX_HEADERS);
      res.write('{"schema":1,');
      res.end('"version":8}');
    };
    await expect(_defaultReadFeed()).resolves.toEqual({ schema: 1, version: 8 });
  });

  test('a null entry reads as null (the cycle’s feed_empty)', async () => {
    feed = entryReply('null');
    await expect(_defaultReadFeed()).resolves.toBeNull();
  });

  test.each([
    ['a 404', (_req, res) => json(res, 404, { code: 404, message: 'Not Found' }), /Feed is empty/],
    ['a 500', (_req, res) => json(res, 500, { code: 500, message: 'x' }), /Feed is empty/],
    ['a 503', (_req, res) => json(res, 503, { code: 503, message: 'x' }), /503/],
    [
      'a redirect, which is not followed',
      (_req, res) => {
        res.writeHead(302, { location: '/feeds/elsewhere' });
        res.end();
      },
      /302/,
    ],
    [
      'no swarm-feed-index',
      entryReply('{}', { 'swarm-feed-index-next': '0000000000000001' }),
      /swarm-feed-index!/,
    ],
    [
      'no swarm-feed-index-next',
      entryReply('{}', { 'swarm-feed-index': '0000000000000000' }),
      /swarm-feed-index-next!/,
    ],
    [
      'an index that is not 8 bytes',
      entryReply('{}', { ...INDEX_HEADERS, 'swarm-feed-index': '03' }),
      /not a feed index/,
    ],
    ['a body that is not JSON', entryReply('not json'), SyntaxError],
    ['an empty body', entryReply(''), SyntaxError],
    [
      'a body shorter than it declared',
      (_req, res) => {
        res.writeHead(200, { 'content-length': 10, ...INDEX_HEADERS });
        res.write('{}');
        res.destroy();
      },
      /./,
    ],
  ])('%s fails the read', async (_name, reply, error) => {
    feed = reply;
    await expect(_defaultReadFeed()).rejects.toThrow(error);
  });

  test('an entry declared past the cap is refused before its body is read', async () => {
    feed = entryReply(Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20));
    await expect(_defaultReadFeed()).rejects.toMatchObject({
      reason: 'data_too_large',
      limit: MANIFEST_MAX_BYTES,
      actual: MANIFEST_MAX_BYTES + 1,
    });
    // A large one: its body is let go, not drained.
    const total = MANIFEST_MAX_BYTES * 64;
    feed = (_req, res, entry) => {
      res.writeHead(200, { 'content-length': total, ...INDEX_HEADERS });
      streamBody(entry, { total });
    };
    await expect(_defaultReadFeed()).rejects.toMatchObject({ actual: total });
    await node.requests[1].done;
    expect(node.requests[1].aborted).toBe(true);
    expect(node.requests[1].bytesSent).toBeLessThan(total);
  });

  test('an entry with no declared length is cut off once it passes the cap', async () => {
    feed = (_req, res, entry) => {
      res.writeHead(200, INDEX_HEADERS);
      streamBody(entry);
    };
    await expect(_defaultReadFeed()).rejects.toMatchObject({
      reason: 'data_too_large',
      limit: MANIFEST_MAX_BYTES,
    });
    await node.requests[0].done;
    expect(node.requests[0].aborted).toBe(true);
    expect(node.requests[0].bytesSent).toBeLessThan(MANIFEST_MAX_BYTES * 4);
  });

  test('a read the signal ends lets its connection go', async () => {
    feed = (_req, res) => {
      res.writeHead(200, INDEX_HEADERS);
      res.write('{"schema":');
    };
    const controller = new AbortController();
    const reading = _defaultReadFeed({ signal: controller.signal });
    await waitFor(() => node.requests.length === 1, { what: 'the feed read' });
    controller.abort(new Error('timed out'));
    await expect(reading).rejects.toThrow('timed out');
    await node.requests[0].done;
    expect(node.requests[0].aborted).toBe(true);
  });

  test('with no node URL nothing is dialled', async () => {
    mockRegistry.url = null;
    await expect(_defaultReadFeed()).rejects.toThrow('Swarm node is not ready');
    await expect(_defaultDownloadBlob(REF_ADS, {})).rejects.toThrow('Swarm node is not ready');
    expect(node.requests).toEqual([]);
  });

  test('a list download that fails its status, or names no reference, fails', async () => {
    await expect(_defaultDownloadBlob('cc'.repeat(32), {})).rejects.toThrow(/404/);
    await expect(_defaultDownloadBlob('not a ref', {})).rejects.toThrow(/not a Swarm reference/);
    expect(node.requests.map((r) => r.url)).toEqual([`/bytes/${'cc'.repeat(32)}`]);
  });

  test('a whole cycle on the default IO applies the update, as with injected IO', async () => {
    const manifest = await signedManifest(5);
    feed = entryReply(JSON.stringify(manifest));
    const result = await runUpdateOnce({
      root,
      trustConfigured: true,
      sigAddress: SIGNER.address,
      activate: jest.fn(() => Promise.resolve()),
    });
    expect(result).toEqual({ status: 'applied', version: 5 });
    expect(fs.readFileSync(path.join(root, 'updated', 'easylist.txt'))).toEqual(ADS);
    expect(fs.readFileSync(path.join(root, 'updated', 'easyprivacy.txt'))).toEqual(PRIV);
    expect(node.requests.map((r) => r.url)).toEqual([
      FEED_PATH,
      `/bytes/${REF_ADS}`,
      `/bytes/${REF_PRIV}`,
    ]);
  });

  test.each([
    [
      'the feed fails',
      () => (feed = (_req, res) => json(res, 503, {})),
      { status: 'feed_unavailable' },
    ],
    ['the feed is empty', () => (feed = entryReply('null')), { status: 'feed_empty' }],
    [
      'a list fails',
      async () => {
        feed = entryReply(JSON.stringify(await signedManifest(5)));
        blobs.delete(REF_ADS);
      },
      { status: 'download_failed', reason: 'ads' },
    ],
    [
      'a list is not what the manifest signed',
      async () => {
        feed = entryReply(JSON.stringify(await signedManifest(5)));
        blobs.set(REF_PRIV, Buffer.from('tampered'));
      },
      { status: 'hash_mismatch', reason: 'privacy' },
    ],
  ])('a whole cycle where %s ends as it did', async (_name, arrange, expected) => {
    await arrange();
    const result = await runUpdateOnce({
      root,
      trustConfigured: true,
      sigAddress: SIGNER.address,
      activate: jest.fn(() => Promise.resolve()),
    });
    expect(result).toEqual(expected);
    expect(fs.existsSync(path.join(root, 'updated'))).toBe(false);
  });

  test('a feed read past the cycle’s timeout is cancelled', async () => {
    feed = () => {}; // never answers
    const result = await runUpdateOnce({ root, trustConfigured: true, timeoutMs: 50 });
    expect(result).toEqual({ status: 'feed_unavailable' });
    await waitFor(() => node.requests[0]?.closed, { what: 'the dial to close' });
    expect(node.requests[0].aborted).toBe(true);
  });
});
