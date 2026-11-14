/**
 * Main's writes of the four permission files (freedom-core design 0012, "The
 * APR-3 pin" and APB-3). From the pin of cored-v0.14.0 on, the core reads
 * them at its checks. Main is still the only writer of
 * `dapp-permissions.json` and `x402-permissions.json`, and writes each by a
 * temp file and a rename (lib/atomic-file.js), never in place: a spy on the
 * helper and on `fs`. `swarm-permissions.json` and
 * `radicle-permissions.json` are the core's (APB-3: both in the hello's
 * `grant_moved`): main writes neither anywhere, and each of their stores'
 * writes goes to the core's write methods.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
}));
jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('./lib/atomic-file', () => {
  const actual = jest.requireActual('./lib/atomic-file');
  return { writeFileAtomicSync: jest.fn(actual.writeFileAtomicSync) };
});

const { app } = require('electron');
const { writeFileAtomicSync } = require('./lib/atomic-file');
const { useSimulatedGrantCore, testPage } = require('../../test/helpers/simulated-grant-core');
const dapp = require('./wallet/dapp-permissions');
const swarm = require('./swarm/swarm-permissions');
const radicle = require('./radicle/radicle-permissions');
const x402 = require('./x402/permissions');

const ORIGIN = 'https://app.example';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER = '0xa9059cbb';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-files-'));
  app.getPath.mockReturnValue(tmpDir);
  for (const store of [dapp, x402]) store._resetCache();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  writeFileAtomicSync.mockClear();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Each store's writes, every one that saves the file: [file, store, writes]
// where `writes()` returns how many saves it made.
const STORES = [
  [
    'dapp-permissions.json',
    dapp,
    () => {
      dapp.grantPermission(ORIGIN, 0, 1);
      dapp.updateLastUsed(ORIGIN, 10);
      dapp.updateWalletIndex(ORIGIN, 1);
      dapp.setSigningAutoApprove(ORIGIN, true);
      expect(dapp.addTransactionAutoApprove(ORIGIN, TOKEN, TRANSFER, 10, 0)).toBe(true);
      expect(dapp.removeTransactionAutoApprove(ORIGIN, TOKEN, TRANSFER, 10)).toBe(true);
      dapp.revokePermissionsForWalletIndex(1);
      dapp.grantPermission(ORIGIN, 0, 1);
      expect(dapp.revokePermission(ORIGIN)).toBe(true);
      return 9;
    },
  ],
  [
    'x402-permissions.json',
    x402,
    () => {
      x402.grant(ORIGIN, 8453, TOKEN, '10000000', 3600);
      const taken = x402.charge(ORIGIN, 8453, TOKEN, '1000000');
      expect(taken).not.toBeNull();
      expect(x402.refund(taken)).toBe(true);
      x402.updatePermission(ORIGIN, 8453, TOKEN, { capAmount: '5000000' });
      x402.revoke(ORIGIN, 8453, TOKEN);
      x402.grant(ORIGIN, 8453, TOKEN, '10000000', 3600);
      x402.revokeAllForOrigin(ORIGIN);
      return 7;
    },
  ],
];

describe.each(STORES)('%s', (name, _store, writes) => {
  test('every write is a temp file renamed over it, through the helper, never in place', () => {
    const target = path.join(tmpDir, name);
    const opens = jest.spyOn(fs, 'openSync');
    const inPlace = [
      jest.spyOn(fs, 'writeFileSync'),
      jest.spyOn(fs, 'appendFileSync'),
      jest.spyOn(fs, 'truncateSync'),
      jest.spyOn(fs, 'copyFileSync'),
    ];
    const renames = jest.spyOn(fs, 'renameSync');

    const saves = writes();

    const helped = writeFileAtomicSync.mock.calls.filter(([file]) => file === target);
    expect(helped).toHaveLength(saves);
    const onto = renames.mock.calls.filter(([, to]) => to === target);
    expect(onto).toHaveLength(saves);
    for (const [from] of onto) {
      expect(path.dirname(from)).toBe(tmpDir);
      expect(path.basename(from).startsWith(`${name}.`)).toBe(true);
      expect(from.endsWith('.tmp')).toBe(true);
    }
    for (const spy of inPlace) {
      for (const [file] of spy.mock.calls) expect(file).not.toBe(target);
    }
    // Only the flush after a rename opens the target itself (on Windows,
    // FlushFileBuffers needs the file), never before one, never to write.
    const renamedAt = renames.mock.calls
      .map(([, to], i) => (to === target ? renames.mock.invocationCallOrder[i] : null))
      .filter((order) => order !== null);
    opens.mock.calls.forEach(([file, flags], i) => {
      if (file !== target) return;
      expect(flags).toBe('r+');
      expect(renamedAt.some((order) => order < opens.mock.invocationCallOrder[i])).toBe(true);
    });
    expect(fs.readdirSync(tmpDir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    // The file is whole JSON, as JSON.stringify(…, null, 2) wrote it.
    const text = fs.readFileSync(target, 'utf-8');
    expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
  });
});

// The files the core writes (APB-3): every write fs makes while each store
// changes, none of them to the grant root.
const MOVED = [
  [
    'swarm-permissions.json',
    'swarm',
    async (page) => {
      await swarm.grantPermission(ORIGIN, { page });
      expect(await swarm.updateLastUsed(ORIGIN, { page })).toBe(true);
      expect(await swarm.setAutoApprove(ORIGIN, 'publish', true, { page })).toBe(true);
      expect(await swarm.grantMessaging(ORIGIN, { page })).toBe(true);
      expect(await swarm.setAutoApprove(ORIGIN, 'publish', false)).toBe(true);
      expect(await swarm.revokeMessaging(ORIGIN)).toBe(true);
      expect(await swarm.revokePermission(ORIGIN)).toBe(true);
      // A manifest's projection, as main's own.
      await swarm.grantPermission(ORIGIN, { source: 'manifest' });
      expect(await swarm.revokePermission(ORIGIN, { source: 'manifest' })).toBe(true);
      return 9;
    },
  ],
  [
    'radicle-permissions.json',
    'radicle',
    async (page) => {
      await radicle.grantPermission(ORIGIN, { page });
      expect(await radicle.grantSigning(ORIGIN, { page })).toBe(true);
      expect(await radicle.setAutoApprove(ORIGIN, 'signing', true, { page })).toBe(true);
      expect(await radicle.setAutoApprove(ORIGIN, 'node', false, { caller: 'chrome' })).toBe(true);
      expect(await radicle.revokePermission(ORIGIN, { caller: 'chrome' })).toBe(true);
      return 5;
    },
  ],
];

describe.each(MOVED)('%s (the core\'s)', (name, store, writes) => {
  test('main writes it nowhere: each change goes to the core', async () => {
    const core = await useSimulatedGrantCore();
    const spies = [
      'writeFileSync',
      'appendFileSync',
      'truncateSync',
      'copyFileSync',
      'renameSync',
      'unlinkSync',
      'rmSync',
      'openSync',
      'writeFile',
      'rename',
    ].map((method) => jest.spyOn(fs, method));
    const promises = ['writeFile', 'rename', 'open', 'appendFile', 'copyFile', 'unlink'].map((method) =>
      jest.spyOn(fs.promises, method)
    );

    const changes = await writes(testPage(ORIGIN));

    for (const spy of [...spies, ...promises]) {
      for (const [file] of spy.mock.calls) {
        expect(path.resolve(String(file)).startsWith(tmpDir)).toBe(false);
      }
    }
    expect(writeFileAtomicSync).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, name))).toBe(false);
    expect(core.calls.filter((call) => call.params.store === store)).toHaveLength(changes);
  });

  test('its store reads and writes no file itself', () => {
    const source = fs.readFileSync(path.join(__dirname, store, `${store}-permissions.js`), 'utf8');
    expect(source).not.toMatch(/require\('fs'\)|require\("fs"\)|atomic-file|getFreedomDataPath/);
  });
});
