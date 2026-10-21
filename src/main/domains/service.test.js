'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DomainService } = require('./service');
const { DomainOperationStore } = require('./operation-store');
const { ADDRESSES, ABI, DomainError, parseName, ZeroAddress } = require('./contracts');

const address = '0x000000000000000000000000000000000000dEaD';
const hash = `0x${'ab'.repeat(32)}`;
const publicationId = `swarm_pub_${'ab'.repeat(12)}`;
function fixture(namespace = 'eth', available = false) {
  let secret;
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => { secret = value; return Buffer.from('protected-fixture'); }, decryptString: () => secret };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-domain-service-'));
  const store = new DomainOperationStore({ directory, safeStorage });
  const parsed = parseName(`freedom-fixture.${namespace}`);
  const state = { ...parsed, available, active: !available, owner: available ? ZeroAddress : address, manager: address,
    recordOwner: address, resolver: namespace === 'eth' ? ADDRESSES.resolver : ADDRESSES[namespace],
    supportedResolver: true, expiry: '99999999', records: { contenthash: '0x', address, text: { description: 'before' } } };
  const clock = { tag: '0x100', hash, timestamp: 1000 };
  let wire;
  let committedAt = 0n;
  const chain = {
    snapshot: jest.fn(async () => ({ ...clock })),
    inspect: jest.fn(async () => structuredClone({ ...state, snapshot: clock })),
    checkCode: jest.fn(async () => {}), simulate: jest.fn(async () => {}),
    call: jest.fn(async (role, method, args) => {
      if (method === 'computeId') return [BigInt(parseName(args[0]).tokenId)];
      if (method === 'normalize') return [args[0]];
      if (method === 'rentPrice') return [{ base: 100n, premium: 0n }];
      if (method === 'getFee') return [100n];
      if (method === 'getPremium') return [0n];
      if (method === 'MIN_REGISTRATION_DURATION') return [2419200n];
      if (method === 'minCommitmentAge') return [60n];
      if (method === 'maxCommitmentAge') return [86400n];
      if (method === 'commitments') return [committedAt];
      if (method === 'controllers' || method === 'valid') return [true];
      return [false];
    }),
    receipt: jest.fn(async () => wire ? ({ blockHash: hash, blockNumber: '0x100', status: '0x1' }) : null),
    request: jest.fn(async () => wire),
  };
  const account = { index: 0, address, type: 'mnemonic' };
  const wallet = { account: jest.fn(async () => account), send: jest.fn(async (plan, context) => {
    await context.requestApproval({ label: plan.label });
    await context.revalidate();
    await context.beforeSend();
    wire = { from: address, to: plan.to, value: plan.value, input: plan.data };
    const iface = namespace === 'eth' ? (plan.to === ADDRESSES.resolver ? ABI.resolver : ABI.controller) : ABI.nft;
    const decoded = iface.parseTransaction({ data: plan.data });
    if (decoded.name === 'commit') committedAt = BigInt(clock.timestamp);
    else if (decoded.name === 'register' || decoded.name === 'reveal') { state.available = false; state.active = true; state.owner = address; }
    else if (decoded.name === 'renew') state.expiry = (BigInt(state.expiry) + 31536000n).toString();
    else if (decoded.name === 'setContenthash') state.records.contenthash = decoded.args[1];
    else if (decoded.name === 'setText') state.records.text[decoded.args[1]] = decoded.args[2];
    else if (decoded.name === 'setAddr') state.records.address = decoded.args[1];
    return { hash };
  }) };
  const options = { store, chain, wallet, executeWaitMs: 0, pollMs: 1, verifyResolution: jest.fn(async () => true),
    getPublication: jest.fn(async () => ({ publicationId, reference: '12'.repeat(32), state: 'completed', verified: true, indexDocument: 'index.html' })) };
  return { service: new DomainService(options), options, state, chain, wallet, clock, store,
    context: { conversationId: 'conversation', requestApproval: jest.fn(async () => 'approved') }, getSecret: () => secret };
}

test.each(['eth', 'wei', 'gwei'])('%s registration survives a restart and needs a separately approved reveal', async namespace => {
  const f = fixture(namespace, true);
  const prepared = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  expect(JSON.stringify(prepared)).not.toContain(f.getSecret());
  let result = await f.service.execute(prepared.operationId, f.context);
  expect(result.state).toBe('waiting_commitment');
  expect(result.transactionHash).toBeUndefined();
  expect(result.transactions).toEqual([expect.objectContaining({ step: 'commit', hash })]);
  expect(f.context.requestApproval).toHaveBeenCalledTimes(1);
  const reopened = new DomainOperationStore({ directory: path.dirname(f.store.filename), safeStorage: f.store.safeStorage });
  f.service.close();
  const service = new DomainService({ ...f.options, store: reopened });
  f.clock.timestamp += 61;
  result = await service.status({ operationId: prepared.operationId });
  expect(result.state).toBe('ready');
  expect(f.context.requestApproval).toHaveBeenCalledTimes(1);
  result = await service.execute(prepared.operationId, f.context);
  expect(result.state).toBe('completed');
  expect(f.context.requestApproval).toHaveBeenCalledTimes(2);
  expect(reopened.get(prepared.operationId).encryptedSecret).toBeUndefined();
  await service.execute(prepared.operationId, f.context);
  expect(f.wallet.send).toHaveBeenCalledTimes(2);
});

test.each(['eth', 'wei', 'gwei'])('%s verified website binding preserves other records and checks fresh resolution', async namespace => {
  const f = fixture(namespace);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'set_website', publicationId }, f.context);
  expect(f.wallet.send).not.toHaveBeenCalled();
  const result = await f.service.execute(plan.operationId, f.context);
  expect(result).toMatchObject({ state: 'completed', resolutionVerified: true });
  expect(f.state.records.text.description).toBe('before');
  expect(f.state.records.address).toBe(address);
  expect(f.options.verifyResolution).toHaveBeenCalledWith(f.state.name, '12'.repeat(32));
});

test('unverified/non-site publications and custom resolvers never prepare a write', async () => {
  const f = fixture();
  f.options.getPublication.mockResolvedValue({ state: 'completed', verified: false });
  await expect(f.service.prepare({ name: f.state.name, intent: 'set_website', publicationId }, f.context)).rejects.toThrow('verified');
  f.state.supportedResolver = false;
  await expect(f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context)).rejects.toThrow('resolver');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('changed record/ownership and price changes invalidate stale plans before sending', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context);
  f.state.records.text.description = 'someone else changed it';
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'stale' });
  expect(f.wallet.send).not.toHaveBeenCalled();
  const g = fixture('wei', true);
  const registration = await g.service.prepare({ name: g.state.name, intent: 'register' }, g.context);
  const call = g.chain.call.getMockImplementation();
  g.chain.call.mockImplementation((role, method, args) => method === 'getFee' ? [200n] : call(role, method, args));
  expect(await g.service.execute(registration.operationId, g.context)).toMatchObject({ state: 'stale' });
  expect(g.wallet.send).not.toHaveBeenCalled();
});

test('uncertain broadcasts block duplicates and accept only matching recovery transactions', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context);
  const send = f.wallet.send.getMockImplementation();
  f.wallet.send.mockImplementation(async (...args) => { await send(...args); throw new Error(`RPC echoed private payload ${f.getSecret()}`); });
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'dispatch_unknown' });
  expect(await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context)).toMatchObject({ operationId: plan.operationId, state: 'dispatch_unknown' });
  await f.service.execute(plan.operationId, { ...f.context, resume: true });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
  const request = f.chain.request.getMockImplementation();
  f.chain.request.mockResolvedValue({ from: address, to: ADDRESSES.base, input: '0x', value: '0' });
  await expect(f.service.status({ operationId: plan.operationId, transactionHash: hash })).rejects.toThrow('match');
  f.chain.request.mockImplementation(request);
  expect(await f.service.status({ operationId: plan.operationId, transactionHash: hash })).toMatchObject({ state: 'completed' });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('a decline is retained and does not automatically reopen approval', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  f.wallet.send.mockRejectedValue(new DomainError('DOMAIN_DECLINED', 'Not approved'));
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'declined' });
  await f.service.execute(plan.operationId, f.context);
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('ENS expiry uses the exclusive maximum boundary, NameNFT includes it', async () => {
  for (const namespace of ['eth', 'wei']) {
    const f = fixture(namespace, true);
    const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
    await f.service.execute(plan.operationId, f.context);
    f.clock.timestamp = 1000 + 86400;
    expect((await f.service.status({ operationId: plan.operationId })).state).toBe(namespace === 'eth' ? 'expired' : 'ready');
  }
});

test('stopping observation leaves the sent operation recoverable without another send', async () => {
  const f = fixture();
  f.chain.receipt.mockResolvedValue(null);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'pending' });
  const controller = new AbortController(); controller.abort();
  await expect(f.service.status({ operationId: plan.operationId, waitMs: 30000 }, { signal: controller.signal })).rejects.toThrow();
  expect(f.store.get(plan.operationId).state).toBe('pending');
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('availability and price inspection does not touch a wallet or create a plan', async () => {
  const f = fixture('wei', true);
  expect(await f.service.inspect({ name: f.state.name })).toMatchObject({ available: true,
    quote: { priceWei: '100', purpose: 'registration', networkFeesExtra: true } });
  expect(f.wallet.account).not.toHaveBeenCalled();
  expect(f.store.list()).toEqual([]);
});

test('a reveal requotes without paying for another commitment', async () => {
  const f = fixture('wei', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  f.clock.timestamp += 61;
  await f.service.status({ operationId: plan.operationId });
  const call = f.chain.call.getMockImplementation();
  f.chain.call.mockImplementation((role, method, args) => method === 'getFee' ? [200n] : call(role, method, args));
  const result = await f.service.execute(plan.operationId, f.context);
  expect(result).toMatchObject({ state: 'completed', priceWei: '200' });
  expect(f.wallet.send).toHaveBeenCalledTimes(2);
  const sent = f.wallet.send.mock.calls[1][0];
  expect(sent.value).toBe('200');
  expect(ABI.nft.parseTransaction({ data: sent.data }).name).toBe('reveal');
});

test('a reorg of a completed receipt requires reconciliation without a second send', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'completed' });
  f.chain.receipt.mockResolvedValue(null);
  expect(await f.service.status({ operationId: plan.operationId })).toMatchObject({ state: 'verification_needed' });
  await f.service.execute(plan.operationId, f.context);
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('a lost commitment before reveal blocks another purchase until reconciled', async () => {
  const f = fixture('eth', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  f.clock.timestamp += 61;
  await f.service.status({ operationId: plan.operationId });
  const call = f.chain.call.getMockImplementation();
  f.chain.call.mockImplementation((role, method, args) => method === 'commitments' ? [0n] : call(role, method, args));
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'verification_needed' });
  expect(await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context)).toMatchObject({ operationId: plan.operationId, state: 'verification_needed' });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('journal identifiers cannot substitute a different name behind the approval label', async () => {
  const f = fixture('eth', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  const saved = f.store.get(plan.operationId);
  saved.label = 'another-name';
  f.store.save(saved);
  await expect(f.service.execute(plan.operationId, f.context)).rejects.toThrow('inconsistent');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('a provably unsent step can resume with a fresh approval without discarding its operation', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const send = f.wallet.send.getMockImplementation();
  f.wallet.send.mockImplementation(async (_plan, context) => {
    await context.beforeSend();
    throw Object.assign(new Error('Redacted local signer refusal'), { code: 'DOMAIN_NOT_BROADCAST' });
  });
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'declined' });
  f.wallet.send.mockImplementation(send);
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'declined' });
  expect(await f.service.execute(plan.operationId, { ...f.context, resume: true })).toMatchObject({ operationId: plan.operationId, state: 'completed' });
  expect(f.wallet.send).toHaveBeenCalledTimes(2);
});
