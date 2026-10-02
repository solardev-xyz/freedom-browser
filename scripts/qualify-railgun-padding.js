/** Synthetic full-tree node-padding qualification using authenticated engine9.6. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const base = path.join(__dirname, '..');
const guards = require('../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
  onRefusal: () => process.exit(2),
});
require(path.join(base, 'scripts/railgun-fixture-integrity')).assertRailgunFixture(
  path.join(base, 'scripts/fixtures/railgun-engine/node_modules')
);
const r = createRequire(path.join(base, 'scripts/fixtures/railgun-engine/package.json'));
const root = path.dirname(r.resolve('@railgun-community/engine'));
const { Merkletree } = require(path.join(root, 'merkletree/merkletree'));
const { initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
const { ZERO_NODES, projectPublicRecord } = require(
  path.join(base, 'src/main/wallet/railgun-public-records')
);
const { paths } = require(path.join(base, 'src/main/wallet/railgun-frontier'));
(async () => {
  await initPoseidonPromise;
  const reports = [];
  for (const [method, batchSize] of [
    ['insertLeaves', 4096],
    ['insertLeaves', 65536],
    ['rebuild-inclusive-helper', 4096],
    ['rebuild-inclusive-helper', 65536],
  ]) {
    const nodes = Array.from({ length: 17 }, () => new Map());
    for (let start = 0; start < 65536; start += batchSize) {
      const group = [[]];
      for (let i = start; i < start + batchSize; i++)
        group[0][i] = BigInt(i + 1)
          .toString(16)
          .padStart(64, '0');
      const lookup = async (level, index) => nodes[level].get(index) ?? ZERO_NODES[level];
      if (method === 'insertLeaves') {
        await Merkletree.prototype.insertLeaves.call(
          {
            getNodeHash: (_tree, level, index) => lookup(level, index),
            merklerootValidator: async () => true,
            validRootCallback: async () => {},
            writeTreeToDB: async (_tree, written) => {
              group.splice(0, group.length, ...written);
            },
          },
          0,
          start,
          group[0].slice(start).map((hash) => ({ hash })),
          true
        );
      } else {
        await Merkletree.fillHashWriteGroup(group, 0, start, start + batchSize - 1, lookup);
      }
      const trees = [{ tree: 0, length: start + batchSize, root: '0x' + group[16][0] }];
      for (let level = 0; level <= 16; level++)
        for (const key of Object.keys(group[level])) {
          const index = Number(key),
            hash = group[level][key];
          assert.equal(
            projectPublicRecord(paths.node(0, level, index), Buffer.from(hash, 'hex'), trees),
            null
          );
          nodes[level].set(index, hash);
        }
    }
    const padding = [];
    for (let level = 1; level <= 16; level++) {
      const index = 65536 >> level;
      const value = nodes[level].get(index);
      if (value !== undefined) {
        assert.equal(value, ZERO_NODES[level]);
        padding.push({ level, index, hash: value });
      }
    }
    assert.equal(
      padding.length,
      method === 'rebuild-inclusive-helper' && batchSize === 4096 ? 12 : 16
    );
    reports.push({ method, batchSize, root: nodes[16].get(0), padding });
  }
  for (const report of reports) assert.equal(report.root, reports[0].root);
  assert.equal(guards.report().attempts, 0);
  const sourceSha256 = require('crypto')
    .createHash('sha256')
    .update(require('fs').readFileSync(__filename))
    .digest('hex');
  console.log(
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        passed: true,
        sourceSha256,
        guards: guards.report(),
        scope: 'actual engine hash-write groups; no storage, wallet or chain qualification',
        reports,
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
