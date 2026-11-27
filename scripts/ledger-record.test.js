/**
 * scripts/ledger-record.js, the recorder of a real Ledger's answers (LDG-3
 * PR 13), driven whole against the fake node-hid: a scripted Ethereum app
 * holding the test phrase, and simulated hands that do what each step asks
 * (approve, reject, unplug, leave a prompt, turn blind signing on). The
 * file it writes is checked as freedom-core's replay test (C1) will read
 * it: each step's request is ledger.json's, its APDUs are the core's (main's
 * stream, and with the vectors ledger-grammar.json's honest one; the
 * reference's for F-2's names), and each signature recovers to the test
 * account over the core's own digest. Then the safety checks: a Ledger with
 * another seed records nothing, and one swapped in at a replug stops the
 * session with none of its answers written.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HDNodeWallet,
  Signature,
  SigningKey,
  Transaction,
  TypedDataEncoder,
  computeAddress,
  concat,
  decodeRlp,
  hashMessage,
  keccak256,
} = require('ethers');
const { HidHost } = require('../src/main/wallet/ledger/hid-device');
const { Admission, parsePath } = require('../src/main/core/ledger-grammar');
const { bindTypedData } = require('../src/main/wallet/ledger/apdu-binding');
const { createFakeNodeHid, inProcessHosts, APP_ANSWER } = require('../test/helpers/fake-node-hid');
const { ledgerVectors, ledgerVectorsRequired } = require('../test/helpers/ledger-vectors');
const recorder = require('./ledger-record');
const CASES = require('./ledger-record-cases.json');

const { TEST_PHRASE, TEST_PATH, TEST_ADDRESS, MODELS, FIELD_STEPS, HASH_ONLY_STEPS } = recorder;
const OTHER_PHRASE = 'test test test test test test test test test test test junk';
const FIRMWARE = '2.4.1';
const HELD_MS = 80;
// The simulated user's time on each of the Mail's values (R2).
const SCROLL_MS = 120;
const HEX = /^(?:[0-9a-f]{2})+$/;

const FIELD_IDS = [
  'discovery',
  'tx-type0',
  'tx-type2',
  'message',
  'typed-mail',
  'typed-safe-tx',
  'typed-eip3009',
  'name-field-ascii-253',
  'name-primary-type-ascii-255',
  'name-field-e-acute-252',
  'name-field-e-acute-253',
  'name-field-emoji-252',
  'name-field-emoji-253',
  'add',
  'reject',
  'contract-call-blind-off',
  'contract-call-blind-on',
  'unplug',
  'cancel-old',
  'cancel-new',
];

const hex = (bytes) => Buffer.from(bytes).toString('hex');

function decodePath(data) {
  const elements = [];
  for (let k = 0; k < data[0]; k++) elements.push(data.readUInt32BE(1 + 4 * k));
  return { elements, length: 1 + 4 * data[0] };
}

const pathOf = (elements) =>
  'm/' + elements.map((e) => (e >= 0x80000000 ? `${e - 0x80000000}'` : String(e))).join('/');

/** The total length of the RLP list at the head of `bytes`, or null while its header is short. */
function rlpLength(bytes) {
  if (bytes.length === 0) return null;
  const b = bytes[0];
  if (b <= 0xf7) return 1 + (b - 0xc0);
  const width = b - 0xf7;
  if (bytes.length < 1 + width) return null;
  return 1 + width + Number(BigInt(`0x${hex(bytes.subarray(1, 1 + width))}`));
}

/** Each typed-data stream a step sends, as the device would hash it: its definitions and values → the digest. */
function typedDigests() {
  const digests = new Map();
  for (const source of Object.values(CASES.cases)) {
    if (source.operation !== 'sign.typed_data') continue;
    const { typed_data: typedData, expected_hash: expectedHash } = source.request;
    const body = source.apdus
      ? source.apdus.slice(2, -1)
      : bindTypedData({ typedData, expectedHash }).apdus.map(hex);
    digests.set(body.join(''), expectedHash);
  }
  return digests;
}

/**
 * The Ethereum app behind the fake node-hid, as a real one answers: `E0 02`
 * with the phrase's key and address at the path, `B0 01` with the app,
 * transactions and messages signed over their hashes once whole, typed data
 * signed over its digest (`fields: false`, a Nano S: `6D00` to `E0 1A` and
 * `E0 1C`, and the hash-only APDU signed over its two hashes). What it does
 * at a prompt is the step's hands: approve, reject, unplug, or leave it on
 * screen; a request on another channel while a prompt shows waits until the
 * hands reject the old prompt (`reject-old`). With blind signing off, a
 * transaction with data is refused `6A80`.
 */
function scriptedLedger(fake, { fields = true } = {}) {
  const digests = typedDigests();
  const state = { step: null, hands: 'none', blind: false };
  let root;

  function reset() {
    Object.assign(state, { tx: null, msg: null, typed: [], prompt: null, queued: [] });
  }
  function setPhrase(phrase) {
    root = HDNodeWallet.fromPhrase(phrase, '', 'm');
  }
  reset();
  setPhrase(TEST_PHRASE);

  const keyAt = (elements) => root.derivePath(pathOf(elements)).signingKey;
  const reply = (channel, answer, ms = 2) =>
    setTimeout(() => fake.ledger.answerOn(channel, Buffer.from(answer, 'hex')), ms);

  function signed(elements, digest, v) {
    const sig = keyAt(elements).sign(digest);
    return Buffer.concat([
      Buffer.from([v(sig.yParity)]),
      Buffer.from(sig.r.slice(2), 'hex'),
      Buffer.from(sig.s.slice(2), 'hex'),
      Buffer.from('9000', 'hex'),
    ]).toString('hex');
  }

  function address(data) {
    const key = keyAt(decodePath(data).elements);
    const pub = Buffer.from(SigningKey.computePublicKey(key.publicKey, false).slice(2), 'hex');
    const text = Buffer.from(computeAddress(key.publicKey).slice(2), 'latin1');
    return Buffer.concat([
      Buffer.from([65]),
      pub,
      Buffer.from([40]),
      text,
      Buffer.from('9000', 'hex'),
    ]).toString('hex');
  }

  // The device waits for the user.
  function prompt(channel, answer) {
    if (state.hands === 'reject') return reply(channel, '6985', 5);
    if (state.hands === 'unplug') return setTimeout(() => fake.unplug(), 10);
    if (state.hands === 'leave') {
      state.prompt = { channel };
      return null;
    }
    return reply(channel, answer(), 5);
  }

  function transaction(p1, data, channel) {
    if (p1 === 0x00) {
      const p = decodePath(data);
      state.tx = { elements: p.elements, bytes: data.subarray(p.length) };
    } else {
      state.tx.bytes = Buffer.concat([state.tx.bytes, data]);
    }
    const t = state.tx.bytes;
    const typed = t[0] < 0x80;
    const body = typed ? t.subarray(1) : t;
    const total = rlpLength(body);
    if (total === null || body.length < total) return reply(channel, '9000');
    const items = decodeRlp(body);
    if ((typed ? items[7] : items[5]) !== '0x' && !state.blind) return reply(channel, '6a80');
    const { elements } = state.tx;
    state.tx = null;
    const chainPrime = Number(BigInt(`0x${items[6].slice(2, 10) || '0'}`));
    return prompt(channel, () =>
      signed(elements, keccak256(t), (parity) =>
        typed ? parity : (chainPrime * 2 + 35 + parity) & 0xff
      )
    );
  }

  function message(p1, data, channel) {
    if (p1 === 0x00) {
      const p = decodePath(data);
      state.msg = {
        elements: p.elements,
        length: data.readUInt32BE(p.length),
        bytes: data.subarray(p.length + 4),
      };
    } else {
      state.msg.bytes = Buffer.concat([state.msg.bytes, data]);
    }
    if (state.msg.bytes.length < state.msg.length) return reply(channel, '9000');
    const { elements, bytes } = state.msg;
    state.msg = null;
    return prompt(channel, () => signed(elements, hashMessage(bytes), (parity) => 27 + parity));
  }

  function handle(apdu, channel) {
    const [cla, ins, p1, p2] = apdu;
    const data = apdu.subarray(5);
    if (cla === 0xb0 && ins === 0x01) return reply(channel, APP_ANSWER);
    if (ins === 0x02) {
      state.typed = [];
      if (p1 === 0x01) return prompt(channel, () => address(data));
      return reply(channel, address(data));
    }
    if (ins === 0x04) return transaction(p1, data, channel);
    if (ins === 0x08) return message(p1, data, channel);
    if (ins === 0x1a || ins === 0x1c) {
      if (!fields) return reply(channel, '6d00');
      state.typed.push(hex(apdu));
      const value = ins === 0x1c && p1 === 0x00 && p2 === 0xff;
      return reply(channel, '9000', value && state.step === 'typed-mail' ? SCROLL_MS : 2);
    }
    if (ins === 0x0c) {
      const p = decodePath(data);
      const digest =
        p2 === 0x01
          ? digests.get(state.typed.join(''))
          : keccak256(concat(['0x1901', data.subarray(p.length)]));
      if (!digest) return reply(channel, '6a80');
      return prompt(channel, () => signed(p.elements, digest, (parity) => 27 + parity));
    }
    return reply(channel, '6d00');
  }

  fake.ledger.respond = (apdu, { channel }) => {
    if (state.prompt && state.prompt.channel !== channel) {
      // The device still shows an older request.
      state.queued.push({ apdu, channel });
      if (state.hands === 'reject-old' && state.queued.length === 1) {
        setTimeout(() => {
          const old = state.prompt;
          state.prompt = null;
          fake.ledger.answerOn(old.channel, Buffer.from('6985', 'hex'));
          for (const queued of state.queued.splice(0)) handle(queued.apdu, queued.channel);
        }, 20);
      }
    } else {
      handle(apdu, channel);
    }
    return { hold: true };
  };

  return { state, reset, setPhrase };
}

/** Hands that do what each step asks, and the answers a person types. */
function simulatedHands(ledger, fake, { onReplug = () => {} } = {}) {
  const said = [];
  const asked = [];
  return {
    said,
    asked,
    say: (text) => said.push(text),
    ask: async (key) => {
      asked.push(key);
      if (key === 'firmware') return FIRMWARE;
      if (key === 'blind-on') ledger.state.blind = true;
      if (key === 'replugged') {
        onReplug();
        ledger.reset();
        fake.plug();
      }
      if (key === 'hashes-match') return 'y';
      if (key === 'retry' || key === 'connect') return 'n';
      return '';
    },
    step: ({ id, hands }) => Object.assign(ledger.state, { step: id, hands }),
  };
}

let dir;
let host;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-record-'));
});

afterEach(() => {
  host?.kill();
  host = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The recorder, run whole against a scripted Ledger. */
async function record(model, { fields = true, phrase = TEST_PHRASE, onReplug, args = [] } = {}) {
  const fake = createFakeNodeHid();
  const ledger = scriptedLedger(fake, { fields });
  ledger.setPhrase(phrase);
  const hands = simulatedHands(ledger, fake, {
    onReplug: () => onReplug?.(ledger),
  });
  host = new HidHost({ launch: inProcessHosts(fake), idleMs: null });
  const out = path.join(dir, `ledger-devices-${model}.json`);
  const code = await recorder.run(['--model', model, '--out', out, ...args], {
    io: hands,
    host,
    heldMs: HELD_MS,
    cancelAfterMs: 30,
  });
  expect(fake.violations).toEqual([]);
  return { code, out, hands, fake };
}

// ---------------------------------------------------------------------------
// What C1 will read

/** Main's stream for a step, built here from its request: the APDUs and whether each waits. */
function mainStream(c) {
  const source = CASES.cases[c.from];
  if (source.apdus) {
    return source.apdus.map((apdu) => ({ apdu, waits: apdu.startsWith('e00c0001') }));
  }
  let typedData;
  if (c.operation === 'sign.typed_data') {
    typedData = bindTypedData({
      typedData: c.request.typed_data,
      expectedHash: c.request.expected_hash,
    });
  }
  const admission = new Admission({
    operation: c.operation,
    params: c.request,
    path: c.record?.path,
    records: [],
    typedData,
  });
  let slots = admission.slots;
  if (c.exchanges.some((e) => e.hash_only === 'shown')) {
    slots = [...slots.slice(0, 3), admission.hashOnlySlot];
  }
  return slots.map((s) => ({ apdu: hex(s.apdu), waits: s.waits }));
}

/** The core's digest of a step's request, computed here, not by the recorder. */
function coreDigest(c) {
  const { request } = c;
  if (c.operation === 'sign.message')
    return hashMessage(Buffer.from(request.message.slice(2), 'hex'));
  if (c.operation === 'sign.typed_data') {
    const { domain, types, message } = request.typed_data;
    return TypedDataEncoder.hash(domain, types, message);
  }
  const { tx } = request;
  return Transaction.from({
    type: tx.type,
    chainId: BigInt(tx.chain_id),
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gas_limit),
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
    ...(tx.type === 0
      ? { gasPrice: BigInt(tx.gas_price) }
      : {
          maxFeePerGas: BigInt(tx.max_fee_per_gas),
          maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
        }),
  }).unsignedHash;
}

/** The address a step's last answer, `v ‖ r ‖ s ‖ 9000`, recovers to over the core's digest. */
function recovered(c) {
  const answer = Buffer.from(c.exchanges.at(-1).answer, 'hex');
  const v = answer[0];
  let yParity = v - 27;
  if (c.operation === 'sign.transaction') {
    const { tx } = c.request;
    yParity = tx.type === 2 ? v : v - (Number(tx.chain_id) * 2 + 35);
  }
  const signature = Signature.from({
    r: `0x${hex(answer.subarray(1, 33))}`,
    s: `0x${hex(answer.subarray(33, 65))}`,
    yParity,
  });
  return computeAddress(SigningKey.recoverPublicKey(coreDigest(c), signature));
}

/** The file as C1 reads it: every step replayable against the core. */
function expectReplayable(recording, { model, firmware = FIRMWARE }) {
  expect(Object.keys(recording)).toEqual(['meta', 'formats', 'device', 'cases', 'timing', 'held']);
  expect(recording.meta).toMatchObject({
    design: '0016, LDG-3',
    vectors: {
      repo: 'solardev-xyz/freedom-core',
      commit: 'b4e0cef4f24f4e80aaa9df6568c7c9737ade9589',
      release: 'cored-v0.30.0',
      file: 'vectors/ledger.json',
    },
    heldMs: HELD_MS,
    complete: true,
  });
  const app = { name: 'Ethereum', version: '1.13.0' };
  expect(recording.device).toEqual({
    model,
    name: MODELS[model],
    firmware,
    app,
    b001: APP_ANSWER,
    mnemonicId: 'abandon-12',
    account: { path: TEST_PATH, address: TEST_ADDRESS },
  });

  const grammar = ledgerVectors('ledger-grammar.json');
  const ledger = ledgerVectors('ledger.json');
  const honest = new Map(grammar?.honest.map((h) => [h.case, h.apdus]));
  const recorded = new Map(ledger?.cases.map((c) => [c.id, c]));
  let at = 0;
  for (const c of recording.cases) {
    const source = CASES.cases[c.from];
    expect(c.device).toEqual({ model, firmware, app });
    expect(c.operation).toBe(source.operation);
    expect(c.request).toEqual(
      c.operation === 'ledger.add'
        ? { ...parsePath(source.request.path), name: source.request.name }
        : source.request
    );
    expect(c.record).toEqual(source.record);
    expect(c.stream).toBe(source.apdus ? 'reference' : 'core');
    expect(c.exchanges.length).toBeGreaterThan(0);

    const stream = mainStream(c);
    c.exchanges.forEach((e, k) => {
      const bytes = Buffer.from(e.apdu, 'hex');
      expect(e.apdu).toMatch(HEX);
      expect(bytes.length).toBeGreaterThanOrEqual(5);
      expect(bytes.length).toBeLessThanOrEqual(260);
      expect(bytes[4]).toBe(bytes.length - 5);
      // The APDUs are the core's (main's own stream, the joint contract).
      expect(e.apdu).toBe(stream[k].apdu);
      expect(e.deadline_ms).toBe(stream[k].waits ? 300_000 : 15_000);
      const ends = ['answer', 'failed', 'cancelled'].filter((key) => key in e);
      expect(ends).toHaveLength(1);
      if ('answer' in e) {
        expect(e.answer).toMatch(HEX);
        expect(e.answer.length / 2).toBeGreaterThanOrEqual(2);
        expect(e.answer.length / 2).toBeLessThanOrEqual(260);
        expect('held' in e).toBe(!stream[k].waits);
        // Only the last answer may end the step.
        if (k < c.exchanges.length - 1) {
          expect(e.answer.endsWith('9000') || e.hash_only === 'shown').toBe(true);
        }
      } else {
        expect(k).toBe(c.exchanges.length - 1);
      }
      if ('failed' in e) {
        expect(['not_found', 'busy', 'disconnected', 'unresponsive', 'timeout']).toContain(
          e.failed
        );
      }
      if ('cancelled' in e) expect(e.cancelled).toBe(true);
      expect(e.ms).toBeGreaterThanOrEqual(0);
      expect(e.at_ms).toBeGreaterThanOrEqual(at);
      at = e.at_ms;
    });
    // With the vectors: ledger-grammar.json's honest stream, or ledger.json's reference APDUs.
    if (grammar && c.stream === 'core') {
      expect(c.exchanges.map((e) => e.apdu)).toEqual(
        honest.get(c.from).slice(0, c.exchanges.length)
      );
    }
    if (ledger && c.stream === 'reference') {
      expect(c.exchanges.map((e) => e.apdu)).toEqual(
        recorded
          .get(c.from)
          .exchanges.map((e) => e.apdu)
          .slice(0, c.exchanges.length)
      );
    }

    expect(c.outcome.as_asked).toBe(true);
    if (c.operation === 'ledger.accounts' || c.operation === 'ledger.add') {
      expect(c.address).toBe(TEST_ADDRESS);
    } else if (c.outcome.status === '9000') {
      // Each signature recovers to the test account over the core's own digest.
      expect(recovered(c)).toBe(TEST_ADDRESS);
      expect(c.signer).toBe(TEST_ADDRESS);
    }
    expect(Number.isInteger(c.dropped)).toBe(true);
  }
}

describe('the recorder against the fake node-hid, with simulated hands', () => {
  test('the test phrase gives the first account the recorder expects (keys.json abandon-12)', () => {
    expect(HDNodeWallet.fromPhrase(TEST_PHRASE, '', `m/${TEST_PATH}`).address).toBe(TEST_ADDRESS);
  });

  test('a Nano S Plus: every step of the device session, replayable by the core', async () => {
    const { code, out, hands } = await record('nanoSP');
    expect(code).toBe(0);
    const recording = JSON.parse(fs.readFileSync(out, 'utf8'));
    expectReplayable(recording, { model: 'nanoSP' });
    expect(recording.cases.map((c) => `${c.id}#${c.attempt}`)).toEqual(
      FIELD_IDS.map((id) => `${id}#1`)
    );
    expect(hands.asked).toEqual(['firmware', 'start', 'blind-on', 'replugged']);
    for (const step of FIELD_STEPS.filter((s) => !s.ask)) {
      expect(hands.said.join('\n')).toContain(step.say);
    }

    const byId = new Map(recording.cases.map((c) => [c.id, c]));
    const outcome = (id) => byId.get(id).outcome;
    expect(outcome('reject')).toEqual({ status: '6985', as_asked: true });
    expect(outcome('contract-call-blind-off')).toEqual({ status: '6a80', as_asked: true });
    expect(outcome('contract-call-blind-on')).toEqual({ status: '9000', as_asked: true });
    expect(outcome('unplug')).toEqual({ failed: 'disconnected', as_asked: true });
    for (const id of FIELD_IDS.filter((i) => i.startsWith('name-field-e') || i.includes('emoji'))) {
      expect(byId.get(id).stream).toBe('reference');
    }

    // The cancel case: the old request cancelled at its prompt, the new one
    // started at once under the core's deadlines, answered once the old
    // prompt was rejected, whose late answer the host dropped.
    const old = byId.get('cancel-old');
    const next = byId.get('cancel-new');
    expect(old.outcome).toEqual({ cancelled: true, as_asked: true });
    expect(old.exchanges.at(-1)).toMatchObject({ cancelled: true, deadline_ms: 300_000 });
    expect(next.after).toEqual({ id: 'cancel-old', attempt: 1 });
    expect(next.outcome).toEqual({ status: '9000', as_asked: true });
    expect(next.exchanges[0].ms).toBeGreaterThanOrEqual(15);
    expect(next.dropped).toBe(1);

    // R2: the Mail's values waited for the user, and were counted.
    const mailValues = byId
      .get('typed-mail')
      .exchanges.filter((e) => e.apdu.startsWith('e01c00ff'));
    expect(mailValues.length).toBe(9);
    expect(mailValues.every((e) => e.held && e.ms >= SCROLL_MS - 1)).toBe(true);
    expect(recording.held).toMatchObject({
      threshold_ms: HELD_MS,
      steps: expect.arrayContaining(['typed-mail']),
    });
    expect(recording.held.held).toBeGreaterThanOrEqual(9);
    expect(recording.held.by_ins.e01c.held).toBeGreaterThanOrEqual(9);
    // R3: the time per APDU, and the 2,048 bound at that pace.
    expect(recording.timing).toMatchObject({
      bound: 2048,
      by_ins: expect.objectContaining({ e01a: expect.any(Object) }),
    });
    expect(recording.timing.apdus).toBeGreaterThan(100);
    expect(recording.timing.median_ms).toBeLessThan(HELD_MS);
    expect(recording.timing.bound_s.median).toBeGreaterThanOrEqual(0);
  }, 60_000);

  test('a Nano S: the hash-only cases, its two hashes shown first and checked by the user', async () => {
    const { code, out, hands } = await record('nanoS', {
      fields: false,
      args: ['--firmware', '2.1.0'],
    });
    expect(code).toBe(0);
    const recording = JSON.parse(fs.readFileSync(out, 'utf8'));
    expectReplayable(recording, { model: 'nanoS', firmware: '2.1.0' });
    expect(recording.cases.map((c) => c.id)).toEqual([
      'discovery',
      ...HASH_ONLY_STEPS.map((s) => s.id),
    ]);
    expect(hands.asked).toEqual(['start', 'hashes-match', 'hashes-match']);
    for (const c of recording.cases.slice(1)) {
      const { domain, types, message } = c.request.typed_data;
      expect(c.exchanges[2]).toMatchObject({ answer: '6d00', hash_only: 'shown' });
      expect(c.exchanges.at(-1).apdu.startsWith('e00c0000')).toBe(true);
      expect(c.hashes).toEqual({
        domain: TypedDataEncoder.hashDomain(domain),
        message: TypedDataEncoder.from(types).hash(message),
        match: true,
      });
      const shown = [c.hashes.domain, c.hashes.message].map((h) => h.slice(2).toUpperCase());
      expect(hands.said.some((text) => shown.every((h) => text.includes(h)))).toBe(true);
    }
  }, 60_000);
});

describe('the recorder records nothing from a seed other than the test phrase', () => {
  test('a Ledger with another seed: refused before any step, no file written', async () => {
    const { code, out, hands } = await record('nanoX', { phrase: OTHER_PHRASE });
    expect(code).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.partial`)).toBe(false);
    expect(hands.said.join('\n')).toContain(
      "This Ledger's first account isn't the public test phrase's"
    );
    expect(hands.said.join('\n')).toContain('Nothing was recorded.');
  }, 60_000);

  test('another seed swapped in at the replug: the session stops, none of its answers written', async () => {
    const other = HDNodeWallet.fromPhrase(OTHER_PHRASE, '', `m/${TEST_PATH}`);
    const { code, out } = await record('stax', {
      onReplug: (ledger) => ledger.setPhrase(OTHER_PHRASE),
    });
    expect(code).toBe(1);
    const text = fs.readFileSync(out, 'utf8');
    const recording = JSON.parse(text);
    expect(recording.meta.complete).toBe(false);
    expect(recording.cases.map((c) => c.id)).toEqual(
      FIELD_IDS.slice(0, FIELD_IDS.indexOf('unplug') + 1)
    );
    const otherKey = SigningKey.computePublicKey(other.publicKey, false).slice(2);
    expect(text.toLowerCase()).not.toContain(other.address.slice(2).toLowerCase());
    expect(text.toLowerCase()).not.toContain(otherKey.slice(2, 66));
  }, 60_000);

  test('an existing file is never written over, and a bad model is refused', async () => {
    const out = path.join(dir, 'kept.json');
    fs.writeFileSync(out, 'kept');
    const said = [];
    const io = { say: (text) => said.push(text), ask: async () => '' };
    expect(await recorder.run(['--model', 'nanoSP', '--out', out], { io, host: null })).toBe(2);
    expect(fs.readFileSync(out, 'utf8')).toBe('kept');
    expect(
      await recorder.run(['--model', 'nanoZ', '--out', path.join(dir, 'x.json')], { io })
    ).toBe(2);
    expect(said.join('\n')).toContain('--model is one of nanoSP, nanoX, stax, flex, nanoS');
    expect(fs.existsSync(path.join(dir, 'x.json'))).toBe(false);
  });
});

const ledgerJson = ledgerVectors('ledger.json');
const describeVectors =
  ledgerJson || ledgerVectorsRequired
    ? describe
    : (name, fn) => describe.skip(`${name} (skipped: no freedom-core vectors)`, fn);

describeVectors("the recorder's cases are ledger.json's at the core's release", () => {
  test('each case: its operation, request and record, and the reference APDUs, byte for byte', () => {
    expect(ledgerJson).not.toBeNull();
    const byId = new Map(ledgerJson.cases.map((c) => [c.id, c]));
    for (const [id, entry] of Object.entries(CASES.cases)) {
      const c = byId.get(id);
      expect({
        id,
        operation: entry.operation,
        request: entry.request,
        record: entry.record,
      }).toEqual({
        id,
        operation: c.operation,
        request: c.request,
        record: c.record,
      });
      if (entry.apdus) {
        expect(entry.deviation).toBe(c.deviation);
        expect(entry.apdus).toEqual(c.exchanges.map((e) => e.apdu));
      }
    }
  });
});
