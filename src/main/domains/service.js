'use strict';

const crypto = require('crypto');
const { getAddress, keccak256, toUtf8Bytes } = require('ethers');
const { ADDRESSES, ABI, DomainError, refuse, parseName, swarmContenthash, registrationTuple, commitmentFor, ZeroAddress } = require('./contracts');
const { DomainChain, sameAddress } = require('./chain');
const { DomainTransactions } = require('../wallet/domain-transactions');
const YEAR = 31536000;
const INTENTS = ['set_website', 'clear_website', 'set_address', 'set_text', 'register', 'renew'];
const WAITING = new Set(['pending', 'waiting_commitment']);
const TERMINAL = new Set(['completed', 'failed', 'declined', 'expired', 'dispatch_unknown', 'verification_needed', 'stale']);
const digest = value => keccak256(toUtf8Bytes(JSON.stringify(value)));
const pause = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
  const done = () => { cleanup(); resolve(); };
  const aborted = () => { cleanup(); reject(new DomainError('DOMAIN_STOPPED', 'Observation stopped. Submitted transactions are not undone.')); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
});

function publicOperation(operation) {
  // Positive allowlist: no encrypted secret, commitment preimage, calldata,
  // thrown RPC text or signer internals can enter Agent history/tool output.
  return { operationId: operation.id, name: operation.name, namespace: operation.namespace,
    intent: operation.intent, state: operation.state, step: operation.step, chainId: 1,
    account: operation.account, ...(operation.duration && { durationSeconds: operation.duration }),
    ...(operation.publicationId && { publicationId: operation.publicationId, bzzUrl: `bzz://${operation.reference}` }),
    ...(operation.record && { record: operation.record }),
    ...(operation.before && { previous: operation.before }),
    ...(operation.quotedWei && { priceWei: operation.quotedWei }),
    ...(operation.transactionHash && { transactionHash: operation.transactionHash }),
    ...(operation.transactions?.length && { transactions: operation.transactions }),
    ...(operation.readyAt && { readyAt: operation.readyAt, expiresAt: operation.expiresAt }),
    ...(operation.resolutionVerified !== undefined && { resolutionVerified: operation.resolutionVerified }),
    ...(operation.message && { message: operation.message }),
    nextAction: operation.state === 'ready' ? 'Call domain_execute for the next separately approved step.'
      : WAITING.has(operation.state) ? 'Wait on this operation with domain_operation_status. Do not prepare or send a duplicate.'
        : operation.state === 'dispatch_unknown' ? 'Do not resend. Reconcile the existing wallet transaction history and on-chain state first.' : undefined };
}

class DomainService {
  constructor(options) {
    this.store = options.store;
    this.chain = options.chain || new DomainChain();
    this.wallet = options.wallet || new DomainTransactions();
    this.getPublication = options.getPublication;
    this.verifyResolution = options.verifyResolution || (async (name, reference) => {
      const resolver = require('../ens-resolver');
      resolver.invalidateEnsContent(name);
      const result = await resolver.resolveEnsContent(name);
      return result?.uri === `bzz://${reference}`;
    });
    this.pollMs = options.pollMs ?? 2000;
    this.executeWaitMs = options.executeWaitMs ?? 30000;
    this.locks = new Set();
    this.preparations = new Set();
    this.closed = false;
  }
  async inspect(input) {
    const parsed = parseName(input.name);
    const keys = input.textKeys || [];
    if (!Array.isArray(keys) || keys.length > 8 || keys.some(key => typeof key !== 'string' || !key || key.length > 128 || /[\p{Cc}\p{Cf}]/u.test(key))) refuse('Request at most eight bounded text-record keys.', 'DOMAIN_INVALID');
    const state = await this.chain.inspect(parsed, keys);
    let quote;
    if (parsed.topLevel) {
      const duration = input.durationSeconds ?? YEAR;
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 10 * YEAR ||
          (parsed.namespace !== 'eth' && duration !== YEAR)) refuse('Use a supported term: .wei/.gwei require one 365-day year per transaction.', 'DOMAIN_INVALID');
      const role = parsed.namespace === 'eth' ? state.wrapped ? 'wrappedController' : 'controller' : parsed.namespace;
      quote = { purpose: state.available ? 'registration' : 'renewal', durationSeconds: duration,
        priceWei: await this.#price({ ...parsed, duration }, role, state.snapshot, state.available),
        currency: 'ETH', networkFeesExtra: true };
    }
    return { ...state, network: 'Ethereum mainnet',
      ...(quote && { quote }),
      supportedActions: [...(state.active && state.supportedResolver ? ['set_website', 'clear_website', 'set_address', 'set_text'] : []),
        ...(parsed.topLevel && state.available ? ['register'] : parsed.topLevel && state.expiry && state.expiry !== '0' ? ['renew'] : [])],
      note: state.supportedResolver ? 'Contract calls still require an authorized wallet and exact transaction approval.' : 'This resolver is not supported for direct writes; use its management app. No resolver replacement is automatic.' };
  }
  async prepare(input, context = {}) {
    const key = parseName(input.name).name;
    if (this.preparations.has(key)) refuse('A plan for this name is already being prepared. Inspect its status.');
    this.preparations.add(key);
    try { return await this.#prepare(input, context); }
    finally { this.preparations.delete(key); }
  }
  async #prepare(input, context) {
    context.signal?.throwIfAborted();
    if (this.closed) refuse('Domain operations are shutting down.');
    if (!INTENTS.includes(input.intent)) refuse('Choose a supported domain operation.', 'DOMAIN_INVALID');
    const parsed = parseName(input.name);
    if (['register', 'renew'].includes(input.intent) && !parsed.topLevel) refuse('Only top-level registrations and renewals are supported.', 'DOMAIN_UNSUPPORTED');
    const account = await this.wallet.account(input.walletIndex);
    const existing = this.store.list().find(item => item.name === parsed.name && item.account.address === account.address && !TERMINAL.has(item.state));
    // An ambiguous prior dispatch blocks a new plan too, even after restart.
    const uncertain = this.store.list().find(item => item.name === parsed.name && ['dispatching', 'dispatch_unknown', 'verification_needed'].includes(item.state));
    if (uncertain) return publicOperation(uncertain);
    if (existing) return publicOperation(existing);
    const declinedReveal = this.store.list().find(item => item.name === parsed.name && item.account.address === account.address && item.state === 'declined' && item.step === 'reveal');
    if (declinedReveal) return publicOperation(declinedReveal);
    const operation = { ...parsed, id: `domain_${crypto.randomBytes(12).toString('hex')}`, version: 1,
      intent: input.intent, account, sourceConversationId: context.conversationId || null,
      createdAt: Date.now(), state: 'ready', step: input.intent === 'register' ? 'commit' : input.intent, transactions: [] };
    if (['register', 'renew'].includes(input.intent)) {
      operation.duration = input.durationSeconds ?? YEAR;
      if (!Number.isSafeInteger(operation.duration) || operation.duration <= 0 || operation.duration > 10 * YEAR) refuse('Choose a positive duration of at most ten 365-day years.', 'DOMAIN_INVALID');
      if (parsed.namespace !== 'eth' && operation.duration !== YEAR) refuse('.wei and .gwei registration/renewal adds one 365-day year per transaction.', 'DOMAIN_UNSUPPORTED');
    }
    if (input.intent === 'set_website') {
      const publication = await this.getPublication?.(input.publicationId, context);
      if (publication?.state !== 'completed' || publication.verified !== true || !publication.indexDocument) refuse('Choose a completed, retrieval-verified Swarm website publication ID.');
      operation.reference = publication.reference;
      operation.publicationId = publication.publicationId;
      operation.record = { kind: 'contenthash', value: swarmContenthash(publication.reference) };
    } else if (input.intent === 'clear_website') operation.record = { kind: 'contenthash', value: '0x' };
    else if (input.intent === 'set_address') {
      let address;
      try { address = getAddress(input.address); } catch { refuse('Use an exact Ethereum address.', 'DOMAIN_INVALID'); }
      if (address === ZeroAddress) refuse('Setting the zero address is not supported by this operation.', 'DOMAIN_INVALID');
      operation.record = { kind: 'address', value: address };
    } else if (input.intent === 'set_text') {
      if (typeof input.key !== 'string' || !input.key || input.key.length > 128 || /[\p{Cc}\p{Cf}]/u.test(input.key) ||
          typeof input.value !== 'string' || input.value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(input.value)) refuse('Use a bounded text-record key and value without control characters.', 'DOMAIN_INVALID');
      operation.record = { kind: 'text', key: input.key, value: input.value };
    }
    if (input.intent === 'register') {
      const secret = `0x${crypto.randomBytes(32).toString('hex')}`;
      operation.encryptedSecret = this.store.protectSecret(secret);
      operation.commitment = commitmentFor(operation, secret);
    }
    const plan = await this.#build(operation, true);
    operation.planDigest = plan.digest;
    context.signal?.throwIfAborted();
    this.store.save(operation);
    return publicOperation(operation);
  }
  async #build(operation, preparing = false) {
    const parsed = parseName(operation.name);
    if (operation.version !== 1 || !INTENTS.includes(operation.intent) ||
        ['name', 'namespace', 'label', 'node', 'tokenId', 'topLevel'].some(key => parsed[key] !== operation[key])) refuse('Unsupported or inconsistent saved domain plan.', 'DOMAIN_UNSUPPORTED');
    if (['register', 'renew'].includes(operation.intent) && (!parsed.topLevel || !Number.isSafeInteger(operation.duration) ||
        operation.duration <= 0 || operation.duration > 10 * YEAR || (parsed.namespace !== 'eth' && operation.duration !== YEAR))) refuse('Unsupported saved registration term.', 'DOMAIN_UNSUPPORTED');
    const record = operation.record;
    if ((operation.intent === 'set_website' && (record?.kind !== 'contenthash' || record.value !== swarmContenthash(operation.reference))) ||
        (operation.intent === 'clear_website' && (record?.kind !== 'contenthash' || record.value !== '0x')) ||
        (operation.intent === 'set_address' && (record?.kind !== 'address' || !/^0x[a-fA-F0-9]{40}$/.test(record.value) || record.value === ZeroAddress)) ||
        (operation.intent === 'set_text' && (record?.kind !== 'text' || typeof record.key !== 'string' || !record.key || record.key.length > 128 ||
          typeof record.value !== 'string' || record.value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(record.key + record.value)))) refuse('The saved record does not match its typed domain intent.', 'DOMAIN_UNSUPPORTED');
    const commitReceipt = operation.intent === 'register' && operation.step === 'reveal'
      ? await this.#registrationReceipt(operation) : undefined;
    if (commitReceipt === null) refuse(operation.message, 'DOMAIN_STALE');
    const state = await this.chain.inspect(parsed, operation.record?.kind === 'text' ? [operation.record.key] : [], commitReceipt);
    const snapshot = state.snapshot;
    const authority = { owner: state.owner, manager: state.manager, resolver: state.resolver,
      epoch: state.epoch, parentEpoch: state.parentEpoch, fuses: state.fuses, wrapped: state.wrapped };
    if (preparing) operation.authority = authority;
    else if (operation.intent !== 'register' && digest(authority) !== digest(operation.authority)) refuse('Domain ownership, resolver or record generation changed. Prepare a fresh operation.', 'DOMAIN_STALE');
    const eth = parsed.namespace === 'eth';
    const role = eth ? 'controller' : parsed.namespace;
    await this.chain.checkCode(eth ? 'base' : role, snapshot);
    if (eth) {
      await this.chain.checkCode('registry', snapshot);
      if (state.wrapped) await this.chain.checkCode('wrapper', snapshot);
    }
    if (!eth) {
      const [contractId] = await this.chain.call(role, 'computeId', [operation.name], snapshot);
      if (contractId.toString() !== parsed.tokenId) refuse('The namespace identifier does not match the expected name.', 'DOMAIN_UNSUPPORTED');
    }
    let target = role;
    let method;
    let args;
    let value = '0';
    let previous;
    let label;
    if (operation.intent === 'register') {
      if (!state.available) refuse('That name is no longer available.', 'DOMAIN_STALE');
      if (eth) {
        await this.chain.checkCode('controller', snapshot);
        await this.chain.checkCode('resolver', snapshot);
        if (!(await this.chain.call('base', 'controllers', [ADDRESSES.controller], snapshot))[0]) refuse('The ENS controller is no longer authorized.', 'DOMAIN_UNSUPPORTED');
        const [minimum] = await this.chain.call('controller', 'MIN_REGISTRATION_DURATION', [], snapshot);
        if (BigInt(operation.duration) < minimum || !(await this.chain.call('controller', 'valid', [parsed.label], snapshot))[0]) refuse('The name or registration duration is not accepted by ENS.', 'DOMAIN_INVALID');
      } else {
        if ((await this.chain.call(role, 'normalize', [parsed.label], snapshot))[0] !== parsed.label) refuse('The registered spelling would differ.', 'DOMAIN_UNSUPPORTED');
      }
      const secret = this.store.revealSecret(operation);
      const expected = commitmentFor(operation, secret);
      if (expected !== operation.commitment) refuse('The saved commitment does not match its private registration plan.', 'DOMAIN_STALE');
      // Never send a commitment preimage to an RPC merely to compare hashes.
      // Bundled encoding is tested against the pinned deployment on a fork.
      const quotedWei = await this.#price(operation, role, snapshot, true);
      if (preparing) operation.quotedWei = quotedWei;
      if (BigInt(quotedWei) > BigInt(operation.quotedWei)) refuse('The domain price increased. A fresh quote and wallet approval are needed.', operation.step === 'reveal' ? 'DOMAIN_QUOTE_CHANGED' : 'DOMAIN_STALE');
      if (operation.step === 'commit') {
        method = 'commit'; args = [expected];
        label = `Commit registration of ${parsed.name}`;
      } else {
        await this.#commitmentWindow(operation, snapshot);
        if (operation.state !== 'ready') refuse('The registration commitment is not ready for reveal.', 'DOMAIN_STALE');
        method = eth ? 'register' : 'reveal';
        args = eth ? [registrationTuple(operation, secret)] : [parsed.label, secret];
        value = quotedWei;
        label = `Register ${parsed.name}`;
      }
    } else if (operation.intent === 'renew') {
      if (state.available || !state.expiry || state.expiry === '0') refuse('This name cannot be renewed in its current state.', 'DOMAIN_STALE');
      if (eth) {
        target = state.wrapped ? 'wrappedController' : 'controller';
        if (state.wrapped) {
          await this.chain.checkCode('wrapper', snapshot);
          await this.chain.checkCode('wrappedController', snapshot);
          if (!(await this.chain.call('wrapper', 'controllers', [ADDRESSES.wrappedController], snapshot))[0] ||
              !(await this.chain.call('base', 'controllers', [ADDRESSES.wrapper], snapshot))[0]) refuse('The ENS wrapped renewal controller changed.', 'DOMAIN_UNSUPPORTED');
        } else {
          await this.chain.checkCode('controller', snapshot);
          if (!(await this.chain.call('base', 'controllers', [ADDRESSES.controller], snapshot))[0]) refuse('The ENS renewal controller changed.', 'DOMAIN_UNSUPPORTED');
        }
        method = 'renew'; args = state.wrapped ? [parsed.label, operation.duration] : [parsed.label, operation.duration, `0x${'00'.repeat(32)}`];
      } else { method = 'renew'; args = [parsed.tokenId]; }
      value = await this.#price(operation, target, snapshot, false);
      previous = { expiry: state.expiry, owner: state.owner, manager: state.manager, wrapped: state.wrapped || false, wrapperExpiry: state.wrapperExpiry };
      if (preparing) operation.quotedWei = value;
      if (BigInt(value) > BigInt(operation.quotedWei)) refuse('The renewal price increased. Prepare a fresh quote.', 'DOMAIN_STALE');
      label = `Renew ${parsed.name}`;
    } else {
      if (!state.active || !state.supportedResolver) refuse('An active name with a supported resolver is required. Freedom will not replace the resolver automatically.', 'DOMAIN_UNSUPPORTED');
      if (eth) {
        await this.chain.checkCode('resolver', snapshot);
        const recordOwner = state.recordOwner || state.manager;
        if (!sameAddress(recordOwner, operation.account.address) &&
            !(await this.chain.call('resolver', 'isApprovedForAll', [recordOwner, operation.account.address], snapshot))[0] &&
            !(await this.chain.call('resolver', 'isApprovedFor', [recordOwner, parsed.node, operation.account.address], snapshot))[0]) refuse('This wallet is not authorized to edit the name’s resolver records.');
        target = 'resolver';
      } else if (!sameAddress(state.owner, operation.account.address)) refuse('This wallet does not own the name.');
      const identifier = eth ? parsed.node : parsed.tokenId;
      const record = operation.record;
      if (record.kind === 'contenthash') {
        method = 'setContenthash'; args = [identifier, record.value]; previous = state.records.contenthash;
        label = `${record.value === '0x' ? 'Clear website for' : 'Set website for'} ${parsed.name}`;
      } else if (record.kind === 'address') {
        method = 'setAddr'; args = [identifier, record.value]; previous = state.records.address;
        label = `Set ETH address for ${parsed.name}`;
      } else {
        method = 'setText'; args = [identifier, record.key, record.value]; previous = state.records.text[record.key];
        label = `Set ${record.key} for ${parsed.name}`;
      }
    }
    if (preparing) operation.before = previous;
    else if (operation.intent !== 'register' && digest(previous ?? null) !== digest(operation.before ?? null)) refuse('Ownership, expiry or the record changed after preparation. Prepare a fresh operation.', 'DOMAIN_STALE');
    const abi = ABI[target] || ABI.nft;
    const tx = { id: operation.id, name: parsed.name, step: operation.step, account: operation.account,
      to: ADDRESSES[target], data: abi.encodeFunctionData(method, args), value, from: operation.account.address,
      label, summary: [label, `Wallet: ${operation.account.address}`,
        ...(operation.duration ? [`Term: ${operation.duration} seconds (${operation.duration / YEAR} × 365 days)`] : []),
        ...(operation.intent === 'renew' ? ['Renewal extends this exact name; it does not transfer ownership to the paying wallet.'] : []),
        ...(operation.record ? [`Current: ${previous || '(empty)'}`, `New: ${operation.reference ? `bzz://${operation.reference}` : operation.record.value || '(clear)'}`] : []),
        ...(operation.intent === 'register' ? [`Registration price: ${operation.quotedWei} wei, plus network fees.`,
          'Commit costs gas but does not reserve or buy the name. Reveal needs a separate approval.'] : [])].join('\n') };
    // Always simulate from the actual wallet, including commits.
    await this.chain.simulate(tx, snapshot);
    tx.digest = digest({ to: tx.to, data: tx.data, value: tx.value, account: tx.account.address, previous });
    return tx;
  }
  async #price(operation, role, snapshot, registering) {
    if (operation.namespace === 'eth') {
      const [price] = await this.chain.call(role, 'rentPrice', [operation.label, operation.duration], snapshot);
      return (price.base + (registering ? price.premium : 0n)).toString();
    }
    const [fee] = await this.chain.call(role, 'getFee', [Buffer.byteLength(operation.label)], snapshot);
    const premium = registering ? (await this.chain.call(role, 'getPremium', [operation.tokenId], snapshot))[0] : 0n;
    return (fee + premium).toString();
  }
  async execute(id, context = {}) {
    if (this.closed || this.locks.has(id)) refuse('This domain operation is already active or shutting down.');
    this.locks.add(id);
    try {
      const operation = this.#get(id);
      if (operation.state === 'declined' && context.resume === true) {
        const replacement = this.store.list().find(item => item.id !== id && item.name === operation.name && item.account.address === operation.account.address && !TERMINAL.has(item.state));
        if (replacement) return publicOperation(replacement);
        operation.state = 'ready';
      }
      if (operation.state !== 'ready') return this.status({ operationId: id }, context);
      context.signal?.throwIfAborted();
      let plan;
      try {
        // Requote the reveal before presenting its separate approval, without
        // throwing away an already paid commitment or changing its tuple.
        plan = await this.#build(operation, operation.intent === 'register' && operation.step === 'reveal');
        if (operation.step !== 'reveal' && operation.planDigest !== plan.digest) refuse('The prepared transaction changed. Prepare a fresh operation.', 'DOMAIN_STALE');
        const result = await this.wallet.send(plan, {
          signal: context.signal, requestApproval: context.requestApproval,
          revalidate: async () => {
            if (this.closed) refuse('Domain operations are shutting down.');
            const checked = await this.#build(operation);
            if (checked.digest !== plan.digest) refuse('The approved operation changed. No transaction was sent.', operation.intent === 'register' && operation.step === 'reveal' ? 'DOMAIN_QUOTE_CHANGED' : 'DOMAIN_STALE');
          },
          beforeSend: () => {
            if (this.closed || context.signal?.aborted) refuse('Domain execution stopped before dispatch.', 'DOMAIN_STOPPED');
            operation.state = 'dispatching';
            operation.dispatchDigest = digest({ to: plan.to.toLowerCase(), data: plan.data.toLowerCase(), value: BigInt(plan.value).toString(), from: operation.account.address.toLowerCase() });
            this.store.save(operation);
          },
        });
        if (!/^0x[a-fA-F0-9]{64}$/.test(result?.hash || '')) refuse('The wallet did not return a transaction hash. Inspect its history before retrying.');
        operation.transactionHash = result.hash;
        operation.state = 'pending';
        operation.message = 'Transaction submitted; waiting for confirmation.';
        this.store.save(operation);
      } catch (error) {
        if (operation.state === 'dispatching' && error.code === 'DOMAIN_NOT_BROADCAST') {
          operation.state = 'declined'; operation.message = 'The wallet did not broadcast this step. Resume this operation only on the user’s request, with a fresh approval.';
        } else if (operation.state === 'dispatching') {
          operation.state = 'dispatch_unknown';
          operation.message = 'The wallet may have submitted this transaction. Do not send it again; reconcile wallet history first.';
        } else if (error.code === 'DOMAIN_DECLINED') {
          operation.state = 'declined'; operation.message = error.message;
        } else if (error.code === 'DOMAIN_QUOTE_CHANGED') {
          operation.state = 'ready'; operation.message = 'The registration quote changed during approval. No reveal was sent. The same commitment can be requoted for a fresh approval.';
        } else if (error.code === 'DOMAIN_STALE') {
          if (!['expired', 'verification_needed', 'waiting_commitment'].includes(operation.state)) {
            operation.state = 'stale'; operation.message = error.message;
          }
        } else throw error;
        this.store.save(operation);
      }
      return this.status({ operationId: id, waitMs: this.executeWaitMs }, context);
    } finally { this.locks.delete(id); }
  }
  #get(id) {
    if (typeof id !== 'string' || !/^domain_[a-f0-9]{24}$/.test(id)) refuse('Choose a valid domain operation ID.', 'DOMAIN_INVALID');
    const operation = this.store.get(id);
    if (!operation) refuse('That domain operation is not in this browser profile.');
    return operation;
  }
  async #commitmentWindow(operation, snapshot) {
    const role = operation.namespace === 'eth' ? 'controller' : operation.namespace;
    const [committedAt] = await this.chain.call(role, 'commitments', [operation.commitment], snapshot);
    const eth = operation.namespace === 'eth';
    const min = eth ? (await this.chain.call(role, 'minCommitmentAge', [], snapshot))[0] : 60n;
    const max = eth ? (await this.chain.call(role, 'maxCommitmentAge', [], snapshot))[0] : 86400n;
    if (committedAt === 0n) { operation.state = 'verification_needed'; operation.message = 'The confirmed commitment is missing from the current chain. Inspect before continuing.'; return; }
    operation.readyAt = Number(committedAt + min);
    operation.expiresAt = Number(committedAt + max);
    const now = snapshot.timestamp;
    operation.state = (eth ? now >= operation.expiresAt : now > operation.expiresAt) ? 'expired'
      : now >= operation.readyAt ? 'ready' : 'waiting_commitment';
    operation.message = operation.state === 'ready' ? 'Commitment ready. Reveal needs a new exact wallet approval.'
      : operation.state === 'expired' ? 'The commitment expired. A new commitment would cost gas and is not automatic.' : 'Waiting for the on-chain commitment age.';
  }
  async #registrationReceipt(operation) {
    const commit = operation.transactions.find(transaction => transaction.step === 'commit');
    const receipt = commit && await this.chain.receipt(commit.hash);
    const tx = receipt && await this.chain.request('eth_getTransactionByHash', [commit.hash]);
    const role = parseName(operation.name).namespace === 'eth' ? 'controller' : operation.namespace;
    // dispatchDigest belongs to the most recent signing attempt, which may be
    // a provably unsent reveal. Reconstruct the earlier public commit instead.
    const expected = this.#transactionDigest({ from: operation.account.address, to: ADDRESSES[role], value: '0',
      input: (ABI[role] || ABI.nft).encodeFunctionData('commit', [operation.commitment]) });
    if (!receipt || BigInt(receipt.status) !== 1n || receipt.blockHash !== commit.blockHash ||
        !tx || this.#transactionDigest(tx) !== expected) {
      operation.state = 'verification_needed';
      operation.message = 'The saved commit could not be verified in the current canonical chain. Check the same operation again; do not send another commit.';
      return null;
    }
    return receipt;
  }
  async status(input = {}, context = {}) {
    if (!input.operationId && input.transactionHash) refuse('A recovery transaction hash requires its domain operation ID.', 'DOMAIN_INVALID');
    if (!input.operationId) return { operations: this.store.list().filter(operation => !context.conversationId || operation.sourceConversationId === context.conversationId).slice(-20).reverse().map(operation => ({
      operationId: operation.id, name: operation.name, intent: operation.intent, state: operation.state, step: operation.step,
    })) };
    if (input.waitMs !== undefined && (!Number.isSafeInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 30000)) refuse('Wait must be between zero and 30,000 milliseconds.', 'DOMAIN_INVALID');
    const deadline = Date.now() + (input.waitMs || 0);
    let operation = this.#get(input.operationId);
    if (input.transactionHash) {
      if (!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash) || operation.state !== 'dispatch_unknown') refuse('A recovery hash is only accepted for an uncertain domain dispatch.', 'DOMAIN_INVALID');
      const tx = await this.chain.request('eth_getTransactionByHash', [input.transactionHash]);
      if (!tx || this.#transactionDigest(tx) !== operation.dispatchDigest) refuse('That transaction does not match this exact domain operation.', 'DOMAIN_INVALID');
      operation.transactionHash = input.transactionHash;
      operation.state = 'pending';
      this.store.save(operation);
    }
    do {
      context.signal?.throwIfAborted();
      if (operation.state === 'completed' && operation.transactionHash && !await this.chain.receipt(operation.transactionHash)) {
        operation.state = 'verification_needed';
        operation.message = 'The previously confirmed transaction is no longer in the canonical chain. Reconcile before any further send.';
        this.store.save(operation);
      }
      if (operation.state === 'pending') await this.#confirm(operation);
      else if (operation.intent === 'register' && operation.step === 'reveal' && !operation.transactionHash &&
          ['waiting_commitment', 'verification_needed'].includes(operation.state)) {
        // Also reconciles journals saved by older versions after a stale-block
        // read. Only a verified existing commit may recover; never resend it.
        const receipt = await this.#registrationReceipt(operation);
        if (receipt) await this.#commitmentWindow(operation, await this.chain.snapshot(receipt));
        this.store.save(operation);
      }
      if (!WAITING.has(operation.state) || Date.now() >= deadline) break;
      await pause(Math.min(this.pollMs, deadline - Date.now()), context.signal);
      operation = this.#get(input.operationId);
    } while (!this.closed);
    return publicOperation(operation);
  }
  async #confirm(operation) {
    const receipt = await this.chain.receipt(operation.transactionHash);
    if (!receipt) return;
    const tx = await this.chain.request('eth_getTransactionByHash', [operation.transactionHash]);
    if (!tx || this.#transactionDigest(tx) !== operation.dispatchDigest) {
      operation.state = 'verification_needed'; operation.message = 'The returned transaction does not match the prepared domain operation.';
      this.store.save(operation); return;
    }
    operation.transactions.push({ step: operation.step, hash: operation.transactionHash, blockHash: receipt.blockHash });
    if (BigInt(receipt.status) !== 1n) {
      operation.state = 'failed'; operation.message = 'The domain transaction reverted. Gas may have been spent; inspect current state before preparing another operation.';
    } else if (operation.step === 'commit') {
      operation.step = 'reveal';
      delete operation.transactionHash; // The commit hash is in transactions, not a reveal receipt.
      await this.#commitmentWindow(operation, await this.chain.snapshot(receipt));
    } else {
      const state = await this.chain.inspect(parseName(operation.name), operation.record?.kind === 'text' ? [operation.record.key] : [], receipt);
      let verified;
      if (operation.intent === 'register') verified = state.active && sameAddress(state.owner, operation.account.address);
      else if (operation.intent === 'renew') verified = (operation.before.owner === ZeroAddress || sameAddress(state.owner, operation.before.owner)) && sameAddress(state.manager, operation.before.manager) && BigInt(state.expiry) === BigInt(operation.before.expiry) + BigInt(operation.duration) &&
        (!operation.before.wrapped || BigInt(state.wrapperExpiry) === BigInt(operation.before.wrapperExpiry) + BigInt(operation.duration));
      else {
        const record = operation.record;
        const actual = record.kind === 'contenthash' ? state.records.contenthash : record.kind === 'address' ? state.records.address : state.records.text[record.key];
        verified = actual === record.value;
      }
      operation.state = verified ? 'completed' : 'verification_needed';
      operation.message = verified ? 'Transaction confirmed and the requested on-chain result checked.' : 'The transaction succeeded, but the expected domain state could not be verified. Do not resend it.';
      if (verified && operation.reference) {
        try { operation.resolutionVerified = await this.verifyResolution(operation.name, operation.reference); }
        catch { operation.resolutionVerified = false; }
        if (!operation.resolutionVerified) operation.message = 'Website record confirmed on chain; fresh Freedom resolution still needs checking. Do not pay for the same update again.';
      }
      if (operation.state === 'completed') delete operation.encryptedSecret;
    }
    this.store.save(operation);
  }
  #transactionDigest(tx) {
    return digest({ to: tx.to?.toLowerCase(), data: tx.input?.toLowerCase(), value: BigInt(tx.value).toString(), from: tx.from?.toLowerCase() });
  }
  async waitForOperations(ids, context) {
    const receipts = [];
    for (const id of ids) {
      let receipt;
      const deadline = Date.now() + 10 * 60 * 1000;
      do {
        receipt = await this.status({ operationId: id, waitMs: 30000 }, context);
      } while (WAITING.has(receipt.state) && !this.closed && Date.now() < deadline);
      receipts.push(receipt);
    }
    return receipts;
  }
  close() { this.closed = true; }
}

module.exports = { DomainService, publicOperation, WAITING, INTENTS };
