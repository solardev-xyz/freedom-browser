/** Bounded public quote/legacy-gas data. No signature, peer trust or authority. */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { createHash } = require('crypto');
const { TextDecoder } = require('util');
const pins = require('./railgun-shield-pins.json');
const { getAddress } = require('ethers');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function shape(value, keys) {
  assert.ok(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
function decimal(value, maximum) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(0|[1-9][0-9]{0,77})$/);
  assert.ok(BigInt(value) <= maximum);
  return BigInt(value);
}
function normalizeRailgunRelayQuote(quote, gas) {
  shape(quote, ['data', 'signature']);
  assert.equal(typeof quote.data, 'string');
  assert.match(quote.data, /^(?:[0-9a-f]{2}){1,8192}$/);
  assert.equal(typeof quote.signature, 'string');
  assert.match(quote.signature, /^[0-9a-f]{128}$/);
  const bytes = Buffer.from(quote.data, 'hex');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  // Restricted upstream JSON.stringify form. This rejects duplicate keys,
  // alternate numeric spellings and whitespace rather than rewriting signed bytes.
  assert.equal(JSON.stringify(value), text);
  shape(value, [
    'fees',
    'feeExpiration',
    'feesID',
    'railgunAddress',
    ...(Object.hasOwn(value, 'identifier') ? ['identifier'] : []),
    'availableWallets',
    'version',
    'relayAdapt',
    'requiredPOIListKeys',
    'reliability',
  ]);
  assert.ok(value.fees && typeof value.fees === 'object' && !Array.isArray(value.fees));
  const tokens = Object.keys(value.fees);
  assert.ok(tokens.length >= 1 && tokens.length <= 32);
  shape(value.fees, tokens);
  assert.ok(Object.hasOwn(value.fees, pins.wrappedNative));
  for (const token of tokens) {
    assert.match(token, /^0x[0-9a-f]{40}$/);
    assert.ok(BigInt(token) > 0n);
    assert.equal(typeof value.fees[token], 'string');
    assert.match(value.fees[token], /^0x[0-9a-f]{1,64}$/);
    assert.ok(BigInt(value.fees[token]) > 0n);
  }
  const rate = value.fees[pins.wrappedNative];
  assert.ok(Number.isSafeInteger(value.feeExpiration) && value.feeExpiration > 0);
  for (const key of ['feesID']) {
    assert.equal(typeof value[key], 'string');
    assert.match(value[key], /^[\x20-\x7e]{1,128}$/);
  }
  if (Object.hasOwn(value, 'identifier')) {
    assert.equal(typeof value.identifier, 'string');
    assert.ok(Buffer.byteLength(value.identifier) <= 128 && value.identifier.isWellFormed());
    assert.ok(
      [...value.identifier].every(
        (char) => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127
      )
    );
  }
  assert.equal(typeof value.railgunAddress, 'string');
  assert.match(value.railgunAddress, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
  assert.ok(
    Number.isSafeInteger(value.availableWallets) &&
      value.availableWallets > 0 &&
      value.availableWallets <= 1000
  );
  assert.equal(typeof value.version, 'string');
  assert.match(value.version, /^8\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,8})$/);
  const [, minor, patch] = value.version.split('.').map(Number);
  assert.ok(minor < 999 || patch === 0);
  assert.equal(typeof value.relayAdapt, 'string');
  assert.match(value.relayAdapt, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(getAddress(value.relayAdapt), getAddress(pins.relayAdapt));
  assert.ok(
    Number.isFinite(value.reliability) &&
      (value.reliability === -1 || (value.reliability >= 0 && value.reliability <= 1))
  );
  const lists = value.requiredPOIListKeys;
  assert.ok(Array.isArray(lists) && lists.length <= 8);
  lists.forEach((key) => assert.match(key, /^[0-9a-f]{64}$/));
  assert.equal(new Set(lists).size, lists.length);
  shape(gas, ['transactionType', 'gasEstimate', 'gasPrice', 'minGasPrice']);
  // Actual Ethereum legacy type 0, not the SDK's separately named Type1 enum.
  assert.equal(gas.transactionType, 0);
  const estimate = decimal(gas.gasEstimate, 3000000n);
  const price = decimal(gas.gasPrice, (1n << 48n) - 1n);
  const minimum = decimal(gas.minGasPrice, (1n << 48n) - 1n);
  assert.ok(estimate > 0n && price > 0n && minimum <= price);
  // Pinned shared/wallet formula, with floors in this order. Rate is token
  // atomic units per 10^18 native wei, not a token amount per gas-unit count.
  const gasLimit = (estimate * 12000n) / 10000n;
  const maximumGasWei = gasLimit * price;
  const fee = (BigInt(rate) * maximumGasWei) / 10n ** 18n;
  assert.ok(fee > 0n && fee <= BigInt(pins.maxQualificationAmount));
  return freeze({
    quote: { data: quote.data, signature: quote.signature },
    fields: value,
    gas: {
      transactionType: 0,
      gasEstimate: gas.gasEstimate,
      gasPrice: gas.gasPrice,
      minGasPrice: gas.minGasPrice,
    },
    chainId: pins.chainId,
    proxy: pins.proxy,
    token: pins.wrappedNative,
    signedBytesSha256: digest(bytes),
    quoteSha256: digest(JSON.stringify([quote.data, quote.signature])),
    gasLimit: gasLimit.toString(),
    maximumGasWei: maximumGasWei.toString(),
    feeAmount: fee.toString(),
  });
}
function assertQuoteCurrent(value, now, previous) {
  assert.ok(Number.isSafeInteger(now) && Number.isSafeInteger(previous) && now >= previous);
  assert.ok(now < value.fields.feeExpiration);
}
function normalizeQuoteVerification(value, binding, inputSha256) {
  shape(value, [
    'inputSha256',
    'quoteSha256',
    'viewingPublicKey',
    'masterPublicKey',
    'signatureVerified',
    'operatorTrusted',
    'spendingEnabled',
    'disclosureEnabled',
    'engineSha256',
    'guards',
  ]);
  assert.equal(value.inputSha256, inputSha256);
  assert.equal(value.quoteSha256, binding.quoteSha256);
  assert.match(value.viewingPublicKey, /^[0-9a-f]{64}$/);
  assert.ok(decimal(value.masterPublicKey, FIELD - 1n) > 0n);
  assert.equal(value.signatureVerified, true);
  for (const key of ['operatorTrusted', 'spendingEnabled', 'disclosureEnabled'])
    assert.equal(value[key], false);
  assert.equal(value.engineSha256, require('./railgun-engine-manifest.json').sha256);
  assert.deepEqual(value.guards, EXPECTED_GUARDS);
  return freeze({ ...value, guards: structuredClone(value.guards) });
}
// Exact reviewed Electron/Node guard catalog; different runtimes fail closed.
const EXPECTED_GUARDS = Object.freeze({
  hooks: Object.freeze([
    'global.fetch',
    'global.WebSocket',
    'process.dlopen',
    'http.request',
    'http.get',
    'https.request',
    'https.get',
    'net.connect',
    'net.createConnection',
    'tls.connect',
    'http2.connect',
    'dgram.createSocket',
    'worker_threads.Worker',
    'child_process.spawn',
    'child_process.spawnSync',
    'child_process.exec',
    'child_process.execSync',
    'child_process.execFile',
    'child_process.execFileSync',
    'child_process.fork',
    'net.Socket.connect',
    'dgram.Socket.send',
    'dgram.Socket.connect',
    'dgram.Socket.bind',
    'dns.lookup',
    'dns.lookupService',
    'dns.resolve',
    'dns.resolve4',
    'dns.resolve6',
    'dns.resolveAny',
    'dns.resolveCaa',
    'dns.resolveCname',
    'dns.resolveMx',
    'dns.resolveNaptr',
    'dns.resolveNs',
    'dns.resolvePtr',
    'dns.resolveSoa',
    'dns.resolveSrv',
    'dns.resolveTlsa',
    'dns.resolveTxt',
    'dns.reverse',
    'dns.Resolver.resolveAny',
    'dns.Resolver.resolve4',
    'dns.Resolver.resolve6',
    'dns.Resolver.resolveCaa',
    'dns.Resolver.resolveCname',
    'dns.Resolver.resolveMx',
    'dns.Resolver.resolveNs',
    'dns.Resolver.resolveTlsa',
    'dns.Resolver.resolveTxt',
    'dns.Resolver.resolveSrv',
    'dns.Resolver.resolvePtr',
    'dns.Resolver.resolveNaptr',
    'dns.Resolver.resolveSoa',
    'dns.Resolver.reverse',
    'dns.Resolver.resolve',
    'dns.promises.lookup',
    'dns.promises.lookupService',
    'dns.promises.resolve',
    'dns.promises.resolve4',
    'dns.promises.resolve6',
    'dns.promises.resolveAny',
    'dns.promises.resolveCaa',
    'dns.promises.resolveCname',
    'dns.promises.resolveMx',
    'dns.promises.resolveNaptr',
    'dns.promises.resolveNs',
    'dns.promises.resolvePtr',
    'dns.promises.resolveSoa',
    'dns.promises.resolveSrv',
    'dns.promises.resolveTlsa',
    'dns.promises.resolveTxt',
    'dns.promises.reverse',
    'dns.promises.Resolver.resolveAny',
    'dns.promises.Resolver.resolve4',
    'dns.promises.Resolver.resolve6',
    'dns.promises.Resolver.resolveCaa',
    'dns.promises.Resolver.resolveCname',
    'dns.promises.Resolver.resolveMx',
    'dns.promises.Resolver.resolveNs',
    'dns.promises.Resolver.resolveTlsa',
    'dns.promises.Resolver.resolveTxt',
    'dns.promises.Resolver.resolveSrv',
    'dns.promises.Resolver.resolvePtr',
    'dns.promises.Resolver.resolveNaptr',
    'dns.promises.Resolver.resolveSoa',
    'dns.promises.Resolver.reverse',
    'dns.promises.Resolver.resolve',
    'electron.net.request',
    'electron.net.fetch',
    'electron.net.resolveHost',
  ]),
  canaries: 91,
  attempts: 0,
});
module.exports = {
  shape,
  freeze,
  digest,
  decimal,
  normalizeRailgunRelayQuote,
  assertQuoteCurrent,
  normalizeQuoteVerification,
  EXPECTED_GUARDS,
};
