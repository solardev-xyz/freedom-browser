/** Main-owned diagnostic review binding. Pure data; never a signing permit. */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { shape, freeze, normalizeRailgunRelayQuote } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { normalizeRailgunRelayReconstruction } = require('./railgun-relay-wallet-data');
const hash = (value) => createHash('sha256').update(value).digest('hex');
function buildRailgunRelayReviewSummary(input) {
  try {
    shape(input, [
      'draft',
      'reconstruction',
      'noteId',
      'checkpointHash',
      'walletGenerationId',
      'publicIdentity',
    ]);
    const draft = normalizeRailgunRelayDraftCapsule(input.draft);
    const reconstruction = normalizeRailgunRelayReconstruction(input.reconstruction, draft);
    const intent = normalizeRailgunRelayUnsignedIntent(draft.data.intent);
    const context = intent.data.context;
    const quote = normalizeRailgunRelayQuote(context.quote, context.gas);
    assert.equal(input.noteId, `${draft.data.selection.tree}:${draft.data.selection.position}`);
    shape(input.publicIdentity, ['generationId', 'sourceId', 'publicId']);
    for (const value of [
      input.checkpointHash,
      input.walletGenerationId,
      ...Object.values(input.publicIdentity),
    ]) {
      assert.equal(typeof value, 'string');
      assert.match(value, /^[0-9a-f]{64}$/);
    }
    const summary = freeze({
      purpose: 'railgun-relay-unsigned-review-v1',
      chainId: quote.chainId,
      proxy: quote.proxy,
      token: quote.token,
      walletId: draft.data.walletId,
      self: { ...context.self },
      peer: { ...context.peer },
      amounts: {
        input: context.inputAmount,
        fee: context.feeAmount,
        self: context.selfAmount,
        cap: context.feeCap,
      },
      gas: {
        ...quote.gas,
        gasLimitMultiplierBps: 12000,
        multiplierDenominator: 10000,
        rate: BigInt(quote.fields.fees[quote.token]).toString(),
        rateDenominator: '1000000000000000000',
        gasLimit: quote.gasLimit,
        maximumGasWei: quote.maximumGasWei,
      },
      quote: {
        quoteSha256: quote.quoteSha256,
        signedBytesSha256: quote.signedBytesSha256,
        expiresAt: quote.fields.feeExpiration,
        requiredPOIListKeys: [...quote.fields.requiredPOIListKeys],
      },
      selection: { noteId: input.noteId, ...draft.data.selection, noteHash: draft.data.noteHash },
      state: {
        checkpointHash: input.checkpointHash,
        walletGenerationId: input.walletGenerationId,
        publicIdentity: { ...input.publicIdentity },
      },
      bindings: {
        intentDigest: intent.digest,
        draftDigest: draft.digest,
        calldataSha256: hash(Buffer.from(intent.data.transaction.data.slice(2), 'hex')),
        reconstructedExpectedHash: reconstruction.expectedHash,
      },
      gasEstimateVerified: false,
      operatorTrusted: false,
      reservationsChecked: false,
      capsulePersisted: false,
      signingEnabled: false,
      proofAuthority: false,
      poiQueriesPermitted: false,
      relaySendPermitted: false,
    });
    return Object.freeze({
      summary,
      summaryDigest: hash('freedom:railgun:relay-review-summary-v1\0' + JSON.stringify(summary)),
    });
  } catch {
    throw Object.assign(new Error('Railgun relay review summary refused'), {
      code: 'RAILGUN_RELAY_REVIEW_SUMMARY_REFUSED',
    });
  }
}
module.exports = { buildRailgunRelayReviewSummary };
