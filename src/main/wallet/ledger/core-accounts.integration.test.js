/**
 * Ledger discovery and adding through the core (wallet/ledger/core-accounts.js;
 * freedom-core design 0016, Accounts; the LDG-3 plan's PR 8) against the
 * real freedom-cored, with main's relay on the core's backend and a seeded
 * device behind it (test/helpers/fake-ledger-accounts-core.js: each
 * address its key's, as fc-ledger checks). Main's requests go as
 * core-accounts.js sends them, through vault-backend.js's `ledgerCall`
 * with `requires: vault_meta`, and the core reads and writes its own
 * vault-meta.json, which main reads its unmatched records from:
 * - discovery: the accounts the core checked, each with the scheme and
 *   index main adds; main's unmatched records checked after discovery's
 *   APDUs, the record the device doesn't hold `mismatched` and the one it
 *   holds `matched`, as the core wrote them;
 * - adding: the address shown on the device (`E0 02 01 00`, `deadline_ms`
 *   300000), the record the core wrote holding the device's address;
 *   rejected on the device, nothing written.
 * Each case checks that the core is the one it started: its strict reader
 * of main's replies ends the connection on any it doesn't take.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/wallet/ledger/core-accounts.integration
 * or FREEDOM_CORED_LEDGER_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockWorld = { client: null, relay: null, identityDir: null };

jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockWorld.client,
  getLedgerRelay: () => mockWorld.relay,
}));
// Main's list of the unmatched Ledger records, read from the file the core writes.
jest.mock('../../identity-manager', () => ({
  getLedgerRecordsToCheck: () => {
    const meta = JSON.parse(
      require('fs').readFileSync(require('path').join(mockWorld.identityDir, 'vault-meta.json'))
    );
    return meta.derivedWallets
      .filter((w) => w.type === 'ledger' && w.addressCheck !== 'matched')
      .map((w) => ({ addressCheck: 'unchecked', ...w }));
  },
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const log = require('../../logger');
const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('../../core/core-client');
const { registerLedgerRelay } = require('../../core/ledger-relay');
const { fakeLedgerDevices } = require('../../../../test/helpers/fake-ledger-core');
const {
  HARDWARE_INDEX_BASE,
  addressApdu,
  deviceAccount,
  seededDevice,
} = require('../../../../test/helpers/fake-ledger-accounts-core');
const { discoverAccounts, addAccount } = require('./core-accounts');

const required = process.env.FREEDOM_CORED_LEDGER_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH ||
  (required ? require('../../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_LEDGER_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary
  ? describe
  : (name, fn) => describe.skip(`${name} (skipped: no freedom-cored: set FREEDOM_CORED_PATH)`, fn);

jest.setTimeout(60_000);

const MAIN = {
  index: 0,
  name: 'Main Wallet',
  address: '0x0000000000000000000000000000000000000001',
};
const live = (i) => `44'/60'/${i}'/0/0`;
const hexOf = (apdu) => apdu.toString('hex');
// Two Ledger records added before #1065, unchecked: one another device
// holds, one the attached device holds. The core reads its file once, at
// its start, so they are written before it.
const OTHER = {
  index: HARDWARE_INDEX_BASE,
  name: 'Other',
  address: deviceAccount('device-b', live(4)).address,
  type: 'ledger',
  path: live(4),
};
const HELD = {
  index: HARDWARE_INDEX_BASE + 1,
  name: 'Held',
  address: deviceAccount('device-a', live(6)).address,
  type: 'ledger',
  path: live(6),
};

describeIfBinary('Ledger discovery and adding through the real freedom-cored', () => {
  let root;
  let identityDir;
  let device;
  let devices;
  let pid;

  const file = () => path.join(identityDir, 'vault-meta.json');
  const readMeta = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
  const writeMeta = (wallets) =>
    fs.writeFileSync(
      file(),
      JSON.stringify({ activeWalletIndex: 0, derivedWallets: [MAIN, ...wallets] }, null, 2)
    );

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ledger-accounts-'));
    identityDir = path.join(root, 'identity');
    fs.mkdirSync(identityDir);
    writeMeta([OTHER, HELD]);
    mockWorld.identityDir = identityDir;
    device = seededDevice('device-a');
    devices = fakeLedgerDevices({ respond: (apdu) => device.respond(apdu) });
    mockWorld.client = new CoreClient({
      spawn,
      command: binary,
      args: [
        'serve',
        '--data-dir',
        identityDir,
        '--lock-dir',
        path.join(root, 'locks'),
        '--parent-pid',
        String(process.pid),
      ],
      log: { info() {}, warn() {}, error() {}, debug() {} },
      shellVersion: 'jest',
      grantRoot: root,
      protocol: PROTOCOL_VERSION_STREAMS,
    });
    mockWorld.relay = registerLedgerRelay(mockWorld.client, {
      log,
      backendKind: () => 'core',
      openDevice: () => devices.openDevice(),
    });
    const hello = await mockWorld.client.start();
    expect(hello.store_moved).toContain('vault_meta');
    pid = mockWorld.client.current.child.pid;
  });

  afterAll(async () => {
    await mockWorld.client?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    device.script = null;
    devices.events.length = 0;
  });

  afterEach(() => {
    // The core read every reply main wrote: it is the one it started.
    expect(mockWorld.client.current?.child?.pid).toBe(pid);
    expect(log.error).not.toHaveBeenCalled();
    expect(mockWorld.relay.stats()).toEqual({ parents: 0, open: false });
  });

  test("discovery: the core's accounts, and main's unmatched records checked and kept by the core", async () => {
    const found = await discoverAccounts({ scheme: 'live', start: 0, count: 2 });

    expect(found).toEqual({
      accounts: [0, 1].map((index) => ({
        path: live(index),
        address: deviceAccount('device-a', live(index)).address,
        scheme: 'live',
        index,
      })),
      mismatched: [{ index: OTHER.index, name: 'Other', address: OTHER.address, path: OTHER.path }],
    });
    expect(devices.bytes()).toEqual(
      [live(0), live(1), live(4), live(6)].map((at) => hexOf(addressApdu(at)))
    );
    expect(
      readMeta()
        .derivedWallets.slice(1)
        .map((w) => [w.name, w.addressCheck])
    ).toEqual([
      ['Other', 'mismatched'],
      ['Held', 'matched'],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("adding: the address shown on the device, the record the core wrote holding the device's address", async () => {
    const wallet = await addAccount({ name: 'My Stax', scheme: 'live', index: 9 });

    const onDevice = deviceAccount('device-a', live(9)).address;
    expect(wallet).toEqual({
      index: HARDWARE_INDEX_BASE + 2,
      name: 'My Stax',
      address: onDevice,
      type: 'ledger',
      path: live(9),
      addressCheck: 'matched',
    });
    expect(readMeta().derivedWallets[3]).toEqual(wallet);
    expect(devices.bytes()).toEqual([hexOf(addressApdu(live(9), { display: true }))]);
    expect(devices.of('exchange')[0].ms).toBe(300_000);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('adding, rejected on the device: nothing written', async () => {
    const before = readMeta();
    device.script = () => '6985';

    await expect(addAccount({ name: 'No', scheme: 'live', index: 2 })).rejects.toMatchObject({
      code: 'LEDGER_USER_REJECTED',
    });
    expect(readMeta()).toEqual(before);
  });
});
