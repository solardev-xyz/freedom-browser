/**
 * Main's copy of the core's deadline classes, and the hang watchdog each
 * gives (freedom-core design 0001). Against freedom-core's
 * `protocol/schema.json` too, when it is found: FREEDOM_CORE_SCHEMA names
 * the file, or it is in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in.
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
  test('every method, in order, with its class', () => {
    const classOf = {
      null: 'immediate',
      [VAULT_DEADLINE_MS]: 'vault',
      [SESSION_DEADLINE_MS]: 'session',
    };
    const theirs = schema.methods.map((m) => [m.name, classOf[m.deadline_ms] ?? m.deadline_ms]);
    expect(Object.entries(METHOD_CLASSES)).toEqual(theirs);
  });
});
