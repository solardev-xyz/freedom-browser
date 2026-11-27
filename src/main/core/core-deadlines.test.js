/**
 * Main's copy of the core's deadline classes, and the hang watchdog each
 * gives (freedom-core design 0001). Against freedom-core's
 * `protocol/schema.json` too, when it is found: FREEDOM_CORE_SCHEMA names
 * the file, or it is in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in. CI checks out freedom-core's at a reviewed commit and names
 * it; a file named there that is missing fails the suite rather than
 * skipping it. The check itself runs on files written here as well: one of
 * main's table, with design 0009's and design 0015's `"protocol": 2` rows
 * and design 0016's `"device"` ones, and ones that differ from it.
 */

const fs = require('fs');
const path = require('path');
const {
  APDU_DEADLINES_MS,
  ASK_IDLE_MS,
  ASK_REPLY_MS,
  DEVICE_ONLY,
  HEAD_DEADLINE_MS,
  IDLE_WATCHDOGS,
  LANE_QUEUE_MS,
  METHOD_CLASSES,
  PROTOCOL_2_METHODS,
  SAFE_OWNER_METHODS,
  SESSION_DEADLINE_MS,
  SWARM_DEADLINE_MS,
  VAULT_DEADLINE_MS,
  WATCHDOG_MARGIN_MS,
  apduWatchdogMs,
  deviceWatchdogMs,
  drivesDevice,
  idleWatchdogMs,
  isDeviceMethod,
  isIdleMethod,
  watchdogMs,
} = require('./core-deadlines');
const { CONTROL_WATCHDOG_MS: NAMING_CONTROL } = require('./naming-config');
const { CONTROL_WATCHDOG_MS: CHAIN_CONTROL } = require('./chain-config');
const naming = require('./naming-driver');
const chain = require('./chain-driver');
const { PROTOCOL_VERSION_STREAMS } = require('./core-client');
const verifyExecutor = require('../dweb/verify-executor');

// Design 0001's vault queue: every method that waits for the vault worker.
const VAULT_QUEUE = [
  'vault.unlock',
  'vault.verify_password',
  'vault.change_password',
  'vault.delete',
  'vault.export_mnemonic',
  'vault.export_private_key',
  'vault.create',
  'vault.import',
  'vault.reconcile',
  'quick_unlock.enroll',
  'quick_unlock.unlock',
  'quick_unlock.export_mnemonic',
  'quick_unlock.export_private_key',
  'quick_unlock.disable',
  // cored-v0.23.0's (design 0013, PRF-5): the RPC API keys and the accounts.
  'secrets.rpc_api_keys',
  'secrets.rpc_api_key_status',
  'secrets.set_rpc_api_key',
  'secrets.remove_rpc_api_key',
  'accounts.list',
  'accounts.meta',
  'accounts.active',
  'accounts.add_mnemonic',
  'accounts.add_ledger',
  'accounts.add_remote',
  'accounts.record_address_check',
  'accounts.add_safe',
  'accounts.mark_safe_deployed',
  'accounts.set_active',
  'accounts.rename',
  'accounts.remove',
  'nodes.write_identity',
  'nodes.op_status',
  // cored-v0.30.0's (design 0016, SAFE-2's S2): a Safe's record, written
  // as `accounts.add_safe` writes it.
  'safe.create',
];

describe('core deadlines', () => {
  test('an immediate method gets 15 s, a vault method 45 s', () => {
    for (const method of VAULT_QUEUE) expect(watchdogMs(method)).toBe(45_000);
    const immediate = Object.keys(METHOD_CLASSES).filter((m) => METHOD_CLASSES[m] === 'immediate');
    expect(immediate).toEqual(
      expect.arrayContaining(['vault.status', 'vault.lock', 'vault.touch', 'x402.authorize'])
    );
    for (const method of immediate) expect(watchdogMs(method)).toBe(15_000);
    expect(Object.keys(METHOD_CLASSES).filter((m) => METHOD_CLASSES[m] === 'vault')).toEqual(
      VAULT_QUEUE
    );
  });

  test("a session gets its deadline, or the caller's shorter one, plus 15 s", () => {
    expect(watchdogMs('chain.request')).toBe(135_000);
    // cored-v0.18.0's: a phone job's result, and a page's EIP-1193 request
    // (the core's `Steps`, a session's 120 s until APB-4 pauses it).
    expect(watchdogMs('phone.result')).toBe(135_000);
    expect(watchdogMs('eip1193.request')).toBe(135_000);
    // cored-v0.30.0's (design 0016, SAFE-2): the Safe methods that read the
    // chain, under its machine's bound.
    for (const method of [
      'safe.status',
      'safe.deploy',
      'safe.deployed',
      'safe.prepare',
      'safe.propose',
    ]) {
      expect(watchdogMs(method)).toBe(135_000);
    }
    expect(watchdogMs('dweb.open', 10_000)).toBe(25_000);
    expect(watchdogMs('naming.resolve_content', 0)).toBe(15_000);
    for (const odd of [500_000, -1, 1.5, NaN, '10000', null]) {
      expect(watchdogMs('chain.html', odd)).toBe(135_000);
    }
  });

  test("dweb.verify gets its head deadline plus 15 s, and dweb.forget an immediate one's", () => {
    expect(watchdogMs('dweb.verify')).toBe(375_000);
    expect(watchdogMs('dweb.verify', 10_000)).toBe(375_000);
    expect(watchdogMs('dweb.forget')).toBe(15_000);
    // The executor asks the core for the table's deadline.
    expect(verifyExecutor.HEAD_DEADLINE_MS).toBe(HEAD_DEADLINE_MS);
  });

  // cored-v0.29.0's (design 0015, D5): the `swarm` kind is a session's
  // rule at 300 s. An idle method has no total deadline, so it has no total
  // watchdog: asking for one throws, and its watchdog follows its progress
  // (`idleWatchdogMs`, below).
  test("a Swarm request gets 300 s, or the caller's shorter deadline, plus 15 s; an idle one has no total watchdog", () => {
    for (const method of ['swarm.request', 'swarm.feed', 'swarm.stamps', 'swarm.upload_status']) {
      expect(watchdogMs(method)).toBe(SWARM_DEADLINE_MS + WATCHDOG_MARGIN_MS);
      expect(watchdogMs(method, 60_000)).toBe(75_000);
    }
    expect(SWARM_DEADLINE_MS).toBe(300_000);
    expect(watchdogMs('swarm.request', 0)).toBe(15_000);
    for (const odd of [500_000, -1, 1.5, NaN, '10000', null]) {
      expect(watchdogMs('swarm.request', odd)).toBe(315_000);
    }
    for (const method of ['swarm.body', 'swarm.publish']) {
      expect(() => watchdogMs(method)).toThrow(/idle method: its watchdog follows its progress/);
      expect(() => watchdogMs(method, 10_000)).toThrow(/idle method/);
    }
    for (const method of ['swarm.identities', 'swarm.history', 'swarm.manifest']) {
      expect(watchdogMs(method)).toBe(15_000);
    }
  });

  // Design 0015's D13 mirrored, with the margin (fc-swarm-provider's
  // `ask_bound` at the pinned core: `IDLE_MS` 60 s, `WHOLE_REPLY_MS` 300 s).
  test("an idle method's watchdog: 75 s after progress, and for swarm.publish 315 s after a whole call's ask or a streamed body's end", () => {
    expect([ASK_IDLE_MS, ASK_REPLY_MS]).toEqual([60_000, 300_000]);
    expect(idleWatchdogMs('swarm.body')).toBe(75_000);
    expect(idleWatchdogMs('swarm.body', 'progress')).toBe(75_000);
    expect(idleWatchdogMs('swarm.publish')).toBe(75_000);
    expect(idleWatchdogMs('swarm.publish', 'whole_call')).toBe(315_000);
    expect(idleWatchdogMs('swarm.publish', 'body_end')).toBe(315_000);
    expect(IDLE_WATCHDOGS).toEqual({
      'swarm.body': { progress: ASK_IDLE_MS + WATCHDOG_MARGIN_MS },
      'swarm.publish': {
        progress: ASK_IDLE_MS + WATCHDOG_MARGIN_MS,
        whole_call: ASK_REPLY_MS + WATCHDOG_MARGIN_MS,
        body_end: ASK_REPLY_MS + WATCHDOG_MARGIN_MS,
      },
    });
    // A body's own terminal ends its watchdog: it has no later bound.
    expect(() => idleWatchdogMs('swarm.body', 'whole_call')).toThrow(/no whole_call watchdog/);
    expect(() => idleWatchdogMs('swarm.body', 'body_end')).toThrow(/no body_end/);
    expect(() => idleWatchdogMs('swarm.publish', 'deadline')).toThrow(/no deadline/);
    expect(() => idleWatchdogMs('swarm.publish', 'toString')).toThrow(/no toString/);
  });

  test('every idle method has its idle watchdog, and no other method has one', () => {
    const idle = Object.keys(METHOD_CLASSES).filter((m) => METHOD_CLASSES[m] === 'idle');
    expect(idle).toEqual(['swarm.body', 'swarm.publish']);
    expect(Object.keys(IDLE_WATCHDOGS)).toEqual(idle);
    for (const method of idle) expect(isIdleMethod(method)).toBe(true);
    for (const method of Object.keys(METHOD_CLASSES).filter((m) => !idle.includes(m))) {
      expect(isIdleMethod(method)).toBe(false);
      expect(() => idleWatchdogMs(method)).toThrow(/is not an idle method/);
    }
    for (const odd of ['swarm.unknown', 'toString', 'constructor', '', undefined]) {
      expect(isIdleMethod(odd)).toBe(false);
      expect(() => idleWatchdogMs(odd)).toThrow(/is not an idle method/);
    }
  });

  // cored-v0.30.0's (design 0016, D7): the `device` class has no total
  // deadline. `watchdogMs` takes no params, so it gives the watchdog of a
  // request that doesn't drive the device, the immediate 15 s: its own
  // keys' `sign.*`, and x402's settle by outcome or by signature. A
  // `ledger.*` request always drives it, so asking for its watchdog here
  // throws: its watchdog is `deviceWatchdogMs`'s (below).
  test("a device-class method's watchdogMs is 15 s, and a Ledger's own throws", () => {
    const device = Object.keys(METHOD_CLASSES).filter((m) => METHOD_CLASSES[m] === 'device');
    expect(device).toEqual([
      'sign.transaction',
      'sign.message',
      'sign.typed_data',
      'ledger.accounts',
      'ledger.add',
      'x402.settle',
    ]);
    for (const method of ['sign.transaction', 'sign.message', 'sign.typed_data', 'x402.settle']) {
      expect(watchdogMs(method)).toBe(15_000);
      expect(watchdogMs(method, 300_000)).toBe(15_000);
    }
    expect(DEVICE_ONLY).toEqual(device.filter((m) => m.startsWith('ledger.')));
    for (const method of DEVICE_ONLY) {
      expect(() => watchdogMs(method)).toThrow(
        /drives the device: its watchdog is deviceWatchdogMs/
      );
      expect(() => watchdogMs(method, 10_000)).toThrow(/drives the device/);
    }
    for (const method of ['safe.pending', 'safe.discard']) expect(watchdogMs(method)).toBe(15_000);
  });

  test('a method the core does not serve is refused at once: 15 s', () => {
    expect(watchdogMs('vault.unknown')).toBe(15_000);
    expect(watchdogMs('toString')).toBe(15_000);
  });

  test("naming's and chain's watchdogs are the same table's", () => {
    expect(NAMING_CONTROL).toBe(watchdogMs('naming.configure'));
    expect(CHAIN_CONTROL).toBe(watchdogMs('chain.configure'));
    for (const driver of [naming, chain]) {
      expect(driver.DEADLINE_MS).toBe(SESSION_DEADLINE_MS);
      expect(driver.WATCHDOG_MARGIN_MS).toBe(WATCHDOG_MARGIN_MS);
    }
  });
});

const LEDGER = { kind: 'ledger', index: 3 };
const VAULT_KEY = { kind: 'account', index: 0 };
const TX = { to: '0x' + '11'.repeat(20), value: '0x0', chain_id: 1 };

/**
 * Design 0016's device watchdog (D7, "The device lane"), as main picks it
 * from a request's method and params: the lane's for a request that drives
 * the device, 5 minutes and 15 s until its first `shell.ledger_apdu`, and
 * then each APDU's `deadline_ms` plus 15 s; 0001's immediate 15 s for any
 * other. The client's timing of it is core-client-device.test.js's.
 */
describe("the device watchdog's classifier (design 0016, D7)", () => {
  test("which requests drive the device: a Ledger key's sign.*, every ledger.*, x402's settle by typed data, a Ledger owner's Safe signature", () => {
    for (const method of ['sign.transaction', 'sign.message', 'sign.typed_data']) {
      expect(drivesDevice(method, { key: LEDGER, tx: TX })).toBe(true);
      expect(drivesDevice(method, { key: { ...LEDGER, path: "m/44'/60'/0'/0/3" } })).toBe(true);
      for (const key of [VAULT_KEY, { kind: 'bee_wallet' }, { kind: 'publisher', index: 1 }]) {
        expect(drivesDevice(method, { key, tx: TX })).toBe(false);
      }
      for (const params of [{}, { key: 'ledger' }, { key: null }, { kind: 'ledger' }, null]) {
        expect(drivesDevice(method, params)).toBe(false);
      }
      // `ledgerOwner` is the Safe methods' alone.
      expect(drivesDevice(method, { key: VAULT_KEY, owner: 1 }, { ledgerOwner: true })).toBe(false);
    }
    for (const method of ['ledger.accounts', 'ledger.add']) {
      expect(drivesDevice(method, {})).toBe(true);
      expect(drivesDevice(method, { scheme: 'bip44', start: 0, count: 5 })).toBe(true);
    }
    expect(drivesDevice('x402.settle', { reservation: 'r', typed_data: {} })).toBe(true);
    expect(drivesDevice('x402.settle', { reservation: 'r', outcome: 'withheld' })).toBe(false);
    expect(drivesDevice('x402.settle', { reservation: 'r', signature: '0x' })).toBe(false);
    for (const method of SAFE_OWNER_METHODS) {
      expect(drivesDevice(method, { safe: 7, owner: 2 }, { ledgerOwner: true })).toBe(true);
      expect(drivesDevice(method, { safe: 7, owner: 0 }, { ledgerOwner: true })).toBe(true);
      expect(drivesDevice(method, { safe: 7, owner: 2 }, { ledgerOwner: false })).toBe(false);
      expect(drivesDevice(method, { safe: 7, owner: 2 })).toBe(false);
      expect(drivesDevice(method, { safe: 7, owner: 2 }, { ledgerOwner: 'yes' })).toBe(false);
      // No `owner`: the vault owners sign, whatever `ledgerOwner` says.
      expect(drivesDevice(method, { safe: 7 }, { ledgerOwner: true })).toBe(false);
      expect(drivesDevice(method, { safe: 7, owner: null }, { ledgerOwner: true })).toBe(false);
    }
  });

  test("the methods it classifies are the device class's and the two Safe owner methods; every other throws", () => {
    const device = Object.keys(METHOD_CLASSES).filter((m) => METHOD_CLASSES[m] === 'device');
    expect(SAFE_OWNER_METHODS).toEqual(['safe.sign_owner', 'safe.message_sign']);
    // cored-v0.30.0's table has no row for them: the schema check stays
    // exact (below).
    for (const method of SAFE_OWNER_METHODS)
      expect(Object.hasOwn(METHOD_CLASSES, method)).toBe(false);
    for (const method of [...device, ...SAFE_OWNER_METHODS])
      expect(isDeviceMethod(method)).toBe(true);
    const others = [
      ...Object.keys(METHOD_CLASSES).filter((m) => !device.includes(m)),
      'safe.unknown',
      'toString',
      'constructor',
      '',
      undefined,
    ];
    for (const method of others) {
      expect(isDeviceMethod(method)).toBe(false);
      expect(() => drivesDevice(method, {})).toThrow(/is not a device-class method/);
      expect(() => deviceWatchdogMs(method, {})).toThrow(/is not a device-class method/);
    }
  });

  test("a vault key's sign.* gets 15 s, and a Ledger key's the lane's 5 minutes and 15 s", () => {
    expect(LANE_QUEUE_MS).toBe(300_000);
    for (const method of ['sign.transaction', 'sign.message', 'sign.typed_data']) {
      expect(deviceWatchdogMs(method, { key: VAULT_KEY, tx: TX })).toBe(15_000);
      expect(deviceWatchdogMs(method, { key: LEDGER, tx: TX })).toBe(315_000);
      expect(deviceWatchdogMs(method, { key: LEDGER })).toBe(LANE_QUEUE_MS + WATCHDOG_MARGIN_MS);
    }
    for (const method of DEVICE_ONLY) expect(deviceWatchdogMs(method, {})).toBe(315_000);
    expect(deviceWatchdogMs('x402.settle', { reservation: 'r', typed_data: {} })).toBe(315_000);
    expect(deviceWatchdogMs('x402.settle', { reservation: 'r', outcome: 'spent' })).toBe(15_000);
    expect(deviceWatchdogMs('x402.settle', { reservation: 'r', signature: '0x' })).toBe(15_000);
  });

  // Their setup reads come first, under the chain machine's 120 s: 135 s
  // for vault owners, and 120 s + the lane's 5 minutes + 15 s for a Ledger
  // owner until its first APDU. 0.30.0 has no rows for them, so only the
  // classifier is tested here; their live watchdog tests are SAFE-3's
  // (0016, Steps).
  test('safe.sign_owner and safe.message_sign: 135 s for vault owners, 7 minutes and 15 s for a Ledger owner', () => {
    for (const method of SAFE_OWNER_METHODS) {
      expect(deviceWatchdogMs(method, { safe: 7 })).toBe(135_000);
      expect(deviceWatchdogMs(method, { safe: 7 }, { ledgerOwner: true })).toBe(135_000);
      expect(deviceWatchdogMs(method, { safe: 7, owner: 2 })).toBe(135_000);
      expect(deviceWatchdogMs(method, { safe: 7, owner: 2 }, { ledgerOwner: false })).toBe(135_000);
      expect(deviceWatchdogMs(method, { safe: 7, owner: 2 }, { ledgerOwner: true })).toBe(435_000);
      expect(deviceWatchdogMs(method, { safe: 7, owner: 2 }, { ledgerOwner: true })).toBe(
        7 * 60_000 + 15_000
      );
      // The vault owners' is the chain reads' watchdog, as `chain.request`'s.
      expect(deviceWatchdogMs(method, { safe: 7 })).toBe(watchdogMs('chain.request'));
    }
  });

  test("each APDU's watchdog is its deadline_ms plus 15 s: 30 s, or 5 minutes and 15 s for the one the user confirms", () => {
    expect(APDU_DEADLINES_MS).toEqual([15_000, 300_000]);
    expect(apduWatchdogMs(15_000)).toBe(30_000);
    expect(apduWatchdogMs(300_000)).toBe(315_000);
    for (const odd of [0, 14_999, 15_001, 60_000, 299_999, 300_001, -15_000, 15_000.5, NaN]) {
      expect(() => apduWatchdogMs(odd)).toThrow(/deadline_ms is 15000 or 300000/);
    }
    for (const odd of ['15000', null, undefined, {}, [15_000]]) {
      expect(() => apduWatchdogMs(odd)).toThrow(TypeError);
    }
  });
});

/**
 * The check against the core's file: every method, in order, with its
 * class, main's table whole. A row's `protocol`, when it has one, is the
 * number 2, and the rows that carry it are exactly PROTOCOL_2_METHODS, in
 * its order (design 0009, amendment 3; design 0015, D5). Main asks for
 * protocol 2 (core-process.js), so a file without those rows (a core
 * before 0009's protocol 2, as 0.9.1) fails. An idle method's deadline is
 * written `"idle"` (design 0015, D5) and a device-class one's `"device"`
 * (design 0016, D7), apart from an immediate one's `null`.
 */
function checkSchema(schema) {
  const classOf = {
    null: 'immediate',
    [VAULT_DEADLINE_MS]: 'vault',
    [SESSION_DEADLINE_MS]: 'session',
    [HEAD_DEADLINE_MS]: 'head',
    [SWARM_DEADLINE_MS]: 'swarm',
    idle: 'idle',
    device: 'device',
  };
  const theirs = schema.methods.map((m) => [m.name, classOf[m.deadline_ms] ?? m.deadline_ms]);
  expect(Object.entries(METHOD_CLASSES)).toEqual(theirs);
  const marked = schema.methods
    .filter((m) => Object.hasOwn(m, 'protocol'))
    .map((m) => [m.name, m.protocol]);
  expect(marked).toEqual(PROTOCOL_2_METHODS.map((name) => [name, PROTOCOL_VERSION_STREAMS]));
}

const DEADLINE_OF = {
  immediate: null,
  vault: VAULT_DEADLINE_MS,
  session: SESSION_DEADLINE_MS,
  head: HEAD_DEADLINE_MS,
  swarm: SWARM_DEADLINE_MS,
  idle: 'idle',
  device: 'device',
};

/** Main's table as the core writes it: the protocol-2 rows marked. */
function schemaOf() {
  const methods = Object.entries(METHOD_CLASSES).map(([name, kind]) => ({
    name,
    callers: ['shell'],
    mutates: false,
    deadline_ms: DEADLINE_OF[kind],
    ...(PROTOCOL_2_METHODS.includes(name) && { protocol: 2 }),
  }));
  return { protocol: 1, methods };
}

/** `schemaOf()` with `edit(methods)` applied. */
function edited(edit) {
  const written = schemaOf();
  edit(written.methods);
  return written;
}

const at = (methods, name) => methods.findIndex((m) => m.name === name);

describe("the check against the core's file", () => {
  test('main\'s table, the rows marked "protocol": 2 with it (0009, amendment 3; 0015), passes', () => {
    const written = schemaOf();
    expect(written.methods.filter((m) => m.protocol === 2).map((m) => m.name)).toEqual([
      'dweb.verify',
      'dweb.forget',
      'swarm.body',
      'swarm.publish',
    ]);
    expect(() => checkSchema(written)).not.toThrow();
  });

  test("a file of protocol 1's rows only (core 0.9.1's) fails: main asks for protocol 2", () => {
    const written = edited((methods) => {
      for (const name of PROTOCOL_2_METHODS) methods.splice(at(methods, name), 1);
    });
    expect(() => checkSchema(written)).toThrow();
  });

  test('a protocol other than the number 2 fails, on any row', () => {
    for (const protocol of [1, 3, '2', null]) {
      for (const name of ['core.hello', 'dweb.open', 'dweb.verify', 'dweb.forget', 'chain.html']) {
        const written = edited((methods) => {
          methods[at(methods, name)].protocol = protocol;
        });
        expect(() => checkSchema(written)).toThrow();
      }
    }
  });

  test("the marked rows are exactly 0009's two and 0015's two, once each, in order, with their deadlines", () => {
    const fails = [
      // A row unmarked, or another marked.
      (methods) => delete methods[at(methods, 'dweb.verify')].protocol,
      (methods) => delete methods[at(methods, 'dweb.forget')].protocol,
      (methods) => (methods[at(methods, 'dweb.open')].protocol = 2),
      // One alone, twice, or reversed.
      (methods) => methods.splice(at(methods, 'dweb.verify'), 1),
      (methods) => methods.splice(at(methods, 'dweb.forget'), 1),
      (methods) =>
        methods.splice(at(methods, 'dweb.verify'), 0, { ...methods[at(methods, 'dweb.verify')] }),
      (methods) =>
        methods.splice(at(methods, 'dweb.forget'), 0, { ...methods[at(methods, 'dweb.forget')] }),
      (methods) => {
        const i = at(methods, 'dweb.verify');
        methods.splice(i, 2, methods[i + 1], methods[i]);
      },
      // 0015's unmarked, or reversed.
      (methods) => delete methods[at(methods, 'swarm.body')].protocol,
      (methods) => delete methods[at(methods, 'swarm.publish')].protocol,
      (methods) => (methods[at(methods, 'swarm.request')].protocol = 2),
      (methods) => {
        const body = methods.splice(at(methods, 'swarm.body'), 1)[0];
        methods.splice(at(methods, 'swarm.publish') + 1, 0, body);
      },
      // Another deadline: an idle method's written as an immediate one's,
      // or a Swarm request's as a session's.
      (methods) => (methods[at(methods, 'dweb.verify')].deadline_ms = SESSION_DEADLINE_MS),
      (methods) => (methods[at(methods, 'dweb.forget')].deadline_ms = VAULT_DEADLINE_MS),
      (methods) => (methods[at(methods, 'swarm.publish')].deadline_ms = null),
      (methods) => (methods[at(methods, 'swarm.body')].deadline_ms = SWARM_DEADLINE_MS),
      (methods) => (methods[at(methods, 'swarm.request')].deadline_ms = SESSION_DEADLINE_MS),
      (methods) => (methods[at(methods, 'swarm.history')].deadline_ms = 'idle'),
      // A third marked row.
      (methods) =>
        methods.splice(at(methods, 'dweb.forget') + 1, 0, {
          ...methods[at(methods, 'dweb.forget')],
          name: 'dweb.pin',
        }),
    ];
    for (const edit of fails) expect(() => checkSchema(edited(edit))).toThrow();
  });

  test('0016\'s rows: sign.*, ledger.* and x402.settle written "device", and the Safe rows each in its class', () => {
    const written = schemaOf();
    expect(written.methods.filter((m) => m.deadline_ms === 'device').map((m) => m.name)).toEqual([
      'sign.transaction',
      'sign.message',
      'sign.typed_data',
      'ledger.accounts',
      'ledger.add',
      'x402.settle',
    ]);
    const fails = [
      // A device-class row written as an immediate one's, or as an idle
      // one's; an immediate row written as a device-class one's.
      (methods) => (methods[at(methods, 'sign.message')].deadline_ms = null),
      (methods) => (methods[at(methods, 'x402.settle')].deadline_ms = null),
      (methods) => (methods[at(methods, 'ledger.add')].deadline_ms = 'idle'),
      (methods) => (methods[at(methods, 'x402.authorize')].deadline_ms = 'device'),
      // A Safe row in another class.
      (methods) => (methods[at(methods, 'safe.create')].deadline_ms = SESSION_DEADLINE_MS),
      (methods) => (methods[at(methods, 'safe.status')].deadline_ms = null),
      (methods) => (methods[at(methods, 'safe.pending')].deadline_ms = 'device'),
      // A row of 0.30.0's missing (a file before it, as 0.29.0's).
      (methods) => methods.splice(at(methods, 'ledger.accounts'), 1),
      (methods) => methods.splice(at(methods, 'safe.propose'), 1),
    ];
    for (const edit of fails) expect(() => checkSchema(edited(edit))).toThrow();
  });
});

function schemaPath() {
  if (process.env.FREEDOM_CORE_SCHEMA) return process.env.FREEDOM_CORE_SCHEMA;
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'protocol', 'schema.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const file = schemaPath();
const schema = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const describeIfSchema = schema ? describe : describe.skip;
// Named outright (CI does): it must be there.
const required = Boolean(process.env.FREEDOM_CORE_SCHEMA);

(required ? test : test.skip)('the schema FREEDOM_CORE_SCHEMA names is there', () => {
  expect(fs.existsSync(file)).toBe(true);
  expect(schema?.methods?.length).toBeGreaterThan(0);
});

describeIfSchema("the core's method table (protocol/schema.json)", () => {
  test('every method, in order, with its class; the protocol-2 rows marked', () => {
    checkSchema(schema);
  });
});
