/**
 * Ledger account discovery and adding through freedom-cored (freedom-core
 * design 0016, Accounts, `ledger.accounts` and `ledger.add`; the LDG-3
 * plan's PR 8 and its points 2, 3, 9 and 14), for FREEDOM_LEDGER_BACKEND
 * `core` (ledger-backend-kind.js). On `js`, ipc.js and identity-manager.js
 * keep today's path (transport.js, account-checks.js), unchanged.
 *
 * Each request is one operation on the core's device lane: main prepares
 * the stream it expects from what it holds itself (point 2), sends the
 * request through vault-backend.js's `ledgerCall` under the device
 * watchdog (point 3), opens the parent in its relay from `onSent`
 * (core/ledger-relay.js), and the core sends every APDU through
 * `shell.ledger_apdu`, which the relay admits by that stream before any
 * byte reaches the device. The parent closes in the relay when its answer
 * comes, whatever it is.
 *
 * - **Discovery** (`ledger.accounts { scheme, start, count }`): the range
 *   is today's `listAccounts`' (a scheme of the two, `start` at least 0,
 *   1 to 20 accounts). Main's stream includes the check of its own list
 *   of the Ledger records no device has matched (`getLedgerRecordsToCheck`,
 *   D1, compared strictly by the relay), which the core reads from its own
 *   snapshot after discovery's APDUs and keeps on each record itself, so
 *   account-checks.js isn't run. A stale list costs a failed check, which
 *   the core logs and answers with `mismatched` empty; discovery still
 *   answers. Each account comes back with the path main asked for, and
 *   main adds its `scheme` and `index` from its own request: what the
 *   chrome sends to add it.
 * - **Adding** (`ledger.add { scheme, index, name? }`, point 9): the chrome
 *   sends a name, a scheme and an index, never an address. The core reads
 *   the address at that path with the display on, the user confirms it on
 *   the Ledger (question 3), and the core writes the record (`matched`)
 *   through its accounts store and answers `{ path, address, wallet }`:
 *   the stored address is the device's, never the chrome's, and main
 *   doesn't call `accounts.add_ledger`. A refused write keeps its
 *   `accounts.*` code (a duplicate, no vault).
 * - **Errors:** a device's failure is `device_failed` with `data.ledger`,
 *   its `LEDGER_*` code, which becomes errors.js's error for it, so the
 *   chrome gets the same codes and texts as on `js`. An answer that isn't
 *   the one main asked for is `LEDGER_UNKNOWN`.
 */

const { isAddress } = require('ethers');
const log = require('../../logger');
const { getLedgerRelay } = require('../../core/core-process');
const { vaultBackend, VaultBackendError } = require('../../core/vault-backend');
const { MAX_ACCOUNTS, MAX_INDEX, SCHEMES } = require('../../core/ledger-grammar');
const { LEDGER_ERROR_CODES, createLedgerError } = require('./errors');

const KNOWN_CODES = new Set(Object.values(LEDGER_ERROR_CODES));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A device's failure (`device_failed`, `data.ledger`) as errors.js's error; any other error as it is. */
function ledgerError(err) {
  if (err?.code !== 'device_failed') return err;
  const code = err.data?.ledger;
  const mapped = createLedgerError(KNOWN_CODES.has(code) ? code : LEDGER_ERROR_CODES.UNKNOWN);
  mapped.cause = err;
  return mapped;
}

/** An answer that isn't the one main asked for. */
function unexpected(method, what) {
  log.warn(`[Ledger] ${method}: the core's answer isn't the one asked for`, { what });
  return createLedgerError(LEDGER_ERROR_CODES.UNKNOWN);
}

/**
 * One Ledger request through the core: its stream prepared in the relay
 * from what main holds, sent by `send({ onSent, signal })`, opened in the
 * relay as it is written, and closed there once it settles.
 */
async function throughRelay(method, params, capture, send) {
  const relay = getLedgerRelay();
  if (!relay) throw new VaultBackendError('core_unavailable', 'The identity core is not running');
  const prepared = relay.prepare({ method, params, ...capture });
  if (!prepared.ok) {
    // Main can't derive a stream for it: nothing is sent.
    log.warn(`[Ledger] ${method} not sent: main can't derive its stream`, {
      rule: prepared.rule,
      reason: prepared.reason,
    });
    throw createLedgerError(LEDGER_ERROR_CODES.UNKNOWN);
  }
  const controller = new AbortController();
  let handle = null;
  let refused = null;
  try {
    return await send({
      signal: controller.signal,
      // `onSent` must not throw (service-client.js): a parent the relay
      // can't open is cancelled at once, and its error is the caller's.
      onSent: (id, generation) => {
        try {
          handle = relay.open({ id, generation }, { prepared, controller });
        } catch (err) {
          refused = err;
          controller.abort();
        }
      },
    });
  } catch (err) {
    throw ledgerError(refused ?? err);
  } finally {
    handle?.close();
  }
}

/** Discovery's range, as today's `listAccounts` reads it (transport.js). */
function discoveryParams(options) {
  const { scheme = 'live', start = 0, count = 5 } = isObject(options) ? options : {};
  if (!Object.hasOwn(SCHEMES, scheme)) {
    throw new Error(`Unknown derivation scheme: ${scheme}`);
  }
  const first = Math.max(0, Math.trunc(start));
  const many = Math.min(MAX_ACCOUNTS, Math.max(1, Math.trunc(count)));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(many)) {
    throw new Error('Invalid Ledger account range');
  }
  return { scheme, start: first, count: many };
}

/** `ledger.accounts`' answer, held to the range main asked for. */
function discovered(result, params) {
  const accounts = isObject(result) ? result.accounts : undefined;
  if (!Array.isArray(accounts) || accounts.length !== params.count) {
    throw unexpected('ledger.accounts', 'accounts');
  }
  const listed = accounts.map((account, k) => {
    const index = params.start + k;
    const path = SCHEMES[params.scheme](index);
    if (
      !isObject(account) ||
      account.path !== path ||
      typeof account.address !== 'string' ||
      !isAddress(account.address)
    ) {
      throw unexpected('ledger.accounts', 'account');
    }
    return { path, address: account.address, scheme: params.scheme, index };
  });
  const mismatched = Array.isArray(result.mismatched)
    ? result.mismatched
        .filter(isObject)
        .map(({ index, name, address, path }) => ({ index, name, address, path }))
    : [];
  return { accounts: listed, mismatched };
}

/**
 * The attached Ledger's accounts for a scheme's range, and the wallet's
 * Ledger records no device had matched that it doesn't hold (D1).
 *
 * @param {{scheme?: string, start?: number, count?: number}} [options]
 * @returns {Promise<{accounts: Array<{path: string, address: string, scheme: string, index: number}>,
 *   mismatched: Array<{index: number, name: string, address: string, path: string}>}>}
 */
async function discoverAccounts(options = {}) {
  const params = discoveryParams(options);
  // identity-manager.js adds through this module: required here, not at load.
  const { getLedgerRecordsToCheck } = require('../../identity-manager');
  const records = getLedgerRecordsToCheck();
  const result = await throughRelay('ledger.accounts', params, { records }, (sending) =>
    vaultBackend.ledger.accounts(params, sending)
  );
  return discovered(result, params);
}

/** `ledger.add`'s params from the chrome's name, scheme and index. */
function addParams({ name, scheme, index }) {
  if (typeof scheme !== 'string' || !Object.hasOwn(SCHEMES, scheme)) {
    throw new Error('Unknown derivation scheme for Ledger account');
  }
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error('Invalid Ledger account index');
  }
  return typeof name === 'string' ? { scheme, index, name } : { scheme, index };
}

/** `ledger.add`'s answer, held to the path main asked for: the record the core wrote. */
function added(result, params) {
  const path = SCHEMES[params.scheme](params.index);
  if (!isObject(result) || result.path !== path || !isAddress(result.address)) {
    throw unexpected('ledger.add', 'account');
  }
  const { wallet } = result;
  if (
    !isObject(wallet) ||
    wallet.type !== 'ledger' ||
    wallet.path !== path ||
    wallet.address !== result.address
  ) {
    throw unexpected('ledger.add', 'wallet');
  }
  return wallet;
}

/**
 * Adds the account at a scheme's index: the core reads its address from the
 * device, the user confirms it there, and the core writes the record.
 *
 * @param {{name?: string, scheme: string, index: number}} account
 * @returns {Promise<{index: number, name: string, address: string, type: string, path: string, addressCheck: string}>}
 *   The record, its address the device's.
 */
async function addAccount(account) {
  const params = addParams(account);
  const result = await throughRelay('ledger.add', params, {}, (sending) =>
    vaultBackend.ledger.add(params, sending)
  );
  return added(result, params);
}

module.exports = { discoverAccounts, addAccount };
