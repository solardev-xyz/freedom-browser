/**
 * Main's copy of the core's deadline classes, and the hang watchdog each
 * gives (freedom-core design 0001). Against freedom-core's
 * `protocol/schema.json` too, when it is found: FREEDOM_CORE_SCHEMA names
 * the file, or it is in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in. CI checks out freedom-core's at a reviewed commit and names
 * it; a file named there that is missing fails the suite rather than
 * skipping it. The check itself runs on files written here as well: one of
 * main's table, with design 0009's and design 0015's `"protocol": 2` rows,
 * and ones that differ from it.
 */

const fs = require('fs');
const path = require('path');
const {
  ASK_IDLE_MS,
  ASK_REPLY_MS,
  HEAD_DEADLINE_MS,
  IDLE_WATCHDOGS,
  METHOD_CLASSES,
  PROTOCOL_2_METHODS,
  SESSION_DEADLINE_MS,
  SWARM_DEADLINE_MS,
  VAULT_DEADLINE_MS,
  WATCHDOG_MARGIN_MS,
  idleWatchdogMs,
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
];

describe('core deadlines', () => {
  test('an immediate method gets 15 s, a vault method 45 s', () => {
    for (const method of VAULT_QUEUE) expect(watchdogMs(method)).toBe(45_000);
    const immediate = Object.keys(METHOD_CLASSES).filter((m) => METHOD_CLASSES[m] === 'immediate');
    expect(immediate).toEqual(
      expect.arrayContaining(['vault.status', 'vault.lock', 'vault.touch', 'sign.message'])
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

/**
 * The check against the core's file: every method, in order, with its
 * class, main's table whole. A row's `protocol`, when it has one, is the
 * number 2, and the rows that carry it are exactly PROTOCOL_2_METHODS, in
 * its order (design 0009, amendment 3; design 0015, D5). Main asks for
 * protocol 2 (core-process.js), so a file without those rows (a core
 * before 0009's protocol 2, as 0.9.1) fails. An idle method's deadline is
 * written `"idle"`, apart from an immediate one's `null` (design 0015, D5).
 */
function checkSchema(schema) {
  const classOf = {
    null: 'immediate',
    [VAULT_DEADLINE_MS]: 'vault',
    [SESSION_DEADLINE_MS]: 'session',
    [HEAD_DEADLINE_MS]: 'head',
    [SWARM_DEADLINE_MS]: 'swarm',
    idle: 'idle',
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
