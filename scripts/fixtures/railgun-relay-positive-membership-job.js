/** PUBLIC synthetic-list fixture. Engine hashes stay in this guarded utility. */
const assert = require('assert/strict');
const path = require('path');
const crypto = require('crypto');
const wallet = '../../src/main/wallet/';
const TEST_LIST = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';
const PRODUCTION_LIST = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => BigInt(v).toString(16).padStart(64, '0');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
let attempted = false;
exports.run = async (text, { request, signal, guardReport }) => {
  assert.equal(attempted, false);
  attempted = true;
  const active = () => {
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
  };
  active();
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 8192);
  const input = JSON.parse(text);
  const { shape, EXPECTED_GUARDS, normalizeRailgunRelayQuote } = require(
    wallet + 'railgun-relay-quote-data'
  );
  shape(input, ['archive', 'createdAt', 'selected']);
  assert.ok(typeof input.archive === 'string' && path.isAbsolute(input.archive));
  assert.ok(Number.isSafeInteger(input.createdAt) && input.createdAt > 0);
  assert.ok(Date.now() >= input.createdAt && Date.now() - input.createdAt < 15000);
  const selected = input.selected;
  shape(selected, ['hash', 'npk', 'tree', 'position', 'blindedCommitment', 'type', 'amount']);
  // Fixed public fixture inputs: the 2,000 Shield note or the 700 Transact note.
  assert.equal(selected.amount, { Shield: '2000', Transact: '700' }[selected.type]);
  for (const key of ['hash', 'npk', 'blindedCommitment']) {
    assert.match(selected[key], /^0x[0-9a-f]{64}$/);
    assert.ok(BigInt(selected[key]) < FIELD);
  }
  for (const key of ['tree', 'position'])
    assert.ok(Number.isSafeInteger(selected[key]) && selected[key] >= 0 && selected[key] < 65536);
  const records = require(wallet + 'railgun-poi-records');
  assert.equal(records.REQUIRED_LIST, TEST_LIST);
  const archive = require(wallet + 'railgun-engine-runtime').verifyRailgunEngineRuntime(
    input.archive
  );
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  const { poseidon, poseidonHex, initPoseidonPromise } = imp('utils/poseidon');
  await initPoseidonPromise;
  active();
  const noteUtil = imp('note/note-util');
  const token = noteUtil.getTokenDataERC20(
    require(wallet + 'railgun-shield-pins.json').wrappedNative
  );
  const tokenHash = noteUtil.getTokenDataHash(token);
  const noteHash = imp('note/transact-note').TransactNote.getHash(
    BigInt(selected.npk),
    tokenHash,
    BigInt(selected.amount)
  );
  assert.equal('0x' + hex(noteHash), selected.hash);
  const position = BigInt(selected.tree) * 65536n + BigInt(selected.position);
  const blinded = '0x' + hex(poseidon([BigInt(selected.hash), BigInt(selected.npk), position]));
  assert.equal(blinded, selected.blindedCommitment);
  const makePath = (blind) => {
    const elements = [];
    let empty = hex(0),
      root = blind.slice(2);
    for (let level = 0; level < 16; level++) {
      elements.push(empty);
      root = poseidonHex([root, empty]);
      empty = poseidonHex([empty, empty]);
    }
    return { leaf: blind.slice(2), elements, indices: hex(0), root };
  };
  const key = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 10),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  assert.equal(
    crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('hex'),
    '302a300506032b6570032100' + TEST_LIST
  );
  const signEvent = (note, proof) => {
    const value = { index: 0, blindedCommitment: note.blindedCommitment, type: note.type };
    return {
      signedPOIEvent: {
        ...value,
        signature: crypto.sign(null, Buffer.from(JSON.stringify(value)), key).toString('hex'),
      },
      validatedMerkleroot: proof.root,
    };
  };
  const note = { blindedCommitment: blinded, type: selected.type },
    proof = makePath(blinded),
    event = signEvent(note, proof);
  const hashPair = (a, b) => poseidonHex([a, b]);
  records.verifyPoiMembership([proof], [note], hashPair);
  records.verifyPoiEvent([event], note, proof);
  const badEvent = structuredClone(event);
  badEvent.signedPOIEvent.signature = '00'.repeat(64);
  assert.throws(() => records.verifyPoiEvent([badEvent], note, proof));
  const originalMessage = Buffer.from(
    JSON.stringify({ index: 0, blindedCommitment: blinded, type: selected.type })
  );
  const productionKey = crypto.createPublicKey({
    key: Buffer.from('302a300506032b6570032100' + PRODUCTION_LIST, 'hex'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(
    crypto.verify(
      null,
      originalMessage,
      productionKey,
      Buffer.from(event.signedPOIEvent.signature, 'hex')
    ),
    false
  );
  const badPath = structuredClone(proof);
  badPath.elements[0] = hex((BigInt('0x' + badPath.elements[0]) + 1n) % FIELD);
  assert.throws(() => records.verifyPoiMembership([badPath], [note], hashPair));
  const otherNote = {
    blindedCommitment: '0x' + hex((BigInt(blinded) + 1n) % FIELD),
    type: selected.type,
  };
  const otherProof = makePath(otherNote.blindedCommitment),
    otherEvent = signEvent(otherNote, otherProof);
  records.verifyPoiMembership([otherProof], [otherNote], hashPair);
  records.verifyPoiEvent([otherEvent], otherNote, otherProof);
  assert.notEqual(otherNote.blindedCommitment, selected.blindedCommitment);
  assert.throws(() => records.verifyPoiEvent([otherEvent], note, proof));
  const vector = require('./railgun-relay-quote-native-vectors').buildVectors(
    archive,
    input.createdAt
  );
  const fields = JSON.parse(Buffer.from(vector.cases[0].quote.data, 'hex').toString('utf8'));
  fields.requiredPOIListKeys = [TEST_LIST];
  const quoteBytes = Buffer.from(JSON.stringify(fields));
  const quote = {
    data: quoteBytes.toString('hex'),
    signature: crypto.sign(null, quoteBytes, key).toString('hex'),
  };
  const checked = normalizeRailgunRelayQuote(quote, vector.gas);
  assert.deepEqual(checked.fields.requiredPOIListKeys, [TEST_LIST]);
  assert.equal(checked.fields.feeExpiration, input.createdAt + 240000);
  active();
  assert.ok(Date.now() >= input.createdAt && Date.now() - input.createdAt < 15000);
  const guards = guardReport();
  assert.deepEqual(guards, EXPECTED_GUARDS);
  const value = {
    inputSha256: sha(text),
    selectedSha256: sha(JSON.stringify(selected)),
    note,
    proof,
    event,
    quote,
    gas: vector.gas,
    createdAt: input.createdAt,
    controls: {
      badEventRefused: true,
      productionKeyRefused: true,
      badPathRefused: true,
      otherEventAndPathVerified: true,
      otherNoteUnequal: true,
      otherEventSelectedJoinRefused: true,
    },
    syntheticList: TEST_LIST,
    productionServiceAuthority: false,
    engineSha256: require(wallet + 'railgun-engine-manifest.json').sha256,
    guards,
  };
  const wire = JSON.stringify({ id: 1, method: 'result', value });
  assert.ok(Buffer.byteLength(wire) <= 16384);
  assert.deepEqual(JSON.parse(await request(wire)), { id: 1, value: null });
  active();
};
