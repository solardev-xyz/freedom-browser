const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Wallet } = require('ethers');

jest.mock('../settings-store', () => ({ loadSettings: jest.fn() }));
jest.mock('./service', () => ({
  refreshEngine: jest.fn(() => Promise.resolve()),
  getEnabledCategories: jest.fn(() => ['ads', 'privacy']),
}));

const { loadSettings } = require('../settings-store');
const { getEnabledCategories } = require('./service');
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
  getEnabledCategories.mockReturnValue(['ads', 'privacy']);
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
    getEnabledCategories.mockReturnValue(['ads']);
    const opts = io({ readFeed: async () => signedManifest(1) });
    await runUpdateOnce(opts);
    expect(opts.downloadBlob).toHaveBeenCalledTimes(1);
    expect(opts.downloadBlob).toHaveBeenCalledWith(REF_ADS);
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
    getEnabledCategories.mockReturnValue(['ads']);
    await runUpdateOnce(io({ readFeed: async () => signedManifest(3) }));
    expect(fs.existsSync(path.join(root, 'updated', 'easyprivacy.txt'))).toBe(false);

    // The user turns privacy on. The feed hasn't bumped its version, but the
    // missing list must still be fetched instead of waiting for a republish.
    getEnabledCategories.mockReturnValue(['ads', 'privacy']);
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
    getEnabledCategories.mockReturnValue(['ads']);
    await runUpdateOnce(io({ readFeed: async () => signedManifest(3) }));

    getEnabledCategories.mockReturnValue(['ads', 'privacy']);
    const opts = io({ readFeed: async () => signedManifest(3) });
    expect(await runUpdateOnce(opts)).toEqual({ status: 'applied', version: 3 });
    // Only the missing privacy list is fetched — the applied ads copy is
    // reused after hash verification, not re-downloaded.
    expect(opts.downloadBlob).toHaveBeenCalledTimes(1);
    expect(opts.downloadBlob).toHaveBeenCalledWith(REF_PRIV);
    expect(fs.readFileSync(path.join(root, 'updated', 'easylist.txt'))).toEqual(ADS);
    expect(fs.readFileSync(path.join(root, 'updated', 'easyprivacy.txt'))).toEqual(PRIV);
  });

  test('a backfill apply retains still-valid applied categories that are disabled', async () => {
    // v3 applied with ads+privacy; user disables privacy and enables ads only
    // — then a backfill (cookies-style scenario via re-apply) must not throw
    // away the still-valid privacy copy from updated/.
    getEnabledCategories.mockReturnValue(['ads', 'privacy']);
    await runUpdateOnce(io({ readFeed: async () => signedManifest(3) }));

    // Force a rewrite of updated/ while privacy is disabled: bump to v4.
    getEnabledCategories.mockReturnValue(['ads']);
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
    getEnabledCategories.mockReturnValue(['ads', 'privacy', 'cookies']);
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
