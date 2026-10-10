/** Rebuild public Sepolia trees over bounded Tor log windows, without a wallet.
 * Source Electron usage: script.js /absolute/pinned.asar /absolute/output
 * This diagnoses recovery data availability; it does not qualify SDK note recovery.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { app } = require('electron');
const { Interface } = require('ethers');
const { loadPPv2Runtime } = require('../src/main/wallet/ppv2-runtime');
const { CANDIDATE } = require('../src/main/wallet/ppv2-sepolia-preflight');
const { openLiveTransport } = require('./qualify-ppv2-live');
const abi = new Interface([
  'event LeafInserted(uint256 _newLeaf,uint256 _newRoot,uint256 _leafIndex)',
  'event LeafUpdated(uint256 _newLeaf,uint256 _newRoot,uint256 _leafIndex)',
  'event LeavesInserted(uint256[] _newLeaves,uint256 _newRoot,uint256 _startIndex)',
  'function currentRoot() view returns(uint256)',
  'function currentRootIndex() view returns(uint32)',
  'function roots(uint256) view returns(uint256)',
  'function latestASPRoot() view returns(uint256)',
]);

function applyTreeEvent(leaves, event) {
  if (event.name === 'LeavesInserted') {
    assert.equal(Number(event.args._startIndex), leaves.length);
    assert.ok(
      event.args._newLeaves.length > 0 && leaves.length + event.args._newLeaves.length <= 100000
    );
    leaves.push(...event.args._newLeaves.map((v) => `0x${v.toString(16)}`));
  } else {
    assert.ok(['LeafInserted', 'LeafUpdated'].includes(event.name));
    const index = Number(event.args._leafIndex);
    assert.ok(
      index >= 0 &&
        index < 100000 &&
        (event.name === 'LeafInserted' ? index === leaves.length : index < leaves.length)
    );
    leaves[index] = `0x${event.args._newLeaf.toString(16)}`;
  }
  return event.args._newRoot;
}

async function main() {
  const [archive, output, source = 'publicnode'] = process.argv.slice(2);
  assert.ok(archive && output && path.isAbsolute(output));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  await app.whenReady();
  const runtime = loadPPv2Runtime(archive),
    sdk = require(runtime.sdkEntry);
  const merkle = new sdk.MerkleService({ hashService: await sdk.PoseidonHashService.create() });
  const client = await openLiveTransport(output, console.log, source);
  const report = {
    signingEnabled: false,
    broadcastEnabled: false,
    chainStateVerified: false,
    sdkNoteRecoveryQualified: false,
    trees: {},
  };
  try {
    assert.equal(BigInt(await client.rpc('eth_chainId', [])), BigInt(CANDIDATE.chainId));
    const block = await client.rpc('eth_getBlockByNumber', ['finalized', false]);
    const end = Number(BigInt(block.number));
    assert.ok(end >= CANDIDATE.deploymentBlock && end - CANDIDATE.deploymentBlock < 2000000);
    report.anchor = { number: block.number, hash: block.hash };
    const call = async (to, name, args = []) =>
      abi.decodeFunctionResult(
        name,
        await client.rpc('eth_call', [
          { to, data: abi.encodeFunctionData(name, args) },
          block.number,
        ])
      )[0];
    const poolIndex = await call(CANDIDATE.pool, 'currentRootIndex');
    const roots = {
      pool: await call(CANDIDATE.pool, 'roots', [poolIndex]),
      keystore: await call(CANDIDATE.keystore, 'currentRoot'),
    };
    const aspRoot = await call(CANDIDATE.aspRegistry, 'latestASPRoot');
    try {
      const snapshot = await client.getJson(
        'asp',
        `/11155111/public/event-snapshot/payload?entrypoint=${CANDIDATE.entrypoint}`
      );
      report.snapshot = {
        readable: true,
        generatedAt: snapshot.generatedAt,
        block: snapshot.snapshotBlockNumber,
      };
    } catch {
      report.snapshot = { readable: false, failure: client.trace.at(-1) };
    }
    try {
      const aspLeaves = (
        await client.getJson(
          'asp',
          `/association-set/leaves?chainId=11155111&entrypoint=${CANDIDATE.entrypoint}`
        )
      ).leaves;
      assert.ok(Array.isArray(aspLeaves) && aspLeaves.length < 100000);
      const aspComputed = BigInt(
        await merkle.computeRoot(aspLeaves.map((v) => `0x${BigInt(v).toString(16)}`))
      );
      const latest = await client.rpc('eth_getBlockByNumber', ['latest', false]);
      const raw = await client.rpc('eth_call', [
        { to: CANDIDATE.aspRegistry, data: abi.encodeFunctionData('latestASPRoot') },
        latest.number,
      ]);
      const latestRoot = abi.decodeFunctionResult('latestASPRoot', raw)[0];
      report.asp = {
        count: aspLeaves.length,
        computed: String(aspComputed),
        finalizedRegistry: String(aspRoot),
        latestRegistry: String(latestRoot),
        latestBlock: latest.number,
        matched: aspComputed === latestRoot,
      };
    } catch {
      report.asp = { matched: false, failure: client.trace.at(-1) };
    }
    const topics = ['LeafInserted', 'LeafUpdated', 'LeavesInserted'].map(
      (name) => abi.getEvent(name).topicHash
    );
    for (const name of ['pool', 'keystore']) {
      const leaves = [],
        records = [],
        start = Date.now();
      let windows = 0,
        lastRoot = 0n,
        previousPosition = -1n;
      for (let from = CANDIDATE.deploymentBlock; from <= end; from += 5000) {
        const to = Math.min(from + 4999, end);
        report.scanPosition = { contract: name, from, to, leaves: leaves.length };
        const logs = await client.rpc('eth_getLogs', [
          {
            address: CANDIDATE[name],
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            topics: [topics],
          },
        ]);
        assert.ok(Array.isArray(logs) && logs.length <= 10000);
        logs.sort(
          (a, b) =>
            Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
            Number(BigInt(a.logIndex) - BigInt(b.logIndex))
        );
        for (const log of logs) {
          assert.equal(log.address.toLowerCase(), CANDIDATE[name]);
          assert.ok(!log.removed);
          const height = Number(BigInt(log.blockNumber)),
            position = BigInt(log.blockNumber) * (1n << 32n) + BigInt(log.logIndex);
          assert.ok(height >= from && height <= to && position > previousPosition);
          previousPosition = position;
          const event = abi.parseLog(log);
          report.lastEvent = {
            type: event.name,
            height,
            index: Number(event.args._startIndex ?? event.args._leafIndex),
            leavesBefore: leaves.length,
          };
          lastRoot = applyTreeEvent(leaves, event);
          records.push({ height });
          assert.ok(records.length < 100000);
        }
        windows += 1;
        if (windows % 20 === 0) console.log(`${name}: ${windows} windows, ${leaves.length} leaves`);
      }
      const computed = BigInt(await merkle.computeRoot(leaves));
      report.trees[name] = {
        fromBlock: CANDIDATE.deploymentBlock,
        toBlock: end,
        windows,
        count: leaves.length,
        events: records.length,
        firstEventBlock: records[0]?.height ?? null,
        elapsedMs: Date.now() - start,
        computed: String(computed),
        lastEventRoot: String(lastRoot),
        contractRoot: String(roots[name]),
        matched: computed === roots[name] && computed === lastRoot,
      };
      console.log(`${name}: root match ${report.trees[name].matched}`);
    }
    assert.equal(
      (await client.rpc('eth_getBlockByNumber', [block.number, false])).hash,
      block.hash
    );
    report.passed = report.asp.matched && Object.values(report.trees).every((v) => v.matched);
  } finally {
    fs.writeFileSync(
      path.join(output, 'recovery.json'),
      JSON.stringify({ ...report, transport: client.metadata, requests: client.trace }, null, 2) +
        '\n'
    );
    await client.close();
  }
  console.log(JSON.stringify(report));
  return report.passed ? 0 : 1;
}
if (process.versions.electron && path.resolve(process.argv[1] || '') === __filename) {
  main().then(
    (code) => app.exit(code),
    (error) => {
      console.error('Public recovery qualification failed', error.code || error.name);
      app.exit(1);
    }
  );
}
module.exports = { abi, applyTreeEvent };
