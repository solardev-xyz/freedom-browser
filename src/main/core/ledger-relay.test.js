/**
 * Main's relay for the core's `shell.ledger_apdu` (freedom-core design
 * 0016, LDG-3; the LDG-3 plan's PR 6), against a scripted core
 * (test/helpers/fake-ledger-core.js) whose reader is cored 0.30.0's
 * (reply.rs), through a real CoreClient, with a scripted device behind the
 * relay that records every byte it is sent (the transport spy):
 * - the strict reader and the parent registry: a parent main didn't send,
 *   one that ended, the Safe rows until SAFE-3, the JS backend (every APDU
 *   `parent`);
 * - the relay's refusals in LDG-3's row, each answered before a byte
 *   reaches the device and logged with its rule only, never an APDU's
 *   bytes, the device closed after; every later APDU of that parent
 *   `ended`;
 * - what the relay answers (point 4): every reply here is read by the
 *   core's reader, and none is a protocol error; a throw inside the relay
 *   is `ended`, logged `relay_fault`, the device closed;
 * - `deadline_ms` (point 6) enforced from the APDU's arrival, logged when
 *   it isn't the row's, and the device watchdog set by each APDU and each
 *   answer;
 * - main's own cancel (point 5) and `beforeSign` (point 7);
 * - the hash-only warning (point 12): with the surface's report held, no
 *   answer and no `E0 0C 00 00` reaches the device; at most 10 s, inside
 *   the APDU's 15 s;
 * - across operations, after the core's cancel, after the core's deadline
 *   and after main's: the cancel processed first, the old device closed
 *   without its reply awaited, a fresh one opened, the old reply routed to
 *   no parent;
 * - the device opened per operation and closed at its end, and on the
 *   core's exit.
 * Every honest stream and every forbidden entry of the pinned grammar are
 * played the same way in ledger-relay.vectors.test.js.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { TypedDataEncoder, hexlify, toUtf8Bytes } = require('ethers');
const log = require('../logger');
const { LedgerRelay, readAsk, HASH_ONLY_WAIT_MS } = require('./ledger-relay');
const { apduWatchdogMs } = require('./core-deadlines');
const {
  fakeClock,
  fakeLedgerDevices,
  parentOf,
  settle,
  startLedgerCore,
  until,
} = require('../../../test/helpers/fake-ledger-core');

const PATH = "44'/60'/0'/0/0";
const LEDGER = { kind: 'ledger', index: 0 };
const MESSAGE = { key: LEDGER, message: hexlify(toUtf8Bytes('Hello, Ledger')) };
const TX = {
  key: LEDGER,
  tx: {
    type: 2,
    chain_id: '1',
    nonce: '7',
    gas_limit: '21000',
    to: '0x' + '22'.repeat(20),
    value: '1000',
    data: '0x',
    max_fee_per_gas: '30000000000',
    max_priority_fee_per_gas: '1000000000',
  },
};
const MAIL = {
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};
const MAIL_HASH = TypedDataEncoder.hash(MAIL.domain, MAIL.types, MAIL.message);
const TYPED = { key: LEDGER, typed_data: MAIL, expected_hash: MAIL_HASH };

const PARENTS = {
  message: { method: 'sign.message', params: MESSAGE, capture: { path: PATH } },
  transaction: { method: 'sign.transaction', params: TX, capture: { path: PATH } },
  typed: { method: 'sign.typed_data', params: TYPED, capture: { path: PATH } },
  accounts: {
    method: 'ledger.accounts',
    params: { scheme: 'live', start: 0, count: 2 },
    capture: { records: [{ path: "44'/60'/0'/7", address: '0x' + '11'.repeat(20) }] },
  },
  add: { method: 'ledger.add', params: { scheme: 'legacy', index: 3 }, capture: {} },
};

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const SIX_D = '6d00';

/** Main's own stream for a parent: each APDU's hex and `deadline_ms`, from a fresh admission. */
function streamOf({ method, params, capture }) {
  const prepared = new LedgerRelay().prepare({ method, params, ...capture });
  if (!prepared.ok) throw new Error(`no stream: ${prepared.rule}`);
  return prepared.admission.slots.map((slot) => ({
    apdu: hex(slot.apdu),
    ms: slot.waits ? 300_000 : 15_000,
    row: slot.row,
  }));
}

let started;
let clock;
let devices;

const core = () => started.core();

async function start({ respond, deps = {}, withClock = true } = {}) {
  clock = withClock ? fakeClock() : null;
  devices = fakeLedgerDevices(respond ? { respond } : {});
  started = await startLedgerCore({ log, devices, clock, deps });
  return started;
}

function open(which, capture = {}) {
  const spec = PARENTS[which];
  return parentOf(started.client, started.relay, {
    method: spec.method,
    params: spec.params,
    capture: { ...spec.capture, ...capture },
  });
}

/** The core sends one APDU for parent `parent` and waits for main's reply. */
async function ask(parent, apdu, ms = 15_000) {
  const id = core().apdu(parent.id, apdu, ms);
  await until(() => core().raw(id), `the reply to ${apdu.slice(0, 8)}`);
  return core().reply(id);
}

/** Plays `stream[from…to)` for `parent`, each answered 9000 by the device. */
async function play(parent, stream, to = stream.length, from = 0) {
  const replies = [];
  for (let k = from; k < to; k++) replies.push(await ask(parent, stream[k].apdu, stream[k].ms));
  return replies;
}

/** Every APDU's hex of every stream above, to look for in the log. */
const ALL_APDUS = Object.values(PARENTS)
  .flatMap((spec) => streamOf(spec).map((s) => s.apdu))
  .filter((apdu) => apdu.length > 10);

const message = () => streamOf(PARENTS.message);
const typed = () => streamOf(PARENTS.typed);

/** Main's log never holds an APDU's or an answer's bytes. */
function expectNoBytesLogged() {
  const text = JSON.stringify(
    [log.info, log.warn, log.error, log.debug].flatMap((fn) => fn.mock.calls)
  );
  for (const apdu of ALL_APDUS) expect(text).not.toContain(apdu.slice(10));
  expect(text).not.toMatch(/[0-9a-f]{20,}/);
}

const refusals = () =>
  log.warn.mock.calls.filter(([message]) => message === '[Ledger] shell.ledger_apdu refused');

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  if (!started) return;
  // No reply main wrote was a protocol error to the core.
  expect(core().faults).toEqual([]);
  expectNoBytesLogged();
  await started.client.stop();
  started = null;
});

describe('the strict reader', () => {
  test.each([
    ['not an object', null, { for: null, rule: 'parent' }],
    ['no for', { apdu: 'b001000000', deadline_ms: 15000 }, { for: null, rule: 'parent' }],
    ['for 0', { for: 0, apdu: 'b001000000', deadline_ms: 15000 }, { for: null, rule: 'parent' }],
    [
      'for as text',
      { for: '3', apdu: 'b001000000', deadline_ms: 15000 },
      { for: null, rule: 'parent' },
    ],
    [
      'an unknown member',
      { for: 3, apdu: 'b001000000', deadline_ms: 15000, x: 1 },
      { for: 3, rule: 'header' },
    ],
    ['no deadline_ms', { for: 3, apdu: 'b001000000' }, { for: 3, rule: 'header' }],
    [
      'deadline_ms 16000',
      { for: 3, apdu: 'b001000000', deadline_ms: 16000 },
      { for: 3, rule: 'header' },
    ],
    [
      'deadline_ms as text',
      { for: 3, apdu: 'b001000000', deadline_ms: '15000' },
      { for: 3, rule: 'header' },
    ],
    [
      'apdu of 4 bytes',
      { for: 3, apdu: 'b0010000', deadline_ms: 15000 },
      { for: 3, rule: 'header' },
    ],
    [
      'apdu of 261 bytes',
      { for: 3, apdu: 'e0'.repeat(261), deadline_ms: 15000 },
      { for: 3, rule: 'header' },
    ],
    ['apdu odd', { for: 3, apdu: 'b00100000', deadline_ms: 15000 }, { for: 3, rule: 'header' }],
    [
      'apdu with 0x',
      { for: 3, apdu: '0xb001000000', deadline_ms: 15000 },
      { for: 3, rule: 'header' },
    ],
    [
      'apdu as bytes',
      { for: 3, apdu: [176, 1, 0, 0, 0], deadline_ms: 15000 },
      { for: 3, rule: 'header' },
    ],
  ])('%s', (_name, params, expected) => {
    expect(readAsk(params)).toEqual(expected);
  });

  test('reads exactly { for, apdu, deadline_ms }, deadline_ms 15000 or 300000', () => {
    for (const ms of [15_000, 300_000]) {
      const read = readAsk({ for: 9, apdu: 'B001000000', deadline_ms: ms });
      expect(read).toEqual({ for: 9, apdu: Buffer.from('b001000000', 'hex'), deadlineMs: ms });
    }
  });
});

describe('the parent registry', () => {
  test("a parent main didn't send is refused parent, one that ended ended, nothing reaching the device", async () => {
    await start();
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = streamOf(PARENTS.message);
    expect(await ask({ id: parent.id + 50 }, stream[0].apdu)).toEqual({ refused: 'parent' });
    parent.handle.close();
    expect(await ask(parent, stream[0].apdu)).toEqual({ refused: 'ended' });
    expect(devices.bytes()).toEqual([]);
    expect(devices.of('open')).toEqual([]);
    expect(refusals().map(([, fields]) => fields)).toEqual([{ rule: 'parent' }, { rule: 'ended' }]);
  });

  test('a parent that ended is still refused ended after many more parents end', async () => {
    await start();
    const first = open('message');
    await until(() => first.handle, 'the first parent');
    const stream = streamOf(PARENTS.message);
    first.handle.close();
    for (let i = 0; i < 70; i++) {
      const later = open('message');
      await until(() => later.handle, 'a later parent');
      later.handle.close();
    }
    expect(await ask(first, stream[0].apdu)).toEqual({ refused: 'ended' });
    expect(devices.bytes()).toEqual([]);
  });

  test('with js, open() throws and every APDU is refused parent', async () => {
    await start({ deps: { backendKind: () => 'js' } });
    const parent = open('message');
    await until(() => parent.id, 'the parent sent');
    expect(parent.error).toBeInstanceOf(Error);
    expect(parent.error.message).toMatch(/JS backend/);
    for (const { apdu, ms } of streamOf(PARENTS.message)) {
      expect(await ask(parent, apdu, ms)).toEqual({ refused: 'parent' });
    }
    expect(devices.events).toEqual([]);
  });

  test.each([
    ['safe.sign_owner', { safe: 0, owner: 1 }],
    ['safe.message_sign', { safe: 0, session: 'a', owner: 1 }],
    ['sign.message', { key: { kind: 'account', index: 0 }, message: '0x01' }],
    ['x402.settle', { reservation: 'r', signature: '0x01' }],
  ])(
    '%s opens no operation: prepare refuses it parent, and its APDUs are refused parent',
    async (method, params) => {
      await start();
      const relay = started.relay;
      expect(relay.prepare({ method, params, path: PATH })).toEqual({
        ok: false,
        rule: 'parent',
        reason: 'no-operation',
      });
      const parent = parentOf(started.client, relay, { method, params, capture: { path: PATH } });
      await until(() => parent.handle, 'the parent');
      expect(parent.handle.operation).toBeNull();
      const address = streamOf(PARENTS.message)[0].apdu;
      expect(await ask(parent, address)).toEqual({ refused: 'parent' });
      expect(await ask(parent, address)).toEqual({ refused: 'ended' });
      expect(devices.bytes()).toEqual([]);
    }
  );

  test('what main cannot derive is refused before the first APDU, by prepare and on the wire', async () => {
    await start();
    const relay = started.relay;
    const wrongHash = { ...TYPED, expected_hash: '0x' + '00'.repeat(32) };
    expect(
      relay.prepare({ method: 'sign.typed_data', params: wrongHash, path: PATH })
    ).toMatchObject({
      ok: false,
      rule: 'payload',
      reason: 'hash-mismatch',
    });
    expect(
      relay.prepare({ method: 'sign.message', params: { key: LEDGER, message: '0x' }, path: PATH })
    ).toEqual({ ok: false, rule: 'payload', reason: 'empty-message' });
    expect(
      relay.prepare({ method: 'sign.message', params: MESSAGE, path: "m/44'/60'/0'/0/0" })
    ).toEqual({ ok: false, rule: 'path', reason: 'path-strict' });
    // Opened anyway: its first APDU is refused with that rule, then ended.
    const parent = parentOf(started.client, relay, {
      method: 'sign.typed_data',
      params: wrongHash,
      capture: { path: PATH },
    });
    await until(() => parent.handle, 'the parent');
    const stream = streamOf(PARENTS.typed);
    expect(await ask(parent, stream[0].apdu)).toEqual({ refused: 'payload' });
    expect(await ask(parent, stream[1].apdu)).toEqual({ refused: 'ended' });
    expect(devices.bytes()).toEqual([]);
  });

  test('open() takes a parent once, with its controller', async () => {
    await start();
    const { relay } = started;
    const controller = new AbortController();
    const prepared = relay.prepare({ method: 'sign.message', params: MESSAGE, path: PATH });
    expect(() => relay.open({ generation: 1, id: 40 }, { prepared })).toThrow(TypeError);
    relay.open({ generation: 1, id: 40 }, { prepared, controller });
    expect(() => relay.open({ generation: 1, id: 41 }, { prepared, controller })).toThrow(
      /admission is open already/
    );
    expect(() =>
      relay.open({ generation: 1, id: 40 }, { ...PARENTS.message, params: MESSAGE, controller })
    ).toThrow(/open already/);
    expect(() =>
      relay.open(
        { generation: 1, id: 42 },
        { method: 'ledger.add', params: PARENTS.add.params, controller, beforeSign: async () => {} }
      )
    ).toThrow(/beforeSign is for a signature/);
    expect(() => relay.open({ generation: 1 }, { prepared, controller })).toThrow(/no request ID/);
  });
});

describe("the relay's refusals (LDG-3's row): before the device, logged with the rule only", () => {
  const flip = (apduHex, at) => {
    const bytes = Buffer.from(apduHex, 'hex');
    bytes[at] ^= 0x01;
    return hex(bytes);
  };
  // Each: the parent, how many honest APDUs go first, the APDU, the rule.
  const CASES = [
    ['an instruction outside its row', 'message', 2, () => 'e00a000000', 'header'],
    [
      'a second E0 0C (signature)',
      'typed',
      () => typed().length,
      () => typed()[typed().length - 1].apdu,
      'ended',
    ],
    ['another path', 'message', 0, () => flip(message()[0].apdu, 9), 'path'],
    [
      'one byte changed in an E0 08 piece',
      'message',
      2,
      () => flip(message()[2].apdu, 30),
      'payload',
    ],
    [
      'one byte changed in an E0 04 piece',
      'transaction',
      2,
      () => flip(streamOf(PARENTS.transaction)[2].apdu, 40),
      'payload',
    ],
    [
      'E0 02 01 00 outside ledger.add',
      'message',
      0,
      () => 'e0020100' + message()[0].apdu.slice(8),
      'header',
    ],
    ['B0 01 again', 'message', 2, () => 'b001000000', 'count'],
    ['an Lc that is not the length', 'message', 1, () => 'b001000001', 'header'],
    [
      'E0 0C 00 00 without the 6D00',
      'typed',
      3,
      () => 'e00c0000' + '55' + typed()[0].apdu.slice(10) + '00'.repeat(64),
      'order',
    ],
  ];

  test.each(CASES)('%s', async (_name, which, before, apduOf, rule) => {
    await start();
    const parent = open(which);
    await until(() => parent.handle, 'the parent');
    const stream = streamOf(PARENTS[which]);
    const count = typeof before === 'function' ? before() : before;
    const replies = await play(parent, stream, count);
    expect(replies.every((r) => r.answer?.toString('hex') === '9000')).toBe(true);
    const bad = apduOf();
    const seen = devices.bytes().length;
    expect(await ask(parent, bad)).toEqual({ refused: rule });
    // Nothing more reached the device, and its device is closed.
    expect(devices.bytes()).toHaveLength(seen);
    expect(devices.bytes()).toEqual(stream.slice(0, count).map((s) => s.apdu));
    if (count > 0) expect(devices.of('detach')).toHaveLength(1);
    expect(refusals().map(([, fields]) => fields)).toEqual([{ rule }]);
    // Every later APDU of that parent is ended, even the honest next one.
    const next = stream[Math.min(count, stream.length - 1)];
    expect(await ask(parent, next.apdu, next.ms)).toEqual({ refused: 'ended' });
    expect(devices.bytes()).toHaveLength(seen);
  });

  test('a form that names a live parent is refused header, and its parent ends', async () => {
    await start();
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 1);
    const id = core().ask('shell.ledger_apdu', {
      for: parent.id,
      apdu: stream[1].apdu,
      deadline_ms: 20_000,
    });
    await until(() => core().raw(id), 'the reply');
    expect(core().reply(id)).toEqual({ refused: 'header' });
    expect(devices.of('detach')).toHaveLength(1);
    expect(await ask(parent, stream[1].apdu)).toEqual({ refused: 'ended' });
    expect(devices.bytes()).toEqual([stream[0].apdu]);
  });

  test('a second APDU while one is out is refused order, and the first is still answered', async () => {
    await start({ respond: (apdu) => (apdu[0] === 0xb0 ? { hold: true } : '9000') });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 1);
    const held = core().apdu(parent.id, stream[1].apdu);
    await until(() => devices.held.length === 1, 'the held exchange');
    expect(await ask(parent, stream[2].apdu, stream[2].ms)).toEqual({ refused: 'order' });
    // The refusal closed the device: the held exchange answers disconnected.
    await until(() => core().raw(held), 'the held reply');
    expect(core().reply(held)).toEqual({ failed: 'disconnected' });
    expect(devices.bytes()).toEqual([stream[0].apdu, stream[1].apdu]);
  });
});

describe('what the relay answers (point 4)', () => {
  test('{ answer } with the device bytes, its device opened at the first APDU and closed after the last', async () => {
    const answers = { e002: '41' + '04'.repeat(65) + '28' + '61'.repeat(40) + '9000' };
    await start({ respond: (apdu) => answers[hex(apdu.subarray(0, 2))] ?? '9000' });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    expect(devices.of('open')).toEqual([]);
    const stream = message();
    const replies = await play(parent, stream);
    expect(replies.map((r) => r.answer.toString('hex'))).toEqual([answers.e002, '9000', '9000']);
    expect(replies.every((r) => r.hashOnlyShown === false)).toBe(true);
    expect(devices.bytes()).toEqual(stream.map((s) => s.apdu));
    expect(devices.of('open')).toHaveLength(1);
    // Closed after its last APDU, with nothing in flight.
    expect(devices.of('detach')).toEqual([{ type: 'detach', device: 1, inFlight: false }]);
    expect(await ask(parent, stream[2].apdu, stream[2].ms)).toEqual({ refused: 'ended' });
  });

  test('a status that ends the operation closes the device, and ends the parent', async () => {
    await start({ respond: (apdu) => (apdu[0] === 0xb0 ? '6e00' : '9000') });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    const replies = await play(parent, stream, 2);
    expect(replies[1].answer.toString('hex')).toBe('6e00');
    expect(devices.of('detach')).toHaveLength(1);
    expect(await ask(parent, stream[2].apdu, stream[2].ms)).toEqual({ refused: 'ended' });
  });

  test.each(['not_found', 'busy', 'disconnected'])(
    '{ failed: %s } from the device closes it',
    async (failure) => {
      await start({ respond: () => ({ fail: failure }) });
      const parent = open('accounts');
      await until(() => parent.handle, 'the parent');
      const stream = streamOf(PARENTS.accounts);
      expect(await ask(parent, stream[0].apdu)).toEqual({ failed: failure });
      expect(devices.of('detach')).toHaveLength(1);
      expect(await ask(parent, stream[1].apdu)).toEqual({ refused: 'ended' });
    }
  );

  test("cancelled only for the core's cancel, at once", async () => {
    await start({ respond: (apdu) => (apdu[1] === 0x08 ? { hold: true } : '9000') });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 2);
    const id = core().apdu(parent.id, stream[2].apdu, stream[2].ms);
    await until(() => devices.held.length === 1, 'the user waits');
    core().cancel(id);
    await until(() => core().raw(id), 'the reply');
    expect(core().reply(id)).toEqual({ cancelled: true });
    // The device let go at once, mid-exchange.
    expect(devices.of('detach')).toEqual([{ type: 'detach', device: 1, inFlight: true }]);
    // Released later: the answer has no reader.
    devices.release('9000');
    await settle();
    expect(devices.of('late')).toHaveLength(1);
  });

  test('a throw inside the relay is refused ended, logged relay_fault, and the device closed', async () => {
    await start({
      respond: (apdu) =>
        apdu[0] === 0xb0 ? { throw: new TypeError('a call the relay never makes') } : '9000',
    });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 1);
    expect(await ask(parent, stream[1].apdu)).toEqual({ refused: 'ended' });
    expect(log.error).toHaveBeenCalledWith('[Ledger] shell.ledger_apdu relay_fault', {
      rule: 'ended',
      error: 'TypeError',
    });
    expect(devices.of('detach')).toHaveLength(1);
    expect(await ask(parent, stream[2].apdu, stream[2].ms)).toEqual({ refused: 'ended' });
  });
});

describe('deadline_ms (point 6)', () => {
  test("15000 enforced from the APDU's arrival: unresponsive, the device closed", async () => {
    await start({ respond: (apdu) => (apdu[0] === 0xb0 ? { hold: true } : '9000') });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 1);
    const id = core().apdu(parent.id, stream[1].apdu, 15_000);
    await until(() => devices.held.length === 1, 'the held exchange');
    await clock.advance(14_999);
    expect(core().raw(id)).toBeNull();
    await clock.advance(1);
    await until(() => core().raw(id), 'the reply');
    expect(core().reply(id)).toEqual({ failed: 'unresponsive' });
    expect(devices.of('detach')).toEqual([{ type: 'detach', device: 1, inFlight: true }]);
  });

  test('300000 on the APDU the user confirms: timeout at 5 minutes', async () => {
    await start({ respond: (apdu) => (apdu[1] === 0x08 ? { hold: true } : '9000') });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 2);
    expect(stream[2].ms).toBe(300_000);
    const id = core().apdu(parent.id, stream[2].apdu, 300_000);
    await until(() => devices.held.length === 1, 'the user waits');
    await clock.advance(299_999);
    expect(core().raw(id)).toBeNull();
    await clock.advance(1);
    await until(() => core().raw(id), 'the reply');
    expect(core().reply(id)).toEqual({ failed: 'timeout' });
  });

  test("one that isn't the row's is logged, not refused, and enforced as sent", async () => {
    await start();
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 2);
    // The confirming APDU sent with 15000 (R2's other way round).
    const reply = await ask(parent, stream[2].apdu, 15_000);
    expect(reply.answer.toString('hex')).toBe('9000');
    expect(log.warn).toHaveBeenCalledWith("[Ledger] deadline_ms isn't the row's", {
      row: 'sign.message',
      deadline_ms: 15_000,
    });
    expect(devices.of('exchange').map((e) => e.ms)).toEqual([15_000, 15_000, 15_000]);
  });

  test("each APDU and each answer set the parent's device watchdog to deadline_ms + 15 s", async () => {
    await start();
    const resets = jest.spyOn(started.client, 'watchdogReset');
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    await play(parent, message());
    const calls = resets.mock.calls;
    expect(calls).toHaveLength(6);
    for (const [generation, id] of calls) {
      expect(generation).toBe(parent.generation);
      expect(id).toBe(parent.id);
    }
    expect(calls.map(([, , ms]) => ms)).toEqual([
      apduWatchdogMs(15_000),
      apduWatchdogMs(15_000),
      apduWatchdogMs(15_000),
      apduWatchdogMs(15_000),
      apduWatchdogMs(300_000),
      apduWatchdogMs(300_000),
    ]);
  });
});

describe("main's own cancel (point 5)", () => {
  test('the parent cancel goes, the device closes at once, and the APDU is answered as the exchange gives', async () => {
    await start({ respond: (apdu) => (apdu[1] === 0x08 ? { hold: true } : '9000') });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 2);
    const id = core().apdu(parent.id, stream[2].apdu, stream[2].ms);
    await until(() => devices.held.length === 1, 'the user waits');
    parent.handle.cancel();
    expect(devices.of('detach')).toEqual([{ type: 'detach', device: 1, inFlight: true }]);
    await until(() => core().raw(id), 'the reply');
    // Not cancelled: the core didn't cancel it. The core reads the parent's
    // cancel first, and drops this as late.
    expect(core().reply(id)).toEqual({ failed: 'disconnected' });
    const cancelAt = core().indexOf((m) => m.type === 'cancel' && m.id === parent.id);
    const replyAt = core().indexOf((m) => m.type === 'response' && m.id === id);
    expect(cancelAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(replyAt);
    expect(await ask(parent, stream[2].apdu, stream[2].ms)).toEqual({ refused: 'ended' });
  });
});

describe('beforeSign (point 7)', () => {
  test('held after B0 01: the next APDU reaches the device only once it passes', async () => {
    await start();
    let pass;
    const beforeSign = jest.fn(() => new Promise((resolve) => (pass = resolve)));
    const parent = open('transaction', { beforeSign });
    await until(() => parent.handle, 'the parent');
    const stream = streamOf(PARENTS.transaction);
    await play(parent, stream, 2);
    expect(beforeSign).not.toHaveBeenCalled();
    const id = core().apdu(parent.id, stream[2].apdu, stream[2].ms);
    await until(() => beforeSign.mock.calls.length === 1, 'the last check');
    await settle();
    expect(devices.bytes()).toEqual([stream[0].apdu, stream[1].apdu]);
    pass();
    await until(() => core().raw(id), 'the reply');
    expect(core().reply(id).answer.toString('hex')).toBe('9000');
    expect(devices.bytes()).toEqual(stream.slice(0, 3).map((s) => s.apdu));
    // Once per parent.
    await play(parent, stream, stream.length, 3);
    expect(beforeSign).toHaveBeenCalledTimes(1);
  });

  test("its refusal is main's own cancel: nothing reaches the device, and the caller has its error", async () => {
    await start();
    const refusal = new Error('the rule changed');
    const parent = open('message', { beforeSign: () => Promise.reject(refusal) });
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 2);
    const id = core().apdu(parent.id, stream[2].apdu, stream[2].ms);
    await until(() => core().raw(id), 'the reply');
    expect(core().reply(id)).toEqual({ failed: 'disconnected' });
    expect(parent.handle.stopped).toBe(refusal);
    expect(core().cancels()).toEqual([parent.id]);
    expect(devices.bytes()).toEqual([stream[0].apdu, stream[1].apdu]);
    expect(devices.of('detach')).toHaveLength(1);
    expect(parent.controller.signal.aborted).toBe(true);
  });

  test("one slower than the APDU's deadline answers unresponsive, with nothing sent", async () => {
    await start();
    const parent = open('typed', { beforeSign: () => new Promise(() => {}) });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    const id = core().apdu(parent.id, stream[2].apdu, 15_000);
    await settle();
    await clock.advance(15_000);
    await until(() => core().raw(id), 'the reply');
    expect(core().reply(id)).toEqual({ failed: 'unresponsive' });
    expect(devices.bytes()).toHaveLength(2);
  });
});

describe('the hash-only warning (Q23, point 12)', () => {
  const hashOnlyApdu = () => {
    const prepared = new LedgerRelay().prepare({
      ...PARENTS.typed.capture,
      method: 'sign.typed_data',
      params: TYPED,
    });
    return hex(prepared.admission.hashOnlySlot.apdu);
  };
  const sixD = (apdu, { index }) => (index === 2 ? SIX_D : '9000');

  test('with the report held, no answer and no E0 0C 00 00 reaches the device; then hash_only "shown"', async () => {
    await start({ respond: sixD });
    let report;
    const surface = jest.fn(() => new Promise((resolve) => (report = resolve)));
    const parent = open('typed', { hashOnlySurface: surface });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    const first = core().apdu(parent.id, stream[2].apdu, 15_000);
    await until(() => surface.mock.calls.length === 1, 'the warning asked for');
    await clock.advance(5_000);
    expect(core().raw(first)).toBeNull();
    // The two hashes the warning shows are the hash-only APDU's.
    const [{ domainSeparator, structHash, signal }] = surface.mock.calls[0];
    expect(hashOnlyApdu().endsWith(domainSeparator.slice(2) + structHash.slice(2))).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(devices.bytes()).toEqual(stream.slice(0, 3).map((s) => s.apdu));
    report(true);
    await until(() => core().raw(first), 'the reply');
    expect(core().reply(first)).toEqual({ answer: Buffer.from(SIX_D, 'hex'), hashOnlyShown: true });
    expect(core().raw(first).result).toEqual({ answer: SIX_D, hash_only: 'shown' });
    // Now the gate is open: E0 0C 00 00 is admitted and reaches the device.
    const reply = await ask(parent, hashOnlyApdu(), 300_000);
    expect(reply.answer.toString('hex')).toBe('9000');
    expect(devices.bytes()).toEqual([...stream.slice(0, 3).map((s) => s.apdu), hashOnlyApdu()]);
  });

  test('a core that sends E0 0C 00 00 while the report is held is refused order, nothing reaching the device', async () => {
    await start({ respond: sixD });
    const surface = jest.fn(() => new Promise(() => {}));
    const parent = open('typed', { hashOnlySurface: surface });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    const first = core().apdu(parent.id, stream[2].apdu, 15_000);
    await until(() => surface.mock.calls.length === 1, 'the warning asked for');
    expect(await ask(parent, hashOnlyApdu(), 300_000)).toEqual({ refused: 'order' });
    expect(devices.bytes()).not.toContain(hashOnlyApdu());
    // The held 6D00 goes bare: hash_only only once the warning is on screen.
    await until(() => core().raw(first), 'the held reply');
    expect(core().raw(first).result).toEqual({ answer: SIX_D });
    expect(surface.mock.calls[0][0].signal.aborted).toBe(true);
  });

  test('no report in 10 s: the bare 6d00, the device closed', async () => {
    await start({ respond: sixD });
    const surface = jest.fn(() => new Promise(() => {}));
    const parent = open('typed', { hashOnlySurface: surface });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    const first = core().apdu(parent.id, stream[2].apdu, 15_000);
    await until(() => surface.mock.calls.length === 1, 'the warning asked for');
    await clock.advance(HASH_ONLY_WAIT_MS - 1);
    expect(core().raw(first)).toBeNull();
    await clock.advance(1);
    await until(() => core().raw(first), 'the reply');
    expect(core().raw(first).result).toEqual({ answer: SIX_D });
    expect(devices.of('detach')).toHaveLength(1);
    expect(surface.mock.calls[0][0].signal.aborted).toBe(true);
    // A late report changes nothing.
    expect(await ask(parent, hashOnlyApdu(), 300_000)).toEqual({ refused: 'ended' });
  });

  test("the wait is inside the APDU's 15 s: a slow 6D00 leaves only what is left of them", async () => {
    await start({ respond: (apdu, ctx) => (ctx.index === 2 ? { hold: true } : '9000') });
    const surface = jest.fn(() => new Promise(() => {}));
    const parent = open('typed', { hashOnlySurface: surface });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    const first = core().apdu(parent.id, stream[2].apdu, 15_000);
    await until(() => devices.held.length === 1, 'the slow device');
    await clock.advance(8_000);
    devices.release(SIX_D);
    await until(() => surface.mock.calls.length === 1, 'the warning asked for');
    await clock.advance(6_999);
    expect(core().raw(first)).toBeNull();
    await clock.advance(1);
    await until(() => core().raw(first), 'the reply');
    expect(core().raw(first).result).toEqual({ answer: SIX_D });
  });

  test('with no surface, the 6d00 goes bare at once; and a report other than true is none', async () => {
    await start({ respond: sixD });
    const parent = open('typed');
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    expect(await ask(parent, stream[2].apdu)).toEqual({
      answer: Buffer.from(SIX_D, 'hex'),
      hashOnlyShown: false,
    });
    const other = open('typed', { hashOnlySurface: async () => 'shown' });
    await until(() => other.handle, 'the other parent');
    await play(other, stream, 2);
    expect((await ask(other, stream[2].apdu)).hashOnlyShown).toBe(false);
  });

  test('a 6D00 to any other APDU is a status like any: no warning, no hash_only', async () => {
    await start({ respond: (apdu, { index }) => (index === 3 ? SIX_D : '9000') });
    const surface = jest.fn(async () => true);
    const parent = open('typed', { hashOnlySurface: surface });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    const replies = await play(parent, stream, 4);
    expect(replies[3]).toEqual({ answer: Buffer.from(SIX_D, 'hex'), hashOnlyShown: false });
    expect(surface).not.toHaveBeenCalled();
    expect(devices.of('detach')).toHaveLength(1);
  });

  test("the core's cancel during the wait: cancelled at once, the wait given up, the device closed", async () => {
    await start({ respond: sixD });
    const surface = jest.fn(() => new Promise(() => {}));
    const parent = open('typed', { hashOnlySurface: surface });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    const first = core().apdu(parent.id, stream[2].apdu, 15_000);
    await until(() => surface.mock.calls.length === 1, 'the warning asked for');
    core().cancel(first);
    await until(() => core().raw(first), 'the reply');
    expect(core().reply(first)).toEqual({ cancelled: true });
    expect(surface.mock.calls[0][0].signal.aborted).toBe(true);
    expect(devices.of('detach')).toEqual([{ type: 'detach', device: 1, inFlight: false }]);
    expect(await ask(parent, hashOnlyApdu(), 300_000)).toEqual({ refused: 'ended' });
    expect(clock.pending()).toBe(0);
  });

  test("main's own cancel during the wait: the parent's cancel, then the bare 6d00", async () => {
    await start({ respond: sixD });
    const surface = jest.fn(() => new Promise(() => {}));
    const parent = open('typed', { hashOnlySurface: surface });
    await until(() => parent.handle, 'the parent');
    const stream = typed();
    await play(parent, stream, 2);
    const first = core().apdu(parent.id, stream[2].apdu, 15_000);
    await until(() => surface.mock.calls.length === 1, 'the warning asked for');
    parent.handle.cancel();
    await until(() => core().raw(first), 'the reply');
    expect(core().raw(first).result).toEqual({ answer: SIX_D });
    expect(core().cancels()).toEqual([parent.id]);
    expect(surface.mock.calls[0][0].signal.aborted).toBe(true);
    expect(devices.of('detach')).toHaveLength(1);
  });
});

describe('across operations (0016, LDG-3 relay rules)', () => {
  /**
   * Parent A waits for the user at its confirming APDU; then the core ends
   * it (`end(aId)`) and, in the same chunk, sends parent B's first APDU.
   */
  async function overlap(end, { waitMs = 0 } = {}) {
    await start({
      respond: (apdu, { device }) => (device === 1 && apdu[1] === 0x08 ? { hold: true } : '9000'),
    });
    const a = open('message');
    await until(() => a.handle, 'parent A');
    const stream = message();
    await play(a, stream, 2);
    const aId = core().apdu(a.id, stream[2].apdu, stream[2].ms);
    await until(() => devices.held.length === 1, 'the user waits on A');
    if (waitMs) await clock.advance(waitMs);
    const b = open('message');
    await until(() => b.handle, 'parent B');
    let bId;
    core().batch(() => {
      end(aId);
      bId = core().apdu(b.id, stream[0].apdu, stream[0].ms);
    });
    await until(() => core().raw(aId) && core().raw(bId), 'both replies');
    return { a, b, aId, bId, stream };
  }

  function expectHandOver({ b, aId, bId, stream }, aReply) {
    expect(core().reply(aId)).toEqual(aReply);
    expect(core().reply(bId).answer.toString('hex')).toBe('9000');
    // The cancel processed first: A's device closed, mid-exchange and
    // without its reply awaited, before B's device opened and was sent
    // anything.
    const order = devices.events.map((e) => `${e.type}:${e.device}`);
    expect(order).toEqual([
      'open:1',
      'exchange:1',
      'answer:1',
      'exchange:1',
      'answer:1',
      'exchange:1',
      'detach:1',
      'open:2',
      'exchange:2',
      'answer:2',
    ]);
    expect(devices.of('detach')[0].inFlight).toBe(true);
    expect(devices.devices).toHaveLength(2);
    // A's late answer reaches no parent: B's reply is B's device's own.
    devices.release('9000');
    return settle().then(() => {
      expect(devices.of('late')).toEqual([{ type: 'late', device: 1, answer: '9000' }]);
      expect(core().messages.filter((m) => m.type === 'response')).toHaveLength(core().asks.size);
      return play(b, stream, stream.length, 1).then((replies) => {
        expect(replies.every((r) => r.answer.toString('hex') === '9000')).toBe(true);
        expect(devices.bytes().slice(3)).toEqual(stream.map((s) => s.apdu));
      });
    });
  }

  test("after the core's cancel (the parent's, 0001)", async () => {
    const run = await overlap((aId) => core().cancel(aId));
    await expectHandOver(run, { cancelled: true });
  });

  test("after the core's deadline (its timer, which cancels the APDU)", async () => {
    // The core's timer runs from its send, main's from the APDU's arrival:
    // the core's cancel may come just before main's own deadline.
    const run = await overlap((aId) => core().cancel(aId), { waitMs: 299_999 });
    await expectHandOver(run, { cancelled: true });
    // Main's deadline for A then passes: nothing more goes for A.
    await clock.advance(10_000);
    expect(core().messages.filter((m) => m.type === 'response')).toHaveLength(core().asks.size);
    expect(devices.of('detach')).toHaveLength(2);
  });

  test("after main's deadline: unresponsive, then the next parent on a fresh device", async () => {
    await start({
      respond: (apdu, { device }) => (device === 1 && apdu[0] === 0xb0 ? { hold: true } : '9000'),
    });
    const a = open('message');
    await until(() => a.handle, 'parent A');
    const stream = message();
    await play(a, stream, 1);
    const aId = core().apdu(a.id, stream[1].apdu, 15_000);
    await until(() => devices.held.length === 1, 'the silent device');
    await clock.advance(15_000);
    await until(() => core().raw(aId), "A's reply");
    expect(core().reply(aId)).toEqual({ failed: 'unresponsive' });
    const b = open('message');
    await until(() => b.handle, 'parent B');
    const replies = await play(b, stream);
    expect(replies.every((r) => r.answer.toString('hex') === '9000')).toBe(true);
    devices.release('6985');
    await settle();
    expect(devices.of('late')).toEqual([{ type: 'late', device: 1, answer: '6985' }]);
    expect(devices.events.map((e) => `${e.type}:${e.device}`).slice(0, 6)).toEqual([
      'open:1',
      'exchange:1',
      'answer:1',
      'exchange:1',
      'detach:1',
      'open:2',
    ]);
  });

  test('a new parent lets go of a device an older one still holds (close before open)', async () => {
    await start({
      respond: (apdu, { device }) => (device === 1 && apdu[0] === 0xb0 ? { hold: true } : '9000'),
    });
    const a = open('message');
    await until(() => a.handle, 'parent A');
    const stream = message();
    await play(a, stream, 1);
    const aId = core().apdu(a.id, stream[1].apdu);
    await until(() => devices.held.length === 1, 'A in flight');
    // A faulty core: B's first APDU with A's still out and never cancelled.
    const b = open('message');
    await until(() => b.handle, 'parent B');
    const reply = await ask(b, stream[0].apdu);
    expect(reply.answer.toString('hex')).toBe('9000');
    await until(() => core().raw(aId), "A's reply");
    expect(core().reply(aId)).toEqual({ failed: 'disconnected' });
    expect(log.warn).toHaveBeenCalledWith(
      '[Ledger] a new operation: the device an older one held is let go'
    );
    // A admits nothing more.
    expect(await ask(a, stream[2].apdu, stream[2].ms)).toEqual({ refused: 'ended' });
  });
});

describe('the device per operation', () => {
  test('opened at the first APDU, closed when the parent ends, one per operation', async () => {
    await start();
    const add = open('add');
    await until(() => add.handle, 'ledger.add');
    const [addApdu] = streamOf(PARENTS.add);
    expect(addApdu.ms).toBe(300_000);
    expect((await ask(add, addApdu.apdu, addApdu.ms)).answer.toString('hex')).toBe('9000');
    core().respond(add.id, { path: "44'/60'/0'/3", address: '0x' + '33'.repeat(20) });
    await until(() => add.outcome, 'ledger.add answered');
    const accounts = open('accounts');
    await until(() => accounts.handle, 'ledger.accounts');
    const stream = streamOf(PARENTS.accounts);
    expect(stream).toHaveLength(3);
    await play(accounts, stream, 1);
    core().respond(accounts.id, { accounts: [], mismatched: [] });
    await until(() => accounts.outcome, 'ledger.accounts answered');
    expect(devices.events.map((e) => `${e.type}:${e.device}`)).toEqual([
      'open:1',
      'exchange:1',
      'answer:1',
      'detach:1',
      'open:2',
      'exchange:2',
      'answer:2',
      'detach:2',
    ]);
    expect(started.relay.stats()).toEqual({ parents: 0, open: false });
  });

  test("the core's exit ends every parent and closes the device", async () => {
    await start({ respond: (apdu) => (apdu[0] === 0xb0 ? { hold: true } : '9000') });
    const parent = open('message');
    await until(() => parent.handle, 'the parent');
    const stream = message();
    await play(parent, stream, 1);
    core().apdu(parent.id, stream[1].apdu);
    await until(() => devices.held.length === 1, 'in flight');
    core().exit(1);
    await until(() => devices.of('detach').length === 1, 'the device closed');
    expect(devices.of('detach')[0].inFlight).toBe(true);
    await until(() => started.relay.stats().parents === 0, 'the parents ended');
    expect(started.relay.stats()).toEqual({ parents: 0, open: false });
  });
});
