'use strict';

// ENSv2-specific preparation and encoding. The shared service still owns the
// journal, canonical-receipt recovery, approvals and signing handoff.
const { keccak256, toUtf8Bytes, formatUnits, dnsEncode, getAddress } = require('ethers');
const { ADDRESSES, ABI, CONTRACT_NAMES, refuse, ZeroAddress, ZeroHash } = require('./contracts');
const { PAYMENT_TOKENS } = require('./ens-v2-contracts');
const { sameAddress } = require('./chain');

// NameWrapper has no grace-period getter. Its pinned v1 runtime/source uses 90 days.
const LEGACY_WRAPPER_GRACE = 90n * 86400n;
const RECORD_ROLES = 0x11111111n | (1n << 120n) | (1n << 124n);
const RESOLVER_ROLES = RECORD_ROLES | (RECORD_ROLES << 128n);
const addressFor = (chain, role) => (chain.addresses || ADDRESSES)[role];
const tokenFor = operation => {
  const key = operation.paymentToken ?? 'USDC';
  const token = Object.hasOwn(PAYMENT_TOKENS, key) ? PAYMENT_TOKENS[key] : null;
  if (!token) refuse('Choose USDC or DAI for ENS registration and renewal.', 'DOMAIN_INVALID');
  return token;
};
const amountText = (operation, amount = operation.quotedAmount) => `${formatUnits(BigInt(amount), tokenFor(operation).decimals)} ${tokenFor(operation).symbol}`;
const termText = seconds => seconds % 31536000 === 0 ? `${seconds / 31536000} ${seconds === 31536000 ? 'year' : 'years'} (${seconds / 86400} days)` : seconds % 86400 === 0 ? `${seconds / 86400} days` : `${seconds} seconds`;
const resolverSalt = account => BigInt(keccak256(toUtf8Bytes(`Freedom ENSv2 records v1:${account.address.toLowerCase()}`))).toString();
async function resolverAddress(chain, account, snapshot) {
  return (await chain.call('ensFactory', 'predictProxyAddress', [account.address, resolverSalt(account)], snapshot))[0];
}
async function prepare(chain, operation, input) {
  operation.protocol = 'ensv2';
  operation.paymentToken = input.paymentToken ?? 'USDC';
  tokenFor(operation);
  if (operation.intent === 'register') {
    const snapshot = await chain.snapshot();
    await chain.checkCode('ensFactory', snapshot);
    operation.ensResolver = await resolverAddress(chain, operation.account, snapshot);
  }
}
async function price(chain, operation, state) {
  const snapshot = state.snapshot;
  const role = operation.intent === 'register' ? 'ensRegistrar' : state.ensVersion === 1 ? 'ensRenewerV1' : 'ensRegistrar';
  const token = tokenFor(operation);
  await chain.checkCode(role, snapshot);
  await chain.checkCode('ensOracle', snapshot);
  if (!sameAddress((await chain.call(role, 'ETH_REGISTRY', [], snapshot))[0], addressFor(chain, 'ensRegistry')) ||
      !sameAddress((await chain.call(role, 'rentPriceOracle', [], snapshot))[0], addressFor(chain, 'ensOracle')) ||
      !(await chain.call('ensOracle', 'isPaymentToken', [addressFor(chain, token.role)], snapshot))[0]) {
    refuse('ENS changed its registrar, price oracle or accepted payment token. Use its official app until this deployment is qualified.', 'DOMAIN_UNSUPPORTED');
  }
  if (role === 'ensRenewerV1') {
    for (const [getter, binding] of [['BASE_REGISTRAR', 'base'], ['NAME_WRAPPER', 'wrapper'], ['WRAPPED_CONTROLLER', 'wrappedController']]) {
      await chain.checkCode(binding, snapshot);
      if (!sameAddress((await chain.call(role, getter, [], snapshot))[0], addressFor(chain, binding))) refuse('The legacy ENS renewal route changed.', 'DOMAIN_UNSUPPORTED');
    }
  }
  if (operation.intent === 'register') {
    const [minimum] = await chain.call(role, 'MIN_REGISTER_DURATION', [], snapshot);
    if (BigInt(operation.duration) < minimum) refuse('ENS does not accept this registration term.', 'DOMAIN_QUOTE_UNAVAILABLE');
    const [base, premium] = await chain.call(role, 'getRegisterPrice', [operation.label, operation.duration, addressFor(chain, token.role)], snapshot);
    return { amount: (base + premium).toString(), role, token };
  }
  return { amount: (await chain.call(role, 'getRenewPrice', [operation.label, operation.duration, addressFor(chain, token.role)], snapshot))[0].toString(), role, token };
}
async function resolverReady(chain, operation, snapshot) {
  await chain.checkCode('ensFactory', snapshot);
  await chain.checkCode('ensResolverImpl', snapshot);
  if (!sameAddress(operation.ensResolver, await resolverAddress(chain, operation.account, snapshot))) refuse('The saved ENS resolver address changed.', 'DOMAIN_STALE');
  const code = await chain.request('eth_getCode', [operation.ensResolver, snapshot.tag]);
  if (code === '0x') return false;
  const [implementation] = await chain.call('ensFactory', 'verifyContract', [operation.ensResolver], snapshot);
  if (!sameAddress(implementation, addressFor(chain, 'ensResolverImpl')) ||
      !(await chain.callAt('ensResolverImpl', operation.ensResolver, 'hasRootRoles', [RESOLVER_ROLES, operation.account.address], snapshot))[0]) {
    refuse('The wallet’s ENS records contract is not the qualified resolver or its permissions changed.', 'DOMAIN_UNSUPPORTED');
  }
  return true;
}
async function build(chain, operation, state, preparing, secret) {
  const snapshot = state.snapshot;
  const quote = await price(chain, operation, state);
  const { role, token } = quote;
  await chain.checkCode('ensRegistry', snapshot);
  if (Number((await chain.call(token.role, 'decimals', [], snapshot))[0]) !== token.decimals) refuse('The ENS payment token changed.', 'DOMAIN_UNSUPPORTED');
  const tokenAddress = addressFor(chain, token.role);
  const spender = addressFor(chain, role);
  const balance = (await chain.call(token.role, 'balanceOf', [operation.account.address], snapshot))[0];
  if (balance < BigInt(quote.amount)) refuse(`This wallet needs ${formatUnits(quote.amount, token.decimals)} ${token.symbol} for ENS, plus ETH for network fees. Freedom does not exchange currencies automatically.`, 'DOMAIN_BALANCE');
  if (preparing) {
    operation.commitQuoteAmount ??= quote.amount;
    operation.quotedAmount = quote.amount;
    operation.payment = { token: tokenAddress, symbol: token.symbol, decimals: token.decimals, spender,
      maxAmount: BigInt(operation.payment?.maxAmount || '0') >= BigInt(quote.amount) ? operation.payment.maxAmount : quote.amount };
  }
  if (!operation.payment || operation.payment.token !== tokenAddress || operation.payment.spender !== spender ||
      BigInt(quote.amount) > BigInt(operation.quotedAmount)) refuse('The ENS price or payment route changed. Requote the same operation for a fresh approval.', 'DOMAIN_QUOTE_CHANGED');
  const allowance = (await chain.call(token.role, 'allowance', [operation.account.address, spender], snapshot))[0];
  let step = operation.step;
  let target = role;
  let method, args;
  const renewing = operation.intent === 'renew';
  if (!renewing && step === 'commit') {
    const [minimum] = await chain.call('ensRegistrar', 'MIN_REGISTER_DURATION', [], snapshot);
    if (BigInt(operation.duration) < minimum) refuse('ENS does not accept this registration term.', 'DOMAIN_INVALID');
    await resolverReady(chain, operation, snapshot); // Refuse changed existing resolver permissions before paying commit gas.
    method = 'commit'; args = [operation.commitment];
  } else {
    const needsApproval = allowance < BigInt(quote.amount) || allowance > BigInt(operation.payment.maxAmount);
    const hasResolver = renewing || await resolverReady(chain, operation, snapshot);
    const next = needsApproval ? 'approve_payment' : !hasResolver ? 'deploy_resolver' : renewing ? 'renew' : 'reveal';
    if (preparing) operation.step = step = next;
    else if (step !== next) refuse('The ENS payment allowance or resolver setup changed during approval. Inspect the same operation before continuing.', operation.intent === 'register' ? 'DOMAIN_QUOTE_CHANGED' : 'DOMAIN_STALE');
    if (step === 'approve_payment') {
      target = token.role; method = 'approve'; args = [spender, operation.payment.maxAmount];
    } else if (step === 'deploy_resolver') {
      target = 'ensFactory'; method = 'deployProxy';
      args = [addressFor(chain, 'ensResolverImpl'), resolverSalt(operation.account),
        ABI.ensResolverImpl.encodeFunctionData('initialize', [[[operation.account.address, RESOLVER_ROLES]], []])];
    } else if (renewing) {
      method = 'renew'; args = [[operation.label, operation.duration, ZeroHash], tokenAddress];
    } else {
      method = 'register'; args = [operation.label, operation.account.address, secret, ZeroAddress,
        operation.ensResolver, operation.duration, tokenAddress, ZeroHash];
    }
  }
  const action = step === 'commit' ? 'register_commit' : step === 'approve_payment' ? 'approve_payment'
    : step === 'deploy_resolver' ? 'setup_resolver' : renewing ? 'renew' : 'register';
  const label = step === 'commit' ? `Commit registration of ${operation.name}` : step === 'approve_payment'
    ? `Approve ${token.symbol} for ${operation.name}` : step === 'deploy_resolver' ? `Set up ENS records for ${operation.name}`
      : `${renewing ? 'Renew' : 'Register'} ${operation.name}`;
  const items = [{ label: 'Name', value: operation.name }, { label: 'Price', value: `${amountText(operation)}; ETH network fees are separate.` },
    { label: 'Term', value: termText(operation.duration) }];
  if (step === 'commit') items.push({ label: 'Step', value: 'Commit only. It spends network fees but does not buy or reserve the name. Token approval, resolver setup if needed, and registration each need separate wallet approval.' });
  else if (step === 'approve_payment') items.push({ label: 'Permission', value: `${allowance > BigInt(operation.payment.maxAmount) ? 'Reduce the existing larger allowance. ' : ''}Allow only ${CONTRACT_NAMES[role]} (${getAddress(spender)}) to spend up to ${amountText(operation, operation.payment.maxAmount)} from this wallet. This does not buy or renew the name. Any unused allowance remains until spent or revoked.` });
  else if (step === 'deploy_resolver') items.push({ label: 'Records contract', value: `Deploy the official ENS permissioned resolver at ${operation.ensResolver}. This wallet controls its record permissions and upgrades. It can be reused for later names; no domain is bought by this step.` });
  else {
    items.push({ label: 'Payment limit', value: `Up to ${amountText(operation, operation.payment.maxAmount)} under this wallet’s token allowance. A separate change to that allowance can change this limit.` });
    items.push({ label: 'Payment', value: `ENS takes the current ${token.symbol} price, bounded by the approved allowance. No ETH registration payment, price buffer or token refund is involved.` });
  }
  if (operation.commitQuoteAmount && BigInt(operation.quotedAmount) > BigInt(operation.commitQuoteAmount)) items.push({ label: 'Price change', value: `${renewing ? 'At preparation' : 'At commit'}: ${amountText(operation, operation.commitQuoteAmount)}. Now: ${amountText(operation)}.` });
  if (renewing) items.push({ label: 'Ownership', value: 'Renewal extends the name without transferring ownership or changing records.' });
  const to = addressFor(chain, target);
  return { to, data: ABI[target].encodeFunctionData(method, args), value: '0', label,
    presentation: { format: 'freedom-domain-approval/1', action, name: operation.name, durationSeconds: operation.duration,
      contract: { address: to, name: CONTRACT_NAMES[target] }, items } };
}
function verifySetup(chain, operation, receipt, tx) {
  // Receipt logs prove this transaction's effect without archive state. Current
  // allowance, code and roles are separately rechecked before the next send.
  const deploying = operation.step === 'deploy_resolver';
  const role = deploying ? 'ensFactory' : tokenFor(operation).role;
  const address = addressFor(chain, role);
  if (!sameAddress(tx.to, address)) return false;
  let call;
  try { call = ABI[role].parseTransaction({ data: tx.input }); } catch { return false; }
  if (!call || call.name !== (deploying ? 'deployProxy' : 'approve')) return false;
  for (const log of receipt.logs || []) {
    if (log.removed || !sameAddress(log.address, address)) continue;
    let event;
    try { event = ABI[role].parseLog(log); } catch { continue; }
    if (!event) continue;
    if (deploying && event.name === 'ProxyDeployed' && sameAddress(event.args.sender, operation.account.address) &&
        sameAddress(event.args.proxyAddress, operation.ensResolver) && event.args.salt === BigInt(resolverSalt(operation.account)) &&
        sameAddress(event.args.implementation, addressFor(chain, 'ensResolverImpl')) &&
        sameAddress(call.args[0], event.args.implementation) && call.args[1] === event.args.salt) return true;
    if (!deploying && event.name === 'Approval' && sameAddress(event.args.owner, operation.account.address) &&
        sameAddress(event.args.spender, call.args[0]) && event.args.value === call.args[1]) return true;
  }
  return false;
}
async function recordPlan(chain, operation, state) {
  const role = state.resolverRole;
  if (!['ensResolverImpl', 'ensPublicResolver'].includes(role)) return null;
  await chain.checkCode(role, state.snapshot);
  const record = operation.record;
  let method, args;
  if (role === 'ensResolverImpl') {
    await chain.checkCode('ensFactory', state.snapshot);
    const [implementation] = await chain.call('ensFactory', 'verifyContract', [state.resolver], state.snapshot);
    if (!sameAddress(implementation, addressFor(chain, role))) refuse('The ENS resolver implementation changed.', 'DOMAIN_UNSUPPORTED');
    const required = record.kind === 'contenthash' ? 1n << 8n : record.kind === 'address' ? 1n : 1n << 4n;
    if (!(await chain.callAt(role, state.resolver, 'hasRootRoles', [required, operation.account.address], state.snapshot))[0]) refuse('This wallet cannot edit these ENS records.');
    const name = dnsEncode(operation.name, 255);
    method = record.kind === 'contenthash' ? 'setContenthash' : record.kind === 'address' ? 'setAddress' : 'setText';
    args = record.kind === 'contenthash' ? [name, record.value] : record.kind === 'address' ? [name, 60n, record.value] : [name, record.key, record.value];
  } else {
    if (!(await chain.call(role, 'canModifyName', [operation.node, operation.account.address], state.snapshot))[0]) refuse('This wallet cannot edit these ENS records.');
    method = record.kind === 'contenthash' ? 'setContenthash' : record.kind === 'address' ? 'setAddr(bytes32,address)' : 'setText';
    args = record.kind === 'text' ? [operation.node, record.key, record.value] : [operation.node, record.value];
  }
  return { to: state.resolver, data: ABI[role].encodeFunctionData(method, args), value: '0', label: `Update ${operation.name}` };
}
module.exports = { prepare, price, build, verifySetup, recordPlan, amountText, resolverAddress, RESOLVER_ROLES, LEGACY_WRAPPER_GRACE };
