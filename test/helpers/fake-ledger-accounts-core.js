/**
 * A scripted freedom-cored that plays `ledger.accounts` and `ledger.add`
 * (freedom-core design 0016, Accounts; LDG-2's L3 as cored 0.30.0 builds
 * them, `crates/freedom-cored/src/ledger/methods.rs` and `accounts.rs` at
 * b4e0cef4) through main's relay, and a device whose answers come from a
 * seed: for LDG-3's PR 8 (wallet/ledger/core-accounts.js).
 *
 * **The core** (`LedgerAccountsCore`, over fake-ledger-core.js's
 * `FakeLedgerCore`, whose reader reads every reply of main's as reply.rs
 * does and keeps what it wouldn't take in `faults`) answers the hello with
 * the `store_moved` echo it is given (`vault_meta` by default), and runs
 * each `ledger.*` request main sends as one operation of its lane, one at
 * a time: discovery answers `LEDGER_BUSY` at once while another runs
 * (deviation `discovery-busy`), and an add waits its turn.
 * - `ledger.accounts { scheme, start, count }`: `E0 02 00 00 P` for each
 *   of the scheme's paths, then, once `vault_meta` is moved, for each
 *   record its own `vault-meta.json` lists as unmatched (a Ledger's, not
 *   `matched`, a path that is a scheme's text, an address string; the
 *   first 20, in the list's order). Each answer is read as fc-ledger reads
 *   it (`65 ‖ key ‖ 40 ‖ address`, the address the key's). A discovery
 *   APDU that fails ends the request `device_failed`; a check that fails
 *   is a failed check, `mismatched` empty. Otherwise each record still at
 *   that index with that path and address takes the result (a `matched`
 *   one stays matched), written to the file, and the ones left
 *   `mismatched` come back.
 * - `ledger.add { scheme, index, name? }`: `E0 02 01 00 P` with
 *   `deadline_ms` 300000 (the user confirms the address on the device);
 *   then, once moved, the record of the device's address, `matched`, at
 *   the next hardware index, written to the file, answering `{ path,
 *   address, wallet }`; a duplicate address or no file is refused
 *   `invalid_argument` with the reference's text, nothing written.
 * - Main's cancel of a parent cancels its pending APDU, and the parent
 *   answers `cancelled`.
 *
 * **The device** (`seededDevice()`): `respond` for fake-ledger-core.js's
 * `fakeLedgerDevices`, answering each `E0 02` with the key and address a
 * seed derives at that path (`deviceAccount`), `9000`; `seed` changes the
 * device, `script(apdu)` overrides an answer (a status, `{ fail }`,
 * `{ hold }`).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { Wallet, computeAddress, getAddress, isAddress, keccak256, toUtf8Bytes } = require('ethers');
const { CoreClient } = require('../../src/main/core/core-client');
const { CORE_STREAM_KINDS } = require('../../src/main/core/frame');
const { registerLedgerRelay } = require('../../src/main/core/ledger-relay');
const { FakeLedgerCore, fakeLedgerDevices } = require('./fake-ledger-core');

const HARDENED = 0x80000000;
const HARDWARE_INDEX_BASE = 1000000;
const MAX_CHECKS = 20;
const SCHEMES = {
  live: (i) => `44'/60'/${i}'/0/0`,
  legacy: (i) => `44'/60'/0'/${i}`,
};
const LIVE = /^44'\/60'\/(0|[1-9][0-9]{0,9})'\/0\/0$/;
const LEGACY = /^44'\/60'\/0'\/(0|[1-9][0-9]{0,9})$/;

/** The key and address a seed's device holds at `path`. */
function deviceAccount(seed, path) {
  const wallet = new Wallet(keccak256(toUtf8Bytes(`${seed}:${path}`)));
  return { key: wallet.signingKey.publicKey, address: wallet.address };
}

/** A path text as `P`: the number of elements, then each, 4 bytes big-endian. */
function pathBytes(text) {
  const live = LIVE.exec(text);
  const legacy = live ? null : LEGACY.exec(text);
  if (!live && !legacy) throw new Error(`not a scheme's path: ${text}`);
  const index = Number((live || legacy)[1]);
  const elements = live
    ? [44 + HARDENED, 60 + HARDENED, index + HARDENED, 0, 0]
    : [44 + HARDENED, 60 + HARDENED, HARDENED, index];
  const out = Buffer.alloc(1 + 4 * elements.length);
  out[0] = elements.length;
  elements.forEach((element, k) => out.writeUInt32BE(element, 1 + 4 * k));
  return out;
}

/** `P` back to its path text, or null. */
function pathText(p) {
  const n = p[0];
  if (p.length !== 1 + 4 * n) return null;
  const at = (k) => p.readUInt32BE(1 + 4 * k);
  if (n === 5 && at(0) === 44 + HARDENED && at(1) === 60 + HARDENED && at(3) === 0 && at(4) === 0) {
    return at(2) >= HARDENED ? SCHEMES.live(at(2) - HARDENED) : null;
  }
  if (n === 4 && at(0) === 44 + HARDENED && at(1) === 60 + HARDENED && at(2) === HARDENED) {
    return at(3) < HARDENED ? SCHEMES.legacy(at(3)) : null;
  }
  return null;
}

/** `E0 02 00 00 P` (display off) or `E0 02 01 00 P` (display on). */
function addressApdu(text, { display = false } = {}) {
  const p = pathBytes(text);
  return Buffer.concat([Buffer.from([0xe0, 0x02, display ? 0x01 : 0x00, 0x00, p.length]), p]);
}

/** The Ethereum app's answer to `E0 02` for `path` on a seed's device. */
function addressAnswer(seed, path) {
  const { key, address } = deviceAccount(seed, path);
  return Buffer.concat([
    Buffer.from([65]),
    Buffer.from(key.slice(2), 'hex'),
    Buffer.from([40]),
    Buffer.from(address.slice(2), 'ascii'),
    Buffer.from([0x90, 0x00]),
  ]);
}

/**
 * A device answering each `E0 02` from `seed`: `respond` for
 * `fakeLedgerDevices`. `script(apdu, path)` may answer first (anything but
 * undefined: hex, `{ fail }`, `{ hold }`).
 */
function seededDevice(seed = 'device-a') {
  const state = { seed, script: null };
  return {
    get seed() {
      return state.seed;
    },
    set seed(next) {
      state.seed = next;
    },
    set script(fn) {
      state.script = fn;
    },
    respond(apdu) {
      const text = apdu[0] === 0xe0 && apdu[1] === 0x02 ? pathText(apdu.subarray(5)) : null;
      const scripted = state.script?.(apdu, text);
      if (scripted !== undefined) return scripted;
      return text ? addressAnswer(state.seed, text) : '6d00';
    },
  };
}

// fc-ledger's codes for what an APDU's answer ends an operation with.
const FAILED_CODES = {
  not_found: 'LEDGER_DEVICE_NOT_FOUND',
  busy: 'LEDGER_BUSY',
  disconnected: 'LEDGER_DISCONNECTED',
  unresponsive: 'LEDGER_UNRESPONSIVE',
  timeout: 'LEDGER_TIMEOUT',
};
const STATUS_CODES = {
  0x5515: 'LEDGER_DEVICE_LOCKED',
  0x6982: 'LEDGER_DEVICE_LOCKED',
  0x6985: 'LEDGER_USER_REJECTED',
  0x5501: 'LEDGER_USER_REJECTED',
  0x6511: 'LEDGER_ETH_APP_NOT_OPEN',
  0x6d00: 'LEDGER_ETH_APP_NOT_OPEN',
  0x6e00: 'LEDGER_ETH_APP_NOT_OPEN',
};

class Ended extends Error {
  constructor(body) {
    super(body.message);
    this.body = body;
  }
}

const deviceFailed = (code) =>
  new Ended({ code: 'device_failed', message: 'Ledger device failed', data: { ledger: code } });
const refused = (message) => new Ended({ code: 'invalid_argument', message });

/** An `E0 02` answer as fc-ledger reads it: `{ address }` or `{ code }`. */
function readAddress(read) {
  if (read.failed) return { code: FAILED_CODES[read.failed] };
  if (!read.answer) return { code: 'LEDGER_UNKNOWN' };
  const answer = read.answer;
  const status = answer.readUInt16BE(answer.length - 2);
  if (status !== 0x9000) return { code: STATUS_CODES[status] ?? 'LEDGER_UNKNOWN' };
  if (answer.length !== 1 + 65 + 1 + 40 + 2 || answer[0] !== 65 || answer[66] !== 40) {
    return { code: 'LEDGER_UNKNOWN' };
  }
  const key = `0x${answer.subarray(1, 66).toString('hex')}`;
  const address = `0x${answer.subarray(67, 107).toString('ascii')}`;
  if (!isAddress(address) || computeAddress(key) !== getAddress(address)) {
    return { code: 'LEDGER_UNKNOWN' };
  }
  return { address: getAddress(address) };
}

const exactly = (params, required, optional = []) =>
  params !== null &&
  typeof params === 'object' &&
  !Array.isArray(params) &&
  required.every((name) => Object.hasOwn(params, name)) &&
  Object.keys(params).every((name) => required.includes(name) || optional.includes(name));

class LedgerAccountsCore extends FakeLedgerCore {
  /**
   * @param {object} options
   * @param {string} options.identityDir - where its `vault-meta.json` is
   * @param {string[]} [options.storeMoved] - the stores it echoes, of those main names
   */
  constructor({ identityDir, storeMoved = ['vault_meta'] }) {
    super();
    this.identityDir = identityDir;
    this.storeMoved = storeMoved;
    this.moved = false;
    this.waiters = new Map();
    this.parents = new Map();
    this.lane = Promise.resolve();
    this.busy = false;
    // Each operation as it ran: `{ id, method, params, outcome }`.
    this.operations = [];
  }

  onMessage(message) {
    if (message?.type === 'request' && message.method === 'core.hello') {
      this.messages.push(message);
      const sent = message.params?.store_moved ?? [];
      const echo = this.storeMoved.filter((name) => sent.includes(name));
      this.moved = echo.includes('vault_meta');
      this.send({
        type: 'response',
        id: message.id,
        result: {
          protocol: 2,
          core_version: '0.30.0',
          capabilities: ['vault.status', 'fragments', 'streams', 'ledger.accounts', 'ledger.add'],
          store_moved: echo,
        },
      });
      this.decoder.setKinds(CORE_STREAM_KINDS);
      return;
    }
    super.onMessage(message);
    if (message?.type === 'response' && this.waiters.has(message.id)) {
      const resolve = this.waiters.get(message.id);
      this.waiters.delete(message.id);
      resolve(this.reply(message.id) ?? { unreadable: true });
    } else if (message?.type === 'request' && message.method.startsWith('ledger.')) {
      this.operate(message);
    } else if (message?.type === 'cancel') {
      this.cancelParent(message.id);
    }
  }

  get file() {
    return path.join(this.identityDir, 'vault-meta.json');
  }

  readMeta() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  writeMeta(meta) {
    fs.writeFileSync(this.file, JSON.stringify(meta, null, 2));
  }

  /** The records discovery's check reads (accounts.rs `ledger_checks`). */
  recordsToCheck() {
    const meta = this.readMeta();
    if (!meta || !Array.isArray(meta.derivedWallets)) return [];
    return meta.derivedWallets
      .filter((w) => w.type === 'ledger' && w.addressCheck !== 'matched')
      .filter((w) => Number.isFinite(w.index) && typeof w.address === 'string')
      .filter((w) => typeof w.path === 'string' && (LIVE.test(w.path) || LEGACY.test(w.path)))
      .slice(0, MAX_CHECKS)
      .map((w) => ({ index: w.index, path: w.path, address: w.address }));
  }

  async operate({ id, method, params }) {
    const operation = { id, method, params, outcome: null };
    this.operations.push(operation);
    if (method !== 'ledger.accounts' && method !== 'ledger.add') {
      this.fail(id, { code: 'unknown_method', message: 'Unknown method' });
      return;
    }
    const parent = { id, cancelled: false, pending: null };
    this.parents.set(id, parent);
    let outcome;
    try {
      if (method === 'ledger.accounts' && this.busy) throw deviceFailed('LEDGER_BUSY');
      const turn = this.lane.then(async () => {
        this.busy = true;
        try {
          if (parent.cancelled) throw new Ended({ code: 'cancelled', message: 'Cancelled' });
          return method === 'ledger.accounts'
            ? await this.discover(parent, params)
            : await this.add(parent, params);
        } finally {
          this.busy = false;
        }
      });
      this.lane = turn.catch(() => {});
      outcome = { result: await turn };
    } catch (err) {
      if (!(err instanceof Ended)) throw err;
      outcome = { error: err.body };
    } finally {
      this.parents.delete(id);
    }
    operation.outcome = outcome;
    if (outcome.error) this.fail(id, outcome.error);
    else this.respond(id, outcome.result);
  }

  /** One APDU of `parent`'s, and main's reply to it as the core read it. */
  exchange(parent, apdu, deadlineMs) {
    if (parent.cancelled) throw new Ended({ code: 'cancelled', message: 'Cancelled' });
    const ask = this.apdu(parent.id, apdu, deadlineMs);
    parent.pending = ask;
    return new Promise((resolve) => this.waiters.set(ask, resolve)).then((read) => {
      parent.pending = null;
      if (read.cancelled || parent.cancelled) {
        throw new Ended({ code: 'cancelled', message: 'Cancelled' });
      }
      return read;
    });
  }

  cancelParent(id) {
    const parent = this.parents.get(id);
    if (!parent) return;
    parent.cancelled = true;
    if (parent.pending !== null) this.cancel(parent.pending);
  }

  async discover(parent, params) {
    if (!exactly(params, ['scheme', 'start', 'count']) || !Object.hasOwn(SCHEMES, params.scheme)) {
      throw refused('Invalid parameters');
    }
    const { scheme, start, count } = params;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count)) {
      throw refused('Invalid parameters');
    }
    if (count < 1 || count > 20) throw refused('Invalid parameters');
    const accounts = [];
    for (let k = 0; k < count; k++) {
      const at = SCHEMES[scheme](start + k);
      const read = readAddress(await this.exchange(parent, addressApdu(at), 15_000));
      if (read.code) throw deviceFailed(read.code);
      accounts.push({ path: at, address: read.address });
    }
    const checks = this.moved ? this.recordsToCheck() : [];
    const held = [];
    for (const check of checks) {
      const read = readAddress(await this.exchange(parent, addressApdu(check.path), 15_000));
      // A failed check: discovery answers, `mismatched` empty.
      if (read.code) return { accounts, mismatched: [] };
      held.push(read.address);
    }
    if (checks.length === 0) return { accounts, mismatched: [] };
    const meta = this.readMeta();
    const mismatched = [];
    checks.forEach((check, k) => {
      const record = meta.derivedWallets.find((w) => w.index === check.index);
      if (
        !record ||
        record.type !== 'ledger' ||
        record.path !== check.path ||
        record.address !== check.address
      ) {
        return;
      }
      const matched = held[k].toLowerCase() === record.address.toLowerCase();
      if (matched) record.addressCheck = 'matched';
      else if (record.addressCheck !== 'matched') record.addressCheck = 'mismatched';
      if (record.addressCheck === 'mismatched') {
        const { index, name, address, path: at } = record;
        mismatched.push({ index, name, address, path: at });
      }
    });
    this.writeMeta(meta);
    return { accounts, mismatched };
  }

  async add(parent, params) {
    if (!exactly(params, ['scheme', 'index'], ['name']) || !Object.hasOwn(SCHEMES, params.scheme)) {
      throw refused('Invalid parameters');
    }
    const { scheme, index, name } = params;
    if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED) {
      throw refused('Invalid parameters');
    }
    if (name !== undefined && typeof name !== 'string') throw refused('Invalid parameters');
    const at = SCHEMES[scheme](index);
    const read = readAddress(
      await this.exchange(parent, addressApdu(at, { display: true }), 300_000)
    );
    if (read.code) throw deviceFailed(read.code);
    if (!this.moved) return { path: at, address: read.address };
    const meta = this.readMeta();
    if (!meta) throw refused('No vault found');
    const wallets = meta.derivedWallets ?? [];
    const duplicate = wallets.find(
      (w) => typeof w.address === 'string' && w.address.toLowerCase() === read.address.toLowerCase()
    );
    if (duplicate) {
      throw refused(`This account is already in your wallet list as "${duplicate.name}"`);
    }
    const next = Math.max(
      HARDWARE_INDEX_BASE,
      meta.nextHardwareWalletIndex ?? 0,
      ...wallets.map((w) => w.index + 1)
    );
    const ledgers = wallets.filter((w) => w.type === 'ledger').length;
    const wallet = {
      index: next,
      name: name?.trim() || `Ledger ${ledgers + 1}`,
      address: read.address,
      type: 'ledger',
      path: at,
      addressCheck: 'matched',
    };
    this.writeMeta({
      ...meta,
      derivedWallets: [...wallets, wallet],
      nextHardwareWalletIndex: next + 1,
    });
    return { path: at, address: read.address, wallet };
  }
}

/**
 * A CoreClient against a LedgerAccountsCore, with main's relay registered
 * on the core's backend and a seeded device behind it, started: `{ client,
 * relay, devices, device, core(), stop() }`. Timers never fire (the
 * client's watchdogs and the relay's deadlines), so a held APDU waits.
 */
async function startAccountsCore({
  identityDir,
  storeMoved,
  seed,
  log = { info() {}, warn() {}, error() {}, debug() {} },
} = {}) {
  const children = [];
  const device = seededDevice(seed);
  const devices = fakeLedgerDevices({ respond: (apdu) => device.respond(apdu) });
  const never = { setTimer: (fn, ms) => ({ fn, ms }), clearTimer: () => {} };
  const client = new CoreClient({
    spawn: () => {
      const child = new LedgerAccountsCore({ identityDir, storeMoved });
      children.push(child);
      return child;
    },
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
    shellVersion: 'test',
    grantRoot: os.tmpdir(),
    ...never,
  });
  const relay = registerLedgerRelay(client, {
    log,
    backendKind: () => 'core',
    openDevice: () => devices.openDevice(),
    now: () => 0,
    ...never,
  });
  await client.start();
  return {
    client,
    relay,
    devices,
    device,
    core: () => children[children.length - 1],
    stop: () => client.stop(),
  };
}

module.exports = {
  HARDWARE_INDEX_BASE,
  LedgerAccountsCore,
  SCHEMES,
  addressAnswer,
  addressApdu,
  deviceAccount,
  seededDevice,
  startAccountsCore,
};
