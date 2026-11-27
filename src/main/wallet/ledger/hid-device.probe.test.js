/**
 * LDG-3 PR 5's device probe: main's HID device (hid-device.js, its host in
 * hid-host.js; freedom-core design 0016) against a real Ledger, through the
 * real node-hid in a real host process. What it checks, and on which OS, is
 * in docs/development.md (*Ledger through the core*); the plan's R1, R3, R5
 * and R8 need a device, and a fake can't show them.
 *
 * Gated: runs only with LEDGER_DEVICE_E2E=1, and skips when no Ledger is
 * plugged in. Plug one in, unlock it, open the Ethereum app, quit Ledger
 * Live (on Linux, install Ledger's udev rules). LEDGER_DEVICE_E2E_INTERACTIVE=1
 * adds the steps that need hands on the device (a prompt left showing and
 * rejected, an unplug). Run it under Electron's Node, one test at a time:
 *
 *   LEDGER_DEVICE_E2E=1 ELECTRON_RUN_AS_NODE=1 npx electron node_modules/jest/bin/jest.js \
 *     --runInBand src/main/wallet/ledger/hid-device.probe.test.js
 *
 * Under Electron's Node the host is a Node child on the same runtime; one
 * step starts Electron's main process (test/helpers/ledger-hid-utility-main.js)
 * to run it as main does, in a utility process (on Linux it needs a display:
 * a desktop session, or xvfb-run). It prints what it saw at the end. It sends
 * only `B0 01` (the open app's name and version) and, with hands, `E0 02 01
 * 00` (show the address at 44'/60'/0'/0/0); it signs nothing.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HidDevice, HidHost, DEADLINE_MS, LEDGER_VENDOR_ID } = require('./hid-device');

const RUN = process.env.LEDGER_DEVICE_E2E === '1';
const HANDS = process.env.LEDGER_DEVICE_E2E_INTERACTIVE === '1';
const UTILITY_MAIN = path.join(__dirname, '../../../../test/helpers/ledger-hid-utility-main.js');

const B001 = Buffer.from('b001000000', 'hex');
// E0 02 01 00: the address at 44'/60'/0'/0/0, shown on the device until the
// user approves or rejects it.
const ADDRESS_SHOWN = Buffer.from('e002010015058000002c8000003c800000000000000000000000', 'hex');
// Delays before letting go, in ms: before the host has the APDU, while it
// polls, and around the device's answer.
const LET_GO_DELAYS = [0, 1, 2, 3, 5, 8, 13, 21];

function ledgers() {
  return require('node-hid').devices(LEDGER_VENDOR_ID, 0);
}

const found = RUN ? ledgers() : [];
if (RUN && found.length === 0) console.info('[ledger probe] No Ledger plugged in: skipped');
const describeIfDevice = !RUN
  ? (name, fn) => describe.skip(`${name} (skipped: LEDGER_DEVICE_E2E is not 1)`, fn)
  : found.length === 0
    ? (name, fn) => describe.skip(`${name} (skipped: no Ledger plugged in)`, fn)
    : describe;
const testWithHands = HANDS
  ? test
  : (name, fn, ms) =>
      test.skip(`${name} (skipped: LEDGER_DEVICE_E2E_INTERACTIVE is not 1)`, fn, ms);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const status = (answer) => answer.readUInt16BE(answer.length - 2);
const appOf = (answer) => ({
  format: answer[0],
  name: answer.subarray(2, 2 + answer[1]).toString('latin1'),
});
const hex4 = (word) => word.toString(16).padStart(4, '0');

const report = [];
function say(line) {
  console.info(`[ledger probe] ${line}`);
}

describeIfDevice("main's HID device against a real Ledger (LDG-3 PR 5's probe)", () => {
  let host;
  const device = () => new HidDevice({ host });

  // One operation's B0 01.
  async function appAnswer() {
    const op = device();
    try {
      const answer = await op.exchange(B001, DEADLINE_MS.DEVICE);
      return { answer, dropped: op.droppedFrames };
    } finally {
      op.detach();
    }
  }

  // Until the Ethereum app answers 9000, or `ms` passes.
  async function waitForApp(ms) {
    const until = Date.now() + ms;
    let dropped = 0;
    while (Date.now() < until) {
      try {
        const { answer, dropped: more } = await appAnswer();
        dropped += more;
        if (status(answer) === 0x9000 && appOf(answer).name === 'Ethereum') return { dropped };
      } catch (err) {
        if (!err.failure) throw err;
      }
      await sleep(1_000);
    }
    return null;
  }

  beforeAll(() => {
    host = new HidHost({ idleMs: null });
    const versions = process.versions.electron
      ? `Electron ${process.versions.electron}`
      : `Node ${process.versions.node}`;
    report.push(
      `${process.platform}-${process.arch}, ${versions}, ${found[0].product ?? 'Ledger'}`
    );
  });

  afterAll(() => {
    host.kill();
    say(report.join('\n[ledger probe] '));
  });

  test('opens at the first APDU, answers from the Ethereum app, closes at its end', async () => {
    const op = device();
    expect(op.isOpen).toBe(false);
    const answer = await op.exchange(B001, DEADLINE_MS.DEVICE);
    expect(op.isOpen).toBe(true);
    expect(hex4(status(answer))).toBe('9000');
    expect(appOf(answer)).toEqual({ format: 1, name: 'Ethereum' });
    op.detach();
    expect(op.isOpen).toBe(false);
  });

  test('R3: the time per APDU, 50 in one operation', async () => {
    const op = device();
    const times = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      const answer = await op.exchange(B001, DEADLINE_MS.DEVICE);
      times.push(performance.now() - started);
      expect(hex4(status(answer))).toBe('9000');
    }
    op.detach();
    times.sort((a, b) => a - b);
    const ms = (t) => `${t.toFixed(1)} ms`;
    report.push(
      `B0 01: median ${ms(times[25])}, slowest ${ms(times[49])}, fastest ${ms(times[0])}`
    );
  });

  test('R5: 100 operations in one host, each closing its handle before the next opens', async () => {
    const first = (await appAnswer()).answer;
    expect(hex4(status(first))).toBe('9000');
    const generation = host.generation;
    for (let i = 0; i < 100; i++) {
      const { answer } = await appAnswer();
      expect(hex4(status(answer))).toBe('9000');
    }
    // No host was killed: each close ran with no read in flight.
    expect(host.generation).toBe(generation);
    report.push('100 closes with nothing in flight: one host throughout');
  }, 60_000);

  test('R1 and R5: let go mid-exchange 100 times, each killing its host, the next answering its own APDU', async () => {
    const tally = { answered: 0, detached: 0, dropped: 0 };
    for (let i = 0; i < 100; i++) {
      const op = device();
      const outcome = op.exchange(B001, DEADLINE_MS.DEVICE).then(
        () => 'answered',
        (err) => (err.detached ? 'detached' : err.failure)
      );
      await sleep(LET_GO_DELAYS[i % LET_GO_DELAYS.length]);
      op.detach();
      const settled = await outcome;
      expect(['answered', 'detached']).toContain(settled);
      tally[settled]++;

      const { answer, dropped } = await appAnswer();
      expect(hex4(status(answer))).toBe('9000');
      expect(appOf(answer)).toEqual({ format: 1, name: 'Ethereum' });
      tally.dropped += dropped;
    }
    report.push(
      `100 lets go: ${tally.detached} mid-exchange (a host killed each), ${tally.answered} after ` +
        `the answer; ${tally.dropped} late reports dropped by the next handle`
    );
    expect(tally.detached).toBeGreaterThan(0);
  }, 300_000);

  test("R8: under Electron's main process, through a utility process", async () => {
    // Electron's binary: this runtime's, or the npm package's path (jest maps
    // `electron` to a mock, so the real module is asked for).
    const electron = process.versions.electron ? process.execPath : jest.requireActual('electron');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-hid-utility-'));
    const env = { ...process.env, FREEDOM_TEST_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [UTILITY_MAIN];
    if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox');
    const output = await new Promise((resolve, reject) => {
      const child = spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
      let text = '';
      child.stdout.on('data', (chunk) => (text += chunk));
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('error', reject);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(text);
      });
    });
    fs.rmSync(userData, { recursive: true, force: true });
    const line = output.split('\n').find((l) => l.startsWith('LEDGER_HID_UTILITY '));
    expect(line).toBeDefined();
    const result = JSON.parse(line.slice('LEDGER_HID_UTILITY '.length));
    expect(result).toEqual({ first: '9000', letGo: 'detached', after: '9000', hosts: 2 });
    report.push('Through a utility process: answered, let go (host killed), answered again');
  }, 90_000);

  testWithHands(
    'R1 with the device waiting: a cancel lets go mid-read, and the old prompt answers no later operation',
    async () => {
      const op = device();
      const controller = new AbortController();
      const exchanged = op.exchange(ADDRESS_SHOWN, DEADLINE_MS.USER, controller.signal).then(
        () => null,
        (err) => err
      );
      say('The Ledger shows an address: leave it there.');
      await sleep(3_000);
      const started = performance.now();
      controller.abort();
      const letGoMs = performance.now() - started;
      const err = await exchanged;
      expect(err).toMatchObject({ failure: 'disconnected', detached: true });
      expect(op.isOpen).toBe(false);

      // 0016: a device still showing an older request gives the new
      // operation's first APDU an error status, or no answer in 15 s.
      const outcome = await appAnswer().then(
        ({ answer }) => `status ${hex4(status(answer))}`,
        (e) => e.failure
      );
      report.push(`Cancel mid-read: let go in ${letGoMs.toFixed(1)} ms`);
      report.push(`Next APDU while the old prompt shows: ${outcome}`);
      expect(outcome === 'unresponsive' || outcome.startsWith('status')).toBe(true);

      say('Reject the address on the Ledger now (within 60 s).');
      const after = await waitForApp(60_000);
      expect(after).not.toBeNull();
      report.push(
        `After the rejection the next operation works; ${after.dropped} late reports dropped`
      );
    },
    150_000
  );

  testWithHands(
    'an unplug mid-read is disconnected; plugged back in, the next operation works',
    async () => {
      const op = device();
      const controller = new AbortController();
      const giveUp = setTimeout(() => controller.abort(), 90_000);
      const exchanged = op.exchange(ADDRESS_SHOWN, DEADLINE_MS.USER, controller.signal).then(
        () => null,
        (err) => err
      );
      say('The Ledger shows an address: unplug it now (within 90 s).');
      const err = await exchanged;
      clearTimeout(giveUp);
      expect(err).toMatchObject({ failure: 'disconnected', detached: false });
      expect(op.isOpen).toBe(false);

      say('Plug the Ledger back in, unlock it and open the Ethereum app (within 120 s).');
      const after = await waitForApp(120_000);
      expect(after).not.toBeNull();
      report.push('Unplugged mid-read: disconnected; plugged back in, the next operation works');
    },
    240_000
  );
});
