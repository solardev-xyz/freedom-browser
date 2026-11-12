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

// D12's pause reads the wallet's payment records; here it is the switch.
jest.mock('./auto-approve-pause', () => ({
  transactionAutoApprovePaused: jest.fn(async () => false),
}));

const { app } = require('electron');
const { transactionAutoApprovePaused } = require('./auto-approve-pause');

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
  addTransactionAutoApprove,
  isTransactionAutoApproved,
  removeTransactionAutoApprove,
  registerDappPermissionsIpc,
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

    // Onchain application aliases share a friendly contract-and-chain key.
    [
      'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6.eip155-1/swap',
      'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6',
    ],
    [
      'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6:100/swap',
      'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6:100',
    ],
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

// The renderer's question before a dApp transaction: true sends it silently,
// false shows the approval prompt.
describe('dapp-permissions — the auto-approve question, paused while a payment waits (D12)', () => {
  const SITE = 'https://swap.example';
  const TO = '0x' + '66'.repeat(20);
  const SELECTOR = '0xabcdef12';
  let ask;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    registerDappPermissionsIpc();
    ask = (site, selector = SELECTOR) =>
      ipcHandlers['dapp:is-tx-auto-approved']({}, site, TO, selector, 1);
    transactionAutoApprovePaused.mockReset().mockResolvedValue(false);
    grantPermission(SITE, 0, 1);
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1);
  });

  afterEach(() => jest.restoreAllMocks());

  test('a covering rule answers yes while nothing of the site waits', async () => {
    await expect(ask(SITE)).resolves.toBe(true);
    expect(transactionAutoApprovePaused).toHaveBeenCalledWith(SITE);
  });

  test("a covering rule answers no while one of the site's payments waits", async () => {
    transactionAutoApprovePaused.mockResolvedValue(true);
    await expect(ask(SITE)).resolves.toBe(false);
  });

  test('no covering rule answers no, as before, without reading the records', async () => {
    transactionAutoApprovePaused.mockResolvedValue(true);
    await expect(ask(SITE, '0x12345678')).resolves.toBe(false);
    await expect(ask('https://other.example')).resolves.toBe(false);
    expect(transactionAutoApprovePaused).not.toHaveBeenCalled();
  });
});

// A transaction rule covers its call with no more value than the confirmed
// send it was recorded from. Before, a rule recorded from a send of 0.01 ETH
// covered the same call with any value.
describe('dapp-permissions — a transaction rule covers no more value than its send', () => {
  const SITE = 'https://swap.example';
  const TO = '0x' + '66'.repeat(20);
  const SELECTOR = '0xabcdef12';
  const CENT = '10000000000000000'; // 0.01 ETH, in wei
  const CENT_HEX = '0x2386f26fc10000';
  const TWO_CENTS_HEX = '0x470de4df820000';
  const covers = (value, site = SITE) => isTransactionAutoApproved(site, TO, SELECTOR, 1, value);

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    transactionAutoApprovePaused.mockReset().mockResolvedValue(false);
    grantPermission(SITE, 0, 1);
  });

  afterEach(() => jest.restoreAllMocks());

  test('a rule from a send of 0.01 ETH covers 0.01 ETH and less, never more', () => {
    expect(addTransactionAutoApprove(SITE, TO, SELECTOR, 1, CENT)).toBe(true);
    expect(covers(CENT)).toBe(true);
    expect(covers(CENT_HEX)).toBe(true);
    expect(covers('0')).toBe(true);
    expect(covers(undefined)).toBe(true);
    expect(covers(BigInt(CENT) + 1n)).toBe(false);
    expect(covers(TWO_CENTS_HEX)).toBe(false);
    expect(covers('1000000000000000000000')).toBe(false);
  });

  test('a rule from a send of no value covers only calls of no value', () => {
    expect(addTransactionAutoApprove(SITE, TO, SELECTOR, 1, '0x0')).toBe(true);
    expect(covers('0')).toBe(true);
    expect(covers('0x0')).toBe(true);
    expect(covers('1')).toBe(false);
    expect(covers('0x1')).toBe(false);
  });

  test('the rule records the value; the call, chain and site still have to match', () => {
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, CENT_HEX);
    expect(getPermission(SITE).autoApprove.transactions).toEqual([
      { to: TO, selector: SELECTOR, chainId: 1, maxValue: CENT },
    ]);
    expect(isTransactionAutoApproved(SITE, TO, '0x12345678', 1, '0')).toBe(false);
    expect(isTransactionAutoApproved(SITE, TO, SELECTOR, 100, '0')).toBe(false);
    expect(covers('0', 'https://other.example')).toBe(false);
  });

  test('a value that is not a non-negative integer is never covered, nor recorded', () => {
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, CENT);
    for (const value of ['-1', 'lots', '0.5', 1.5, -1, {}, true]) {
      expect(covers(value)).toBe(false);
    }
    expect(addTransactionAutoApprove(SITE, '0x' + '77'.repeat(20), SELECTOR, 1, 'lots')).toBe(false);
    expect(getPermission(SITE).autoApprove.transactions).toHaveLength(1);
  });

  test('added again for the same call, the rule covers the larger value confirmed', () => {
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, CENT);
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, '0');
    expect(covers(CENT)).toBe(true);
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, TWO_CENTS_HEX);
    expect(covers(TWO_CENTS_HEX)).toBe(true);
    expect(getPermission(SITE).autoApprove.transactions).toHaveLength(1);
  });

  test('a rule stored without a value, by an older build, covers only calls of no value', () => {
    const file = path.join(tmpDir, 'dapp-permissions.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        [SITE]: {
          origin: SITE,
          walletIndex: 0,
          chainId: 1,
          autoApprove: { signing: false, transactions: [{ to: TO, selector: SELECTOR, chainId: 1 }] },
        },
      })
    );
    _resetCache();
    expect(covers('0')).toBe(true);
    expect(covers(undefined)).toBe(true);
    expect(covers(CENT)).toBe(false);
    // Confirmed again with "Always allow", it covers that send's value.
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, CENT);
    expect(covers(CENT)).toBe(true);
  });

  test("the renderer's question carries the value", async () => {
    registerDappPermissionsIpc();
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, CENT);
    const ask = (value) => ipcHandlers['dapp:is-tx-auto-approved']({}, SITE, TO, SELECTOR, 1, value);
    await expect(ask(CENT_HEX)).resolves.toBe(true);
    await expect(ask(TWO_CENTS_HEX)).resolves.toBe(false);
  });

  test('removing a rule still works on its call alone', () => {
    addTransactionAutoApprove(SITE, TO, SELECTOR, 1, CENT);
    expect(removeTransactionAutoApprove(SITE, TO, SELECTOR, 1)).toBe(true);
    expect(covers('0')).toBe(false);
  });
});

// freedom-core design 0011, PRQ-4: main writes a connection itself, for the
// key it attested, from the user's decision on its own prompt. The chrome's
// grant write named the site, so it is refused for every site; revoking,
// which only narrows, stays open.
describe('dapp-permissions — the chrome writes no grant (0011 PRQ-4)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    registerDappPermissionsIpc();
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([
    'https://swap.example',
    'bzz://' + 'a'.repeat(64),
    'name.eth',
    'example.com',
    'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6:100',
    '',
    undefined,
  ])('dapp:grant-permission for %p is refused and writes nothing', (site) => {
    expect(() => ipcHandlers['dapp:grant-permission']({}, site, 0, 100)).toThrow(
      'A dApp connection is granted only from its own prompt'
    );
    expect(getAllPermissions()).toEqual([]);
    if (site) expect(getPermission(site)).toBeNull();
  });

  test('an existing grant is left as it is, and revoking it still works', () => {
    grantPermission('https://swap.example', 1, 1);
    expect(() => ipcHandlers['dapp:grant-permission']({}, 'https://swap.example', 0, 100)).toThrow();
    expect(getPermission('https://swap.example')).toMatchObject({ walletIndex: 1, chainId: 1 });
    expect(ipcHandlers['dapp:revoke-permission']({}, 'https://swap.example')).toBe(true);
    expect(getPermission('https://swap.example')).toBeNull();
  });
});
