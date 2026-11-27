/**
 * Ledger discovery and adding through the core (wallet/ledger/core-accounts.js;
 * freedom-core design 0016, Accounts; the LDG-3 plan's PR 8), against a
 * scripted core that plays `ledger.accounts` and `ledger.add` as cored
 * 0.30.0 does (test/helpers/fake-ledger-accounts-core.js, whose reader of
 * main's replies is reply.rs's), through a real CoreClient, main's relay
 * and vault-backend.js's `ledgerCall`, with a seeded device behind the
 * relay that records every byte it is sent:
 * - discovery: the range as today's `listAccounts` reads it, each account
 *   with the scheme and index the chrome adds it by; main's unmatched
 *   records checked after discovery's APDUs (D1), the results kept by the
 *   core, `mismatched` the records the device doesn't hold; a stale list
 *   a failed check, discovery still answered; account-checks.js and
 *   transport.js never used;
 * - adding: `ledger.add { scheme, index, name? }` under `shell`, never an
 *   address, never `accounts.add_ledger`; the device shows the address
 *   (`E0 02 01 00`, `deadline_ms` 300000) and the record the core writes
 *   holds the device's address, never the chrome's;
 * - `requires: vault_meta`: a core that didn't take the store is sent
 *   nothing; a device's failure is errors.js's error for its code; an
 *   answer that isn't the one asked for is `LEDGER_UNKNOWN`.
 * Every reply main wrote is one the core's reader takes (`faults` empty),
 * and every parent is closed in the relay after.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockWorld = { client: null, relay: null, records: null };

jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockWorld.client,
  getLedgerRelay: () => mockWorld.relay,
}));
// Main's list of the unmatched Ledger records (identity-manager.js
// `getLedgerRecordsToCheck`): the core's file's, unless a test says otherwise.
jest.mock('../../identity-manager', () => ({
  getLedgerRecordsToCheck: () => mockWorld.records(),
}));
jest.mock('./transport', () => {
  throw new Error('the JS backend’s transport is not used on the core’s');
});
jest.mock('./account-checks', () => {
  throw new Error('account-checks.js is not run on the core’s backend');
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../../logger');
const { discoverAccounts, addAccount } = require('./core-accounts');
const {
  HARDWARE_INDEX_BASE,
  addressAnswer,
  addressApdu,
  deviceAccount,
  startAccountsCore,
} = require('../../../../test/helpers/fake-ledger-accounts-core');

const MAIN = {
  index: 0,
  name: 'Main Wallet',
  address: '0x0000000000000000000000000000000000000001',
};
const live = (i) => `44'/60'/${i}'/0/0`;
const legacy = (i) => `44'/60'/0'/${i}`;
const hexOf = (apdu) => apdu.toString('hex');

describe('Ledger discovery and adding through the core', () => {
  let identityDir;
  let world;

  const file = () => path.join(identityDir, 'vault-meta.json');
  const readMeta = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
  const writeMeta = (wallets) =>
    fs.writeFileSync(
      file(),
      JSON.stringify({ activeWalletIndex: 0, derivedWallets: [MAIN, ...wallets] }, null, 2)
    );
  // The reference's getLedgerRecordsToCheck over the file.
  const recordsInFile = () =>
    readMeta()
      .derivedWallets.filter((w) => w.type === 'ledger' && w.addressCheck !== 'matched')
      .map((w) => ({ addressCheck: 'unchecked', ...w }));
  const requests = (method) => world.core().requests(method);

  async function start(options = {}) {
    world = await startAccountsCore({ identityDir, log, ...options });
    mockWorld.client = world.client;
    mockWorld.relay = world.relay;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ledger-accounts-'));
    writeMeta([]);
    mockWorld.records = recordsInFile;
    await start();
  });

  afterEach(async () => {
    expect(world.core().faults).toEqual([]);
    expect(world.relay.stats()).toEqual({ parents: 0, open: false });
    // Nothing logged an APDU's bytes or an answer's.
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(logged).not.toMatch(/e002|9000/);
    await world.stop();
    fs.rmSync(identityDir, { recursive: true, force: true });
  });

  describe('discovery', () => {
    test("the scheme's accounts, each with the scheme and index the chrome adds it by", async () => {
      const found = await discoverAccounts({ scheme: 'live', start: 2, count: 3 });

      expect(found).toEqual({
        accounts: [2, 3, 4].map((i) => ({
          path: live(i),
          address: deviceAccount('device-a', live(i)).address,
          scheme: 'live',
          index: i,
        })),
        mismatched: [],
      });
      // Main's own request, under `shell`, its range exactly.
      const [sent] = requests('ledger.accounts');
      expect(sent.params).toEqual({ scheme: 'live', start: 2, count: 3 });
      expect(sent.context).toEqual({ caller: 'shell' });
      // The device saw discovery's APDUs alone, on one device opened for them.
      expect(world.devices.bytes()).toEqual([2, 3, 4].map((i) => hexOf(addressApdu(live(i)))));
      expect(world.devices.of('open')).toHaveLength(1);
      expect(world.devices.of('detach')).toHaveLength(1);
    });

    test("the range as today's listAccounts reads it", async () => {
      await discoverAccounts({ scheme: 'legacy', start: -3, count: 50.7 });
      await discoverAccounts({ scheme: 'legacy', start: 4.9, count: 0 });
      await discoverAccounts();

      expect(requests('ledger.accounts').map((m) => m.params)).toEqual([
        { scheme: 'legacy', start: 0, count: 20 },
        { scheme: 'legacy', start: 4, count: 1 },
        { scheme: 'live', start: 0, count: 5 },
      ]);
      expect(world.devices.bytes()[0]).toBe(hexOf(addressApdu(legacy(0))));
    });

    test('an unknown scheme or a range that is no number is sent nowhere', async () => {
      await expect(discoverAccounts({ scheme: 'ledger-live' })).rejects.toThrow(
        'Unknown derivation scheme: ledger-live'
      );
      await expect(discoverAccounts({ start: 'next' })).rejects.toThrow(
        'Invalid Ledger account range'
      );
      // Past the schemes' last index: main can't derive its stream.
      await expect(discoverAccounts({ start: 2 ** 31 - 2, count: 5 })).rejects.toMatchObject({
        code: 'LEDGER_UNKNOWN',
      });
      expect(requests('ledger.accounts')).toEqual([]);
      expect(world.devices.events).toEqual([]);
    });

    test("main's unmatched records are checked after discovery, and the core keeps each result (D1)", async () => {
      const held = deviceAccount('device-a', live(7)).address;
      const other = deviceAccount('device-b', live(1)).address;
      writeMeta([
        { index: HARDWARE_INDEX_BASE, name: 'Kept', address: held, type: 'ledger', path: live(7) },
        {
          index: HARDWARE_INDEX_BASE + 1,
          name: 'Other Ledger',
          address: other,
          type: 'ledger',
          path: live(1),
          addressCheck: 'unchecked',
        },
        {
          index: HARDWARE_INDEX_BASE + 2,
          name: 'Matched',
          address: deviceAccount('device-a', live(9)).address,
          type: 'ledger',
          path: live(9),
          addressCheck: 'matched',
        },
      ]);

      const found = await discoverAccounts({ scheme: 'live', start: 0, count: 1 });

      expect(found.mismatched).toEqual([
        { index: HARDWARE_INDEX_BASE + 1, name: 'Other Ledger', address: other, path: live(1) },
      ]);
      // Discovery's APDU, then one per unmatched record, in the list's order.
      expect(world.devices.bytes()).toEqual(
        [live(0), live(7), live(1)].map((at) => hexOf(addressApdu(at)))
      );
      const kept = readMeta().derivedWallets.map((w) => [w.name, w.addressCheck]);
      expect(kept).toEqual([
        ['Main Wallet', undefined],
        ['Kept', 'matched'],
        ['Other Ledger', 'mismatched'],
        ['Matched', 'matched'],
      ]);
    });

    test('a stale list is a failed check: discovery answers, mismatched empty', async () => {
      writeMeta([
        {
          index: HARDWARE_INDEX_BASE,
          name: 'Other Ledger',
          address: deviceAccount('device-b', live(1)).address,
          type: 'ledger',
          path: live(1),
        },
      ]);
      // Main's list is older than the core's snapshot: the record isn't in it.
      mockWorld.records = () => [];

      const found = await discoverAccounts({ scheme: 'live', start: 0, count: 1 });

      expect(found.accounts).toHaveLength(1);
      expect(found.mismatched).toEqual([]);
      // Main's stream ended with discovery's APDU: the check's was refused
      // before it reached the device.
      expect(world.devices.bytes()).toEqual([hexOf(addressApdu(live(0)))]);
      const ask = [...world.core().asks.values()].pop();
      expect(ask.read).toEqual({ refused: 'ended' });
      expect(readMeta().derivedWallets[1].addressCheck).toBeUndefined();
    });

    test("a device's failure is errors.js's error for its code", async () => {
      world.device.script = () => ({ fail: 'not_found' });
      await expect(discoverAccounts({})).rejects.toMatchObject({
        code: 'LEDGER_DEVICE_NOT_FOUND',
        message: 'No Ledger device found. Connect it via USB and unlock it.',
      });

      world.device.script = () => '6511';
      await expect(discoverAccounts({})).rejects.toMatchObject({
        code: 'LEDGER_ETH_APP_NOT_OPEN',
        message: 'Open the Ethereum app on your Ledger.',
      });

      world.device.script = () => '5515';
      await expect(discoverAccounts({})).rejects.toMatchObject({
        code: 'LEDGER_DEVICE_LOCKED',
        message: 'Ledger is locked. Unlock it with your PIN.',
      });
    });

    test('an answer outside the range main asked for is LEDGER_UNKNOWN', async () => {
      const core = world.core();
      const discover = core.discover.bind(core);
      core.discover = async (parent, params) => {
        const answer = await discover(parent, params);
        return { ...answer, accounts: answer.accounts.map((a) => ({ ...a, path: live(9) })) };
      };

      await expect(discoverAccounts({ count: 1 })).rejects.toMatchObject({
        code: 'LEDGER_UNKNOWN',
      });
    });
  });

  describe('adding', () => {
    test("the core reads the address on the device's screen and writes the record: the device's address", async () => {
      const wallet = await addAccount({ name: 'My Stax', scheme: 'live', index: 3 });
      const onDevice = deviceAccount('device-a', live(3)).address;

      expect(wallet).toEqual({
        index: HARDWARE_INDEX_BASE,
        name: 'My Stax',
        address: onDevice,
        type: 'ledger',
        path: live(3),
        addressCheck: 'matched',
      });
      expect(readMeta().derivedWallets[1]).toEqual(wallet);
      // `ledger.add` under `shell`: a scheme, an index and a name, no address.
      const [sent] = requests('ledger.add');
      expect(sent.params).toEqual({ scheme: 'live', index: 3, name: 'My Stax' });
      expect(sent.context).toEqual({ caller: 'shell' });
      expect(requests('accounts.add_ledger')).toEqual([]);
      // The address shown on the device for the user to confirm (question 3).
      expect(world.devices.bytes()).toEqual([hexOf(addressApdu(live(3), { display: true }))]);
      expect(world.devices.of('exchange')[0].ms).toBe(300_000);
    });

    test("an address from the chrome is never the record's", async () => {
      const planted = deviceAccount('device-b', legacy(0)).address;

      // The JS backend's (name, address, path), sent to the core's.
      await expect(
        addAccount({ name: 'Planted', scheme: planted, index: legacy(0) })
      ).rejects.toThrow('Unknown derivation scheme for Ledger account');
      await expect(addAccount({ name: 'Planted', scheme: 'legacy', index: '0' })).rejects.toThrow(
        'Invalid Ledger account index'
      );
      expect(requests('ledger.add')).toEqual([]);
      expect(world.devices.events).toEqual([]);

      // The device holds another address than the one the chrome listed.
      world.device.seed = 'device-c';
      const wallet = await addAccount({ name: 'Mine', scheme: 'legacy', index: 0 });
      expect(wallet.address).toBe(deviceAccount('device-c', legacy(0)).address);
      expect(JSON.stringify(readMeta())).not.toContain(planted.slice(2));
    });

    test('no name is the core’s default; a name that is not a string is not sent', async () => {
      const first = await addAccount({ scheme: 'live', index: 0 });
      const second = await addAccount({ name: 7, scheme: 'live', index: 1 });

      expect(requests('ledger.add').map((m) => m.params)).toEqual([
        { scheme: 'live', index: 0 },
        { scheme: 'live', index: 1 },
      ]);
      expect([first.name, second.name]).toEqual(['Ledger 1', 'Ledger 2']);
      expect(second.index).toBe(HARDWARE_INDEX_BASE + 1);
    });

    test('rejected on the device: nothing is written', async () => {
      world.device.script = () => '6985';

      await expect(addAccount({ name: 'No', scheme: 'live', index: 0 })).rejects.toMatchObject({
        code: 'LEDGER_USER_REJECTED',
        message: 'Request rejected on the Ledger device.',
      });
      expect(readMeta().derivedWallets).toEqual([MAIN]);
    });

    test('a write the store refuses keeps its text', async () => {
      await addAccount({ name: 'First', scheme: 'live', index: 0 });

      await expect(addAccount({ name: 'Again', scheme: 'live', index: 0 })).rejects.toThrow(
        'This account is already in your wallet list as "First"'
      );
      expect(readMeta().derivedWallets).toHaveLength(2);
    });

    test('an answer that is not the record of the path asked for is LEDGER_UNKNOWN', async () => {
      const core = world.core();
      const add = core.add.bind(core);
      core.add = async (parent, params) => {
        const answer = await add(parent, params);
        return { path: answer.path, address: answer.address };
      };

      await expect(addAccount({ scheme: 'live', index: 0 })).rejects.toMatchObject({
        code: 'LEDGER_UNKNOWN',
      });
    });

    test('discovery while an add waits on the device is LEDGER_BUSY at once', async () => {
      world.device.script = (apdu) => (apdu[2] === 0x01 ? { hold: true } : undefined);
      const adding = addAccount({ name: 'Waiting', scheme: 'live', index: 0 });
      await waitFor(() => world.devices.held.length === 1);

      await expect(discoverAccounts({})).rejects.toMatchObject({ code: 'LEDGER_BUSY' });

      world.devices.release(addressAnswer('device-a', live(0)).toString('hex'));
      await expect(adding).resolves.toMatchObject({ name: 'Waiting' });
    });
  });

  test('a core that did not take vault_meta is sent nothing', async () => {
    await world.stop();
    await start({ storeMoved: [] });

    await expect(discoverAccounts({})).rejects.toMatchObject({ code: 'requirement_unmet' });
    await expect(addAccount({ scheme: 'live', index: 0 })).rejects.toMatchObject({
      code: 'requirement_unmet',
    });
    expect(requests('ledger.accounts')).toEqual([]);
    expect(requests('ledger.add')).toEqual([]);
    expect(world.devices.events).toEqual([]);
  });

  test('no core: core_unavailable, nothing prepared', async () => {
    const { relay } = mockWorld;
    mockWorld.relay = null;
    try {
      await expect(discoverAccounts({})).rejects.toMatchObject({ code: 'core_unavailable' });
      await expect(addAccount({ scheme: 'live', index: 0 })).rejects.toMatchObject({
        code: 'core_unavailable',
      });
    } finally {
      mockWorld.relay = relay;
    }
  });
});

/** Waits for `predicate` in real turns of the event loop. */
async function waitFor(predicate) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out');
}
