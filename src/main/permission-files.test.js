/**
 * Main's writes of the four permission files (freedom-core design 0012, "The
 * APR-3 pin"). From the pin of cored-v0.14.0 on, the core reads them at its
 * checks while main is still their only writer, so main writes each by a
 * temp file and a rename (lib/atomic-file.js), never in place. Every write
 * each store makes goes through the helper, and nothing else writes the
 * file: a spy on the helper and on `fs`.
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
  for (const store of [dapp, swarm, radicle, x402]) store._resetCache();
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
    'swarm-permissions.json',
    swarm,
    () => {
      swarm.grantPermission(ORIGIN);
      swarm.updateLastUsed(ORIGIN);
      expect(swarm.setAutoApprove(ORIGIN, 'publish', true)).toBe(true);
      expect(swarm.grantMessaging(ORIGIN)).toBe(true);
      expect(swarm.revokeMessaging(ORIGIN)).toBe(true);
      expect(swarm.revokePermission(ORIGIN)).toBe(true);
      return 6;
    },
  ],
  [
    'radicle-permissions.json',
    radicle,
    () => {
      radicle.grantPermission(ORIGIN);
      expect(radicle.grantSigning(ORIGIN)).toBe(true);
      expect(radicle.setAutoApprove(ORIGIN, 'signing', true)).toBe(true);
      expect(radicle.revokePermission(ORIGIN)).toBe(true);
      return 4;
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
