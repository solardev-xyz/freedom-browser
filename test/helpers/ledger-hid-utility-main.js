/**
 * Run by the Ledger device probe (src/main/wallet/ledger/hid-device.probe.test.js)
 * as Electron's main process: main's HID device with its host in a utility
 * process, as main runs it (freedom-core design 0016, LDG-3 PR 5). One
 * operation answers `B0 01`; one is let go of while its exchange is in
 * flight, which kills the host; one more answers from a fresh host. It
 * prints one line, `LEDGER_HID_UTILITY {…}`, and quits.
 */

const { app } = require('electron');
const { HidDevice, HidHost, DEADLINE_MS } = require('../../src/main/wallet/ledger/hid-device');

const B001 = Buffer.from('b001000000', 'hex');
const statusOf = (answer) => answer.toString('hex').slice(-4);

async function run() {
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
  process.stdout.write(`LEDGER_HID_UTILITY ${JSON.stringify(result)}\n`);
}

app.whenReady().then(async () => {
  await run();
  app.quit();
});
