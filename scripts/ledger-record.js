#!/usr/bin/env node
/**
 * Records a real Ledger's answers to Freedom's requests, for freedom-core's
 * `vectors/ledger-devices.json` (freedom-core design 0016, Vectors and
 * LDG-3's row; the LDG-3 plan's PR 13 and §5, the user's device session).
 * Development only: electron-builder packs `src/**` and `package.json`
 * alone (package.json's `build.files`), so this script and its cases never
 * ship (scripts/package-files.test.js holds that).
 *
 * Run it under Electron's Node, since node-hid is built for Electron, with
 * a Ledger reset to the public test phrase (`abandon` ×11, `about`) and never
 * funded, Ledger Live closed, the Ledger unlocked in the Ethereum app with
 * blind signing off (on Linux, Ledger's udev rules installed):
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/ledger-record.js \
 *     --model <nanoSP|nanoX|stax|flex|nanoS> --out ledger-devices-<model>.json \
 *     [--firmware <version>]
 *
 * It asks for the firmware version when `--firmware` isn't given (Ledger
 * Live's My Ledger, or the device's Settings > About), reads the Ethereum
 * app's name and version from the device (`B0 01`), and then tells the user,
 * step by step, what to do on the device.
 *
 * **What it plays.** Each step is a ledger.json case at the core's release
 * (`ledger-record-cases.json`, held to ledger.json by the test):
 * - **main's own stream** for the request (`core/ledger-grammar.js`'s
 *   Admission, with `wallet/ledger/apdu-binding.js` for typed data), which
 *   is the core's by the joint contract (0016, Main's typed-data binding),
 *   played through the Admission APDU by APDU as the relay will, the
 *   hash-only APDU after a `6D00` to the first `E0 1A` included;
 * - for F-2's names (a field named with `é` or `😀` at 252 and 253 UTF-8
 *   bytes), **the reference's APDUs** from ledger.json, which the core never
 *   sends (deviation `name-ascii`), to record what a device does with them.
 *
 * The steps (§5): a type 0 and a type 2 transaction, a message, the Mail
 * typed data, a SafeTx, an EIP-3009 authorization, the name-edge cases (the
 * core's 253-character field name and 255-character primary type, and the
 * reference's four), adding an account with the address shown, one
 * rejection, a contract call with blind signing off and then on, an unplug,
 * and the cancel case (a request left on screen, cancelled, and a new one
 * started at once while the user rejects the old prompt). On a Nano S only
 * the hash-only cases (the Mail and the SafeTx), with the user checking the
 * device's two hashes against the ones printed.
 *
 * **What it records,** per exchange: the APDU, the answer or the failure,
 * when it was sent and how long the answer took (R3), and whether an APDU
 * that doesn't wait for the user was held until the user went on (R2). The
 * file's `formats` say the rest. It is written after every step, `complete`
 * once the last is done, and never over an existing file.
 *
 * **Safety:** nothing is recorded unless the device's first account under
 * the test phrase is the expected address: the recorder reads it before the
 * first step and after every replug, and checks the address in every `E0 02`
 * answer before it sends anything more. A Ledger holding another seed stops
 * the session, and none of its answers is written.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const {
  HDNodeWallet,
  Signature,
  SigningKey,
  computeAddress,
  formatEther,
  hashMessage,
  keccak256,
} = require('ethers');
const { Admission, parsePath, unsignedTransaction } = require('../src/main/core/ledger-grammar');
const { bindTypedData } = require('../src/main/wallet/ledger/apdu-binding');
const { HidDevice, HidHost, DEADLINE_MS } = require('../src/main/wallet/ledger/hid-device');
const { mapLedgerError } = require('../src/main/wallet/ledger/errors');
const CASES = require('./ledger-record-cases.json');

/** The public test phrase (keys.json's abandon-12) and its first account. */
const TEST_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PATH = "44'/60'/0'/0/0";
const TEST_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

const MODELS = Object.freeze({
  nanoSP: 'Nano S Plus',
  nanoX: 'Nano X',
  stax: 'Stax',
  flex: 'Flex',
  nanoS: 'Nano S',
});
// Devices whose Ethereum app shows no typed-data fields (`6D00` to E0 1A).
const HASH_ONLY_MODELS = new Set(['nanoS']);

// An APDU that doesn't wait for the user, answered after this long, was held
// for the user (R2): a device answers one in tens of milliseconds.
const HELD_MS = 1_000;
// The cancel case: how long the old request is left on screen.
const CANCEL_AFTER_MS = 5_000;
// When to tell the user that Freedom would have given up on an APDU.
const SLOW_NOTICE_MS = DEADLINE_MS.DEVICE;
// The grammar's bound on APDUs per operation (R3's question).
const APDUS_PER_OPERATION = 2_048;

const STATUS_OK = 0x9000;
const REJECTED = new Set([0x6985, 0x5501]);
const LOCKED = new Set([0x5515, 0x6982]);
const B001 = Buffer.from('b001000000', 'hex');

const USAGE = [
  'Usage: ELECTRON_RUN_AS_NODE=1 npx electron scripts/ledger-record.js \\',
  `  --model <${Object.keys(MODELS).join('|')}> --out <file> [--firmware <version>]`,
].join('\n');

/** The file's own description of its form (ledger.json's `formats`). */
const FORMATS = {
  file: "vectors/ledger-devices.json's form (freedom-core design 0016, Vectors; LDG-3): one real Ledger's answers to Freedom's requests with the public test phrase on the device, recorded by freedom-browser's scripts/ledger-record.js, for the core's replay test (C1). One file per device.",
  device:
    "{ model (nanoSP, nanoX, stax, flex or nanoS), name, firmware (as the user read it from the device or Ledger Live), app { name, version } and b001 (its B0 01 answer, hex), mnemonicId (keys.json's abandon-12), account { path, address }: the first account, which the recorder checked before it recorded anything }",
  case: "{ id, attempt (from 1: a step the user tried again), from (the ledger.json case, at meta.vectors, whose operation, request and record these are), family, operation (the core's method), request (the core's wire form: ledger.accounts { scheme, start, count }; ledger.add { scheme, index, name }; sign.transaction { tx }; sign.message { message }; sign.typed_data { typed_data, expected_hash }), record { path, address } (a signature's account), stream, device (the file's model, firmware and app), hands, exchanges, outcome, then signer or address, hashes (the hash-only branch), after (the cancel case's new request: the old one's id and attempt), dropped (reports the HID host dropped: another channel's, such as an old request's late answer) }",
  stream:
    "core: main's own stream for the request (core/ledger-grammar.js's Admission, with wallet/ledger/apdu-binding.js for typed data), the core's by the joint contract (0016, Main's typed-data binding), played APDU by APDU through the Admission as main's relay will, the hash-only APDU after a 6D00 to the first E0 1A. reference: ledger.json's APDUs for the case, the JS reference's, whose name length bytes count UTF-16 units (deviation name-ascii, F-2): the core never sends them; recorded to show what a device does with them.",
  hands:
    "what the user was asked to do on the device: none (nothing shows), approve, reject, refuse (a contract call with blind signing off: the device should refuse it), unplug (at the prompt), leave (the cancel case's old request, left on screen until the recorder cancelled it), reject-old (the cancel case's new request, started at once: reject the old prompt, then approve this one), any (a reference stream: approve what shows, or dismiss an error).",
  exchange:
    "{ apdu (hex), row (the grammar's row), deadline_ms (what the core sends: 300000 for the APDU that waits for the user, else 15000), at_ms (when it was sent, from the session's start), then answer (hex, the status word last), failed (not_found, busy, disconnected, unresponsive or timeout) or cancelled: true (the recorder let go of it, as main does on the core's cancel), ms (until the answer or the failure), held (an APDU that doesn't wait for the user, answered after meta.heldMs or more: R2), hash_only: 'shown' (the 6D00 the hash-only APDU follows) }. The recorder gives every APDU 5 minutes, so an answer held for the user is measured rather than cut off at 15 s; the cancel case's new request runs under the core's deadline_ms, as Freedom will.",
  outcome:
    "{ status (the last answer's status word, hex) | failed | cancelled: true, as_asked: whether that is what the hands asked for }",
  signer:
    "a signature answered 9000: the address its v, r and s recover to over the core's digest (a transaction's keccak256 of its unsigned serialization, a message's EIP-191 hash, typed data's expected_hash), or null. address: for ledger.accounts and ledger.add, the address the device answered. hashes: the hash-only warning's { domain, message } and match, the user's word that the device showed the same.",
  timing:
    "R3: the time per APDU that doesn't wait for the user (held ones left out), overall and by CLA INS, and what the grammar's 2,048 APDUs would take at the median and at the 90th percentile.",
  held: "R2: of the APDUs that don't wait for the user, in the steps the user approved, how many were answered after meta.heldMs or more, by CLA INS, and in which steps.",
};

// ---------------------------------------------------------------------------
// The steps

const typedSay =
  'The Ledger shows its fields one by one: go through them at your own pace, then approve it.';
const referenceSay =
  'Freedom never sends this: the recording shows what the Ledger does with it. If the Ledger shows a request, go through it and approve it; if it shows an error, dismiss it.';

function txLabel(from, what) {
  const { tx } = CASES.cases[from].request;
  const data = (tx.data.length - 2) / 2;
  return (
    `${what}: a type ${tx.type} transaction of ${formatEther(tx.value)} ETH to ${tx.to} on chain ` +
    `${tx.chain_id}, nonce ${tx.nonce}${data ? `, with ${data} bytes of contract data` : ''}.`
  );
}

function messageLabel(from, what) {
  const bytes = (CASES.cases[from].request.message.length - 2) / 2;
  return `${what}: a message of ${bytes} bytes (not text, so the Ledger may show it as hex).`;
}

/** The steps for a device that shows typed data's fields. */
const FIELD_STEPS = [
  {
    id: 'tx-type0',
    from: 'tx-type0-chain-1-parity-0',
    family: 'transaction',
    hands: 'approve',
    say: `${txLabel('tx-type0-chain-1-parity-0', 'A transaction')} Check it on the Ledger and approve it.`,
  },
  {
    id: 'tx-type2',
    from: 'tx-type2-chain-1-parity-0',
    family: 'transaction',
    hands: 'approve',
    say: `${txLabel('tx-type2-chain-1-parity-0', 'A transaction')} Check it on the Ledger and approve it.`,
  },
  {
    id: 'message',
    from: 'msg-steps',
    family: 'message',
    hands: 'approve',
    say: `${messageLabel('msg-steps', 'A message')} Go through it at your own pace, then approve it.`,
  },
  {
    id: 'typed-mail',
    from: 'typed-mail',
    family: 'typed-data',
    hands: 'approve',
    say: `Typed data, the Mail example (from Cow to Bob, "Hello, Bob!"). ${typedSay}`,
  },
  {
    id: 'typed-safe-tx',
    from: 'typed-safe-tx',
    family: 'typed-data',
    hands: 'approve',
    say: `Typed data, a Safe transaction (SafeTx) on chain 100. ${typedSay}`,
  },
  {
    id: 'typed-eip3009',
    from: 'typed-eip3009-transfer-with-authorization',
    family: 'typed-data',
    hands: 'approve',
    say: `Typed data, an EIP-3009 authorization (TransferWithAuthorization) of 0.01 USD Coin on chain 8453. ${typedSay}`,
  },
  {
    id: 'name-field-ascii-253',
    from: 'name-field-ascii-253',
    family: 'name-length',
    hands: 'approve',
    say: `Typed data with a field named with 253 characters, the longest a definition carries. ${typedSay}`,
  },
  {
    id: 'name-primary-type-ascii-255',
    from: 'name-primary-type-ascii-255',
    family: 'name-length',
    hands: 'approve',
    say: `Typed data whose type is named with 255 characters. ${typedSay}`,
  },
  ...[
    ['name-field-e-acute-252', 'a field name of 252 bytes ending in "é"'],
    ['name-field-e-acute-253', 'a field name of 253 bytes ending in "é"'],
    ['name-field-emoji-252', 'a field name of 252 bytes ending in an emoji'],
    ['name-field-emoji-253', 'a field name of 253 bytes ending in an emoji'],
  ].map(([id, what]) => ({
    id,
    from: id,
    family: 'name-length',
    hands: 'any',
    say: `Typed data as the old code sent it, with ${what}, its length counted wrong (F-2). ${referenceSay}`,
  })),
  {
    id: 'add',
    from: 'add-live-0',
    family: 'add',
    hands: 'approve',
    say: `Adding an account: the Ledger shows the address at ${TEST_PATH}. Check that it is ${TEST_ADDRESS} and approve it.`,
  },
  {
    id: 'reject',
    from: 'msg-live-125',
    family: 'message',
    hands: 'reject',
    say: `${messageLabel('msg-live-125', 'A rejection')} When the Ledger shows it, reject it.`,
  },
  {
    id: 'contract-call-blind-off',
    from: 'tx-steps',
    family: 'transaction',
    hands: 'refuse',
    say: `${txLabel('tx-steps', 'A contract call with blind signing off')} The Ledger should refuse it. If it shows a message about blind signing, acknowledge it; don't turn the setting on yet.`,
  },
  {
    ask: 'blind-on',
    say: "Now turn blind signing on: in the Ethereum app, open Settings, turn on Blind signing, and go back to the app's first screen. Press Enter when done.",
  },
  {
    id: 'contract-call-blind-on',
    from: 'tx-steps',
    family: 'transaction',
    hands: 'approve',
    say: `${txLabel('tx-steps', 'The same contract call, blind signing on')} The Ledger warns that it is blind signing: approve it.`,
  },
  {
    id: 'unplug',
    from: 'msg-live-126',
    family: 'message',
    hands: 'unplug',
    say: `${messageLabel('msg-live-126', 'An unplug')} When the Ledger shows it, don't approve or reject it: unplug its USB cable.`,
  },
  {
    cancel: true,
    say: `The cancel case. The recorder starts a message; when the Ledger shows it, leave it there. A few seconds later the recorder cancels it, as Freedom's Cancel does, and starts a new request at once. When told, reject the old message on the Ledger within 15 seconds, then approve the new request.`,
    old: { id: 'cancel-old', from: 'msg-live-275', family: 'message', hands: 'leave' },
    next: { id: 'cancel-new', from: 'msg-live-1', family: 'message', hands: 'reject-old' },
  },
];

const hashOnlySay =
  "A Nano S shows no typed-data fields: it should show two hashes, which the recorder prints first. Check them against the Ledger's and approve if they match (reject if not). If the Ledger shows fields instead, go through them and approve it.";

/** The steps for a Nano S: the hash-only cases. */
const HASH_ONLY_STEPS = [
  {
    id: 'typed-hash-only-mail',
    from: 'typed-hash-only-mail',
    family: 'hash-only',
    hands: 'approve',
    say: `Typed data, the Mail example. ${hashOnlySay}`,
  },
  {
    id: 'typed-hash-only-safe-tx',
    from: 'typed-hash-only-safe-tx',
    family: 'hash-only',
    hands: 'approve',
    say: `Typed data, a Safe transaction (SafeTx). ${hashOnlySay}`,
  },
];

const DISCOVERY = {
  id: 'discovery',
  from: 'discovery-live-0-1',
  family: 'discovery',
  hands: 'none',
};

// ---------------------------------------------------------------------------
// Bytes

const statusOf = (answer) => answer.readUInt16BE(answer.length - 2);
const statusText = (status) => status.toString(16).padStart(4, '0');
const round = (ms, digits = 1) => Number(ms.toFixed(digits));

class UsageError extends Error {}

/** A device answering with another seed's account: stop, record none of it. */
class SeedMismatch extends Error {
  constructor() {
    super("This Ledger's first account isn't the public test phrase's");
    this.name = 'SeedMismatch';
  }
}

/** `B0 01`'s answer: `{ name, version }`, or null for another shape. */
function parseApp(answer) {
  if (answer.length < 5 || statusOf(answer) !== STATUS_OK || answer[0] !== 1) return null;
  const end = answer.length - 2;
  let at = 1;
  const field = () => {
    const n = answer[at];
    if (n === undefined || at + 1 + n > end) return null;
    const value = answer.subarray(at + 1, at + 1 + n).toString('latin1');
    at += 1 + n;
    return value;
  };
  const name = field();
  const version = name === null ? null : field();
  return version === null ? null : { name, version };
}

/** `E0 02`'s answer: `{ key, address }` with the address the key derives, or null. */
function parseAddressAnswer(answer) {
  if (answer.length !== 109 || statusOf(answer) !== STATUS_OK) return null;
  if (answer[0] !== 65 || answer[1] !== 0x04 || answer[66] !== 40) return null;
  const key = `0x${answer.subarray(1, 66).toString('hex')}`;
  const text = answer.subarray(67, 107).toString('latin1');
  if (!/^[0-9a-fA-F]{40}$/.test(text)) return null;
  const address = computeAddress(key);
  return address.slice(2).toLowerCase() === text.toLowerCase() ? { key, address } : null;
}

/** A path's text from `P` (count, then big-endian elements). */
function pathText(p) {
  const elements = [];
  for (let k = 0; k < p[0]; k++) {
    const e = p.readUInt32BE(1 + 4 * k);
    elements.push(e >= 0x80000000 ? `${e - 0x80000000}'` : String(e));
  }
  return elements.join('/');
}

const testRoot = HDNodeWallet.fromPhrase(TEST_PHRASE, '', 'm');
const testAddresses = new Map();

/** The test phrase's address at an `E0 02` APDU's path. */
function testAddressAt(apdu) {
  const text = pathText(apdu.subarray(5));
  if (!testAddresses.has(text)) testAddresses.set(text, testRoot.derivePath(`m/${text}`).address);
  return testAddresses.get(text);
}

/**
 * Every `E0 02` answered `9000` must carry the test phrase's account at its
 * path, checked before anything more is sent; anything else is another seed.
 */
function checkAddressAnswer(apdu, answer) {
  if (apdu[0] !== 0xe0 || apdu[1] !== 0x02 || statusOf(answer) !== STATUS_OK) return;
  const read = parseAddressAnswer(answer);
  if (!read || read.address !== testAddressAt(apdu)) throw new SeedMismatch();
}

// ---------------------------------------------------------------------------
// Signatures, recovered over the core's digest

function recover(digest, yParity, rs) {
  if (yParity !== 0 && yParity !== 1) return null;
  try {
    const signature = Signature.from({
      r: `0x${rs.subarray(0, 32).toString('hex')}`,
      s: `0x${rs.subarray(32, 64).toString('hex')}`,
      yParity,
    });
    return computeAddress(SigningKey.recoverPublicKey(digest, signature));
  } catch {
    return null;
  }
}

/** A type 0's `v` byte holds `chainId'·2 + 35 + parity`, `chainId'` the chain ID's first four bytes. */
function legacyParity(v, chainId) {
  let hex = BigInt(chainId).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const base = (Number(BigInt(`0x${hex.slice(0, 8)}`)) * 2 + 35) % 256;
  return (v - base + 256) % 256;
}

/** The address a step's signature recovers to over the core's digest, or null. */
function signerOf(kase) {
  const last = kase.exchanges.at(-1);
  if (!last?.answer) return null;
  const answer = Buffer.from(last.answer, 'hex');
  if (answer.length !== 67 || statusOf(answer) !== STATUS_OK) return null;
  const v = answer[0];
  const rs = answer.subarray(1, 65);
  const { request } = kase;
  switch (kase.operation) {
    case 'sign.transaction': {
      const digest = keccak256(unsignedTransaction(request.tx));
      const parity = request.tx.type === 0 ? legacyParity(v, request.tx.chain_id) : v;
      return recover(digest, parity, rs);
    }
    case 'sign.message':
      return recover(hashMessage(Buffer.from(request.message.slice(2), 'hex')), v - 27, rs);
    case 'sign.typed_data':
      return recover(request.expected_hash, v - 27, rs);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// One step on the device

/** The request in the core's wire form: `ledger.add` takes `{ scheme, index, name }` (plan point 9). */
function requestOf(source) {
  if (source.operation !== 'ledger.add') return source.request;
  return { ...parsePath(source.request.path), name: source.request.name };
}

/** Main's Admission for a case, and its typed-data binding. */
function admissionFor(source, request) {
  let typedData;
  if (source.operation === 'sign.typed_data') {
    typedData = bindTypedData({
      typedData: request.typed_data,
      expectedHash: request.expected_hash,
    });
    if (typedData.rule) {
      throw new Error(`Main's binding refused a recorder case (${typedData.reason})`);
    }
  }
  const admission = new Admission({
    operation: source.operation,
    params: request,
    path: source.record?.path,
    records: [],
    typedData,
  });
  return { admission, typedData };
}

/** The row and wait of a reference APDU, by its header. */
function referenceRow(apdu) {
  const header = apdu.subarray(0, 4).toString('hex');
  if (header === 'e00c0001') return { row: 'sign.typed_data.sign', waits: true };
  if (header === 'e0020000') return { row: 'signature.first', waits: false };
  if (header === 'b0010000') return { row: 'signature.second', waits: false };
  if (header.startsWith('e01a')) return { row: 'sign.typed_data.definitions', waits: false };
  if (header.startsWith('e01c')) return { row: 'sign.typed_data.values', waits: false };
  throw new Error(`A reference APDU with no row: ${header}`);
}

/**
 * One exchange, timed. The device gets 5 minutes for every APDU (so a held
 * answer is measured, R2) unless `coreDeadlines`, when it gets what the
 * core sends.
 */
async function exchangeOne(ctx, device, apdu, { row, waits }, options) {
  const { signal = null, onWaiting = null, coreDeadlines = false } = options;
  const deadline = waits ? DEADLINE_MS.USER : DEADLINE_MS.DEVICE;
  const started = ctx.now();
  const ex = {
    apdu: apdu.toString('hex'),
    row,
    deadline_ms: deadline,
    at_ms: round(started - ctx.t0),
  };
  const notice =
    waits || coreDeadlines
      ? null
      : setTimeout(
          () =>
            ctx.io.say(
              "The Ledger hasn't answered in 15 seconds (Freedom would give up here, LEDGER_UNRESPONSIVE). Still waiting, up to 5 minutes."
            ),
          ctx.slowNoticeMs
        );
  if (waits && onWaiting) onWaiting();
  try {
    const answer = await device.exchange(apdu, coreDeadlines ? deadline : DEADLINE_MS.USER, signal);
    ex.answer = answer.toString('hex');
  } catch (err) {
    if (!err.failure) throw err;
    if (err.detached) ex.cancelled = true;
    else ex.failed = err.failure;
  } finally {
    clearTimeout(notice);
  }
  ex.ms = round(ctx.now() - started);
  if (!waits && ex.answer !== undefined) ex.held = ex.ms >= ctx.heldMs;
  return ex;
}

/** Shows the hash-only warning's two hashes before the hash-only APDU, as main's surface does. */
function showHashes(ctx, kase, typedData) {
  kase.hashes = {
    domain: `0x${typedData.domainSeparator.toString('hex')}`,
    message: `0x${typedData.structHash.toString('hex')}`,
  };
  ctx.io.say(
    [
      "The Ledger can't show this request's fields (it answered 6D00). It will show two hashes instead:",
      `  Domain hash:  ${typedData.domainSeparator.toString('hex').toUpperCase()}`,
      `  Message hash: ${typedData.structHash.toString('hex').toUpperCase()}`,
      "Check them against the Ledger's: approve on the Ledger if they match, reject if not.",
    ].join('\n')
  );
}

async function playCore(ctx, kase, source, device, options) {
  const { admission, typedData } = admissionFor(source, kase.request);
  for (;;) {
    const apdu = admission.expected[admission.position];
    if (!apdu) return;
    const verdict = admission.admit(apdu);
    if (verdict.rule) throw new Error(`Main's own stream was refused (${verdict.rule})`);
    const ex = await exchangeOne(ctx, device, apdu, verdict, options);
    kase.exchanges.push(ex);
    if (ex.answer === undefined) {
      admission.end();
      return;
    }
    const answer = Buffer.from(ex.answer, 'hex');
    checkAddressAnswer(apdu, answer);
    if (admission.isHashOnlyAnswer(answer)) {
      showHashes(ctx, kase, typedData);
      ex.hash_only = 'shown';
      admission.answered({ answer, hashOnly: true });
      continue;
    }
    admission.answered({ answer });
    if (statusOf(answer) !== STATUS_OK) return;
  }
}

async function playReference(ctx, kase, source, device, options) {
  for (const text of source.apdus) {
    const apdu = Buffer.from(text, 'hex');
    const ex = await exchangeOne(ctx, device, apdu, referenceRow(apdu), options);
    kase.exchanges.push(ex);
    if (ex.answer === undefined) return;
    const answer = Buffer.from(ex.answer, 'hex');
    checkAddressAnswer(apdu, answer);
    if (statusOf(answer) !== STATUS_OK) return;
  }
}

/** Whether a step's outcome is what its hands asked for. */
function asAsked(hands, outcome, complete) {
  const status = outcome.status === undefined ? null : parseInt(outcome.status, 16);
  switch (hands) {
    case 'none':
    case 'approve':
    case 'reject-old':
      return status === STATUS_OK && complete;
    case 'reject':
      return REJECTED.has(status);
    case 'refuse':
      return status !== null && status !== STATUS_OK;
    case 'unplug':
      return outcome.failed === 'disconnected';
    case 'leave':
      return outcome.cancelled === true;
    default:
      return true;
  }
}

/**
 * Plays one step on a fresh HidDevice, as one operation. Throws SeedMismatch
 * before anything more is sent when an `E0 02` answer isn't the test
 * phrase's: the step is then never recorded.
 */
async function playStep(ctx, step, attempt, options = {}) {
  const source = CASES.cases[step.from];
  const kase = {
    id: step.id,
    attempt,
    from: step.from,
    family: step.family,
    operation: source.operation,
    request: requestOf(source),
    ...(source.record ? { record: source.record } : {}),
    stream: source.apdus ? 'reference' : 'core',
    device: ctx.caseDevice,
    hands: step.hands,
    exchanges: [],
  };
  const device = new HidDevice({ host: ctx.host });
  let total;
  try {
    if (source.apdus) {
      total = source.apdus.length;
      await playReference(ctx, kase, source, device, options);
    } else {
      await playCore(ctx, kase, source, device, options);
    }
  } finally {
    device.detach();
  }
  const last = kase.exchanges.at(-1);
  const outcome = last.cancelled
    ? { cancelled: true }
    : last.failed
      ? { failed: last.failed }
      : { status: last.answer.slice(-4) };
  const complete =
    outcome.status === statusText(STATUS_OK) &&
    (total === undefined ? true : kase.exchanges.length === total);
  kase.outcome = { ...outcome, as_asked: asAsked(step.hands, outcome, complete) };
  if (kase.operation === 'ledger.accounts' || kase.operation === 'ledger.add') {
    const read = last.answer && parseAddressAnswer(Buffer.from(last.answer, 'hex'));
    kase.address = read ? read.address : null;
  } else {
    kase.signer = signerOf(kase);
  }
  kase.dropped = device.droppedFrames;
  return kase;
}

// ---------------------------------------------------------------------------
// The session

function describeOutcome(kase) {
  const asked =
    kase.outcome.as_asked && ['reject', 'refuse', 'unplug', 'leave'].includes(kase.hands);
  return `${describeAnswer(kase)}${asked ? ' As this step asked.' : ''}`;
}

function describeAnswer(kase) {
  const { outcome } = kase;
  if (outcome.cancelled) return 'Cancelled by the recorder.';
  if (outcome.failed) {
    const words = {
      not_found: 'no Ledger was found (plug it in and unlock it)',
      busy: 'the Ledger is busy (close Ledger Live and any other wallet)',
      disconnected: 'the Ledger was disconnected',
      unresponsive: 'the Ledger stopped answering',
      timeout: "the Ledger wasn't confirmed in 5 minutes",
    };
    return `Failed: ${words[outcome.failed] ?? outcome.failed}.`;
  }
  const status = parseInt(outcome.status, 16);
  if (status !== STATUS_OK) {
    return `The Ledger answered ${outcome.status.toUpperCase()}: ${mapLedgerError({ statusCode: status }).message}`;
  }
  if (kase.signer !== undefined) {
    return kase.signer === TEST_ADDRESS
      ? 'Signed; the signature recovers to the test account.'
      : "Signed, but the signature doesn't recover to the test account over Freedom's digest (recorded as it is).";
  }
  return `Answered: ${kase.address}.`;
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function stats(values) {
  if (values.length === 0) return { apdus: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    apdus: sorted.length,
    median_ms: percentile(sorted, 0.5),
    p90_ms: percentile(sorted, 0.9),
    max_ms: sorted.at(-1),
  };
}

const deviceExchanges = (cases) =>
  cases.flatMap((c) =>
    c.exchanges.filter((e) => e.deadline_ms === DEADLINE_MS.DEVICE && e.answer !== undefined)
  );

/** R3: the time per APDU that doesn't wait for the user. */
function timingOf(cases) {
  const quick = deviceExchanges(cases).filter((e) => !e.held);
  const byIns = {};
  for (const e of quick) (byIns[e.apdu.slice(0, 4)] ??= []).push(e.ms);
  const all = stats(quick.map((e) => e.ms));
  return {
    ...all,
    by_ins: Object.fromEntries(Object.entries(byIns).map(([ins, ms]) => [ins, stats(ms)])),
    bound: APDUS_PER_OPERATION,
    bound_s:
      all.apdus > 0
        ? {
            median: round((all.median_ms * APDUS_PER_OPERATION) / 1000, 0),
            p90: round((all.p90_ms * APDUS_PER_OPERATION) / 1000, 0),
          }
        : null,
  };
}

/** R2: the APDUs that don't wait for the user but were held, in the approved steps. */
function heldOf(cases, heldMs) {
  const approved = cases.filter((c) => c.hands === 'approve');
  const rows = deviceExchanges(approved);
  const byIns = {};
  for (const e of rows) {
    const entry = (byIns[e.apdu.slice(0, 4)] ??= { apdus: 0, held: 0, slowest_ms: 0 });
    entry.apdus += 1;
    if (e.held) entry.held += 1;
    entry.slowest_ms = Math.max(entry.slowest_ms, e.ms);
  }
  return {
    threshold_ms: heldMs,
    apdus: rows.length,
    held: rows.filter((e) => e.held).length,
    by_ins: byIns,
    steps: [...new Set(approved.filter((c) => c.exchanges.some((e) => e.held)).map((c) => c.id))],
  };
}

function save(ctx, complete) {
  const recording = ctx.recording;
  recording.meta.complete = complete;
  recording.timing = timingOf(recording.cases);
  recording.held = heldOf(recording.cases, ctx.heldMs);
  const partial = `${ctx.out}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(recording, null, 1)}\n`);
  fs.renameSync(partial, ctx.out);
}

function keep(ctx, kase) {
  ctx.recording.cases.push(kase);
  save(ctx, false);
}

async function askYes(ctx, key, text, fallback) {
  const answer = (await ctx.io.ask(key, `${text} ${fallback ? '[Y/n]' : '[y/N]'}`)).trim();
  if (!answer) return fallback;
  return /^y/i.test(answer);
}

/** One operation's B0 01: the app's name and version, or what the user must do. */
async function readApp(ctx) {
  const device = new HidDevice({ host: ctx.host });
  let answer;
  try {
    answer = await device.exchange(B001, DEADLINE_MS.DEVICE);
  } catch (err) {
    if (!err.failure) throw err;
    return {
      problem:
        {
          not_found: 'No Ledger was found: plug it in by USB and unlock it.',
          busy: 'The Ledger is busy: close Ledger Live and any other wallet app.',
        }[err.failure] ?? "The Ledger didn't answer: unplug it, plug it back in and unlock it.",
    };
  } finally {
    device.detach();
  }
  const status = statusOf(answer);
  if (LOCKED.has(status)) return { problem: 'The Ledger is locked: unlock it.' };
  const app = parseApp(answer);
  if (!app || app.name !== 'Ethereum') {
    return {
      problem: `Open the Ethereum app on the Ledger${app ? ` (it shows ${app.name})` : ''}.`,
    };
  }
  return { app, b001: answer.toString('hex') };
}

/**
 * The test phrase's first account, read as discovery reads it. Returns the
 * step (recorded at the start only), or null when the user gave up; throws
 * SeedMismatch for another seed.
 */
async function checkSeed(ctx) {
  for (;;) {
    const kase = await playStep(ctx, DISCOVERY, 1);
    if (kase.address === TEST_ADDRESS) return kase;
    if (!(await askYes(ctx, 'connect', `${describeOutcome(kase)} Try again?`, true))) return null;
  }
}

async function connect(ctx) {
  for (;;) {
    const read = await readApp(ctx);
    if (!read.problem) return read;
    if (!(await askYes(ctx, 'connect', `${read.problem} Try again?`, true))) return null;
  }
}

/** After an unplug: the device back, and the test phrase's again (nothing of it recorded). */
async function replug(ctx) {
  await ctx.io.ask(
    'replugged',
    'Plug the Ledger back in, unlock it and open the Ethereum app. Press Enter when done.'
  );
  if (!(await connect(ctx)) || !(await checkSeed(ctx))) return false;
  ctx.io.say(`The first account is the test phrase's (${TEST_ADDRESS}): going on.`);
  return true;
}

async function runStep(ctx, step, label) {
  for (let attempt = 1; ; attempt++) {
    ctx.io.step({ id: step.id, hands: step.hands, attempt });
    ctx.io.say(`\n${label} ${step.say}`);
    const kase = await playStep(ctx, step, attempt);
    keep(ctx, kase);
    ctx.io.say(describeOutcome(kase));
    if (kase.hashes) {
      kase.hashes.match = await askYes(
        ctx,
        'hashes-match',
        'Did the Ledger show the same two hashes as the recorder?',
        true
      );
      save(ctx, false);
    } else if (step.family === 'hash-only' && kase.outcome.as_asked) {
      ctx.io.say(
        'This Ledger showed the fields: its app reads E0 1A, so it gave no hash-only signature (R9).'
      );
    }
    if (step.hands === 'unplug' && !(await replug(ctx))) return false;
    if (kase.outcome.as_asked) return true;
    if (
      !(await askYes(ctx, 'retry', 'That is not what this step asked for. Try it again?', false))
    ) {
      return true;
    }
  }
}

async function runCancel(ctx, entry, label) {
  for (let attempt = 1; ; attempt++) {
    ctx.io.step({ id: entry.old.id, hands: entry.old.hands, attempt });
    ctx.io.say(`\n${label} ${entry.say}`);
    const controller = new AbortController();
    let timer = null;
    const old = await playStep(ctx, entry.old, attempt, {
      signal: controller.signal,
      onWaiting: () => {
        timer = setTimeout(() => controller.abort(), ctx.cancelAfterMs);
      },
    });
    clearTimeout(timer);
    keep(ctx, old);
    if (old.outcome.cancelled) {
      ctx.io.step({ id: entry.next.id, hands: entry.next.hands, attempt });
      ctx.io.say(
        'The recorder cancelled the old message and started a new request. Reject the old message on the Ledger now; then approve the new request when it shows.'
      );
      const next = await playStep(ctx, entry.next, attempt, { coreDeadlines: true });
      next.after = { id: old.id, attempt };
      keep(ctx, next);
      ctx.io.say(describeOutcome(next));
      if (next.outcome.as_asked) return true;
    } else {
      ctx.io.say(`${describeOutcome(old)} The old message should have stayed on the Ledger.`);
    }
    if (!(await askYes(ctx, 'retry', 'Try the cancel case again?', false))) return true;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (!['--model', '--out', '--firmware'].includes(flag)) {
      throw new UsageError(`Unknown argument: ${argv[i]}`);
    }
    const value = inline ?? argv[++i];
    if (!value) throw new UsageError(`${flag} needs a value`);
    args[flag.slice(2)] = value;
  }
  if (!Object.hasOwn(MODELS, args.model ?? '')) {
    throw new UsageError(`--model is one of ${Object.keys(MODELS).join(', ')}`);
  }
  if (!args.out) throw new UsageError('--out names the file to write');
  return args;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The whole session. `io`: `say(text)`, `ask(key, text)` → the user's line,
 * and `step({ id, hands, attempt })` before each step is played (the
 * simulated hands' cue; nothing for a person). `host`: the HidHost the
 * operations share. Returns the exit code.
 */
async function run(argv, deps) {
  const {
    io: given,
    host,
    now = () => performance.now(),
    heldMs = HELD_MS,
    cancelAfterMs = CANCEL_AFTER_MS,
    slowNoticeMs = SLOW_NOTICE_MS,
  } = deps;
  const io = { step: () => {}, ...given };
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.say(`${err.message}\n${USAGE}`);
    return 2;
  }
  const out = path.resolve(args.out);
  if (fs.existsSync(out)) {
    io.say(`${out} exists: name another --out, or move it away first.`);
    return 2;
  }
  const model = args.model;
  const { what: _what, ...vectors } = CASES.source;
  const ctx = { io, host, now, t0: now(), heldMs, cancelAfterMs, slowNoticeMs, out };

  io.say(
    [
      `Freedom's Ledger recorder (freedom-core design 0016, LDG-3), for a ${MODELS[model]}.`,
      `It plays Freedom's requests on the Ledger and writes every answer, with its timing, to ${out}.`,
      'Use only a Ledger reset to the public test phrase (abandon x11, about) and never funded: the file holds its public keys, addresses and signatures. The recorder checks the first account before it records anything.',
      'Before you start: Ledger Live closed, the Ledger plugged in by USB and unlocked, the Ethereum app open, blind signing off.',
    ].join('\n')
  );
  let firmware = args.firmware;
  while (!firmware) {
    firmware = (
      await io.ask(
        'firmware',
        "Which firmware version does this Ledger run (Ledger Live's My Ledger, or the device's Settings > About)?"
      )
    ).trim();
  }
  await io.ask('start', 'Press Enter to start.');

  const read = await connect(ctx);
  if (!read) {
    io.say('Stopped: nothing was recorded.');
    return 1;
  }
  ctx.caseDevice = { model, firmware, app: read.app };
  ctx.recording = {
    meta: {
      design: '0016, LDG-3',
      recorder: 'freedom-browser scripts/ledger-record.js',
      freedomBrowserCommit: gitCommit(),
      vectors,
      recordedAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? null,
        node: process.versions.node,
      },
      heldMs,
      complete: false,
    },
    formats: FORMATS,
    device: {
      model,
      name: MODELS[model],
      firmware,
      app: read.app,
      b001: read.b001,
      mnemonicId: 'abandon-12',
      account: { path: TEST_PATH, address: TEST_ADDRESS },
    },
    cases: [],
    timing: null,
    held: null,
  };

  const steps = HASH_ONLY_MODELS.has(model) ? HASH_ONLY_STEPS : FIELD_STEPS;
  const total = steps.filter((s) => !s.ask).length;
  try {
    io.say('Reading the first account (nothing shows on the Ledger)…');
    const discovery = await checkSeed(ctx);
    if (!discovery) {
      io.say('Stopped: nothing was recorded.');
      return 1;
    }
    keep(ctx, discovery);
    io.say(`The first account is the test phrase's (${TEST_ADDRESS}).`);
    let n = 0;
    for (const entry of steps) {
      if (entry.ask) {
        await io.ask(entry.ask, entry.say);
        continue;
      }
      n += 1;
      const label = `[${n}/${total}]`;
      const going = entry.cancel
        ? await runCancel(ctx, entry, label)
        : await runStep(ctx, entry, label);
      if (!going) {
        io.say(`Stopped. ${out} keeps the steps recorded so far.`);
        return 1;
      }
    }
  } catch (err) {
    if (!(err instanceof SeedMismatch)) throw err;
    const kept = ctx.recording.cases.length;
    io.say(
      kept === 0
        ? `${err.message}: the recorder runs only on a Ledger reset to the public test phrase (abandon x11, about). Nothing was recorded.`
        : `${err.message}: stopped. ${out} keeps the ${kept} steps recorded before, all from the test phrase; nothing from this device.`
    );
    return 1;
  }
  save(ctx, true);
  const { timing, held } = ctx.recording;
  io.say(
    [
      `\nDone: ${ctx.recording.cases.length} steps recorded in ${out}.`,
      timing.apdus > 0
        ? `R3: ${timing.median_ms} ms per APDU at the median (${timing.p90_ms} ms at the 90th percentile): ${APDUS_PER_OPERATION} APDUs would take about ${timing.bound_s.median} s (${timing.bound_s.p90} s).`
        : 'R3: no APDU timed.',
      `R2: ${held.held} of ${held.apdus} APDUs that don't wait for the user were answered only after ${heldMs} ms or more${held.steps.length ? ` (in ${held.steps.join(', ')})` : ''}.`,
      "Send the file on: it holds only the test phrase's public keys, addresses and signatures.",
    ].join('\n')
  );
  return 0;
}

class InputClosed extends Error {}

/**
 * A person at the terminal. Lines are queued as they come, so typed-ahead
 * or piped answers aren't lost; once the input ends, every question fails
 * with InputClosed.
 */
function terminalIo() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on('line', (line) => (waiting.length ? waiting.shift().resolve(line) : lines.push(line)));
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w.reject(new InputClosed());
  });
  return {
    say: (text) => console.log(text),
    ask: (_key, text) => {
      if (closed) {
        process.stdout.write(`${text} `);
      } else {
        rl.setPrompt(`${text} `);
        rl.prompt();
      }
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.reject(new InputClosed());
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    onInterrupt: (fn) => {
      rl.on('SIGINT', fn);
      process.on('SIGINT', fn);
    },
    close: () => rl.close(),
  };
}

async function main(argv) {
  if (!process.versions.electron) {
    console.error(
      `node-hid is built for Electron: run the recorder under Electron's Node.\n${USAGE}`
    );
    return 2;
  }
  const io = terminalIo();
  const host = new HidHost({ idleMs: null });
  const stop = () => {
    host.kill();
    io.close();
  };
  io.onInterrupt(() => {
    console.log('\nStopped. The file keeps the steps recorded so far.');
    stop();
    process.exit(130);
  });
  try {
    return await run(argv, { io, host });
  } catch (err) {
    if (!(err instanceof InputClosed)) throw err;
    console.log('\nStopped: the input ended. The file, if any, keeps the steps recorded so far.');
    return 1;
  } finally {
    stop();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = {
  FIELD_STEPS,
  HASH_ONLY_STEPS,
  MODELS,
  TEST_ADDRESS,
  TEST_PATH,
  TEST_PHRASE,
  parseAddressAnswer,
  run,
};
