/**
 * Main's writes of the four permission files (freedom-core design 0012, "The
 * APR-3 pin"). From the pin of cored-v0.14.0 on, the core reads them at its
 * checks while main is still their only writer, so main writes each by a
 * temp file and a rename (lib/atomic-file.js), never in place. Every write
 * each store makes goes through the helper, and nothing else writes the
 * file: a spy on the helper and on `fs`. `dapp-permissions.json` is the
 * core's from APB-2, and main writes it nowhere
 * (wallet/dapp-permissions.test.js). No script under scripts/ writes,
 * renames or deletes a permission file either: `npm run dapp:reset`, which
 * deleted the dApp file, refuses from APB-2 and touches nothing.
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

const { spawnSync } = require('child_process');
const { app } = require('electron');
const { writeFileAtomicSync } = require('./lib/atomic-file');
const swarm = require('./swarm/swarm-permissions');
const radicle = require('./radicle/radicle-permissions');
const x402 = require('./x402/permissions');

const ORIGIN = 'https://app.example';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-files-'));
  app.getPath.mockReturnValue(tmpDir);
  for (const store of [swarm, radicle, x402]) store._resetCache();
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

// Scripts run beside main, not through it: one that wrote a file the core
// owns would write behind the core, which holds the grants in memory and
// writes them back. The surface is closed rather than pattern-matched: no
// file under scripts/ names a permission file at all, but the refusing
// dapp:reset script, which is run below; and no npm script, lifecycle hooks
// included, names one or reaches that script but `dapp:reset` itself.
describe('scripts/ writes no permission file', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const SCRIPTS = path.join(ROOT, 'scripts');
  const PERMISSION_FILE = /(?:dapp|swarm|radicle|x402)-permissions/;
  const RESET = 'scripts/reset-dapp-permissions.js';

  function* files(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* files(full);
      else if (entry.isFile()) yield full;
    }
  }

  test('no script names a permission file but the refusing dapp:reset', () => {
    const naming = [];
    let read = 0;
    for (const file of files(SCRIPTS)) {
      const bytes = fs.readFileSync(file);
      if (bytes.includes(0)) continue;
      read += 1;
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (PERMISSION_FILE.test(bytes.toString('utf8')) || PERMISSION_FILE.test(rel)) naming.push(rel);
    }
    expect(read).toBeGreaterThan(100);
    expect(naming).toEqual([RESET]);
  });

  test('no npm script, hook or alias reaches a permission file but dapp:reset, exactly', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const reaching = Object.entries(scripts)
      .filter(([name, command]) => PERMISSION_FILE.test(command) || /^(?:pre|post)dapp:reset$/.test(name))
      .map(([name, command]) => [name, command]);
    expect(reaching).toEqual([['dapp:reset', `node ${RESET}`]]);
  });

  test('npm run dapp:reset refuses: it exits non-zero, says why, and leaves the file as it was', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['dapp:reset']).toBe('node scripts/reset-dapp-permissions.js');
    // The file where the old command looked for it, on each platform.
    const appData = path.join(tmpDir, 'AppData', 'Roaming');
    const planted = [
      path.join(tmpDir, '.config', 'Freedom'),
      path.join(tmpDir, 'Library', 'Application Support', 'Freedom'),
      path.join(appData, 'Freedom'),
    ].map((dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'dapp-permissions.json');
      fs.writeFileSync(file, JSON.stringify({ 'https://app.example': { origin: 'https://app.example' } }, null, 2));
      return [file, fs.readFileSync(file)];
    });
    const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'reset-dapp-permissions.js')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: tmpDir, USERPROFILE: tmpDir, APPDATA: appData, XDG_CONFIG_HOME: path.join(tmpDir, '.config') },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nothing was changed');
    expect(run.stderr).toContain("the dApp permissions are the identity core's");
    expect(run.stderr).toContain('Disconnect');
    for (const [file, bytes] of planted) expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });
});
