const { Wallet } = require('ethers');
const {
  canonicalManifestForSigning,
  verifyManifest,
  desktopListsFor,
} = require('./update-manifest');

// A deterministic throwaway signer (never used outside tests).
const SIGNER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

// Well-formed bzz refs / sha256 digests (64 hex chars) for fixtures.
const REF_A = 'aa'.repeat(32);
const REF_B = 'bb'.repeat(32);
const SHA_A = '11'.repeat(32);
const SHA_B = '22'.repeat(32);

function baseManifest(overrides = {}) {
  return {
    schema: 1,
    version: 5,
    generated_at: '2026-07-06T03:00:00Z',
    engines: { adblock_rs: '0.12.3' },
    platforms: {
      desktop: {
        lists: [
          {
            category: 'ads',
            list_id: 'easylist',
            ref: REF_A,
            sha256: SHA_A,
            bytes: 10,
            rule_count: 3,
          },
          {
            category: 'privacy',
            list_id: 'easyprivacy',
            ref: REF_B,
            sha256: SHA_B,
            bytes: 20,
            rule_count: 4,
          },
        ],
      },
      ios: { lists: [] },
    },
    ...overrides,
  };
}

// A baseManifest whose first desktop list entry has `fields` overridden.
function withEntry(fields) {
  const m = baseManifest();
  m.platforms.desktop.lists[0] = { ...m.platforms.desktop.lists[0], ...fields };
  return m;
}

async function signed(manifest, signer = SIGNER) {
  const sig = await signer.signMessage(canonicalManifestForSigning(manifest));
  return { ...manifest, sig };
}

describe('canonicalManifestForSigning', () => {
  test('strips sig, sorts keys recursively, compact', () => {
    const out = canonicalManifestForSigning({
      version: 2,
      schema: 1,
      sig: '0xdead',
      engines: { b: '1', a: '2' },
    });
    expect(out).toBe('{"engines":{"a":"2","b":"1"},"schema":1,"version":2}');
  });

  test('is independent of the sig field value', () => {
    const m = baseManifest();
    expect(canonicalManifestForSigning({ ...m, sig: '0xaaa' })).toBe(
      canonicalManifestForSigning({ ...m, sig: '0xbbb' })
    );
  });
});

describe('verifyManifest', () => {
  const opts = () => ({ sigAddress: SIGNER.address, appliedVersion: 0 });

  test('accepts a well-formed, correctly-signed, newer manifest', async () => {
    const result = verifyManifest(await signed(baseManifest()), opts());
    expect(result).toEqual({ ok: true, version: 5 });
  });

  test('rejects a manifest tampered after signing (sig no longer matches)', async () => {
    const m = await signed(baseManifest());
    m.platforms.desktop.lists[0].sha256 = 'de'.repeat(32); // flip a hash post-signature
    expect(verifyManifest(m, opts())).toEqual({ ok: false, reason: 'wrong_signer' });
  });

  test('rejects a signature from the wrong key', async () => {
    const other = Wallet.createRandom();
    expect(verifyManifest(await signed(baseManifest(), other), opts())).toEqual({
      ok: false,
      reason: 'wrong_signer',
    });
  });

  test('rejects a downgrade or replay of the applied version', async () => {
    const m = await signed(baseManifest({ version: 5 }));
    expect(verifyManifest(m, { sigAddress: SIGNER.address, appliedVersion: 5 })).toEqual({
      ok: false,
      reason: 'not_newer',
      version: 5,
    });
    expect(verifyManifest(m, { sigAddress: SIGNER.address, appliedVersion: 9 }).reason).toBe(
      'not_newer'
    );
  });

  test('allowRepublish accepts the applied version again but never an older one', async () => {
    const m = await signed(baseManifest({ version: 5 }));
    const withRepublish = { sigAddress: SIGNER.address, allowRepublish: true };
    expect(verifyManifest(m, { ...withRepublish, appliedVersion: 5 })).toEqual({
      ok: true,
      version: 5,
    });
    expect(verifyManifest(m, { ...withRepublish, appliedVersion: 6 }).reason).toBe('not_newer');
  });

  test('rejects a schema mismatch', async () => {
    expect(verifyManifest(await signed(baseManifest({ schema: 2 })), opts())).toEqual({
      ok: false,
      reason: 'schema_mismatch',
    });
  });

  test('rejects a missing or empty signature', () => {
    expect(verifyManifest(baseManifest(), opts())).toEqual({ ok: false, reason: 'missing_sig' });
  });

  test('rejects structural problems', () => {
    expect(verifyManifest(null, opts()).reason).toBe('not_an_object');
    expect(verifyManifest(baseManifest({ version: 0 }), opts()).reason).toBe('bad_version');
    expect(verifyManifest(baseManifest({ version: 1.5 }), opts()).reason).toBe('bad_version');
    expect(
      verifyManifest(baseManifest({ platforms: { desktop: {}, ios: { lists: [] } } }), opts())
        .reason
    ).toBe('bad_desktop_section');
  });

  test('rejects a list_id that could path-escape the staging dir, even if signed', async () => {
    for (const list_id of ['../../evil', 'a/b', 'a\\b', '..', '.hidden', 'UPPER', '']) {
      const m = await signed(withEntry({ list_id }));
      expect(verifyManifest(m, opts())).toEqual({ ok: false, reason: 'bad_list_entry' });
    }
  });

  test('rejects malformed entry fields (ref, sha256, sizes, counts, category)', async () => {
    const bad = [
      { ref: 'not-hex' },
      { ref: 'aa' }, // too short for a bzz reference
      { sha256: 'deadbeef' }, // not a 64-char digest
      { sha256: 42 },
      { bytes: 0 },
      { bytes: 10.5 },
      { rule_count: -1 },
      { rule_count: '3' },
      { category: '../ads' },
      { category: 7 },
      { title: 12 },
    ];
    for (const fields of bad) {
      const m = await signed(withEntry(fields));
      expect(verifyManifest(m, opts())).toEqual({ ok: false, reason: 'bad_list_entry' });
    }
  });

  test('rejects duplicate list_ids (they would collide on the same output file)', async () => {
    const m = await signed(withEntry({ list_id: 'easyprivacy' }));
    expect(verifyManifest(m, opts())).toEqual({ ok: false, reason: 'duplicate_list_id' });
  });
});

describe('desktopListsFor', () => {
  test('returns entries for enabled categories only, preserving order', () => {
    const m = baseManifest();
    expect(desktopListsFor(m, ['ads']).map((e) => e.category)).toEqual(['ads']);
    expect(desktopListsFor(m, ['ads', 'privacy']).map((e) => e.category)).toEqual([
      'ads',
      'privacy',
    ]);
    expect(desktopListsFor(m, new Set(['cookies'])).length).toBe(0);
  });
});
