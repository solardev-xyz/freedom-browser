/**
 * A Ledger behind a fake node-hid (fake-node-hid.js) that answers from
 * freedom-core's `vectors/ledger.json` (design 0016, Vectors): the JS
 * reference's recorded exchanges, from a device holding the public test
 * phrase (`abandon` ×11, `about`). For LDG-3's gates against the real
 * freedom-cored (the LDG-3 plan's PR 12).
 *
 * `play(id)` loads one case's recording: each APDU the device is sent is
 * answered with the answer recorded for that very APDU, byte for byte (in
 * order, when one APDU was recorded more than once with different answers).
 * Two of the core's APDUs have no verbatim recording, because the core
 * reads the device where the reference didn't (ledger.json's deviations),
 * and are answered from what the device answered the reference instead:
 * - `B0 01 00 00 00` before a transaction or a message (deviation
 *   `app-check`: the reference read it only for typed data): the app's
 *   answer the vectors recorded for a case on the same app;
 * - `E0 02 01 00 P` for `ledger.add` (deviation `address-from-device`: the
 *   reference read the address with the display off, `E0 02 00 00 P`): the
 *   answer recorded for that path, since the Ethereum app answers both
 *   forms with the same bytes (the flag only shows the address on screen).
 * Both are listed in `translated`. Any other APDU no recording holds is
 * listed in `unrecorded` and answered `6F00`, which ends the operation, so
 * a gate that checks `unrecorded` is empty fails on any byte the core sends
 * that the reference's device never saw.
 *
 * `play(id, { sign })` is for a case whose typed data the core builds
 * afresh (x402: the core's own nonce and main's clock, so the values and
 * the signature can't be the recording's). `E0 0C 00 01` (its data only
 * the path, as the recording's) is answered with a signature over
 * `sign()`, the digest the device would compute, by the phrase's key at
 * the case's path, as ledger.json's `formats.device` says the reference's
 * scripted device signed; any other APDU the recording holds is answered
 * from it, and an `E0 1A` or `E0 1C` it doesn't with `9000`, as that
 * device did. Those the rule answered are listed in `ruled`.
 *
 * `hold(predicate)` makes the device wait for the user at the first APDU
 * the predicate takes (`fake.ledger.release(answer)` answers it later);
 * `asked` is every APDU the device was sent since `play`, in hex.
 */

const { HDNodeWallet, Signature } = require('ethers');

// keys.json's `abandon-12`: the phrase ledger.json's device holds. Public,
// never funded.
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const APP_CHECK = 'b001000000';
const INS_NOT_SUPPORTED = '6f00';

const isTypedField = (hex) => hex.startsWith('e01a') || hex.startsWith('e01c');
const isTypedSign = (hex) => hex.startsWith('e00c0001');
// `E0 02 01 00 P` (display on) as the reference sent it: `E0 02 00 00 P`.
const displayOff = (hex) => (hex.startsWith('e0020100') ? `e0020000${hex.slice(8)}` : null);

/** A vectors file's case by its ID; throws if it isn't there. */
function caseOf(ledger, id) {
  const found = ledger.cases.find((c) => c.id === id);
  if (!found) throw new Error(`ledger.json has no case ${id}`);
  return found;
}

/** The app's answer to `B0 01` the vectors recorded on `app` (a case's `device.app`). */
function recordedAppAnswer(ledger, app) {
  for (const c of ledger.cases) {
    if (c.device?.app?.name !== app.name || c.device?.app?.version !== app.version) continue;
    const exchange = c.exchanges.find((e) => e.apdu === APP_CHECK && typeof e.answer === 'string');
    if (exchange) return exchange.answer;
  }
  throw new Error(`ledger.json recorded no B0 01 answer for ${app.name} ${app.version}`);
}

/** The phrase's key at a case's path, as the reference's device holds it. */
function deviceKey(path) {
  return HDNodeWallet.fromPhrase(ABANDON, undefined, `m/${path}`);
}

/** The Ethereum app's answer to `E0 0C 00 01`: v (27 + parity) ‖ r ‖ s ‖ 9000. */
function typedSignatureAnswer(key, digest) {
  const sig = Signature.from(key.signingKey.sign(digest));
  return (27 + sig.yParity).toString(16) + sig.r.slice(2) + sig.s.slice(2) + '9000';
}

/**
 * The reference device on `fake` (createFakeNodeHid()), answering from
 * `ledger` (ledger.json, parsed).
 */
function referenceLedger(fake, ledger) {
  const state = {
    case: null,
    answers: new Map(),
    sign: null,
    hold: null,
    asked: [],
    translated: [],
    ruled: [],
    unrecorded: [],
  };

  function recorded(hex) {
    const queue = state.answers.get(hex);
    if (!queue) return undefined;
    return queue.length > 1 ? queue.shift() : queue[0];
  }

  fake.ledger.respond = (apdu) => {
    const hex = Buffer.from(apdu).toString('hex');
    state.asked.push(hex);
    if (state.hold?.(hex)) {
      state.hold = null;
      return { hold: true };
    }
    // The signature APDU carries only the path, as the recording's does,
    // but what the device signs is the core's typed data, not the case's.
    if (state.sign && isTypedSign(hex)) {
      state.ruled.push(hex);
      return { answer: typedSignatureAnswer(deviceKey(state.case.record.path), state.sign()) };
    }
    const verbatim = recorded(hex);
    if (verbatim !== undefined) return { answer: verbatim };
    if (hex === APP_CHECK) {
      state.translated.push({ apdu: hex, from: 'the app check recorded on the same app' });
      return { answer: recordedAppAnswer(ledger, state.case.device.app) };
    }
    const off = displayOff(hex);
    const offAnswer = off ? recorded(off) : undefined;
    if (offAnswer !== undefined) {
      state.translated.push({ apdu: hex, from: off });
      return { answer: offAnswer };
    }
    if (state.sign && isTypedField(hex)) {
      state.ruled.push(hex);
      return { answer: '9000' };
    }
    state.unrecorded.push(hex);
    return { answer: INS_NOT_SUPPORTED };
  };

  return {
    /** Loads a case's recording; `sign` for a case the core builds afresh (above). */
    play(id, { sign = null } = {}) {
      const c = caseOf(ledger, id);
      state.case = c;
      state.answers = new Map();
      for (const exchange of c.exchanges) {
        if (typeof exchange.answer !== 'string') continue;
        if (!state.answers.has(exchange.apdu)) state.answers.set(exchange.apdu, []);
        state.answers.get(exchange.apdu).push(exchange.answer);
      }
      state.sign = sign;
      state.hold = null;
      state.asked = [];
      state.translated = [];
      state.ruled = [];
      state.unrecorded = [];
      return c;
    },
    /** The device waits for the user at the first APDU `predicate(hex)` takes. */
    hold(predicate) {
      state.hold = predicate;
    },
    get asked() {
      return state.asked;
    },
    get translated() {
      return state.translated;
    },
    get ruled() {
      return state.ruled;
    },
    get unrecorded() {
      return state.unrecorded;
    },
  };
}

module.exports = { ABANDON, caseOf, deviceKey, referenceLedger };
