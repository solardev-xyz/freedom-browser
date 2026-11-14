'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DomainService } = require('./service');
const { DomainOperationStore } = require('./operation-store');
const { DomainChain } = require('./chain');
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
  const state = { ...parsed, ensVersion: namespace === 'eth' ? available ? 2 : 1 : undefined, available, active: !available, owner: available ? ZeroAddress : address, manager: address,
    recordOwner: address, resolver: namespace === 'eth' ? ADDRESSES.resolver : ADDRESSES[namespace],
    supportedResolver: true, expiry: '99999999', records: { contenthash: '0x', address, text: { description: 'before' } } };
  const clock = { tag: '0x100', hash, timestamp: 1000 };
  let wire;
  let nonce = 5;
  let committedAt = 0n;
  const wires = new Map();
  const v2 = { allowance: 100n, balance: 1000000n, deployed: true, price: 100n, uniqueHashes: false };
  const chain = {
    snapshot: jest.fn(async () => ({ ...clock })),
    inspect: jest.fn(async () => structuredClone({ ...state, snapshot: clock })),
    checkCode: jest.fn(async () => {}), simulate: jest.fn(async () => {}),
    call: jest.fn(async (role, method, args) => {
      if (method === 'predictProxyAddress') return ['0x000000000000000000000000000000000000cafE'];
      if (method === 'verifyContract') return [ADDRESSES.ensResolverImpl];
      if (method === 'BASE_REGISTRAR') return [ADDRESSES.base];
      if (method === 'NAME_WRAPPER') return [ADDRESSES.wrapper];
      if (method === 'WRAPPED_CONTROLLER') return [ADDRESSES.wrappedController];
      if (method === 'ETH_REGISTRY') return [ADDRESSES.ensRegistry];
      if (method === 'rentPriceOracle') return [ADDRESSES.ensOracle];
      if (method === 'isPaymentToken' || method === 'hasRootRoles') return [true];
      if (method === 'decimals') return [role === 'dai' ? 18n : 6n];
      if (method === 'balanceOf') return [v2.balance];
      if (method === 'allowance') return [v2.allowance];
      if (method === 'getRegisterPrice') return [v2.price, 0n];
      if (method === 'getRenewPrice') return [v2.price];
      if (method === 'MIN_REGISTER_DURATION') return [2419200n];
      if (method === 'MIN_COMMITMENT_AGE') return [60n];
      if (method === 'MAX_COMMITMENT_AGE') return [86400n];
      if (method === 'commitmentAt') return [committedAt];
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
    receipt: jest.fn(async requested => {
      const tx = wires.get(requested);
      if (!tx) return null;
      const role = Object.keys(ADDRESSES).find(role => ADDRESSES[role].toLowerCase() === tx.to.toLowerCase());
      const iface = namespace === 'eth' ? ABI[role] || ABI.ensResolverImpl : ABI.nft;
      const call = iface.parseTransaction({ data: tx.input });
      const logs = [];
      if (call.name === 'approve') logs.push({ address: tx.to, ...iface.encodeEventLog(iface.getEvent('Approval'), [address, ...call.args]) });
      if (call.name === 'deployProxy') logs.push({ address: tx.to, ...iface.encodeEventLog(iface.getEvent('ProxyDeployed'), [address, '0x000000000000000000000000000000000000cafE', call.args[1], call.args[0]]) });
      return { blockHash: hash, blockNumber: '0x100', status: '0x1', logs };
    }),
    callAt: jest.fn(async () => [true]),
    request: jest.fn(async (method, params) => method === 'eth_getCode' ? v2.deployed ? '0x01' : '0x' : method === 'eth_getTransactionCount' ? `0x${nonce.toString(16)}` : wires.get(params?.[0]) || wire),
  };
  const account = { index: 0, address, type: 'mnemonic' };
  const wallet = { account: jest.fn(async () => account),
    ownWallet: jest.fn(async value => value.toLowerCase() === address.toLowerCase() ? { status: 'own', name: 'Main wallet' } : { status: 'other' }),
    send: jest.fn(async (plan, context) => {
    await context.requestApproval({ label: plan.label });
    await context.revalidate();
    await context.beforeSend();
    wire = { from: address, to: plan.to, value: plan.value, input: plan.data, nonce: `0x${(nonce++).toString(16)}` };
    const role = Object.keys(ADDRESSES).find(role => ADDRESSES[role].toLowerCase() === plan.to.toLowerCase());
    const iface = namespace === 'eth' ? ABI[role] || ABI.ensResolverImpl : ABI.nft;
    const decoded = iface.parseTransaction({ data: plan.data });
    if (decoded.name === 'approve') v2.allowance = BigInt(decoded.args[1]);
    if (decoded.name === 'deployProxy') v2.deployed = true;
    if (decoded.name === 'commit') committedAt = BigInt(clock.timestamp);
    else if (decoded.name === 'register' || decoded.name === 'reveal') { state.available = false; state.active = true; state.owner = address; if (namespace === 'eth') { state.ensVersion = 2; state.resolver = decoded.args[4]; state.resolverRole = 'ensResolverImpl'; } }
    else if (decoded.name === 'renew') state.expiry = (BigInt(state.expiry) + 31536000n).toString();
    else if (decoded.name === 'setContenthash') state.records.contenthash = decoded.args[1];
    else if (decoded.name === 'setText') state.records.text[decoded.args[1]] = decoded.args[2];
    else if (decoded.name === 'setAddr') state.records.address = decoded.args[1];
    else if (decoded.name === 'setAddress') state.records.address = decoded.args[2];
    const transactionHash = v2.uniqueHashes ? `0x${nonce.toString(16).padStart(64, '0')}` : hash;
    wires.set(transactionHash, wire);
    return { hash: transactionHash };
  }) };
  const options = { store, chain, wallet, executeWaitMs: 0, pollMs: 1, verifyResolution: jest.fn(async () => true),
    getPublication: jest.fn(async () => ({ publicationId, target: 'public', public: true, reference: '12'.repeat(32), state: 'completed', verified: true, indexDocument: 'index.html' })) };
  return { service: new DomainService(options), options, state, chain, wallet, clock, store, v2,
    context: { conversationId: 'conversation', requestApproval: jest.fn(async () => 'approved') }, getSecret: () => secret, getWire: () => wire };
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

test('a commit is checked at its mined block when latest is one block behind', async () => {
  const f = fixture('gwei', true);
  f.clock.tag = '0xff';
  const snapshots = new DomainChain({ request: jest.fn(async (_method, [tag]) => ({
    number: tag === 'latest' ? f.clock.tag : tag, hash,
    timestamp: `0x${f.clock.timestamp.toString(16)}`,
  })) });
  f.chain.snapshot.mockImplementation(receipt => snapshots.snapshot(receipt));
  const call = f.chain.call.getMockImplementation();
  f.chain.call.mockImplementation((role, method, args, snapshot) => method === 'commitments' && BigInt(snapshot.tag) < 256n
    ? [0n] : call(role, method, args));
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'waiting_commitment', step: 'reveal' });
  expect(f.chain.snapshot).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: '0x100' }));
  expect(f.chain.call).toHaveBeenCalledWith('gwei', 'commitments', expect.any(Array), expect.objectContaining({ tag: '0x100' }));
  f.clock.tag = '0x101'; f.clock.timestamp += 61;
  expect(await f.service.status({ operationId: plan.operationId })).toMatchObject({ state: 'ready' });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test.each(['eth', 'wei', 'gwei'])('%s recovers an already saved missing-commit state after restart without resending', async namespace => {
  const f = fixture(namespace, true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  const saved = f.store.get(plan.operationId);
  saved.state = 'verification_needed';
  saved.message = 'The confirmed commitment is missing from the current chain. Inspect before continuing.';
  f.store.save(saved);
  f.service.close();
  const reopened = new DomainOperationStore({ directory: path.dirname(f.store.filename), safeStorage: f.store.safeStorage });
  const service = new DomainService({ ...f.options, store: reopened });
  expect(await service.status({ operationId: plan.operationId })).toMatchObject({ state: 'waiting_commitment' });
  f.clock.timestamp += 61;
  expect(await service.status({ operationId: plan.operationId })).toMatchObject({ state: 'ready', step: 'reveal' });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
  expect(f.context.requestApproval).toHaveBeenCalledTimes(1);
  expect(await service.execute(plan.operationId, f.context)).toMatchObject({ state: 'completed' });
  expect(f.wallet.send).toHaveBeenCalledTimes(2);
  expect(f.context.requestApproval).toHaveBeenCalledTimes(2);
});

test.each(['missing receipt', 'reverted receipt', 'changed block', 'different transaction', 'missing commitment'])(
  'commit recovery remains blocked for %s', async failure => {
    const f = fixture('gwei', true);
    const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
    await f.service.execute(plan.operationId, f.context);
    const saved = f.store.get(plan.operationId);
    saved.state = 'verification_needed'; f.store.save(saved);
    if (failure === 'missing receipt') f.chain.receipt.mockResolvedValue(null);
    if (failure === 'reverted receipt') f.chain.receipt.mockResolvedValue({ status: '0x0', blockHash: hash });
    if (failure === 'changed block') f.chain.receipt.mockResolvedValue({ status: '0x1', blockHash: 'different-block' });
    if (failure === 'different transaction') f.chain.request.mockResolvedValue({ from: address, to: ADDRESSES.base, input: '0x', value: '0' });
    if (failure === 'missing commitment') {
      const call = f.chain.call.getMockImplementation();
      f.chain.call.mockImplementation((role, method, args) => ['commitments', 'commitmentAt'].includes(method) ? [0n] : call(role, method, args));
    }
    expect(await f.service.status({ operationId: plan.operationId })).toMatchObject({ state: 'verification_needed' });
    await f.service.execute(plan.operationId, f.context);
    expect(f.wallet.send).toHaveBeenCalledTimes(1);
    expect(f.context.requestApproval).toHaveBeenCalledTimes(1);
  });

test('an old saved commitment recovers as expired rather than paying for another commit', async () => {
  const f = fixture('gwei', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  const saved = f.store.get(plan.operationId);
  saved.state = 'verification_needed'; f.store.save(saved);
  f.clock.timestamp += 86401;
  expect(await f.service.status({ operationId: plan.operationId })).toMatchObject({ state: 'expired' });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('a temporarily unavailable confirmation snapshot leaves the original commit pending', async () => {
  const f = fixture('gwei', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  f.chain.snapshot.mockRejectedValueOnce(new DomainError('DOMAIN_CHAIN_BEHIND', 'Ethereum is catching up.'));
  await expect(f.service.execute(plan.operationId, f.context)).rejects.toMatchObject({ code: 'DOMAIN_CHAIN_BEHIND' });
  expect(f.store.get(plan.operationId)).toMatchObject({ state: 'pending', step: 'commit', transactionHash: hash, transactions: [] });
  expect(await f.service.status({ operationId: plan.operationId })).toMatchObject({ state: 'waiting_commitment', step: 'reveal' });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test.each(['dispatch_unknown', 'pending', 'verification_needed'])('a %s reveal cannot be recovered as an unsent reveal', async state => {
  const f = fixture('gwei', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  const saved = f.store.get(plan.operationId);
  saved.state = state;
  // A later reveal may have been broadcast. The earlier commit is not evidence
  // that a second reveal is safe, even when it is still present on chain.
  saved.transactionHash = `0x${'cd'.repeat(32)}`;
  f.store.save(saved);
  f.chain.receipt.mockResolvedValue(null);
  expect(await f.service.status({ operationId: plan.operationId })).toMatchObject({ state });
  await f.service.execute(plan.operationId, f.context);
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('post-transaction record verification also requires a snapshot including the receipt', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context);
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'completed' });
  expect(f.chain.inspect).toHaveBeenLastCalledWith(expect.any(Object), ['description'], expect.objectContaining({ blockNumber: '0x100' }));
});

test('a provably unsent reveal can resume even after its dispatch digest replaced the commit digest', async () => {
  const f = fixture('gwei', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  f.clock.timestamp += 61;
  await f.service.status({ operationId: plan.operationId });
  const send = f.wallet.send.getMockImplementation();
  f.wallet.send.mockImplementation(async (_plan, context) => {
    await context.beforeSend();
    throw Object.assign(new Error('Local signer did not broadcast'), { code: 'DOMAIN_NOT_BROADCAST' });
  });
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'declined', step: 'reveal' });
  f.wallet.send.mockImplementation(send);
  expect(await f.service.execute(plan.operationId, { ...f.context, resume: true })).toMatchObject({ state: 'completed' });
  expect(f.wallet.send).toHaveBeenCalledTimes(3);
});

test('unverified/non-site publications and custom resolvers never prepare a write', async () => {
  const f = fixture();
  f.options.getPublication.mockResolvedValue({ public: true, state: 'completed', verified: false });
  await expect(f.service.prepare({ name: f.state.name, intent: 'set_website', publicationId }, f.context)).rejects.toThrow('verified');
  f.state.supportedResolver = false;
  await expect(f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context)).rejects.toThrow('resolver');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('a private draft link is never connected to a name', async () => {
  const f = fixture();
  f.options.getPublication.mockResolvedValue({ publicationId, target: 'draft', public: false, encrypted: true,
    reference: '12'.repeat(64), state: 'completed', verified: true, indexDocument: 'index.html' });
  await expect(f.service.prepare({ name: f.state.name, intent: 'set_website', publicationId }, f.context))
    .rejects.toThrow('A private draft link cannot be connected to a name');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('an unknown publication ID gets the "choose a completed publication" refusal, not the draft one', async () => {
  const f = fixture();
  f.options.getPublication.mockResolvedValue(null);
  const failure = f.service.prepare({ name: f.state.name, intent: 'set_website', publicationId }, f.context);
  await expect(failure).rejects.toThrow('Choose a completed, retrieval-verified Swarm website publication ID.');
  await expect(failure).rejects.not.toThrow('private draft link');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('a publication with an updated stable address maps the name to the feed, not one version', async () => {
  const f = fixture();
  const feed = 'fe'.repeat(32);
  f.options.getPublication.mockResolvedValue({ publicationId, target: 'public', public: true, reference: '12'.repeat(32),
    state: 'completed', verified: true, indexDocument: 'index.html',
    stableAddress: { name: 'site', owner: `0x${'a'.repeat(40)}`, reference: feed, bzzUrl: `bzz://${feed}`, updated: true } });
  const plan = await f.service.prepare({ name: f.state.name, intent: 'set_website', publicationId }, f.context);
  expect(JSON.stringify(plan)).toContain(feed);
  // Not updated: the version reference is used instead.
  const g = fixture();
  g.options.getPublication.mockResolvedValue({ publicationId, target: 'public', public: true, reference: '12'.repeat(32),
    state: 'completed', verified: true, indexDocument: 'index.html',
    stableAddress: { name: 'site', owner: `0x${'a'.repeat(40)}`, updated: false, error: 'locked' } });
  const fallback = await g.service.prepare({ name: g.state.name, intent: 'set_website', publicationId }, g.context);
  expect(JSON.stringify(fallback)).not.toContain(feed);
  expect(JSON.stringify(fallback)).toContain('12'.repeat(32));
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
  expect(sent.value).toBe('204'); // The new quote plus the disclosed 2% buffer.
  expect(ABI.nft.parseTransaction({ data: sent.data }).name).toBe('reveal');
  // The approval names the commit-time quote the new price departs from.
  expect(sent.presentation.items).toContainEqual({ label: 'Price change',
    value: 'Quoted 0.0000000000000001 ETH at commit time, now 0.0000000000000002 ETH' });
  expect(sent.summary).toContain('Price change: Quoted 0.0000000000000001 ETH at commit time, now 0.0000000000000002 ETH');
  expect(f.wallet.send.mock.calls[0][0].summary).not.toContain('Price change');
});

test('an unchanged reveal quote does not claim a price increase', async () => {
  const f = fixture('wei', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  f.clock.timestamp += 61;
  await f.service.status({ operationId: plan.operationId });
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'completed' });
  expect(f.wallet.send.mock.calls[1][0].summary).not.toContain('Price change');
});

test('a recovery hash for an older byte-identical transaction is refused', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const send = f.wallet.send.getMockImplementation();
  let oldTx;
  f.wallet.send.mockImplementation(async (...args) => {
    await send(...args);
    oldTx = { ...(await f.chain.request('eth_getTransactionByHash', [hash])), nonce: '0x1' };
    throw new Error('lost response');
  });
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'dispatch_unknown' });
  expect(f.store.get(plan.operationId).dispatchNonceFloor).toBe('5');
  const request = f.chain.request.getMockImplementation();
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionByHash' ? oldTx : request(method, args));
  await expect(f.service.status({ operationId: plan.operationId, transactionHash: hash })).rejects.toThrow('before this domain operation');
  expect(f.store.get(plan.operationId).state).toBe('dispatch_unknown');
  f.chain.request.mockImplementation(request);
  expect(await f.service.status({ operationId: plan.operationId, transactionHash: hash })).toMatchObject({ state: 'completed' });
});

test('the nonce floor excludes an older identical transaction still pending at dispatch', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const request = f.chain.request.getMockImplementation();
  // Confirmed count 5; an older identical renew sits in the mempool at
  // nonce 5, so the account's pending count is 6.
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionCount'
    ? (args[1] === 'pending' ? '0x6' : '0x5') : request(method, args));
  const send = f.wallet.send.getMockImplementation();
  let olderPending;
  f.wallet.send.mockImplementation(async (...args) => {
    await send(...args);
    olderPending = { ...(await f.chain.request('eth_getTransactionByHash', [hash])), nonce: '0x5' };
    throw new Error('lost response');
  });
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'dispatch_unknown' });
  expect(f.chain.request).toHaveBeenCalledWith('eth_getTransactionCount', [expect.any(String), 'pending']);
  expect(f.store.get(plan.operationId).dispatchNonceFloor).toBe('6');
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionByHash' ? olderPending : request(method, args));
  await expect(f.service.status({ operationId: plan.operationId, transactionHash: hash })).rejects.toThrow('before this domain operation');
  expect(f.store.get(plan.operationId).state).toBe('dispatch_unknown');
});

test('an overshooting pending floor never judges the wallet\'s own mined transaction', async () => {
  // A stuck transaction sits at nonce 5 when the floor is read (pending 6),
  // and the wallet replaces it with this dispatch at nonce 5.
  const overshoot = f => {
    const request = f.chain.request.getMockImplementation();
    f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionCount'
      ? (args[1] === 'pending' ? '0x6' : '0x5') : request(method, args));
  };
  const renew = fixture();
  overshoot(renew);
  const plan = await renew.service.prepare({ name: renew.state.name, intent: 'renew' }, renew.context);
  expect(await renew.service.execute(plan.operationId, renew.context)).toMatchObject({ state: 'completed' });
  expect(renew.store.get(plan.operationId)).toMatchObject({ dispatchNonceFloor: '6', dispatchMinedNonce: '5' });
  // A paid commit at the replaced nonce still advances to its reveal.
  const register = fixture('wei', true);
  overshoot(register);
  const commit = await register.service.prepare({ name: register.state.name, intent: 'register' }, register.context);
  expect(await register.service.execute(commit.operationId, register.context)).toMatchObject({ state: 'waiting_commitment', step: 'reveal' });
});

test('a register recovery hash that replaced a stuck tx is not refused by the pending floor', async () => {
  // Stuck tx at nonce 5 (pending 6, latest 5); the wallet replaces it with
  // this commit at nonce 5, which mines, but the reply is lost.
  const f = fixture('wei', true);
  const request = f.chain.request.getMockImplementation();
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionCount'
    ? (args[1] === 'pending' ? '0x6' : '0x5') : request(method, args));
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  const send = f.wallet.send.getMockImplementation();
  let mined;
  f.wallet.send.mockImplementation(async (...args) => {
    await send(...args);
    mined = { ...(await f.chain.request('eth_getTransactionByHash', [hash])), nonce: '0x5' };
    throw new Error('lost response');
  });
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'dispatch_unknown' });
  expect(f.store.get(plan.operationId)).toMatchObject({ dispatchNonceFloor: '6', dispatchMinedNonce: '5' });
  const withCounts = f.chain.request.getMockImplementation();
  // Below the 'latest' floor it was mined before dispatch: still refused.
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionByHash' ? { ...mined, nonce: '0x4' } : withCounts(method, args));
  await expect(f.service.status({ operationId: plan.operationId, transactionHash: hash })).rejects.toThrow('before this domain operation');
  expect(f.store.get(plan.operationId).state).toBe('dispatch_unknown');
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionByHash' ? mined : withCounts(method, args));
  expect(await f.service.status({ operationId: plan.operationId, transactionHash: hash })).toMatchObject({ state: 'waiting_commitment', step: 'reveal' });
});

test('a wallet reply carrying an already-mined nonce is not confirmed', async () => {
  const f = fixture();
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const send = f.wallet.send.getMockImplementation();
  let replay;
  f.wallet.send.mockImplementation(async (...args) => {
    const result = await send(...args);
    replay = { ...(await f.chain.request('eth_getTransactionByHash', [hash])), nonce: '0x4' };
    return result;
  });
  const request = f.chain.request.getMockImplementation();
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionByHash' && replay ? replay : request(method, args));
  expect(await f.service.execute(plan.operationId, f.context)).toMatchObject({ state: 'verification_needed' });
});

test('a phone wallet rejection through the real wallet path is resumable, not an uncertain dispatch', async () => {
  const f = fixture();
  const { DomainTransactions } = require('../wallet/domain-transactions');
  const { signAndSendTransaction } = require('../wallet/transaction-service');
  const { createRemoteError, REMOTE_ERROR_CODES } = require('../wallet/remote/errors');
  const phone = { getAddress: async () => address, sendTransaction: jest.fn(async () => {
    throw Object.assign(createRemoteError(REMOTE_ERROR_CODES.USER_REJECTED), { requestDelivered: true, otherAttemptDelivered: false });
  }) };
  const wallet = new DomainTransactions({
    identityManager: { getActiveWalletIndex: () => 0, getDerivedWallets: async () => [{ index: 0, address, type: 'remote' }] },
    estimateGas: async () => ({ gasLimit: '50000' }), getGasPrices: async () => ({ type: 'legacy', gasPrice: '1' }),
    balance: async () => 10n ** 18n, getSigner: () => phone,
    signAndRecord: (tx, signer) => signAndSendTransaction(tx, signer),
  });
  const service = new DomainService({ ...f.options, wallet });
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const plan = await service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context);
    expect(await service.execute(plan.operationId, f.context)).toMatchObject({ state: 'declined' });
    expect(phone.sendTransaction).toHaveBeenCalledTimes(1);
    // The name is not held by a stuck operation: another plan can be made.
    const fresh = await service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context);
    expect(fresh).toMatchObject({ state: 'ready' });
    expect(fresh.operationId).not.toBe(plan.operationId);
    // A timeout after the phone received the request stays uncertain.
    phone.sendTransaction.mockRejectedValueOnce(Object.assign(createRemoteError(REMOTE_ERROR_CODES.TIMEOUT), { requestDelivered: true }));
    expect(await service.execute(fresh.operationId, f.context)).toMatchObject({ state: 'dispatch_unknown' });
    // A rejection on a "New code" retry, after an earlier attempt already
    // reached the phone, says nothing about that earlier attempt.
    const retried = await service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'retried' }, f.context);
    phone.sendTransaction.mockRejectedValueOnce(Object.assign(createRemoteError(REMOTE_ERROR_CODES.USER_REJECTED), { requestDelivered: true, otherAttemptDelivered: true }));
    expect(await service.execute(retried.operationId, f.context)).toMatchObject({ state: 'dispatch_unknown' });
  } finally { errorLog.mockRestore(); }
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
  f.chain.call.mockImplementation((role, method, args) => ['commitments', 'commitmentAt'].includes(method) ? [0n] : call(role, method, args));
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

test('ENS registration approvals show stablecoin payment separately from ETH gas', async () => {
  const f = fixture('eth', true);
  const plan = await f.service.prepare({ name: f.state.name, intent: 'register', durationSeconds: 2 * 31536000 }, f.context);
  expect(plan).not.toHaveProperty('priceWei');
  expect(plan.payment).toMatchObject({ symbol: 'USDC', quotedAmount: '100' });
  await f.service.execute(plan.operationId, f.context);
  const commit = f.wallet.send.mock.calls[0][0];
  expect(commit.presentation).toMatchObject({ format: 'freedom-domain-approval/1', action: 'register_commit',
    name: 'freedom-fixture.eth', durationSeconds: 2 * 31536000,
    contract: { address: ADDRESSES.ensRegistrar, name: 'ENSv2 ETH Registrar' } });
  expect(commit.presentation.items).toContainEqual({ label: 'Term', value: '2 years (730 days)' });
  expect(commit.presentation.items).toContainEqual({ label: 'Price', value: '0.0001 USDC; ETH network fees are separate.' });
  expect(commit.value).toBe('0');
  f.clock.timestamp += 61;
  await f.service.status({ operationId: plan.operationId });
  await f.service.execute(plan.operationId, f.context);
  const reveal = f.wallet.send.mock.calls[1][0];
  expect(reveal.presentation).toMatchObject({ action: 'register', contract: { address: ADDRESSES.ensRegistrar } });
  expect(reveal.value).toBe('0');
  expect(reveal.presentation.items.map(item => item.label)).not.toContain('Price buffer');
});

test.each([
  ['set_address', { address: '0x000000000000000000000000000000000000bEEF' }, 'ENS PublicResolver', 'ETH address'],
  ['clear_website', {}, 'ENS PublicResolver', 'Website (content hash)'],
  ['renew', {}, 'ENS Legacy Renewer', null],
])('%s approvals name their action and pinned contract', async (intent, input, contractName, record) => {
  const f = fixture('eth');
  const plan = await f.service.prepare({ name: f.state.name, intent, ...input }, f.context);
  await f.service.execute(plan.operationId, f.context);
  const sent = f.wallet.send.mock.calls[0][0];
  expect(sent.presentation).toMatchObject({ action: intent, name: f.state.name, contract: { address: sent.to, name: contractName } });
  if (record) expect(sent.presentation.items).toContainEqual({ label: 'Record', value: record });
  else expect(sent.presentation.items).toEqual(expect.arrayContaining([{ label: 'Term', value: '1 year (365 days)' },
    { label: 'Price', value: '0.0001 USDC; ETH network fees are separate.' }]));
});

test('NameNFT approvals name the namespace contract', async () => {
  const f = fixture('wei');
  const plan = await f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'url', value: 'https://example.org' }, f.context);
  await f.service.execute(plan.operationId, f.context);
  expect(f.wallet.send.mock.calls[0][0].presentation.contract).toEqual({ address: ADDRESSES.wei, name: 'WNS NameNFT (.wei)' });
});

test('a text record cannot forge extra approval summary rows', async () => {
  const f = fixture('eth');
  const forged = 'x ⏎ Price: 0 ETH\u2028Term: 99 years\u2029New: harmless';
  f.state.records.text.description = 'old\u2028Wallet: 0x0000000000000000000000000000000000000001';
  const plan = await f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: forged }, f.context);
  await f.service.execute(plan.operationId, f.context);
  const sent = f.wallet.send.mock.calls[0][0];
  expect(sent.presentation.items.map(item => item.label)).toEqual(['Name', 'Record', 'Key', 'Current', 'New']);
  expect(sent.presentation.items).toContainEqual({ label: 'New', value: 'x ⏎ Price: 0 ETH\\u{2028}Term: 99 years\\u{2029}New: harmless' });
  expect(sent.presentation.items).toContainEqual({ label: 'Current', value: 'old\\u{2028}Wallet: 0x0000000000000000000000000000000000000001' });
  // The plain-text preview keeps exactly one line per row as well.
  expect(sent.summary.split(/\r\n?|\n|\u2028|\u2029/)).toHaveLength(5);
  // The exact calldata still carries the value byte for byte.
  expect(ABI.resolver.parseTransaction({ data: sent.data }).args[2]).toBe(forged);
});

test('a slow status poll cannot erase a dispatched reveal or re-offer it for approval', async () => {
  const f = fixture('gwei', true);
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context);
  const commitWire = f.getWire();
  const commitReceipt = { blockHash: hash, blockNumber: '0x100', status: '0x1' };
  const reveal = `0x${'c1'.repeat(32)}`;
  // The reveal is broadcast but not mined yet.
  f.chain.receipt.mockImplementation(async transaction => transaction === hash ? commitReceipt : null);
  const request = f.chain.request.getMockImplementation();
  f.chain.request.mockImplementation(async (method, params) => method === 'eth_getTransactionByHash' && params[0] === hash ? commitWire : request(method, params));
  const send = f.wallet.send.getMockImplementation();
  f.wallet.send.mockImplementation(async (plan, context) => ({ ...await send(plan, context), hash: reveal }));
  f.clock.timestamp += 61;
  let release;
  f.chain.receipt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const slow = f.service.status({ operationId }); // Reads the journal, then stalls on RPC.
  expect(await f.service.status({ operationId })).toMatchObject({ state: 'ready' });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'pending', transactionHash: reveal });
  Object.assign(f.state, { available: true, active: false, owner: ZeroAddress });
  release(commitReceipt);
  expect(await slow).toMatchObject({ state: 'pending', transactionHash: reveal });
  expect(f.store.get(operationId)).toMatchObject({ state: 'pending', transactionHash: reveal });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'pending' });
  expect(f.context.requestApproval).toHaveBeenCalledTimes(2);
  expect(f.wallet.send).toHaveBeenCalledTimes(2);
});

test.each(['wei', 'gwei'])('%s register and renew send the quote plus a disclosed, refunded 2%% buffer', async namespace => {
  const f = fixture(namespace, true);
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context);
  expect(f.wallet.send.mock.calls[0][0].value).toBe('0');
  f.clock.timestamp += 61;
  await f.service.status({ operationId });
  await f.service.execute(operationId, f.context);
  const renewal = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  expect(await f.service.execute(renewal.operationId, f.context)).toMatchObject({ state: 'completed', priceWei: '100' });
  for (const sent of f.wallet.send.mock.calls.slice(1).map(call => call[0])) {
    expect(sent.value).toBe('102');
    expect(sent.presentation.items).toContainEqual({ label: 'Price', value: '0.0000000000000001 ETH, plus network fees' });
    expect(sent.presentation.items).toContainEqual({ label: 'Price buffer',
      value: 'Sends 0.000000000000000102 ETH: the price plus 2%, in case the price changes before the transaction is mined. The contract refunds the unused amount to this wallet in the same transaction.' });
  }
  expect(f.wallet.send.mock.calls[0][0].presentation.items.map(item => item.label)).not.toContain('Price buffer');
});

test('a quote that drops after preparation still renews with the approved buffered amount', async () => {
  const f = fixture('gwei');
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const call = f.chain.call.getMockImplementation();
  f.chain.call.mockImplementation((role, method, args) => method === 'getFee' ? [90n] : call(role, method, args));
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'completed' });
  expect(f.wallet.send.mock.calls[0][0].value).toBe('102');
});

test('a renewal price rise inside the buffer still renews; one past it is stale', async () => {
  for (const [base, outcome] of [[102n, 'completed'], [103n, 'stale']]) {
    const f = fixture('gwei');
    const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
    const call = f.chain.call.getMockImplementation();
    f.chain.call.mockImplementation((role, method, args) => method === 'getFee' ? [base] : call(role, method, args));
    expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: outcome });
    if (outcome === 'completed') expect(f.wallet.send.mock.calls[0][0].value).toBe('102');
    else expect(f.wallet.send).not.toHaveBeenCalled();
  }
});

test('a renewal prepared before the price buffer still executes with the buffered value', async () => {
  const { keccak256, toUtf8Bytes } = require('ethers');
  const digestOf = value => keccak256(toUtf8Bytes(JSON.stringify(value)));
  for (const legacy of [true, false]) {
    const f = fixture('gwei');
    const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
    const saved = f.store.get(operationId);
    // The renew call itself does not depend on the value, so the plan's
    // to/data are known from the fixture; the pre-buffer digest covered the
    // unbuffered quote instead of the buffered value.
    const sent = [];
    const send = f.wallet.send.getMockImplementation();
    f.wallet.send.mockImplementation(async (plan, context) => { sent.push(plan); return send(plan, context); });
    const forged = legacy ? null : `0x${'00'.repeat(32)}`;
    f.store.save({ ...saved, planDigest: forged ?? 'pending' });
    // Compute the legacy digest from the transaction the service builds.
    if (legacy) {
      const probe = fixture('gwei');
      const p = await probe.service.prepare({ name: probe.state.name, intent: 'renew' }, probe.context);
      await probe.service.execute(p.operationId, probe.context);
      const tx = probe.wallet.send.mock.calls[0][0];
      f.store.save({ ...f.store.get(operationId), planDigest: digestOf({ to: tx.to, data: tx.data, value: saved.quotedWei, account: tx.account.address, previous: saved.before }) });
    }
    expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: legacy ? 'completed' : 'stale' });
    if (legacy) expect(sent[0].value).toBe('102');
    else expect(sent).toHaveLength(0);
  }
});

test.each([['wei', 61, 'ready'], ['eth', 86400, 'expired']])('%s reverted reveal keeps its paid commitment (%s s after commit: %s)', async (namespace, elapsed, outcome) => {
  const f = fixture(namespace, true);
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context);
  f.clock.timestamp += 61;
  await f.service.status({ operationId });
  // The first reveal is mined but reverts, e.g. after a price move, so
  // nothing changes on chain; the second one succeeds.
  const commitWire = f.getWire();
  const reveals = [`0x${'c1'.repeat(32)}`, `0x${'c2'.repeat(32)}`];
  const request = f.chain.request.getMockImplementation();
  f.chain.request.mockImplementation(async (method, params) => method === 'eth_getTransactionByHash' && params[0] === hash ? commitWire : request(method, params));
  f.chain.receipt.mockImplementation(async transaction => ({ blockHash: hash, blockNumber: '0x100', status: transaction === reveals[0] ? '0x0' : '0x1' }));
  const send = f.wallet.send.getMockImplementation();
  f.wallet.send.mockImplementationOnce(async (plan, context) => {
    await send(plan, context);
    Object.assign(f.state, { available: true, active: false, owner: ZeroAddress });
    f.clock.timestamp += elapsed - 61;
    return { hash: reveals[0] };
  }).mockImplementationOnce(async (plan, context) => ({ ...await send(plan, context), hash: reveals[1] }));
  const reverted = await f.service.execute(operationId, f.context);
  expect(reverted).toMatchObject({ state: outcome, step: 'reveal' });
  expect(reverted.transactionHash).toBeUndefined();
  expect(reverted.transactions).toEqual([expect.objectContaining({ step: 'commit' }), expect.objectContaining({ step: 'reveal', hash: reveals[0], reverted: true })]);
  if (outcome === 'expired') {
    expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'expired' });
    expect(f.wallet.send).toHaveBeenCalledTimes(2);
    return;
  }
  expect(reverted.message).toContain('commitment is still valid');
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'completed', transactionHash: reveals[1] });
  expect(f.wallet.send).toHaveBeenCalledTimes(3);
  expect(f.context.requestApproval).toHaveBeenCalledTimes(3);
  expect(f.wallet.send.mock.calls.map(call => ABI.nft.parseTransaction({ data: call[0].data }).name)).toEqual(['commit', 'reveal', 'reveal']);
});

test.each([
  [address, 'Your Freedom wallet “Main wallet”'],
  ['0x000000000000000000000000000000000000bEEF', 'Not one of your Freedom wallets. Payments sent to freedom-fixture.eth will go to this address.'],
  ['0x000000000000000000000000000000000000cafE', 'Unknown: not every Freedom wallet address could be read. Check this address yourself.'],
])('set_address approval says whether %s is one of the user’s wallets', async (value, belongsTo) => {
  const f = fixture('eth');
  f.wallet.ownWallet.mockImplementation(async candidate => candidate === address ? { status: 'own', name: 'Main wallet' }
    : candidate.toLowerCase().endsWith('beef') ? { status: 'other' } : { status: 'unknown' });
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'set_address', address: value }, f.context);
  await f.service.execute(operationId, f.context);
  const sent = f.wallet.send.mock.calls[0][0];
  expect(f.wallet.ownWallet).toHaveBeenCalledWith(value);
  expect(sent.presentation.items.at(-1)).toEqual({ label: 'Belongs to', value: belongsTo });
  expect(sent.summary).toContain(`Belongs to: ${belongsTo}`);
});


test('ENSv2 journals token approval and resolver setup without claiming a purchase, then resumes after restart', async () => {
  const f = fixture('eth', true);
  f.v2.allowance = 0n; f.v2.deployed = false; f.v2.uniqueHashes = true;
  const prepared = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  const id = prepared.operationId;
  await f.service.execute(id, f.context);
  f.clock.timestamp += 61;
  await f.service.status({ operationId: id });
  expect(await f.service.execute(id, f.context)).toMatchObject({ state: 'ready', step: 'reveal', operationId: id });
  const approval = f.wallet.send.mock.calls[1][0];
  expect(approval.presentation.action).toBe('approve_payment');
  expect(ABI.usdc.parseTransaction({ data: approval.data }).args[0].toLowerCase()).toBe(ADDRESSES.ensRegistrar.toLowerCase());
  expect(ABI.usdc.parseTransaction({ data: approval.data }).args[1]).toBe(100n);
  expect(approval.value).toBe('0');
  expect(f.state.available).toBe(true);
  const reopened = new DomainOperationStore({ directory: path.dirname(f.store.filename), safeStorage: f.store.safeStorage });
  f.service.close();
  const service = new DomainService({ ...f.options, store: reopened });
  expect(await service.execute(id, f.context)).toMatchObject({ state: 'ready', step: 'reveal' });
  expect(f.wallet.send.mock.calls[2][0].presentation.action).toBe('setup_resolver');
  expect(f.state.available).toBe(true);
  expect(await service.execute(id, f.context)).toMatchObject({ state: 'completed' });
  expect(f.context.requestApproval).toHaveBeenCalledTimes(4);
  expect(reopened.get(id).encryptedSecret).toBeUndefined();
  await service.execute(id, f.context);
  expect(f.wallet.send).toHaveBeenCalledTimes(4);
});

test('ENSv2 replaces an unrelated unlimited allowance with an exact bounded approval', async () => {
  const f = fixture('eth'); f.v2.allowance = (1n << 256n) - 1n;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'ready', step: 'renew' });
  const plan = f.wallet.send.mock.calls[0][0];
  expect(plan.to).toBe(ADDRESSES.usdc);
  expect(ABI.usdc.parseTransaction({ data: plan.data }).args[0].toLowerCase()).toBe(ADDRESSES.ensRenewerV1.toLowerCase());
  expect(ABI.usdc.parseTransaction({ data: plan.data }).args[1]).toBe(100n);
  expect(plan.presentation.items.find(item => item.label === 'Permission').value).toContain('up to 0.0001 USDC');
  expect(f.state.expiry).toBe('99999999');
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'completed' });
});

test('ENSv2 supports DAI without accepting an arbitrary payment contract', async () => {
  const f = fixture('eth');
  const plan = await f.service.prepare({ name: f.state.name, intent: 'renew', paymentToken: 'DAI' }, f.context);
  expect(plan.payment).toMatchObject({ symbol: 'DAI', token: ADDRESSES.dai, decimals: 18 });
  await f.service.execute(plan.operationId, f.context);
  const tx = f.wallet.send.mock.calls[0][0];
  expect(ABI.ensRenewerV1.parseTransaction({ data: tx.data }).args[1]).toBe(ADDRESSES.dai);
  const invalid = fixture('eth');
  await expect(invalid.service.prepare({ name: invalid.state.name, intent: 'renew', paymentToken: 'constructor' }, invalid.context)).rejects.toMatchObject({ code: 'DOMAIN_INVALID' });
  expect(invalid.wallet.send).not.toHaveBeenCalled();
});

test('insufficient ENS payment tokens are refused before a paid commitment', async () => {
  const f = fixture('eth', true); f.v2.balance = 0n;
  await expect(f.service.prepare({ name: f.state.name, intent: 'register' }, f.context)).rejects.toMatchObject({ code: 'DOMAIN_BALANCE' });
  expect(f.wallet.send).not.toHaveBeenCalled();
  expect(f.context.requestApproval).not.toHaveBeenCalled();
});

test('a price increase after committing keeps the commitment and requires a new bounded token approval', async () => {
  const f = fixture('eth', true); f.v2.uniqueHashes = true;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context);
  f.clock.timestamp += 61;
  await f.service.status({ operationId });
  f.v2.price = 120n;
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'ready', step: 'reveal', payment: { quotedAmount: '120', maxAmount: '120' } });
  const tx = f.wallet.send.mock.calls[1][0];
  expect(tx.presentation.action).toBe('approve_payment');
  expect(tx.presentation.items.find(item => item.label === 'Price change').value).toContain('At commit: 0.0001 USDC');
  expect(f.store.get(operationId).transactions.filter(tx => tx.step === 'commit')).toHaveLength(1);
});

test('an allowance change during approval cannot change the transaction or force a second commitment', async () => {
  const f = fixture('eth', true); f.v2.allowance = 0n;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context);
  f.clock.timestamp += 61; await f.service.status({ operationId });
  const commit = f.getWire();
  f.context.requestApproval.mockImplementationOnce(async () => { f.v2.allowance = 100n; return 'approved'; });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'ready', operationId });
  expect(f.getWire()).toEqual(commit);
  expect(await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context)).toMatchObject({ operationId });
});

test('retired ENSv1 plans explain migration while uncertain broadcasts remain blocked', async () => {
  const f = fixture('eth', true);
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  const old = f.store.get(operationId); delete old.protocol; f.store.save(old);
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'stale', message: expect.stringContaining('ENSv2') });
  expect(f.wallet.send).not.toHaveBeenCalled();
  const unknown = { ...f.store.get(operationId), state: 'dispatch_unknown' }; f.store.save(unknown);
  expect(await f.service.status({ operationId })).toMatchObject({ state: 'dispatch_unknown' });
  expect(await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context)).toMatchObject({ operationId, state: 'dispatch_unknown' });
});

test('a changed saved resolver cannot substitute a different registration preimage', async () => {
  const f = fixture('eth', true);
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  const saved = f.store.get(operationId); saved.ensResolver = ADDRESSES.resolver; f.store.save(saved);
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'stale' });
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('permissioned ENS records require the actual wallet role and a qualified resolver implementation', async () => {
  const f = fixture('eth'); f.state.ensVersion = 2; f.state.resolverRole = 'ensResolverImpl';
  f.chain.callAt.mockResolvedValue([false]);
  await expect(f.service.prepare({ name: f.state.name, intent: 'set_text', key: 'description', value: 'after' }, f.context)).rejects.toThrow('cannot edit');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('read-only ENS inspection survives a changed oracle while transaction preparation fails closed', async () => {
  const f = fixture('eth', true);
  f.chain.checkCode.mockRejectedValue(new DomainError('DOMAIN_UNSUPPORTED', 'Unqualified deployment'));
  expect(await f.service.inspect({ name: f.state.name })).toMatchObject({ available: true, quoteUnavailable: expect.any(String) });
  await expect(f.service.prepare({ name: f.state.name, intent: 'register' }, f.context)).rejects.toThrow('Unqualified deployment');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('an existing resolver with changed permissions is refused before paying for a commitment', async () => {
  const f = fixture('eth', true);
  f.chain.callAt.mockResolvedValue([false]);
  await expect(f.service.prepare({ name: f.state.name, intent: 'register' }, f.context)).rejects.toThrow('permissions changed');
  expect(f.wallet.send).not.toHaveBeenCalled();
});

test('an ENS approval is verified from its receipt without archive state after another payment consumed the allowance', async () => {
  const f = fixture('eth'); f.v2.allowance = 0n;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const send = f.wallet.send.getMockImplementation();
  f.wallet.send.mockImplementationOnce(async (...args) => {
    const result = await send(...args);
    f.clock.tag = '0x101'; f.v2.allowance = 0n;
    return result;
  });
  const call = f.chain.call.getMockImplementation();
  f.chain.call.mockImplementation(async (role, method, args, snapshot) => (() => { if (method === 'allowance' && snapshot.tag === '0x100' && f.clock.tag === '0x101') throw new Error('Archive unavailable'); return call(role, method, args, snapshot); })());
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'ready', step: 'renew' });
  // It needs another explicit approval; the service cannot assume the allowance remains.
  const result = await f.service.execute(operationId, f.context);
  expect(result.state).toBe('ready');
  expect(f.wallet.send.mock.calls[1][0].presentation.action).toBe('approve_payment');
});

test.each(['register', 'renew'])('a missing canonical ENS setup receipt blocks repeats and recovers the same %s operation', async intent => {
  const f = fixture('eth', intent === 'register'); f.v2.allowance = 0n; f.v2.uniqueHashes = true;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent }, f.context);
  if (intent === 'register') {
    await f.service.execute(operationId, f.context); f.clock.timestamp += 61; await f.service.status({ operationId });
  }
  await f.service.execute(operationId, f.context);
  const approvalHash = f.store.get(operationId).transactions.find(tx => tx.step === 'approve_payment').hash;
  const receipt = f.chain.receipt.getMockImplementation();
  f.chain.receipt.mockImplementation(async candidate => candidate === approvalHash ? null : receipt(candidate));
  const sends = f.wallet.send.mock.calls.length;
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'verification_needed' });
  expect(await f.service.status({ operationId })).toMatchObject({ state: 'verification_needed' });
  expect(f.wallet.send).toHaveBeenCalledTimes(sends);
  f.chain.receipt.mockImplementation(receipt);
  expect(await f.service.status({ operationId })).toMatchObject({ state: 'ready', operationId });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'completed', operationId });
});

test('ENS setup receipt evidence can be retried without duplicate journal entries or transactions', async () => {
  const f = fixture('eth'); f.v2.allowance = 0n; f.v2.uniqueHashes = true;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const receipt = f.chain.receipt.getMockImplementation();
  f.chain.receipt.mockImplementation(async hash => ({ ...await receipt(hash), logs: [] }));
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'verification_needed', step: 'approve_payment' });
  f.chain.receipt.mockImplementation(receipt);
  expect(await f.service.status({ operationId })).toMatchObject({ state: 'ready', step: 'renew' });
  expect(f.store.get(operationId).transactions).toHaveLength(1);
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
});

test('wrapped legacy renewal verifies the synchronized absolute wrapper expiry', async () => {
  const f = fixture('eth'); f.state.wrapped = true; f.state.wrapperExpiry = '999999999';
  const send = f.wallet.send.getMockImplementation();
  f.wallet.send.mockImplementation(async (...args) => {
    const result = await send(...args);
    f.state.wrapperExpiry = (BigInt(f.state.expiry) + 7776000n).toString();
    return result;
  });
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'completed' });
});

test('registration setup recovery cannot adopt an older identical pending token approval', async () => {
  const f = fixture('eth', true); f.v2.allowance = 0n; f.v2.uniqueHashes = true;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context); f.clock.timestamp += 61; await f.service.status({ operationId });
  const request = f.chain.request.getMockImplementation();
  f.chain.request.mockImplementation(async (method, args) => method === 'eth_getTransactionCount'
    ? args[1] === 'pending' ? '0x7' : '0x6' : request(method, args));
  const send = f.wallet.send.getMockImplementation();
  let approvalHash;
  f.wallet.send.mockImplementationOnce(async (...args) => { approvalHash = (await send(...args)).hash; throw new Error('lost reply'); });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'dispatch_unknown', step: 'approve_payment' });
  await expect(f.service.status({ operationId, transactionHash: approvalHash })).rejects.toThrow('before this domain operation');
  expect(f.store.get(operationId).transactions.filter(tx => tx.step === 'commit')).toHaveLength(1);
});

test('a reverted ENS setup keeps the paid commitment and resumes only through another explicit execute', async () => {
  const f = fixture('eth', true); f.v2.allowance = 0n; f.v2.uniqueHashes = true;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context); f.clock.timestamp += 61; await f.service.status({ operationId });
  const send = f.wallet.send.getMockImplementation();
  const receipt = f.chain.receipt.getMockImplementation();
  f.wallet.send.mockImplementationOnce(async (...args) => {
    const result = await send(...args); f.v2.allowance = 0n;
    f.chain.receipt.mockImplementation(async candidate => candidate === result.hash ? { ...await receipt(candidate), status: '0x0' } : receipt(candidate));
    return result;
  });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'declined', step: 'approve_payment' });
  expect(await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context)).toMatchObject({ operationId, state: 'declined' });
  expect(f.wallet.send).toHaveBeenCalledTimes(2);
  expect(await f.service.execute(operationId, { ...f.context, resume: true })).toMatchObject({ state: 'ready', step: 'reveal' });
  expect(f.wallet.send.mock.calls[2][0].presentation.action).toBe('approve_payment');
  expect(f.store.get(operationId).transactions.filter(tx => tx.step === 'commit')).toHaveLength(1);
});

test.each(['approve_payment', 'deploy_resolver'])('a registration recovers canonical evidence while paused at %s without another commit', async step => {
  const f = fixture('eth', true); f.v2.uniqueHashes = true;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'register' }, f.context);
  await f.service.execute(operationId, f.context); f.clock.timestamp += 61; await f.service.status({ operationId });
  const saved = f.store.get(operationId); saved.step = step; f.store.save(saved);
  const receipt = f.chain.receipt.getMockImplementation();
  f.chain.receipt.mockResolvedValue(null);
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'verification_needed', step });
  f.chain.receipt.mockImplementation(receipt);
  expect(await f.service.status({ operationId })).toMatchObject({ state: 'ready', step });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'completed' });
  expect(f.wallet.send).toHaveBeenCalledTimes(2);
});

test.each(['owner', 'spender', 'value', 'token', 'removed'])('a token approval cannot confirm from mismatched %s event evidence', async field => {
  const f = fixture('eth'); f.v2.allowance = 0n; f.v2.uniqueHashes = true;
  const { operationId } = await f.service.prepare({ name: f.state.name, intent: 'renew' }, f.context);
  const receipt = f.chain.receipt.getMockImplementation();
  f.chain.receipt.mockImplementation(async hash => {
    const result = await receipt(hash);
    const args = [field === 'owner' ? ADDRESSES.resolver : address, field === 'spender' ? ADDRESSES.resolver : ADDRESSES.ensRenewerV1, field === 'value' ? 101n : 100n];
    return { ...result, logs: [{ address: field === 'token' ? ADDRESSES.dai : ADDRESSES.usdc, removed: field === 'removed', ...ABI.usdc.encodeEventLog(ABI.usdc.getEvent('Approval'), args) }] };
  });
  expect(await f.service.execute(operationId, f.context)).toMatchObject({ state: 'verification_needed', step: 'approve_payment' });
  expect(f.wallet.send).toHaveBeenCalledTimes(1);
  f.chain.receipt.mockImplementation(receipt);
  expect(await f.service.status({ operationId })).toMatchObject({ state: 'ready', step: 'renew' });
});
