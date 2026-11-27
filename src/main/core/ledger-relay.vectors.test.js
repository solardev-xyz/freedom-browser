/**
 * Main's Ledger relay (core/ledger-relay.js) against the pinned core's
 * `vectors/ledger-grammar.json` and `vectors/ledger.json` (freedom-core
 * design 0016, The APDU grammar: "the core's tests and main's relay suite
 * both read it"; LDG-3's PR 6), end to end: a scripted core sends each
 * stream as `shell.ledger_apdu`s through a real CoreClient, the relay
 * admits it with main's own grammar and typed-data binding (prepared from
 * what main holds: the case's request and record, never the core's
 * stream), and a scripted device behind the relay records every byte it is
 * sent (the transport spy). Every reply is read by the core's own reader
 * (test/helpers/fake-ledger-core.js, reply.rs at b4e0cef4), and none is a
 * protocol error.
 * - **Every honest stream** (all 147: discovery with its records, adding,
 *   transactions, messages, typed data field by field and hash-only, the
 *   three x402 forms through `x402.settle`) is admitted and reaches the
 *   device byte for byte on one device, opened at its first APDU and closed
 *   after its last; nothing after it is admitted. The hash-only cases'
 *   `6D00` is answered `hash_only: "shown"` once the warning reports.
 * - **Every forbidden entry** (all 152) is refused by its rule before a
 *   byte of it reaches the device, logged with the rule only, the device
 *   closed after; the held hash-only entry with the warning's report held,
 *   whose `6D00` then goes bare.
 *
 * Skipped unless the vectors are found (test/helpers/ledger-vectors.js):
 * FREEDOM_CORE_LEDGER_VECTORS names freedom-core's `vectors` directory, as
 * CI does at the pinned commit, and then a missing file fails the suite.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const log = require('../logger');
const { LedgerRelay } = require('./ledger-relay');
const { parsePath } = require('./ledger-grammar');
const { ledgerVectors, ledgerVectorsRequired } = require('../../../test/helpers/ledger-vectors');
const {
  fakeLedgerDevices,
  parentOf,
  startLedgerCore,
  until,
} = require('../../../test/helpers/fake-ledger-core');

const grammar = ledgerVectors('ledger-grammar.json');
const ledger = ledgerVectors('ledger.json');
const found = Boolean(grammar && ledger);
const describeIfVectors = found ? describe : describe.skip;

jest.setTimeout(120_000);

(ledgerVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_LEDGER_VECTORS names are there',
  () => {
    expect(grammar?.honest?.length).toBeGreaterThan(0);
    expect(grammar?.forbidden?.length).toBeGreaterThan(0);
    expect(ledger?.cases?.length).toBeGreaterThan(0);
  }
);

const LEDGER = { kind: 'ledger', index: 0 };
const SIX_D = '6d00';
const OK = '9000';

const cases = found ? new Map(ledger.cases.map((c) => [c.id, c])) : new Map();
const honest = found ? new Map(grammar.honest.map((h) => [h.case, h])) : new Map();
const hashOnlyCase = (c) => c.family === 'hash-only';

/** The parent main would send for a ledger.json case, and what it holds for it. */
function parentFor(c) {
  const { request } = c;
  switch (c.operation) {
    case 'ledger.accounts':
      return { method: 'ledger.accounts', params: request, capture: { records: c.records || [] } };
    case 'ledger.add':
      return {
        method: 'ledger.add',
        params: { ...parsePath(request.path), name: request.name },
        capture: {},
      };
    case 'sign.transaction':
      return {
        method: 'sign.transaction',
        params: { key: LEDGER, tx: request.tx },
        capture: { path: c.record.path },
      };
    case 'sign.message':
      return {
        method: 'sign.message',
        params: { key: LEDGER, message: request.message },
        capture: { path: c.record.path },
      };
    case 'sign.typed_data':
      if (c.family === 'x402') {
        return {
          method: 'x402.settle',
          params: { reservation: `reservation-${c.id}`, typed_data: request.typed_data },
          capture: { path: c.record.path, expectedHash: request.expected_hash },
        };
      }
      return {
        method: 'sign.typed_data',
        params: {
          key: LEDGER,
          typed_data: request.typed_data,
          expected_hash: request.expected_hash,
        },
        capture: { path: c.record.path },
      };
    default:
      throw new Error(`${c.id}: no operation ${c.operation}`);
  }
}

/** Each honest APDU's `deadline_ms`: 300000 on the one the user confirms (the row's column). */
function deadlinesOf(c, count) {
  const spec = parentFor(c);
  const prepared = new LedgerRelay().prepare({
    method: spec.method,
    params: spec.params,
    ...spec.capture,
  });
  const slots = prepared.admission.slots;
  return Array.from({ length: count }, (_, k) => {
    if (hashOnlyCase(c) && k === 3) return 300_000;
    return slots[k]?.waits ? 300_000 : 15_000;
  });
}

let started;
let devices;
// The device's answers: by the APDU's index in its operation.
let answerAt;
const core = () => started.core();

const refusals = () =>
  log.warn.mock.calls.filter(([message]) => message === '[Ledger] shell.ledger_apdu refused');

/** Opens a case's parent in the relay. */
async function openCase(c, extra = {}) {
  const spec = parentFor(c);
  const parent = parentOf(started.client, started.relay, {
    method: spec.method,
    params: spec.params,
    capture: { ...spec.capture, ...extra },
  });
  await until(() => parent.handle || parent.error, `${c.id}'s parent`);
  if (parent.error) throw parent.error;
  return parent;
}

/** The core answers main's parent, which closes it in the relay. */
async function finish(parent) {
  core().respond(parent.id, {});
  await until(() => parent.outcome, 'the parent answered');
}

async function ask(parent, apdu, ms) {
  const id = core().apdu(parent.id, apdu, ms);
  await until(() => core().raw(id), `the reply to ${apdu.slice(0, 8)}`);
  return core().reply(id);
}

describeIfVectors('the relay against the pinned grammar (ledger-grammar.json)', () => {
  beforeAll(async () => {
    devices = fakeLedgerDevices({ respond: (apdu, ctx) => answerAt(apdu, ctx) });
    started = await startLedgerCore({ log, devices });
  });

  afterAll(async () => {
    await started?.client.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    answerAt = () => OK;
  });

  afterEach(() => {
    expect(core().faults).toEqual([]);
    // Never an APDU's or an answer's bytes in main's log.
    const text = JSON.stringify(
      [log.info, log.warn, log.error, log.debug].flatMap((fn) => fn.mock.calls)
    );
    expect(text).not.toMatch(/[0-9a-f]{20,}/);
  });

  test('every honest stream is admitted and reaches the device byte for byte, on one device per operation', async () => {
    const counts = {};
    let apduCount = 0;
    for (const entry of grammar.honest) {
      const c = cases.get(entry.case);
      const ms = deadlinesOf(c, entry.apdus.length);
      answerAt = hashOnlyCase(c) ? (apdu, { index }) => (index === 2 ? SIX_D : OK) : () => OK;
      const surface = jest.fn(async () => true);
      const parent = await openCase(c, hashOnlyCase(c) ? { hashOnlySurface: surface } : {});
      const before = devices.events.length;
      const opened = devices.devices.length;
      for (const [k, apdu] of entry.apdus.entries()) {
        const reply = await ask(parent, apdu, ms[k]);
        const expected = hashOnlyCase(c) && k === 2 ? SIX_D : OK;
        if (reply?.answer?.toString('hex') !== expected) {
          throw new Error(`${c.id}: APDU ${k} answered ${JSON.stringify(reply)}`);
        }
        expect(reply.hashOnlyShown).toBe(hashOnlyCase(c) && k === 2);
      }
      const events = devices.events.slice(before);
      expect(events.filter((e) => e.type === 'exchange').map((e) => e.apdu)).toEqual(entry.apdus);
      expect(devices.devices.length).toBe(opened + 1);
      expect(events.filter((e) => e.type === 'open')).toHaveLength(1);
      // Closed after its last APDU, with nothing in flight.
      expect(events.filter((e) => e.type === 'detach')).toEqual([
        { type: 'detach', device: opened + 1, inFlight: false },
      ]);
      // The warning, for a hash-only case, with main's binding's hashes: the APDU's.
      if (hashOnlyCase(c)) {
        const [{ domainSeparator, structHash }] = surface.mock.calls[0];
        const last = entry.apdus[entry.apdus.length - 1];
        expect(last.endsWith(domainSeparator.slice(2) + structHash.slice(2))).toBe(true);
      }
      // Nothing after its last APDU.
      const last = entry.apdus[entry.apdus.length - 1];
      expect(await ask(parent, last, 15_000)).toEqual({ refused: 'ended' });
      await finish(parent);
      counts[entry.operation] = (counts[entry.operation] ?? 0) + 1;
      apduCount += entry.apdus.length;
    }
    expect(counts).toEqual({
      'ledger.accounts': 15,
      'ledger.add': 3,
      'sign.transaction': 36,
      'sign.message': 11,
      'sign.typed_data': 82,
    });
    expect(apduCount).toBe(2095);
    // One refusal per case: its last APDU sent again.
    expect(refusals()).toHaveLength(grammar.honest.length);
    expect(
      log.warn.mock.calls.filter(([m]) => m === "[Ledger] deadline_ms isn't the row's")
    ).toEqual([]);
    expect(started.relay.stats()).toEqual({ parents: 0, open: false });
  });

  test('every forbidden entry is refused by its rule before a byte of it reaches the device', async () => {
    const byRule = {};
    for (const entry of grammar.forbidden) {
      jest.clearAllMocks();
      const c = cases.get(entry.case);
      const stream = honest.get(entry.case).apdus;
      const ms = deadlinesOf(c, stream.length);
      let parent;
      let held = null;
      if (entry.parent) {
        // A parent that opens no operation: a vault account's sign.message.
        const { method, ...params } = entry.parent;
        parent = parentOf(started.client, started.relay, {
          method,
          params: { ...params, message: c.request.message },
          capture: { path: c.record.path },
        });
        await until(() => parent.handle, 'the parent');
      } else {
        // The held entry: main holds the 6D00 for a warning that never reports.
        answerAt = entry.state ? (apdu, { index }) => (index === 2 ? SIX_D : OK) : () => OK;
        const surface = entry.state ? { hashOnlySurface: () => new Promise(() => {}) } : {};
        parent = await openCase(c, surface);
      }
      const before = devices.events.length;
      for (let k = 0; k < entry.at; k++) {
        if (entry.state && k === entry.at - 1) {
          held = core().apdu(parent.id, stream[k], ms[k]);
          await until(
            () =>
              devices.events.slice(before).filter((e) => e.type === 'answer').length === entry.at,
            'the held 6D00'
          );
          continue;
        }
        const reply = await ask(parent, stream[k], ms[k]);
        if (reply?.answer?.toString('hex') !== OK) {
          throw new Error(`${entry.case}: honest APDU ${k} answered ${JSON.stringify(reply)}`);
        }
      }
      const reply = await ask(parent, entry.apdu, 15_000);
      if (reply?.refused !== entry.rule) {
        throw new Error(`${entry.case} at ${entry.at} (${entry.what}): ${JSON.stringify(reply)}`);
      }
      const events = devices.events.slice(before);
      // Only the honest APDUs before it reached the device.
      expect(events.filter((e) => e.type === 'exchange').map((e) => e.apdu)).toEqual(
        stream.slice(0, entry.at)
      );
      expect(refusals().map(([, fields]) => fields)).toEqual([{ rule: entry.rule }]);
      if (entry.at > 0) {
        expect(events.filter((e) => e.type === 'detach')).toHaveLength(1);
      } else {
        expect(events.filter((e) => e.type === 'open')).toEqual([]);
      }
      if (held !== null) {
        await until(() => core().raw(held), 'the held reply');
        expect(core().raw(held).result).toEqual({ answer: SIX_D });
      }
      await finish(parent);
      byRule[entry.rule] = (byRule[entry.rule] ?? 0) + 1;
    }
    expect(Object.values(byRule).reduce((a, b) => a + b, 0)).toBe(grammar.forbidden.length);
    expect(byRule).toEqual({
      header: 99,
      path: 28,
      order: 9,
      ended: 7,
      count: 6,
      payload: 2,
      parent: 1,
    });
    expect(started.relay.stats()).toEqual({ parents: 0, open: false });
  });
});
