/**
 * Main's Ledger relay (core/ledger-relay.js) on main's real HID device
 * layer (wallet/ledger/hid-device.js), its hosts served in this process on
 * a fake node-hid (test/helpers/fake-node-hid.js), against a scripted core
 * whose reader is cored 0.30.0's (test/helpers/fake-ledger-core.js): the
 * device opened per operation and closed at its end; and across
 * operations (freedom-core design 0016, LDG-3's relay rules), the core's
 * cancel of the old operation's APDU written in the same chunk as the next
 * operation's first APDU: the cancel is processed first, the old handle is
 * closed (its host killed, the OS closing it) without its reply awaited, a
 * fresh handle is opened for the new parent only after that, and the old
 * operation's late answer reaches no parent. Nothing breaks hidapi's
 * contract (R1).
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { hexlify, toUtf8Bytes } = require('ethers');
const log = require('../logger');
const { LedgerRelay } = require('./ledger-relay');
const { HidDevice, HidHost } = require('../wallet/ledger/hid-device');
const {
  createFakeNodeHid,
  inProcessHosts,
  APP_ANSWER,
} = require('../../../test/helpers/fake-node-hid');
const {
  parentOf,
  settle,
  startLedgerCore,
  until,
} = require('../../../test/helpers/fake-ledger-core');

const PATH = "44'/60'/0'/0/0";
const MESSAGE = {
  key: { kind: 'ledger', index: 0 },
  message: hexlify(toUtf8Bytes('Hello, Ledger')),
};

let fake;
let host;
let started;
// The relay's devices, one per operation, in order.
let made;

const core = () => started.core();
const hex = (bytes) => Buffer.from(bytes).toString('hex');

function stream() {
  const prepared = new LedgerRelay().prepare({
    method: 'sign.message',
    params: MESSAGE,
    path: PATH,
  });
  return prepared.admission.slots.map((slot) => ({
    apdu: hex(slot.apdu),
    ms: slot.waits ? 300_000 : 15_000,
  }));
}

function open() {
  return parentOf(started.client, started.relay, {
    method: 'sign.message',
    params: MESSAGE,
    capture: { path: PATH },
  });
}

async function ask(parent, { apdu, ms }) {
  const id = core().apdu(parent.id, apdu, ms);
  await until(() => core().raw(id), 'the reply');
  return core().reply(id);
}

beforeEach(async () => {
  jest.clearAllMocks();
  made = [];
  fake = createFakeNodeHid();
  host = new HidHost({ launch: inProcessHosts(fake), idleMs: null });
  started = await startLedgerCore({
    log,
    deps: {
      openDevice: () => {
        const device = new HidDevice({ host });
        made.push(device);
        return device;
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer),
    },
  });
});

afterEach(async () => {
  expect(core().faults).toEqual([]);
  expect(fake.violations).toEqual([]);
  host.kill();
  await started.client.stop();
});

/** The device holds the first E0 08 (the user reads it); every other APDU is answered. */
function holdFirstConfirmation() {
  let holds = 1;
  fake.ledger.respond = (apdu) => {
    if (apdu[1] === 0x08 && holds > 0) {
      holds -= 1;
      return { hold: true };
    }
    return { answer: apdu[0] === 0xb0 ? APP_ANSWER : '9000' };
  };
}

const types = () => fake.events.map((e) => `${e.type}:${e.handle ?? ''}`);

test('one operation opens one handle at its first APDU and closes it after its last', async () => {
  const parent = open();
  await until(() => parent.handle, 'the parent');
  expect(fake.events).toEqual([]);
  const replies = [];
  for (const apdu of stream()) replies.push(await ask(parent, apdu));
  expect(replies.map((r) => r.answer.toString('hex'))).toEqual(['9000', APP_ANSWER, '9000']);
  await until(() => types().includes('close:1'), 'the handle closed');
  expect(types().filter((t) => t.startsWith('open') || t.includes('close'))).toEqual([
    'open:1',
    'close:1',
  ]);
});

test("after the core's cancel, the next parent's first APDU: the old handle closed unawaited, a fresh one opened, the old reply routed nowhere", async () => {
  holdFirstConfirmation();
  const apdus = stream();
  const a = open();
  await until(() => a.handle, 'parent A');
  await ask(a, apdus[0]);
  await ask(a, apdus[1]);
  const aId = core().apdu(a.id, apdus[2].apdu, apdus[2].ms);
  await until(() => fake.ledger.held, 'the user waits on A');
  const b = open();
  await until(() => b.handle, 'parent B');
  let bId;
  core().batch(() => {
    core().cancel(aId);
    bId = core().apdu(b.id, apdus[0].apdu, apdus[0].ms);
  });
  await until(() => core().raw(aId) && core().raw(bId), 'both replies');
  expect(core().reply(aId)).toEqual({ cancelled: true });
  expect(core().reply(bId).answer.toString('hex')).toBe('9000');
  // A's handle went with its host (the OS closed it, its read still in
  // flight), and only then did B's open.
  const order = types();
  expect(order.indexOf('exit-close:1')).toBeGreaterThan(-1);
  expect(order.indexOf('open:2')).toBeGreaterThan(order.indexOf('exit-close:1'));
  expect(order).not.toContain('close:1');
  // A's late answer, on A's channel: no parent takes it.
  fake.ledger.release('9000');
  await settle(50);
  const rest = [];
  for (const apdu of apdus.slice(1)) rest.push(await ask(b, apdu));
  expect(rest.map((r) => r.answer.toString('hex'))).toEqual([APP_ANSWER, '9000']);
  // B's host read A's late answer and dropped it: another channel's.
  expect(made).toHaveLength(2);
  expect(made[1].droppedFrames).toBeGreaterThan(0);
  expect(core().messages.filter((m) => m.type === 'response')).toHaveLength(core().asks.size);
});

test("after main's own cancel: the parent's cancel first, the handle let go mid-read, the next parent on a fresh handle", async () => {
  holdFirstConfirmation();
  const apdus = stream();
  const a = open();
  await until(() => a.handle, 'parent A');
  await ask(a, apdus[0]);
  await ask(a, apdus[1]);
  const aId = core().apdu(a.id, apdus[2].apdu, apdus[2].ms);
  await until(() => fake.ledger.held, 'the user waits on A');
  a.handle.cancel();
  await until(() => core().raw(aId), "A's reply");
  expect(core().reply(aId)).toEqual({ failed: 'disconnected' });
  expect(core().cancels()).toEqual([a.id]);
  const b = open();
  await until(() => b.handle, 'parent B');
  expect((await ask(b, apdus[0])).answer.toString('hex')).toBe('9000');
  const order = types();
  expect(order.indexOf('open:2')).toBeGreaterThan(order.indexOf('exit-close:1'));
});
