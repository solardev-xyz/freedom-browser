const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock electron with IPC capture
const ipcHandlers = {};
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
}));

const { app } = require('electron');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dapp-perms-test-'));
  app.getPath.mockReturnValue(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const {
  getPermission,
  grantPermission,
  revokePermission,
  revokePermissionsForWalletIndex,
  getAllPermissions,
  _resetCache,
} = require('./dapp-permissions');
const sharedOriginUtils = require('../../shared/origin-utils');

beforeEach(() => {
  _resetCache();
});

describe('dapp-permissions — origin normalization consistency', () => {
  // Battery of inputs covering every protocol family the renderer may produce.
  // Each row: [input, expectedNormalizedKey]
  // The expected key matches getPermissionKey from shared/origin-utils.js — the
  // single source of truth for display-URL → permission-key mapping.
  const cases = [
    // Standard HTTP(S)
    ['https://app.example.com', 'https://app.example.com'],
    ['https://app.example.com/path/to/page', 'https://app.example.com'],
    ['http://localhost:1234/foo', 'http://localhost:1234'],

    // ENS (the historical drift hotspot)
    ['vitalik.eth', 'vitalik.eth'],
    ['vitalik.eth/blog', 'vitalik.eth'],
    ['ens://vitalik.eth', 'vitalik.eth'],
    ['ens://vitalik.eth/#/path', 'vitalik.eth'],
    ['VITALIK.ETH', 'vitalik.eth'],
    ['mysite.box', 'mysite.box'],

    // dweb protocols
    ['bzz://abc123def', 'bzz://abc123def'],
    ['bzz://abc123def/page/index.html', 'bzz://abc123def'],
    ['ipfs://QmHash/docs', 'ipfs://QmHash'],
    ['ipns://host/guide', 'ipns://host'],
    ['rad://z123abc/tree', 'rad://z123abc'],
  ];

  test.each(cases)(
    'grantPermission stores under the shared-normalized key for input %s',
    (input, expectedKey) => {
      grantPermission(input, 0, 100);
      const all = getAllPermissions();
      const keys = all.map((p) => p.origin);
      expect(keys).toContain(expectedKey);
    }
  );

  test.each(cases)(
    'getPermission resolves via the shared-normalized key for input %s',
    (input, expectedKey) => {
      grantPermission(input, 0, 100);
      // Looking up with the already-normalized key (what the renderer passes)
      // must find the same record as looking up with the raw input.
      const byRaw = getPermission(input);
      const byKey = getPermission(expectedKey);
      expect(byRaw).not.toBeNull();
      expect(byKey).not.toBeNull();
      expect(byKey.origin).toBe(byRaw.origin);
    }
  );

  test('ENS forms that used to diverge now resolve to the same record', () => {
    // Before consolidation: `ens://vitalik.eth` stored under `ens://vitalik.eth`
    // and `vitalik.eth` stored under `vitalik.eth` — two separate records.
    // After: both normalize to `vitalik.eth` and share a single record.
    grantPermission('ens://vitalik.eth/#/path', 0, 100);

    const viaEnsScheme = getPermission('ens://vitalik.eth');
    const viaBareName = getPermission('vitalik.eth');
    const viaBareWithPath = getPermission('vitalik.eth/blog');

    expect(viaEnsScheme).not.toBeNull();
    expect(viaBareName).not.toBeNull();
    expect(viaBareWithPath).not.toBeNull();
    expect(viaBareName.origin).toBe('vitalik.eth');
    expect(viaEnsScheme.origin).toBe(viaBareName.origin);
    expect(viaBareWithPath.origin).toBe(viaBareName.origin);
  });

  test('uses the shared normalizer, not a local copy', () => {
    // If anyone re-introduces a local normalizeOrigin in dapp-permissions.js,
    // this test catches it: the key we store under must be what the shared
    // utility produces — not what new URL() would have returned.
    for (const [input, expectedKey] of cases) {
      expect(sharedOriginUtils.normalizeOrigin(input)).toBe(expectedKey);
    }
  });
});

describe('dapp-permissions — basic CRUD round-trip', () => {
  test('grant + get round-trips for an HTTP origin', () => {
    grantPermission('https://app.uniswap.org', 0, 1);
    const perm = getPermission('https://app.uniswap.org/swap');
    expect(perm).not.toBeNull();
    expect(perm.origin).toBe('https://app.uniswap.org');
    expect(perm.walletIndex).toBe(0);
    expect(perm.chainId).toBe(1);
  });

  test('grant + get round-trips for an ENS origin', () => {
    grantPermission('vitalik.eth', 1, 100);
    const perm = getPermission('vitalik.eth/blog');
    expect(perm).not.toBeNull();
    expect(perm.origin).toBe('vitalik.eth');
    expect(perm.walletIndex).toBe(1);
  });

  test('grant + get round-trips for a bzz:// origin', () => {
    grantPermission('bzz://abc123/page', 0, 100);
    const perm = getPermission('bzz://abc123/other');
    expect(perm).not.toBeNull();
    expect(perm.origin).toBe('bzz://abc123');
  });

  test('revokePermission removes the entry', () => {
    grantPermission('vitalik.eth', 0, 1);
    expect(getPermission('vitalik.eth')).not.toBeNull();
    const removed = revokePermission('vitalik.eth');
    expect(removed).toBe(true);
    expect(getPermission('vitalik.eth')).toBeNull();
  });

  test('revokePermission finds entry via alternate ENS form', () => {
    grantPermission('ens://vitalik.eth', 0, 1);
    const removed = revokePermission('vitalik.eth');
    expect(removed).toBe(true);
    expect(getPermission('ens://vitalik.eth')).toBeNull();
  });
});

describe('dapp-permissions — revoke by wallet index', () => {
  const LEDGER_INDEX = 1000000;

  test('drops every origin bound to the deleted account and keeps the rest', () => {
    grantPermission('https://swap.example', LEDGER_INDEX, 8453);
    grantPermission('vitalik.eth', LEDGER_INDEX, 1);
    grantPermission('https://other.example', 0, 1);

    const revoked = revokePermissionsForWalletIndex(LEDGER_INDEX);

    expect(revoked.sort()).toEqual(['https://swap.example', 'vitalik.eth']);
    expect(getPermission('https://swap.example')).toBeNull();
    expect(getPermission('vitalik.eth')).toBeNull();
    expect(getPermission('https://other.example')).not.toBeNull();
  });

  test('persists the removal to disk, so a stale index cannot survive a restart', () => {
    grantPermission('https://swap.example', LEDGER_INDEX, 8453);
    revokePermissionsForWalletIndex(LEDGER_INDEX);

    _resetCache();
    expect(getPermission('https://swap.example')).toBeNull();
  });

  test('is a no-op when no origin uses the index', () => {
    grantPermission('https://other.example', 0, 1);
    expect(revokePermissionsForWalletIndex(7)).toEqual([]);
    expect(getPermission('https://other.example')).not.toBeNull();
  });
});
