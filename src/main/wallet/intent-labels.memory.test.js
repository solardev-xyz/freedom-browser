/**
 * #712 review, round 2: a header walk kept every block reply it fetched,
 * transaction lists included, until its pass ended: about 811 MB for 8192
 * headers of 1024 transactions each. Replies are now compacted as each
 * resolves, walked in chunks, and a chain's headers released with its last
 * held intent. Measured in a child process with an exposed GC
 * (test/helpers/finality-memory-probe.js).
 */
const path = require('path');
const { spawnSync } = require('child_process');

jest.setTimeout(120_000);

const PROBE = path.join(__dirname, '../../../test/helpers/finality-memory-probe.js');
const MB = 1024 * 1024;

function probe(depth, txs) {
  const run = spawnSync(process.execPath, ['--expose-gc', PROBE, String(depth), String(txs)], {
    encoding: 'utf8',
  });
  expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
  return JSON.parse(run.stdout.trim());
}

test('walking 8192 headers of 1024 transactions each keeps a few MB live, not the blocks', () => {
  const result = probe(8192, 1024);
  expect(result).toMatchObject({ headers: 8192, settled: true, maxActive: 4 });
  // About 3 MB measured: the verified headers (number, hash, parent hash)
  // and one chunk of replies. The whole replies came to ~811 MB.
  expect(result.liveHeapIncrease).toBeLessThan(24 * MB);
  // Settled: its chain's headers are released with it.
  expect(result.retainedAfterPass).toBeLessThan(2 * MB);
});
