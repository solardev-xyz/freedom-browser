/** Read-only qualification of a published Sepolia candidate, not a signing grant.
 * Wallet owns protocol interpretation; the caller supplies bounded Tor I/O.
 * Remote chain/ASP observations remain unverified, even when mutually consistent.
 */
const { Interface, AbiCoder, keccak256, verifyTypedData } = require('ethers');
const { NATIVE } = require('./ppv2-deposit-policy');
const { privacyError } = require('../networks/privacy-context');
const { ROUTING, QUOTE_TYPES, quoteDomain } = require('./ppv2-relay-policy');
const PINS = require('./ppv2-sepolia-pins.json');
const coder = AbiCoder.defaultAbiCoder();
const CANDIDATE = Object.freeze({
  chainId: 11155111,
  pool: '0x09b94d3127019298757a6ceeb7911922085f7c01',
  entrypoint: '0xeb3e3961008952348445513e418ad6f43c23ca9a',
  keystore: '0x6d264acb9c3a7a3105c29470afe2f5f1ec203c73',
  aspRegistry: '0x35d29efdcf067599ab4a53cf40229477f0b1ca9c',
  processor: '0x7430cc030d7eb8c83e76cd983996982c8c054204',
  quoteSigner: '0x4ba5ff376865b370790a56276c63e7984dcff1f7',
  // Separate facts, even where the documented staging values coincide.
  feeRecipient: '0x4ba5ff376865b370790a56276c63e7984dcff1f7',
  asp: 'https://api-dev.0xbow.io',
  relayer: 'https://relayer-v2-staging-149184580131.us-east1.run.app',
  aspKey: '0x18656ba6d7862cb11d995afe20bf8761edee05ec28aa29bfbcf31ebd19dede71',
  // Earliest V9 deployment block covers keystore events; the ASP pool feed
  // starts later and cannot establish the account's complete recovery history.
  deploymentBlock: 10932354,
});
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ABI = new Interface([
  'function poolVault() view returns (address)', 'function keystore() view returns (address)',
  'function aspRegistry() view returns (address)', 'function paused() view returns (bool)',
  'function depositVerifier() view returns (address)', 'function ragequitVerifier() view returns (address)',
  'function verifiers(bytes32) view returns (tuple(address addr,bytes4 selector))',
  'function assets(address) view returns (tuple(bool enabled,uint256 minAmount,uint256 vettingFeeBPS,uint256 maxRelayFee))',
  'function POOL() view returns (address)', 'function ENTRYPOINT() view returns (address)',
  'function latestASPRoot() view returns (uint256)',
  'function MAX_BATCH() view returns (uint256)', 'function ANNOUNCER() view returns (address)',
  'function keystoreRootLiveness() view returns (uint256)',
]);
const RECIPIENT = '0x1111111111111111111111111111111111111111'; // Public synthetic probe, never a funding address.
const QUOTE_REQUEST = Object.freeze({ asset: NATIVE, commit: true, recipient: RECIPIENT, amount: '1000000000000000', extraGas: false });
const equalAddress = (a, b) => typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a) && a.toLowerCase() === b;
const word = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v);
const refused = () => privacyError('PRIVATE_PPV2_PREFLIGHT_REFUSED', 'Sepolia preflight check failed');
function insist(value) { if (!value) throw refused(); }
function checkQuote(quote, now = Date.now()) {
  try {
    const fee = quote.feeCommitment;
    const integer = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value);
    insist([fee.feeAmount, fee.amountSent, fee.amountReceived, quote.gasPrice, quote.txCost].every(integer));
    insist(equalAddress(fee.asset, NATIVE) && equalAddress(fee.recipient, RECIPIENT));
    insist(fee.amountReceived === QUOTE_REQUEST.amount && BigInt(fee.amountSent) === BigInt(fee.amountReceived) + BigInt(fee.feeAmount));
    insist(quote.feeAmount === fee.feeAmount && quote.amountSent === fee.amountSent && quote.amountReceived === fee.amountReceived);
    insist(fee.extraGas === undefined || fee.extraGas === false);
    insist(Number.isSafeInteger(fee.expiration) && fee.expiration > now && fee.expiration <= now + 3600000);
    const routing = coder.encode([ROUTING], [[RECIPIENT, CANDIDATE.feeRecipient, fee.feeAmount, 0]]);
    insist(fee.data === routing);
    const signer = verifyTypedData(quoteDomain(CANDIDATE.chainId, CANDIDATE.processor), QUOTE_TYPES, fee, fee.signedRelayerCommitment);
    insist(equalAddress(signer, CANDIDATE.quoteSigner));
    return { signer: signer.toLowerCase(), feeRecipient: CANDIDATE.feeRecipient, processor: CANDIDATE.processor, remainingMs: fee.expiration - now,
      expiration: fee.expiration, feeWei: fee.feeAmount, amountReceivedWei: fee.amountReceived,
      amountSentWei: fee.amountSent, gasPriceWei: quote.gasPrice, relayGasEstimate: quote.txCost, signatureVerified: true };
  } catch { throw refused(); }
}

async function inspectSepoliaDeployment({ rpc, getJson, postJson, signal, onStep = () => {}, expected = PINS, purpose = 'full' }) {
  insist(['full', 'exit'].includes(purpose));
  insist(typeof rpc === 'function' && typeof getJson === 'function' && typeof postJson === 'function' && signal);
  const report = { purpose, chainId: CANDIDATE.chainId, observedAt: new Date().toISOString(), chainStateVerified: false,
    signingEnabled: false, broadcastEnabled: false, fundingReady: false, checks: [], contracts: {}, verifiers: {} };
  const active = () => { if (signal.aborted) throw refused(); };
  const exitOmissions = new Set(['native-asset', 'asp-pool-feed', 'asp-public-key', 'asp-root-observations',
    'relayer-deployment', 'signed-native-quote', 'quote-allows-proving-and-handoff']);
  async function check(name, task) {
    active(); onStep(name);
    if (purpose === 'exit' && exitOmissions.has(name)) {
      report.checks.push({ name, notApplicable: true, reason: 'not-required-for-exit' }); return null;
    }
    try { const value = await task(); active(); report.checks.push({ name, passed: true }); return value; }
    catch (error) { active(); report.checks.push({ name, passed: false, code: error?.code === 'PRIVATE_PPV2_PREFLIGHT_REFUSED' ? error.code : 'PREFLIGHT_READ_FAILED' }); return null; }
  }
  async function read(method, params) { active(); const value = await rpc(method, params); active(); return value; }
  const block = await check('chain-and-finalized-anchor', async () => {
    insist(BigInt(await read('eth_chainId', [])) === BigInt(CANDIDATE.chainId));
    const b = await read('eth_getBlockByNumber', ['finalized', false]);
    insist(b && quantity(b.number) && word(b.hash) && quantity(b.timestamp));
    const age = Date.now() - Number(BigInt(b.timestamp)) * 1000;
    insist(age >= -60000 && age < 3600000 && BigInt(b.number) >= BigInt(CANDIDATE.deploymentBlock));
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  });
  report.anchor = block;
  if (!block) return { ...report, observationsConsistent: false };
  const call = async (to, name, args = [], at = block.number) => {
    const result = await read('eth_call', [{ to, data: ABI.encodeFunctionData(name, args) }, at]);
    const decoded = ABI.decodeFunctionResult(name, result);
    insist(ABI.encodeFunctionResult(name, decoded).toLowerCase() === result.toLowerCase());
    return decoded[0];
  };
  async function codeAt(address) {
    insist(/^0x[0-9a-f]{40}$/i.test(address) && BigInt(address) !== 0n);
    const code = await read('eth_getCode', [address, block.number]);
    insist(typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(code) && code.length < 200000);
    return { address: address.toLowerCase(), codeHash: keccak256(code), codeBytes: (code.length - 2) / 2 };
  }
  for (const name of ['pool', 'entrypoint', 'keystore', 'aspRegistry', 'processor']) {
    await check(`code-${name}`, async () => {
      const value = await codeAt(CANDIDATE[name]);
      if (name !== 'processor') {
        const slot = await read('eth_getStorageAt', [value.address, IMPLEMENTATION_SLOT, block.number]);
        insist(word(slot) && /^0x0{24}/i.test(slot));
        value.implementation = await codeAt(`0x${slot.slice(-40)}`);
      }
      report.contracts[name] = value;
    });
  }
  for (const [owner, method, expected] of [['entrypoint', 'poolVault', 'pool'], ['pool', 'keystore', 'keystore'],
    ['pool', 'aspRegistry', 'aspRegistry'], ['processor', 'POOL', 'pool'], ['processor', 'ENTRYPOINT', 'entrypoint']]) {
    await check(`${owner}-${method}`, async () => insist(equalAddress(await call(CANDIDATE[owner], method), CANDIDATE[expected])));
  }
  await check('processor-relay-interface', async () => {
    const maxBatch = await call(CANDIDATE.processor, 'MAX_BATCH');
    insist(maxBatch === 10n);
    const announcer = await codeAt(await call(CANDIDATE.processor, 'ANNOUNCER'));
    const code = (await read('eth_getCode', [CANDIDATE.processor, block.number])).toLowerCase();
    // Complement getter checks and pinned code identity; this is not a bytecode audit.
    insist(code.includes('63ace97342') && !code.includes('63dbc4a257') && !code.includes('63940e2001'));
    report.processorInterface = { maxBatch: Number(maxBatch), announcer, relaySelector: '0xace97342' };
  });
  await check('keystore-root-liveness', async () => {
    const seconds = await call(CANDIDATE.keystore, 'keystoreRootLiveness');
    insist(seconds >= 1200n && seconds < 86400n);
    report.keystoreRootLivenessSeconds = Number(seconds);
  });
  await check('pool-unpaused', async () => insist(await call(CANDIDATE.pool, 'paused') === false));
  await check('native-asset', async () => {
    const asset = await call(CANDIDATE.entrypoint, 'assets', [NATIVE]);
    insist(asset.enabled && asset.minAmount > 0n && asset.vettingFeeBPS < 10000n);
    report.nativeAsset = { enabled: asset.enabled, minAmountWei: String(asset.minAmount), vettingFeeBPS: String(asset.vettingFeeBPS), maxRelayFeeWei: String(asset.maxRelayFee) };
  });
  for (const circuit of ['deposit', 'ragequit', 'transact_1x1']) {
    await check(`verifier-${circuit}`, async () => {
      let target, selector;
      if (circuit === 'transact_1x1') {
        const result = await call(CANDIDATE.pool, 'verifiers', [keccak256(coder.encode(['uint256', 'uint256'], [1, 1]))]);
        target = result.addr; selector = result.selector;
        insist(selector === new Interface(['function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8]) view returns (bool)']).getFunction('verifyProof').selector);
      } else target = await call(CANDIDATE.pool, `${circuit}Verifier`);
      report.verifiers[circuit] = { ...await codeAt(target), ...(selector ? { selector } : {}) };
    });
  }
  await check('reviewed-deployment-pins', async () => {
    const same = (observed, pinned) => {
      insist(observed && pinned);
      for (const key of ['address', 'codeHash', 'codeBytes', 'selector']) if (pinned[key] !== undefined) insist(observed[key] === pinned[key]);
      if (pinned.implementation) same(observed.implementation, pinned.implementation);
    };
    for (const group of ['contracts', 'verifiers']) for (const [name, pin] of Object.entries(expected[group])) same(report[group][name], pin);
  });
  await check('asp-pool-feed', async () => {
    const feed = await getJson('asp', '/global/public/entrypoints');
    const matches = feed.pools.filter((p) => String(p.chainId) === String(CANDIDATE.chainId) && equalAddress(p.poolVault, CANDIDATE.pool));
    insist(matches.length === 1 && equalAddress(matches[0].entrypoint, CANDIDATE.entrypoint));
    insist(Number.isSafeInteger(matches[0].fromBlock) && matches[0].fromBlock >= CANDIDATE.deploymentBlock && BigInt(matches[0].fromBlock) <= BigInt(block.number));
    report.aspPool = matches[0]; report.aspCacheTimestamp = feed.cacheTimestamp;
  });
  await check('asp-public-key', async () => insist((await getJson('asp', '/public-key')).publicKey === CANDIDATE.aspKey));
  await check('asp-root-observations', async () => {
    const response = await getJson('asp', `/association-set/root?chainId=${CANDIDATE.chainId}&entrypoint=${CANDIDATE.entrypoint}`);
    insist(typeof response.root === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(response.root));
    const registry = await call(CANDIDATE.aspRegistry, 'latestASPRoot');
    const latest = await call(CANDIDATE.aspRegistry, 'latestASPRoot', [], 'latest');
    report.aspRoot = { service: response.root, finalizedRegistry: String(registry), latestRegistry: String(latest),
      serviceMatchesLatest: BigInt(response.root) === latest, leavesQualified: false };
    // The leaves-derived root is authoritative for SDK compatibility. A service
    // root ahead of finalized is ordinary finality lag, not proof of bad state.
  });
  await check('relayer-deployment', async () => {
    const details = await getJson('relayer', '/v1/details');
    const matches = details.chains.filter((c) => c.id === CANDIDATE.chainId && c.type === 'evm');
    insist(matches.length === 1);
    const chain = matches[0];
    insist(equalAddress(chain.contracts.poolVault, CANDIDATE.pool) && equalAddress(chain.contracts.entrypoint, CANDIDATE.entrypoint) && equalAddress(chain.contracts.relay, CANDIDATE.processor));
    insist(chain.assets.some((a) => equalAddress(a.address, NATIVE)));
    if (chain.relayerAddress !== undefined) insist(/^0x[0-9a-f]{40}$/i.test(chain.relayerAddress));
    report.relayer = { processor: chain.contracts.relay, gasPayer: chain.relayerAddress ?? null,
      relaySwaps: chain.contracts.relaySwaps ?? null, processors: chain.processors ?? null };
  });
  await check('signed-native-quote', async () => {
    const started = Date.now();
    const quote = await postJson('relayer', '/v1/quote/evm/11155111/receive', { ...QUOTE_REQUEST });
    report.quote = { ...checkQuote(quote), requestMs: Date.now() - started };
  });
  await check('quote-allows-proving-and-handoff', async () => {
    // 15s product handoff margin + observed ~11s native proving + Tor/clock headroom.
    // This diagnostic cannot shorten or bypass the product's expiry rules.
    insist(report.quote && report.quote.remainingMs >= 45000);
  });
  await check('finalized-anchor-still-canonical', async () => {
    const after = await read('eth_getBlockByNumber', [block.number, false]);
    insist(after?.hash === block.hash && after.number === block.number);
  });
  report.observationsConsistent = report.checks.every((c) => c.passed === true || c.notApplicable === true);
  return report;
}
module.exports = { CANDIDATE, ABI, IMPLEMENTATION_SLOT, QUOTE_REQUEST, checkQuote, inspectSepoliaDeployment };
