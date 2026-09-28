/** Narrow single-asset 1x1 withdrawal wire policy, pinned to SDK fe0244e3. Main
 * supplies witness-derived signals; payload acceptance is not proof verification. */
const { AbiCoder, keccak256, verifyTypedData } = require('ethers');
const { createHash } = require('crypto');
const { FIELD, NATIVE, validProof } = require('./ppv2-deposit-policy');
const { privacyError } = require('../networks/privacy-context');
const coder = AbiCoder.defaultAbiCoder();
const ROUTING = 'tuple(address recipient,address feeRecipient,uint256 feeAmount,uint256 nativeGas)';
// Pinned relayer EVMChainService domain/types. The quote signer is configured
// by main, separately from the fee recipient; neither is learned from a quote.
const QUOTE_TYPES = { RelayWithdrawalCommitment: [
  { name: 'data', type: 'bytes' }, { name: 'asset', type: 'address' },
  { name: 'expiration', type: 'uint256' }, { name: 'amountSent', type: 'uint256' },
  { name: 'amountReceived', type: 'uint256' },
] };
const quoteDomain = (chainId, processor) => ({ name: 'Privacy Pools Relayer', version: '1', chainId, verifyingContract: processor });
const hash = (v) => `0x${createHash('sha256').update(v).digest('hex')}`;
const keys = (v, names) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
const address = (v) => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && BigInt(v) !== 0n;
const word = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) < FIELD;
const amount = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v) && BigInt(v) < 1n << 128n;
const hex = (v, max) => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(v) && v.length <= max;
const fail = () => privacyError('PRIVATE_PPV2_RELAY_REFUSED', 'Relay payload does not match its reviewed intent');
function validateRelay({ intent, endpoint, body, fromBlock = 0 }) {
  try {
    const token = intent?.kind === 'ppv2-token-withdrawal' ? intent.token : NATIVE;
    if (!address(token) || (intent?.kind === 'ppv2-token-withdrawal' && token === NATIVE)) throw fail();
    if (!keys(intent, [...(intent?.kind === 'ppv2-token-withdrawal' ? ['token'] : []), 'kind', 'chainId', 'owner', 'inputValue', 'pool', 'processor', 'relayer', 'quoteSigner', 'recipient', 'amount', 'maxFee', 'commitment', 'publicSignals']) ||
        !['ppv2-native-withdrawal', 'ppv2-token-withdrawal'].includes(intent.kind) || intent.chainId !== 11155111 ||
        !['owner', 'pool', 'processor', 'relayer', 'quoteSigner', 'recipient'].every((k) => address(intent[k])) || !amount(intent.inputValue) ||
        !amount(intent.amount) || BigInt(intent.amount) <= 0n || !amount(intent.maxFee) || !word(intent.commitment) ||
        !Array.isArray(intent.publicSignals) || intent.publicSignals.length !== 8 || !intent.publicSignals.every(word)) throw fail();
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) throw fail();
    const url = new URL(endpoint);
    if (url.href !== endpoint || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !url.pathname.endsWith('/v1/relay/evm/11155111/withdrawal') || /%|\\/.test(endpoint)) throw fail();
    if (typeof body !== 'string' || Buffer.byteLength(body) > 16384) throw fail();
    const payload = JSON.parse(body);
    if (JSON.stringify(payload) !== body || !keys(payload, ['proof', 'noteData', 'signedFeeCommitment', 'inputNullifierNumber', 'outputCommitmentNumber']) ||
        payload.inputNullifierNumber !== 1 || payload.outputCommitmentNumber !== 1 ||
        !keys(payload.proof, ['pi_a', 'pi_b', 'pi_c', 'protocol', 'curve', 'publicSignals'])) throw fail();
    const { publicSignals, ...proof } = payload.proof, result = { proof, publicSignals };
    if (!validProof(result, 8) || !publicSignals.every((v, i) => BigInt(v) === BigInt(intent.publicSignals[i]))) throw fail();
    const fee = payload.signedFeeCommitment;
    if (!keys(fee, ['data', 'asset', 'expiration', 'feeAmount', 'signedRelayerCommitment', 'recipient', 'amountSent', 'amountReceived', 'extraGas']) ||
        typeof fee.asset !== 'string' || fee.asset.toLowerCase() !== token || fee.recipient !== intent.recipient || fee.extraGas !== false ||
        !amount(fee.feeAmount) || BigInt(fee.feeAmount) > BigInt(intent.maxFee) || !amount(fee.amountSent) ||
        fee.amountReceived !== intent.amount || BigInt(fee.amountSent) !== BigInt(intent.amount) + BigInt(fee.feeAmount) ||
        BigInt(fee.amountSent) >= BigInt(intent.inputValue) ||
        !Number.isSafeInteger(fee.expiration) || fee.expiration <= Date.now() ||
        !hex(fee.signedRelayerCommitment, 132) || fee.signedRelayerCommitment.length !== 132) throw fail();
    const routing = coder.encode([ROUTING], [[intent.recipient, intent.relayer, BigInt(fee.feeAmount), 0n]]);
    if (fee.data !== routing || !Array.isArray(payload.noteData) || payload.noteData.length !== 1 ||
        !payload.noteData.every((note) => keys(note, ['hint', 'data']) && typeof note.hint === 'string' && /^0x[0-9a-f]{64}$/i.test(note.hint) &&
          hex(note.data, 4098) && note.data.length > 2)) throw fail();
    const context = BigInt(keccak256(coder.encode(['tuple(address processor,bytes data)', 'tuple(bytes32 hint,bytes data)[]'],
      [[intent.processor, routing], payload.noteData]))) % FIELD;
    if (BigInt(publicSignals[5]) !== BigInt(fee.amountSent) || BigInt(publicSignals[6]) !== BigInt(token) || BigInt(publicSignals[7]) !== context) throw fail();
    const signer = verifyTypedData(quoteDomain(intent.chainId, intent.processor), QUOTE_TYPES, { data: fee.data, asset: fee.asset, expiration: fee.expiration,
      amountSent: fee.amountSent, amountReceived: fee.amountReceived }, fee.signedRelayerCommitment);
    if (signer.toLowerCase() !== intent.quoteSigner) throw fail();
    const intentDigest = hash(JSON.stringify(intent)), endpointDigest = hash(endpoint), payloadDigest = hash(body);
    return { proof: result, expiresAt: Math.min(Date.now() + 120000, fee.expiration),
      attempt: { id: hash(JSON.stringify([intentDigest, endpointDigest, payloadDigest])), intentDigest, endpointDigest, payloadDigest,
        commitment: intent.commitment, nullifier: intent.publicSignals[0] },
      settlement: { ...(token === NATIVE ? {} : { token }), owner: intent.owner, inputValue: intent.inputValue,
        pool: intent.pool, processor: intent.processor, outputCommitment: intent.publicSignals[1],
        amountOut: fee.amountSent, noteDigest: hash(JSON.stringify(payload.noteData.map((note) =>
          ({ hint: note.hint.toLowerCase(), data: note.data.toLowerCase() })))), fromBlock },
      summary: { ...intent, publicSignals: Object.freeze([...intent.publicSignals]), fee: fee.feeAmount,
        endpoint, payloadDigest, proofVerified: true, chainStateVerified: false, quoteSignatureVerified: true } };
  } catch { throw fail(); }
}
module.exports = { validateRelay, hash, ROUTING, QUOTE_TYPES, quoteDomain };
