/**
 * Main's Ledger relay (core/ledger-relay.js) against the real
 * freedom-cored (freedom-core design 0016, LDG-3; the LDG-3 plan's PR 6:
 * "every answer form is one the core accepts"), with the switch on and a
 * scripted device behind the relay. Main sends its own Ledger requests
 * under the device watchdog (core-deadlines.js `deviceWatchdogMs`, as
 * vault-backend.js `ledgerCall` sends them) and opens each in the relay
 * from its `onSent`; the core's device lane asks for each APDU
 * (`shell.ledger_apdu`), and main's reply is read by the release main pins,
 * which ends the connection on any reply it doesn't take. So each case also
 * checks that the core is the one it started (no exit, no restart):
 * - `{ answer }`: `ledger.accounts` for one path, the device's recorded
 *   answer (ledger.json's `discovery-live-0-1`, from the public test
 *   phrase), and the account the core checks and returns;
 * - `invalid_argument { rule }`: a `ledger.add` whose path main's record
 *   doesn't hold, refused `path` before the device, and the core ends it
 *   `LEDGER_UNKNOWN`;
 * - `{ failed }`: a device that isn't there, `LEDGER_DEVICE_NOT_FOUND`.
 * The rest of LDG-3's gates (`sign.*` with a Ledger key, which needs the
 * store moved, typed data and the hash-only form, x402) are PR 12's.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/core/ledger-relay.integration
 * or FREEDOM_CORED_LEDGER_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const log = require('../logger');
const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('./core-client');
const { deviceWatchdogMs } = require('./core-deadlines');
const { registerLedgerRelay } = require('./ledger-relay');
const { fakeLedgerDevices } = require('../../../test/helpers/fake-ledger-core');

const required = process.env.FREEDOM_CORED_LEDGER_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH ||
  (required ? require('./cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_LEDGER_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary
  ? describe
  : (name, fn) => describe.skip(`${name} (skipped: no freedom-cored: set FREEDOM_CORED_PATH)`, fn);

jest.setTimeout(60_000);

// ledger.json's `discovery-live-0-1`: the address check at 44'/60'/0'/0/0
// and the reference device's answer (public key, address, 9000).
const ADDRESS_CHECK = 'e002000015058000002c8000003c800000000000000000000000';
const ADDRESS_ANSWER =
  '410437b0bb7a8288d38ed49a524b5dc98cff3eb5ca824c9f9dc0dfdb3d9cd600f299a6179912b7451c09896c4098eca7ce6b2e58330672795e847c4d6af44e02423028393835384566464432333242343033334534376439303030334434314543333445636145646139349000';
const ACCOUNT = { path: "44'/60'/0'/0/0", address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' };

describeIfBinary('the relay against the real freedom-cored', () => {
  let root;
  let client;
  let relay;
  let devices;
  let answers;
  let pid;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ledger-relay-'));
    devices = fakeLedgerDevices({ respond: (apdu) => answers(apdu) });
    client = new CoreClient({
      spawn,
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
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
    relay = registerLedgerRelay(client, {
      log,
      backendKind: () => 'core',
      openDevice: () => devices.openDevice(),
    });
    const hello = await client.start();
    expect(hello.capabilities).toEqual(expect.arrayContaining(['ledger.accounts', 'ledger.add']));
    pid = client.current.child.pid;
    expect(Number.isSafeInteger(pid)).toBe(true);
  });

  afterAll(async () => {
    await client?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    answers = () => '9000';
  });

  afterEach(() => {
    // The core read every reply main wrote: it is the one it started.
    expect(client.current?.child?.pid).toBe(pid);
    expect(log.error).not.toHaveBeenCalled();
    expect(relay.stats()).toEqual({ parents: 0, open: false });
  });

  /** One of main's Ledger requests, under the device watchdog, opened in the relay as it is sent. */
  async function ledgerRequest(method, params, capture = {}) {
    const controller = new AbortController();
    let handle = null;
    try {
      return await client.request(
        method,
        params,
        { caller: 'chrome' },
        {
          deviceWatchdogMs: deviceWatchdogMs(method, params),
          signal: controller.signal,
          onSent: (id, generation) => {
            handle = relay.open({ id, generation }, { method, params, ...capture, controller });
          },
        }
      );
    } finally {
      handle?.close();
    }
  }

  test('{ answer }: ledger.accounts, the account the core checked', async () => {
    answers = (apdu) => (apdu.toString('hex') === ADDRESS_CHECK ? ADDRESS_ANSWER : '6f00');
    const result = await ledgerRequest('ledger.accounts', { scheme: 'live', start: 0, count: 1 });
    expect(result).toEqual({ accounts: [ACCOUNT], mismatched: [] });
    expect(devices.bytes().slice(-1)).toEqual([ADDRESS_CHECK]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("invalid_argument { rule }: ledger.add at a path main's record doesn't hold, refused before the device", async () => {
    const before = devices.bytes().length;
    // Main's record says index 1; the core is asked for index 0.
    const prepared = relay.prepare({ method: 'ledger.add', params: { scheme: 'live', index: 1 } });
    const error = await ledgerRequest(
      'ledger.add',
      { scheme: 'live', index: 0 },
      { prepared }
    ).catch((err) => err);
    expect(error.code).toBe('device_failed');
    expect(error.data).toEqual({ ledger: 'LEDGER_UNKNOWN' });
    expect(devices.bytes()).toHaveLength(before);
    expect(log.warn).toHaveBeenCalledWith('[Ledger] shell.ledger_apdu refused', { rule: 'path' });
  });

  test('{ failed }: no device, LEDGER_DEVICE_NOT_FOUND', async () => {
    answers = () => ({ fail: 'not_found' });
    const error = await ledgerRequest('ledger.accounts', {
      scheme: 'legacy',
      start: 0,
      count: 2,
    }).catch((err) => err);
    expect(error.code).toBe('device_failed');
    expect(error.data).toEqual({ ledger: 'LEDGER_DEVICE_NOT_FOUND' });
  });
});
