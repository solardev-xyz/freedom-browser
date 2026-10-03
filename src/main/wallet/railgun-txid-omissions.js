/** Exact classification of independently investigated public service omissions.
 * This classifies continuity only. It never verifies a root, chain, owned note,
 * membership proof, or spend. Unknown breaks always require new qualification.
 */
const knownBreak = Object.freeze({
  index: 4188,
  precedingRoot: '29b951c81d6d0bd08e8b4657d6a6cc6409d9c2e30f6554b1c4d317dfc8fdf368',
  blockNumber: 11816741,
  txid: '4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932',
  graphID:
    '0x0000000000000000000000000000000000000000000000000000000000b44f2500000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000',
  firstNullifier: '0x1c2cf5a682d5ae2b1617b985a8bc31e3ebcd6c730907b7aa9c67d44763402cae',
  expected: '0xfbd11184128f1161139df47f15f76a22a3c64dd6fb8dc656421d7133fce42b0a',
  actual: '0x39dc4b897e3739eb2793437d1e272514314e08dc9e494d859da6a058d005ada8',
});
const omission = Object.freeze({
  ethereumTransaction: '0x' + knownBreak.txid,
  blockNumber: knownBreak.blockNumber,
  missingNullifiedLogIndex: 98,
  missingFirstNullifier: '0x0e751f51883b1120214ad87f5307782e32f7098f0bd71f2f8bfdd478065b0089',
  missingNullifierCount: 3,
  missingCommitmentTree: 0,
  missingCommitmentPositions: Object.freeze([10136, 10137]),
});
const fail = () =>
  Object.assign(new Error('Railgun TXID continuity requires qualification'), {
    code: 'RAILGUN_TXID_CONTINUITY_REFUSED',
  });
function classifyRailgunTxidContinuity(lastIndex, breaks) {
  if (
    !Number.isSafeInteger(lastIndex) ||
    lastIndex < 0 ||
    lastIndex >= 65536 ||
    !Array.isArray(breaks) ||
    breaks.length > 1
  )
    throw fail();
  // A service repair/reindex would change every later position and root. It
  // needs fresh qualification even if its new hash chain is uninterrupted.
  if (lastIndex >= knownBreak.index && breaks.length === 0) throw fail();
  if (breaks.length) {
    const value = breaks[0],
      keys = Object.keys(knownBreak);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      lastIndex < knownBreak.index ||
      keys.some((key) => !Object.hasOwn(value, key) || value[key] !== knownBreak[key])
    )
      throw fail();
  }
  return Object.freeze({
    status: breaks.length ? 'known-service-omission' : 'unbroken-observed-stream',
    globalTxidCompleteness: false,
    knownServiceOmissions: Object.freeze(breaks.length ? [omission] : []),
  });
}
module.exports = { classifyRailgunTxidContinuity };
