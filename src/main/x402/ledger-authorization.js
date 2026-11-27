/**
 * Main's rebuild of a Ledger payment's x402 authorization (freedom-core
 * design 0016, "x402 from a Ledger account", D2 option A, D10, and LDG-2's
 * L5 as built; LDG-3's PR 3). Pure: no I/O, no clock, no randomness, no
 * state.
 *
 * For a Ledger account the core signs nothing itself. `x402.authorize`
 * takes main's `now_s` (main's wall-clock reading in whole seconds, taken
 * once for the payment), checks the token or the cap, draws a nonce, and
 * answers `{ device: { typed_data, hash }, reservation, accept_index,
 * charged }`: the authorization `@x402/evm` would hand its signer, the
 * nonce in its message. Main then rebuilds that authorization itself, from
 * what it holds (the accept entry the reply names, the account's address
 * from its own record, and the `now_s` it sent) and the nonce, which is the
 * only value it takes from the core: 32 random bytes for EIP-3009, a
 * random uint256 for Permit2. It names no recipient, amount, spender or
 * time. Main requires the core's typed data to equal its rebuild **as JSON
 * values**: the same members and values, members in any order, arrays in
 * order, a number only equal to a number and a string only to a string, as
 * the core compares (`ledger_operation` in freedom-cored's
 * `approvals/x402.rs`). Only then does it send **its own copy** back as
 * `x402.settle { reservation, typed_data }`, which the core requires to
 * equal its reserved authorization before the device, and which the
 * relay's typed-data binding encodes (design 0016, *Main's typed-data
 * binding*). So every time byte the device signs is one main derived, and a
 * faulty core can't have the Ledger sign another schema, spender, recipient
 * or time window.
 *
 * The three forms, exactly as `@x402/evm` builds them (`exact/client`'s
 * `createEIP3009Payload` and `createPermit2PayloadForProxy`, and
 * `exact/v1/client`'s `ExactEvmSchemeV1`), the typed data as
 * `JSON.stringify` writes what the package hands `signTypedData`, each
 * BigInt as its decimal text (core #392's `typed_data`):
 *
 * - **EIP-3009, x402 version 2** (`extra.assetTransferMethod` anything but
 *   `"permit2"`): domain `{ name: extra.name, version: extra.version,
 *   chainId, verifyingContract: asset }`, the chain from the network
 *   `eip155:<id>`; `TransferWithAuthorization(address from, address to,
 *   uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)`;
 *   message `{ from, to: payTo, value: amount, validAfter: "0", validBefore:
 *   now_s + maxTimeoutSeconds, nonce }`.
 * - **EIP-3009, x402 version 1** (any `extra`): the same, the chain from the
 *   two version-1 networks the client registers (`base`, `ethereum`), the
 *   value `maxAmountRequired`, and `validAfter` `now_s − 600`.
 * - **Permit2, x402 version 2** (`extra.assetTransferMethod: "permit2"`):
 *   domain `{ name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS }`;
 *   `PermitWitnessTransferFrom(TokenPermissions permitted, address spender,
 *   uint256 nonce, uint256 deadline, Witness witness)`,
 *   `TokenPermissions(address token, uint256 amount)`, `Witness(address to,
 *   uint256 validAfter)`; message `{ permitted: { token: asset, amount },
 *   spender: PERMIT2_PROXY, nonce, deadline: now_s + maxTimeoutSeconds,
 *   witness: { to: payTo, validAfter: "0" } }`.
 *
 * Addresses are EIP-55 checksummed, as viem's `getAddress` writes them, and
 * amounts are the decimal text of the entry's atomic units with no leading
 * zero, as `BigInt(…).toString()` writes them. No `EIP712Domain` type.
 *
 * What the rebuild refuses is what it can't build exactly as the package
 * and the core do; each is a refusal with its reason (`REFUSALS`), never a
 * throw. The payment's policy (the client's default assets and $1 limit,
 * `extra.paymentFlow`, the 20 s runway, the cap or token) stays the core's,
 * at `x402.authorize`, before any typed data exists.
 *
 * **The interface** (for `sign-flow.js`, LDG-3's PR 9):
 *
 *     const nowS = Math.floor(Date.now() / 1000);  // sent as x402.authorize's now_s
 *     const reply = await authorize({ ..., device: { kind: 'ledger', address }, now_s: nowS });
 *     const result = checkLedgerAuthorization({
 *       x402Version: requirements.x402Version,      // main's parsed requirements
 *       accept: requirements.accepts[reply.accept_index],
 *       from: address,                               // the account's record (getWalletRecord)
 *       nowS,
 *       nonce: nonceOf(reply.device?.typed_data),
 *       authorization: reply.device?.typed_data,     // the core's, as JSON.parse read it
 *     });
 *     // result: { accepted: true, form, typedData } | { accepted: false, reason }
 *     // accepted: settle { reservation, typed_data: result.typedData }, main's copy;
 *     // refused: nothing reaches the device; settle the reservation `withheld`.
 *
 * `typedData` is a fresh, deeply frozen object each call: the copy main
 * sends and binds, which nothing may change after it was compared.
 */

const { getAddress } = require('ethers');

/** The three forms a Ledger signs (design 0016's table). */
const FORMS = Object.freeze({
  EIP3009: 'eip3009',
  EIP3009_V1: 'eip3009-v1',
  PERMIT2: 'permit2',
});

/**
 * Why main refuses: what the rebuild can't build exactly as `@x402/evm`
 * and the core do (each named for the input it reads), or `mismatch`, the
 * core's typed data not equal to main's rebuild.
 */
const REFUSALS = Object.freeze({
  VERSION: 'version', // x402Version isn't 1 or 2
  ACCEPT: 'accept', // the accept entry isn't an object
  SCHEME: 'scheme', // not `exact`
  NETWORK: 'network', // not `eip155:<chain>` (version 2), `base` or `ethereum` (version 1)
  AMOUNT: 'amount', // not decimal atomic units within 256 bits
  ASSET: 'asset', // not a 20-byte hex address (with a valid checksum if mixed case)
  PAY_TO: 'pay_to', // the same, for payTo
  TIMEOUT: 'timeout', // maxTimeoutSeconds isn't a positive safe integer, or the deadline passes 2^53
  DOMAIN: 'domain', // EIP-3009 without non-empty string `extra.name` and `extra.version`
  FROM: 'from', // the account's address isn't an address
  CLOCK: 'clock', // now_s isn't whole seconds, or is before 600 for version 1's validAfter
  NONCE: 'nonce', // not the form's nonce: `0x` and 64 lowercase hex digits, or a uint256's decimal
  MISMATCH: 'mismatch', // the core's authorization isn't main's rebuild
});

/** Permit2's canonical address (`@x402/evm`'s `PERMIT2_ADDRESS`). */
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** x402's Permit2 proxy, the spender (`x402ExactPermit2ProxyAddress`). */
const PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

/**
 * The version-1 networks the client registers (`ExactEvmSchemeV1` for
 * `base` and `ethereum`; the core's `V1_NETWORKS`), with the chains the
 * package's `EVM_NETWORK_CHAIN_ID_MAP` gives them.
 */
const V1_NETWORKS = Object.freeze({ base: 8453, ethereum: 1 });

/** Version 1's `validAfter`: ten minutes before `now_s`. */
const V1_VALID_AFTER_BACK_S = 600;

/** JS adds the times as doubles: a deadline from 2^53 on would round. */
const TIME_LIMIT = 2 ** 53;

const UINT256_LIMIT = 2n ** 256n;
const EIP155_NETWORK = /^eip155:([1-9][0-9]*)$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_NONCE = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const DIGITS = /^[0-9]+$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An own member, never one an object inherits. */
function own(object, key) {
  return isPlainObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** An address as the core reads one (`fc_evm::parse_address`), checksummed; null otherwise. */
function checksummed(value) {
  if (typeof value !== 'string' || !HEX_ADDRESS.test(value)) return null;
  try {
    // ethers refuses mixed case with a wrong checksum, as the core does.
    return getAddress(value);
  } catch {
    return null;
  }
}

/** Atomic units (`/^\d+$/`, within 256 bits) as `BigInt(…).toString()` writes them; null otherwise. */
function atomic(value) {
  if (typeof value !== 'string' || !DIGITS.test(value)) return null;
  const amount = BigInt(value);
  return amount < UINT256_LIMIT ? amount.toString() : null;
}

function chainOf(x402Version, network) {
  if (typeof network !== 'string') return null;
  if (x402Version === 1) return Object.hasOwn(V1_NETWORKS, network) ? V1_NETWORKS[network] : null;
  const match = EIP155_NETWORK.exec(network);
  if (!match) return null;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) ? chainId : null;
}

/** The form an entry is paid in, as the package routes it. */
function formOf(x402Version, accept) {
  if (x402Version === 1) return FORMS.EIP3009_V1;
  return own(own(accept, 'extra'), 'assetTransferMethod') === 'permit2'
    ? FORMS.PERMIT2
    : FORMS.EIP3009;
}

function isFormNonce(form, nonce) {
  if (typeof nonce !== 'string') return false;
  if (form !== FORMS.PERMIT2) return BYTES32_NONCE.test(nonce);
  // 2^256 − 1 has 78 digits: nothing longer is read as a number.
  return nonce.length <= 78 && DECIMAL.test(nonce) && BigInt(nonce) < UINT256_LIMIT;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

function transferWithAuthorization({
  name,
  version,
  chainId,
  asset,
  from,
  payTo,
  amount,
  validAfter,
  deadline,
  nonce,
}) {
  return {
    domain: { name, version, chainId, verifyingContract: asset },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to: payTo,
      value: amount,
      validAfter: String(validAfter),
      validBefore: String(deadline),
      nonce,
    },
  };
}

function permitWitnessTransferFrom({ chainId, asset, payTo, amount, deadline, nonce }) {
  return {
    domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witness', type: 'Witness' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      Witness: [
        { name: 'to', type: 'address' },
        { name: 'validAfter', type: 'uint256' },
      ],
    },
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: asset, amount },
      spender: PERMIT2_PROXY,
      nonce,
      deadline: String(deadline),
      witness: { to: payTo, validAfter: '0' },
    },
  };
}

const refuse = (reason) => ({ ok: false, reason });

/**
 * Main's own build of the authorization `@x402/evm` hands its signer for
 * `accept`, paid from `from` at `nowS` with the core's `nonce`.
 *
 * @param {{
 *   x402Version: 1 | 2,  // the requirements' x402Version
 *   accept: object,      // the accepts[] entry the core's reply names (accept_index), main's copy
 *   from: string,        // the paying account's address, from main's own record
 *   nowS: number,        // the now_s main sent with x402.authorize
 *   nonce: string,       // the core's nonce as the form writes it (nonceOf)
 * }} input
 * @returns {{ ok: true, form: string, typedData: object } | { ok: false, reason: string }}
 */
function rebuildLedgerAuthorization({ x402Version, accept, from, nowS, nonce } = {}) {
  if (x402Version !== 1 && x402Version !== 2) return refuse(REFUSALS.VERSION);
  if (!isPlainObject(accept)) return refuse(REFUSALS.ACCEPT);
  if (own(accept, 'scheme') !== 'exact') return refuse(REFUSALS.SCHEME);
  const chainId = chainOf(x402Version, own(accept, 'network'));
  if (chainId === null) return refuse(REFUSALS.NETWORK);
  const amount = atomic(own(accept, x402Version === 1 ? 'maxAmountRequired' : 'amount'));
  if (amount === null) return refuse(REFUSALS.AMOUNT);
  const asset = checksummed(own(accept, 'asset'));
  if (!asset) return refuse(REFUSALS.ASSET);
  const payTo = checksummed(own(accept, 'payTo'));
  if (!payTo) return refuse(REFUSALS.PAY_TO);
  const timeout = own(accept, 'maxTimeoutSeconds');
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return refuse(REFUSALS.TIMEOUT);
  const account = checksummed(from);
  if (!account) return refuse(REFUSALS.FROM);
  if (!Number.isSafeInteger(nowS) || nowS < 0) return refuse(REFUSALS.CLOCK);
  const deadline = nowS + timeout;
  if (deadline >= TIME_LIMIT) return refuse(REFUSALS.TIMEOUT);

  const form = formOf(x402Version, accept);
  if (form === FORMS.PERMIT2) {
    if (!isFormNonce(form, nonce)) return refuse(REFUSALS.NONCE);
    const typedData = permitWitnessTransferFrom({ chainId, asset, payTo, amount, deadline, nonce });
    return { ok: true, form, typedData: deepFreeze(typedData) };
  }
  const extra = own(accept, 'extra');
  const name = own(extra, 'name');
  const version = own(extra, 'version');
  if (!isNonEmptyString(name) || !isNonEmptyString(version)) return refuse(REFUSALS.DOMAIN);
  let validAfter = 0;
  if (form === FORMS.EIP3009_V1) {
    validAfter = nowS - V1_VALID_AFTER_BACK_S;
    if (validAfter < 0) return refuse(REFUSALS.CLOCK);
  }
  if (!isFormNonce(form, nonce)) return refuse(REFUSALS.NONCE);
  const typedData = transferWithAuthorization({
    name,
    version,
    chainId,
    asset,
    from: account,
    payTo,
    amount,
    validAfter,
    deadline,
    nonce,
  });
  return { ok: true, form, typedData: deepFreeze(typedData) };
}

/**
 * Whether `theirs` equals `mine` as JSON values: the same members (in any
 * order) and values, arrays in order, numbers only equal to numbers and
 * strings to strings. Walks `mine`, which main built, so `theirs` can't
 * make it go deeper or wider than main's own typed data.
 */
function sameJson(mine, theirs) {
  if (mine === null || typeof mine !== 'object') {
    if (typeof mine === 'number') return typeof theirs === 'number' && Object.is(mine, theirs);
    return mine === theirs;
  }
  if (Array.isArray(mine)) {
    return (
      Array.isArray(theirs) &&
      theirs.length === mine.length &&
      mine.every((member, i) => sameJson(member, theirs[i]))
    );
  }
  if (!isPlainObject(theirs)) return false;
  const keys = Object.keys(mine);
  return (
    Object.keys(theirs).length === keys.length &&
    keys.every((key) => Object.hasOwn(theirs, key) && sameJson(mine[key], theirs[key]))
  );
}

/**
 * The nonce in the core's typed data (`message.nonce`), the one value main
 * takes from the core; null when there is none to read.
 *
 * @param {unknown} authorization the core's `device.typed_data`
 * @returns {string | null}
 */
function nonceOf(authorization) {
  const nonce = own(own(authorization, 'message'), 'nonce');
  return typeof nonce === 'string' ? nonce : null;
}

/**
 * Main's check of the core's authorization for a Ledger payment: rebuilt
 * from main's inputs and the core's nonce, then compared as JSON values.
 *
 * @param {{
 *   x402Version: 1 | 2,
 *   accept: object,
 *   from: string,
 *   nowS: number,
 *   nonce: string,
 *   authorization: unknown,  // the core's `device.typed_data`
 * }} input
 * @returns {{ accepted: true, form: string, typedData: object } | { accepted: false, reason: string }}
 *   `typedData` is main's own copy, to send as `x402.settle`'s `typed_data`.
 */
function checkLedgerAuthorization(input = {}) {
  const rebuilt = rebuildLedgerAuthorization(input);
  if (!rebuilt.ok) return { accepted: false, reason: rebuilt.reason };
  if (!sameJson(rebuilt.typedData, input.authorization)) {
    return { accepted: false, reason: REFUSALS.MISMATCH };
  }
  return { accepted: true, form: rebuilt.form, typedData: rebuilt.typedData };
}

module.exports = {
  FORMS,
  REFUSALS,
  PERMIT2_ADDRESS,
  PERMIT2_PROXY,
  V1_NETWORKS,
  rebuildLedgerAuthorization,
  checkLedgerAuthorization,
  nonceOf,
  sameJson,
};
