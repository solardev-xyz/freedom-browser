/**
 * Main's copy of the core's deadline classes, and the hang watchdog each
 * gives (freedom-core design 0001). Against freedom-core's
 * `protocol/schema.json` too, when it is found: FREEDOM_CORE_SCHEMA names
 * the file, or it is in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in. The check itself runs on files written here as well: one of
 * main's table, and one with design 0009's `"protocol": 2` rows.
 */

const fs = require('fs');
const path = require('path');
const {
  METHOD_CLASSES,
  SESSION_DEADLINE_MS,
  VAULT_DEADLINE_MS,
  WATCHDOG_MARGIN_MS,
  watchdogMs,
} = require('./core-deadlines');
const { CONTROL_WATCHDOG_MS: NAMING_CONTROL } = require('./naming-config');
const { CONTROL_WATCHDOG_MS: CHAIN_CONTROL } = require('./chain-config');
const naming = require('./naming-driver');
const chain = require('./chain-driver');
const { PROTOCOL_VERSION_STREAMS } = require('./core-client');
const { HEAD_DEADLINE_MS } = require('../dweb/verify-executor');

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
    expect(watchdogMs('dweb.open', 10_000)).toBe(25_000);
    expect(watchdogMs('naming.resolve_content', 0)).toBe(15_000);
    for (const odd of [500_000, -1, 1.5, NaN, '10000', null]) {
      expect(watchdogMs('chain.html', odd)).toBe(135_000);
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

// Design 0009's rows marked `"protocol": 2` (amendment 3), by deadline:
// `dweb.verify`'s head deadline, which dweb-verify.js's watchdog adds the
// margin to, and none for `dweb.forget`, which gets an immediate one. Main's
// table leaves them out until main adopts protocol 2.
const PROTOCOL_2_DEADLINES = Object.freeze({
  'dweb.verify': HEAD_DEADLINE_MS,
  'dweb.forget': null,
});

/**
 * The check against the core's file. Its rows of protocol 1 are main's
 * table: every method, in order, with its class. A row marked
 * `"protocol": 2` is set aside, and must be one of PROTOCOL_2_DEADLINES with
 * its deadline. A row of any other protocol stays with protocol 1's, which
 * it fails.
 */
function checkSchema(schema) {
  const classOf = {
    null: 'immediate',
    [VAULT_DEADLINE_MS]: 'vault',
    [SESSION_DEADLINE_MS]: 'session',
  };
  const later = (m) => m.protocol === PROTOCOL_VERSION_STREAMS;
  const theirs = schema.methods
    .filter((m) => !later(m))
    .map((m) => [m.name, classOf[m.deadline_ms] ?? m.deadline_ms]);
  expect(Object.entries(METHOD_CLASSES)).toEqual(theirs);
  const marked = schema.methods.filter(later).map((m) => [m.name, m.deadline_ms]);
  expect(Object.entries(PROTOCOL_2_DEADLINES)).toEqual(expect.arrayContaining(marked));
}

const DEADLINE_OF = { immediate: null, vault: VAULT_DEADLINE_MS, session: SESSION_DEADLINE_MS };

/** A file of main's table, as the core writes it, with `rows` after `dweb.open`. */
function schemaOf(...rows) {
  const methods = Object.entries(METHOD_CLASSES).map(([name, kind]) => ({
    name,
    callers: ['shell'],
    mutates: false,
    deadline_ms: DEADLINE_OF[kind],
  }));
  methods.splice(methods.findIndex((m) => m.name === 'dweb.open') + 1, 0, ...rows);
  return { protocol: 1, methods };
}

// As freedom-core's main writes them.
const VERIFY = {
  name: 'dweb.verify',
  callers: ['shell'],
  mutates: false,
  deadline_ms: 360_000,
  protocol: 2,
};
const FORGET = {
  name: 'dweb.forget',
  callers: ['shell'],
  mutates: false,
  deadline_ms: null,
  protocol: 2,
};

describe("the check against the core's file", () => {
  test("a file of protocol 1's rows only (core 0.9.1's) passes", () => {
    expect(() => checkSchema(schemaOf())).not.toThrow();
  });

  test('the rows marked "protocol": 2 are set aside (0009, amendment 3)', () => {
    expect(() => checkSchema(schemaOf(VERIFY, FORGET))).not.toThrow();
    expect(() => checkSchema(schemaOf(VERIFY))).not.toThrow();
  });

  test("only 0009's two rows are set aside, and only with their deadlines", () => {
    const fails = [
      { ...VERIFY, deadline_ms: SESSION_DEADLINE_MS },
      { ...FORGET, deadline_ms: VAULT_DEADLINE_MS },
      { ...FORGET, name: 'dweb.pin' },
      { ...VERIFY, protocol: 1 },
      { ...VERIFY, protocol: 3 },
      { ...FORGET, protocol: '2' },
    ];
    for (const row of fails) expect(() => checkSchema(schemaOf(row))).toThrow();
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

describeIfSchema("the core's method table (protocol/schema.json)", () => {
  test('every method of protocol 1, in order, with its class; the protocol-2 rows set aside', () => {
    checkSchema(schema);
  });
});
