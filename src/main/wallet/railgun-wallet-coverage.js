/** Canonical wallet-private coverage sets. These positions identify owned notes:
 * encrypt them like viewing material and never include them in operational logs.
 */
const { createHash } = require('crypto');
const { plan: normalizePlan } = require('./railgun-scan-journal');
const kinds = Object.freeze([
  'expectedReceived',
  'expectedSent',
  'quarantine',
  'unrecoverableSent',
]);
const fail = () =>
  Object.assign(new Error('Railgun wallet coverage unavailable'), {
    code: 'RAILGUN_WALLET_COVERAGE_INVALID',
  });
const check = (value) => {
  if (!value) throw fail();
};
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const sha = (value) => createHash('sha256').update(value).digest('hex');
function checkpointHash(input) {
  const plan = normalizePlan(input);
  delete plan.source.providersSha256; // Source provider changes do not change public content.
  return sha('freedom:railgun:wallet-checkpoint-v1\0' + JSON.stringify(plan));
}
function assertRailgunWalletCheckpointFollows(previous, next) {
  if (!previous) return;
  previous = normalizePlan(previous);
  next = normalizePlan(next);
  check(next.to.number >= previous.to.number && next.anchor.number >= previous.anchor.number);
  check(next.state.storeId === previous.state.storeId);
  check(next.source.ledgerId === previous.source.ledgerId);
  if (next.anchor.number === previous.anchor.number)
    check(next.anchor.hash === previous.anchor.hash);
  if (next.to.number === previous.to.number)
    check(checkpointHash(next) === checkpointHash(previous));
  check(next.state.trees.length >= previous.state.trees.length);
  for (let i = 0; i < previous.state.trees.length; i++) {
    const old = previous.state.trees[i],
      current = next.state.trees[i];
    check(
      i < previous.state.trees.length - 1
        ? current.length === old.length
        : current.length >= old.length
    );
    if (current.length === old.length) check(current.root === old.root);
  }
  for (const name of ['commitments', 'nullifiers', 'unshields'])
    check(next.state[name].count >= previous.state[name].count);
}
function normalizeRailgunWalletCoverage(checkpoint, input) {
  const plan = normalizePlan(checkpoint),
    trees = plan.state.trees;
  check(exact(input, ['scannedLeaves', ...kinds]));
  check(input.scannedLeaves === plan.state.commitments.count);
  const coverage = { scannedLeaves: input.scannedLeaves };
  const sets = {};
  for (const kind of kinds) {
    const excluded = kind === 'quarantine' || kind === 'unrecoverableSent';
    const rows = input[kind];
    check(Array.isArray(rows) && rows.length <= 10000);
    const seen = new Set();
    coverage[kind] = rows
      .map((row) => {
        check(exact(row, excluded ? ['tree', 'position', 'txid', 'reason'] : ['tree', 'position']));
        check(
          Number.isSafeInteger(row.tree) &&
            row.tree >= 0 &&
            Number.isSafeInteger(row.position) &&
            row.position >= 0
        );
        check(trees[row.tree]?.tree === row.tree && row.position < trees[row.tree].length);
        const id = row.tree + ':' + row.position;
        check(!seen.has(id));
        seen.add(id);
        const value = { tree: row.tree, position: row.position };
        if (excluded) {
          check(typeof row.txid === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(row.txid));
          check(
            row.reason ===
              (kind === 'quarantine' ? 'commitment-mismatch' : 'sent-note-unrecoverable')
          );
          value.txid = row.txid.replace(/^0x/, '').toLowerCase();
          value.reason = row.reason;
        }
        return Object.freeze(value);
      })
      .sort((a, b) => a.tree - b.tree || a.position - b.position);
    Object.freeze(coverage[kind]);
    sets[kind] = seen;
  }
  for (const kind of ['quarantine', 'unrecoverableSent']) {
    for (const id of sets[kind])
      check(!sets.expectedReceived.has(id) && !sets.expectedSent.has(id));
  }
  for (const id of sets.quarantine) check(!sets.unrecoverableSent.has(id));
  return Object.freeze(coverage);
}
function summarizeRailgunWalletCoverage(coverage) {
  return Object.freeze(
    Object.fromEntries(
      kinds.map((kind) => [
        kind,
        Object.freeze({
          count: coverage[kind].length,
          sha256: sha(
            'freedom:railgun:wallet-coverage-v1:' + kind + '\0' + JSON.stringify(coverage[kind])
          ),
        }),
      ])
    )
  );
}
function assertRailgunWalletCoverageExtends(previous, next) {
  check(next.scannedLeaves >= previous.scannedLeaves);
  for (const kind of kinds) {
    const current = new Map(
      next[kind].map((row) => [row.tree + ':' + row.position, JSON.stringify(row)])
    );
    for (const row of previous[kind])
      check(current.get(row.tree + ':' + row.position) === JSON.stringify(row));
  }
}
module.exports = {
  kinds,
  checkpointHash,
  assertRailgunWalletCheckpointFollows,
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
  assertRailgunWalletCoverageExtends,
};
