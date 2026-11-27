/**
 * Run by the Ledger device probe (src/main/wallet/ledger/hid-device.probe.test.js)
 * as Electron's main process: main's HID device with its host in a utility
 * process, as main runs it (freedom-core design 0016, LDG-3 PR 5). The step
 * is LEDGER_HID_UTILITY_STEP's:
 *
 * - `prespawn` (no Ledger needed): the first operation's first exchange is
 *   let go of in the same turn, before its host has spawned, when
 *   Electron's kill can't reach it. That host must end as it spawns, and
 *   the next operation must get a fresh host (its answer with a Ledger,
 *   `not_found` without) once it has exited, well before main would give up
 *   on it. On Linux it also reads the fresh host's environment and mapped
 *   files: only the allowlist's marker, and node-hid loaded.
 * - `device`: one operation answers `B0 01`; one is let go of while its
 *   exchange is in flight, which kills the host; one more answers from a
 *   fresh host.
 *
 * It prints one line, `LEDGER_HID_UTILITY {…}`, and quits.
 */

const fs = require('fs');
const { app } = require('electron');
const {
  HidDevice,
  HidHost,
  DEADLINE_MS,
  launchHost,
} = require('../../src/main/wallet/ledger/hid-device');

const B001 = Buffer.from('b001000000', 'hex');
const statusOf = (answer) => answer.toString('hex').slice(-4);
const SENTINEL = 'LEDGER_HID_PROBE_SENTINEL';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function prespawn() {
  // In main's environment, never in a host's.
  process.env[SENTINEL] = 'main only';
  const pids = [];
  const host = new HidHost({
    idleMs: null,
    launch: () => {
      const proc = launchHost();
      proc.onSpawn(() => pids.push(proc.pid()));
      return proc;
    },
  });
  const result = {};
  try {
    const first = new HidDevice({ host });
    const outcome = first.exchange(B001, DEADLINE_MS.DEVICE).then(
      () => 'answered',
      (err) => (err.detached ? 'detached' : err.failure)
    );
    first.detach();
    result.letGo = await outcome;

    const started = Date.now();
    const next = new HidDevice({ host });
    result.next = await next
      .exchange(B001, DEADLINE_MS.DEVICE)
      .then(statusOf, (err) => err.failure);
    result.nextMs = Date.now() - started;
    next.detach();
    result.hosts = pids.length;
    result.firstGone = pids.length > 0 && !alive(pids[0]);
    if (process.platform === 'linux' && pids[1]) {
      result.env = fs
        .readFileSync(`/proc/${pids[1]}/environ`, 'latin1')
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.split('=')[0]);
      result.nodeHid = /HID(_hidraw)?\.node/.test(
        fs.readFileSync(`/proc/${pids[1]}/maps`, 'latin1')
      );
    }
  } catch (err) {
    result.error = err?.failure ?? err?.message ?? String(err);
  }
  host.kill();
  return result;
}

async function device() {
  const host = new HidHost({ idleMs: null });
  const result = {};
  let forks = 0;
  const generation = () => host.generation;
  try {
    const first = new HidDevice({ host });
    result.first = statusOf(await first.exchange(B001, DEADLINE_MS.DEVICE));
    const firstHost = generation();
    first.detach();

    const letGo = new HidDevice({ host });
    const outcome = letGo.exchange(B001, DEADLINE_MS.DEVICE).then(
      () => 'answered',
      (err) => (err.detached ? 'detached' : err.failure)
    );
    letGo.detach();
    result.letGo = await outcome;

    const after = new HidDevice({ host });
    result.after = statusOf(await after.exchange(B001, DEADLINE_MS.DEVICE));
    forks = generation() - firstHost + 1;
    after.detach();
  } catch (err) {
    result.error = err?.failure ?? err?.message ?? String(err);
  }
  result.hosts = forks;
  host.kill();
  return result;
}

app.whenReady().then(async () => {
  const step = process.env.LEDGER_HID_UTILITY_STEP === 'prespawn' ? prespawn : device;
  const result = await step();
  process.stdout.write(`LEDGER_HID_UTILITY ${JSON.stringify(result)}\n`);
  app.quit();
});
