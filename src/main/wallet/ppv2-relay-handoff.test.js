const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2RelayJournal } = require('./ppv2-relay-journal');
const { createPPv2RelayHandoff } = require('./ppv2-relay-handoff');
const { validateRelay } = require('./ppv2-relay-policy');
const { relayFixture, word } = require('../../../test/helpers/ppv2-relay-fixture');
let scope, directory, journal, gate, network, request, verifyProof;
const subject = { kind: 'private-account', principal: 'ppv2:0', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111 };
const key = Buffer.alloc(32, 5);
const handle = (role) => scope.getContext({ ...subject, role });
const options = (r = request) => ({ method: 'POST', body: r.body, headers: { 'content-type': 'application/json' } });
const invoke = (n) => n.fetch(request.endpoint, options());
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-relay-fixture-'));
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  journal = createPPv2RelayJournal({ handle: handle('storage'), directory, key });
  request = relayFixture();
  network = { fetch: jest.fn(async () => new Response(JSON.stringify({ txHash: word(99) }))) };
  // Unit tests isolate handoff behavior. Electron uses pinned Groth16 verification.
  verifyProof = jest.fn(async () => true);
  gate = createPPv2RelayHandoff({ handle: handle('relayer'), journal, network, verifyProof });
});
afterEach(() => { scope.close(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('requires final proof verification and review, journals before HTTP, and never treats ack as settlement', async () => {
  const prepared = await gate.prepare(request);
  expect(verifyProof).toHaveBeenCalledTimes(1);
  const review = jest.fn(async (summary) => {
    expect(summary).toMatchObject({ recipient: request.intent.recipient, fee: '100', amount: '5900', proofVerified: true,
      chainStateVerified: false, quoteSignatureVerified: false });
    expect(Object.isFrozen(summary)).toBe(true); expect(await journal.list()).toEqual([]); return true;
  });
  network.fetch.mockImplementationOnce(async () => {
    expect(await journal.list()).toEqual([expect.objectContaining({ commitment: request.intent.commitment,
      nullifier: request.intent.publicSignals[0], acknowledgedHash: null })]);
    return new Response(JSON.stringify({ txHash: word(99) }));
  });
  await gate.submit(prepared, { review, invoke });
  expect((await journal.list())[0].acknowledgedHash).toBe(word(99));
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_UNRESOLVED' });
  await expect(gate.submit(prepared, { review, invoke })).rejects.toThrow();
  expect(network.fetch).toHaveBeenCalledTimes(1);
  const raw = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
  expect(raw).not.toContain(request.intent.commitment); expect(raw).not.toContain(request.endpoint);
  const record = JSON.stringify(await journal.list());
  expect(record).not.toContain('signedFeeCommitment'); expect(record).not.toContain('pi_a');
});

test.each(['recipient', 'fee', 'routing', 'asset', 'extraGas', 'amount', 'shape', 'notes', 'context', 'signals', 'endpoint', 'extension'])(
'refuses altered %s before proving, review or transport', async (change) => {
  const p = JSON.parse(request.body);
  if (change === 'recipient') p.signedFeeCommitment.recipient = request.intent.relayer;
  if (change === 'fee') p.signedFeeCommitment.feeAmount = '101';
  if (change === 'routing') p.signedFeeCommitment.data += '00';
  if (change === 'asset') p.signedFeeCommitment.asset = request.intent.pool;
  if (change === 'extraGas') p.signedFeeCommitment.extraGas = true;
  if (change === 'amount') p.signedFeeCommitment.amountReceived = '5901';
  if (change === 'shape') p.outputCommitmentNumber = 2;
  if (change === 'notes') p.noteData[0].data = '0xbb';
  if (change === 'context') { p.proof.publicSignals[7] = word(0); request.intent.publicSignals[7] = word(0); }
  if (change === 'signals') p.proof.publicSignals[0] = word(88);
  if (change === 'endpoint') request.endpoint += '?trace=link';
  if (change === 'extension') p.processorAddress = request.intent.processor;
  request.body = JSON.stringify(p);
  await expect(gate.prepare(request)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_REFUSED' });
  expect(verifyProof).not.toHaveBeenCalled(); expect(network.fetch).not.toHaveBeenCalled();
});

test('refuses cryptographically invalid proofs and snapshots mutable intent before verification', async () => {
  verifyProof.mockResolvedValueOnce(false);
  await expect(gate.prepare(request)).rejects.toThrow();
  const pending = gate.prepare(request); request.intent.recipient = request.intent.relayer;
  const prepared = await pending;
  expect(prepared.recipient).not.toBe(request.intent.recipient);
  expect(network.fetch).not.toHaveBeenCalled();
});

test('uses the upstream millisecond quote deadline and refuses seconds or expired commitments', async () => {
  for (const expiration of [Math.floor(Date.now() / 1000) + 300, Date.now() - 1]) {
    const payload = JSON.parse(request.body); payload.signedFeeCommitment.expiration = expiration;
    await expect(gate.prepare({ ...request, body: JSON.stringify(payload) })).rejects.toThrow();
  }
  const payload = JSON.parse(request.body); payload.signedFeeCommitment.expiration = Date.now() + 50;
  const prepared = await gate.prepare({ ...request, body: JSON.stringify(payload) });
  jest.useFakeTimers(); jest.setSystemTime(Date.now() + 51);
  await expect(gate.submit(prepared, { review: async () => true, invoke })).rejects.toThrow();
  expect(network.fetch).not.toHaveBeenCalled();
});

test.each(['body', 'endpoint', 'headers', 'method', 'options'])('refuses changed wire %s and unissued authority', async (change) => {
  const prepared = await gate.prepare(request), init = options(); let url = request.endpoint;
  if (change === 'body') init.body += ' ';
  if (change === 'endpoint') url = url.replace('relay.example', 'evil.example');
  if (change === 'headers') init.headers.authorization = 'no';
  if (change === 'method') init.method = 'GET';
  if (change === 'options') init.redirect = 'follow';
  const review = jest.fn(async () => true);
  await expect(gate.submit({ ...prepared }, { review, invoke })).rejects.toThrow();
  await expect(gate.submit(prepared, { review, invoke: (n) => n.fetch(url, init) })).rejects.toThrow();
  expect(review).not.toHaveBeenCalled(); expect(network.fetch).not.toHaveBeenCalled();
  expect(await journal.list()).toEqual([]);
});

test.each(['reject', 'expire', 'lock'])('does not persist or send after review %s', async (change) => {
  const prepared = await gate.prepare(request);
  const review = async () => {
    if (change === 'expire') { jest.useFakeTimers(); jest.setSystemTime(Date.now() + 121000); }
    if (change === 'lock') scope.close();
    return change !== 'reject';
  };
  await expect(gate.submit(prepared, { review, invoke })).rejects.toThrow();
  expect(network.fetch).not.toHaveBeenCalled(); expect(fs.readdirSync(directory)).toEqual([]);
});

test.each(['lost', 'error', 'malformed', 'oversize', 'ack-write'])('preserves uncertain attempt on %s and blocks a fresh adapter', async (failure) => {
  network.fetch.mockImplementationOnce(async () => {
    if (failure === 'lost') throw new Error('Sensitive upstream error');
    if (failure === 'error') return new Response('no', { status: 400 });
    if (failure === 'malformed') return new Response('{oops');
    if (failure === 'oversize') return new Response('x'.repeat(1025));
    jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk'); });
    return new Response(JSON.stringify({ txHash: word(99) }));
  });
  const prepared = await gate.prepare(request);
  await expect(gate.submit(prepared, { review: async () => true, invoke })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_UNCERTAIN' });
  const restored = createPPv2RelayJournal({ handle: handle('storage'), directory, key });
  await expect(restored.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_UNRESOLVED' });
  expect((await restored.list())[0].acknowledgedHash).toBeNull(); expect(network.fetch).toHaveBeenCalledTimes(1);
});

test('failed durable write prevents transport, and a returned callback cannot leave a late send behind', async () => {
  const prepared = await gate.prepare(request);
  const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk'); });
  await expect(gate.submit(prepared, { review: async () => true, invoke })).rejects.toThrow();
  expect(network.fetch).not.toHaveBeenCalled(); rename.mockRestore();
  const next = await gate.prepare(request); let release, late;
  await expect(gate.submit(next, { review: () => new Promise((r) => { release = r; }), invoke: (n) => {
    late = n.fetch(request.endpoint, options()).catch((e) => e.code); return Promise.resolve();
  } })).rejects.toThrow();
  release?.(true); await late;
  expect(network.fetch).not.toHaveBeenCalled(); expect(await journal.list()).toEqual([]);
});

test('durable reservation serializes separate adapters and survives a new process', async () => {
  const a = validateRelay(request).attempt;
  const other = createPPv2RelayJournal({ handle: handle('storage'), directory, key });
  const outcomes = await Promise.allSettled([journal.begin(a), other.begin({ ...a, id: word(66) })]);
  expect(outcomes.map((v) => v.status)).toEqual(['fulfilled', 'rejected']);
  const output = execFileSync(process.execPath, ['-e', `
    const { createPrivacyScope } = require(${JSON.stringify(path.resolve(__dirname, '../networks/privacy-context'))});
    const { createPPv2RelayJournal } = require(${JSON.stringify(path.resolve(__dirname, 'ppv2-relay-journal'))});
    const scope = createPrivacyScope({ profileId:'fixture', signal:new AbortController().signal });
    const handle = scope.getContext(${JSON.stringify({ ...subject, role: 'storage' })});
    const journal = createPPv2RelayJournal({handle,directory:process.argv[1],key:Buffer.alloc(32,5)});
    journal.assertCanSubmit().then(()=>process.exit(1),(e)=>process.stdout.write(e.code));
  `, directory], { encoding: 'utf8' });
  expect(output).toBe('PRIVATE_PPV2_RELAY_UNRESOLVED');
});

test('corruption, wrong key and another account fail closed', async () => {
  await journal.begin(validateRelay(request).attempt);
  const wrong = createPPv2RelayJournal({ handle: handle('storage'), directory, key: Buffer.alloc(32, 6) });
  await expect(wrong.list()).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
  const other = scope.getContext({ ...subject, principal: 'ppv2:1', role: 'relayer' });
  expect(() => createPPv2RelayHandoff({ handle: other, journal, network, verifyProof })).toThrow();
  fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), '{}');
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
});

test('rechecks main-owned eligibility after review before durable intent or network', async () => {
  const events = [];
  gate = createPPv2RelayHandoff({ handle: handle('relayer'), journal, network, verifyProof,
    beforeBegin: async () => { events.push('recheck'); throw new Error('Evidence changed'); } });
  const prepared = await gate.prepare(request);
  await expect(gate.submit(prepared, { review: async () => { events.push('review'); return true; }, invoke })).rejects.toThrow();
  expect(events).toEqual(['review', 'recheck']); expect(await journal.list()).toEqual([]);
  expect(network.fetch).not.toHaveBeenCalled();
});

test('accepts the SDK native-asset checksum spelling while preserving exact reviewed bytes', async () => {
  const payload = JSON.parse(request.body);
  payload.signedFeeCommitment.asset = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  request.body = JSON.stringify(payload);
  const prepared = await gate.prepare(request);
  await gate.submit(prepared, { review: async () => true, invoke });
  expect(network.fetch.mock.calls[0][1].body).toBe(request.body);
});

test('binds token withdrawal review and settlement to the same asset and rejects asset substitution', async () => {
  const token=`0x${'66'.repeat(20)}`, payload=JSON.parse(request.body);
  request.intent={...request.intent,kind:'ppv2-token-withdrawal',token};
  request.intent.publicSignals[6]=word(BigInt(token));
  payload.proof.publicSignals[6]=request.intent.publicSignals[6];
  payload.signedFeeCommitment.asset=token;
  request.body=JSON.stringify(payload);
  const prepared=await gate.prepare(request);
  expect(prepared.token).toBe(token);
  await gate.submit(prepared,{review:async()=>true,invoke});
  expect((await journal.list())[0].settlement.token).toBe(token);
  payload.signedFeeCommitment.asset='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  expect(()=>validateRelay({...request,body:JSON.stringify(payload)})).toThrow();
});
