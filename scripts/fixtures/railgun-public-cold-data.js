/** Public-vector fixture wire only. Serialized data never authenticates a main capability. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Interface } = require('ethers');
const { assert } = require('./railgun-native-assertions');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { SHIELD_ABI } = require('../../src/main/wallet/railgun-shield-policy');
const {
  SHIELD_EVENT,
  inspectRailgunShieldReceipt,
} = require('../../src/main/wallet/railgun-shield-receipt');
const { transactionIntent } = require('../../src/main/wallet/private-transaction-intent');
const abi = new Interface([...SHIELD_ABI, SHIELD_EVENT]);
const json = (v) =>
  JSON.stringify(v, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
const digest = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' || Buffer.isBuffer(v) ? v : json(v))
    .digest('hex');
const q = (n) => '0x' + BigInt(n).toString(16);
const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function exact(v, keys) {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
}
function sourceLog(log) {
  assert.notEqual(log.removed, true);
  return {
    address: log.address.toLowerCase(),
    blockNumber: Number(BigInt(log.blockNumber)),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: Number(BigInt(log.transactionIndex)),
    logIndex: Number(BigInt(log.logIndex)),
    topics: [...log.topics],
    data: log.data,
    removed: false,
  };
}
function rpcLog(log) {
  return {
    ...log,
    blockNumber: q(log.blockNumber),
    transactionIndex: q(log.transactionIndex),
    logIndex: q(log.logIndex),
  };
}
function createChain(source) {
  assert.ok(Array.isArray(source.logs) && source.logs.length > 0 && source.logs.length <= 4095);
  const logs = source.logs.map(sourceLog);
  const baselineTo = Math.max(...logs.map((v) => v.blockNumber));
  assert.ok(baselineTo > 0 && baselineTo < 10000);
  const inclusion = baselineTo + 1,
    anchor = Math.max(100, inclusion + 2);
  const headers = Array.from({ length: anchor + 1 }, (_, n) => ({
    number: q(n),
    hash: hash(n + 1),
    parentHash: hash(n),
    transactions: [],
  }));
  for (const log of logs) {
    assert.equal(log.address, pins.proxy);
    assert.equal(log.blockHash, headers[log.blockNumber].hash);
  }
  return {
    version: 1,
    baselineTo,
    logs,
    headers,
    latest: anchor,
    finalized: anchor,
    transaction: null,
    receipt: null,
    expected: null,
  };
}
function acceptSigned(chain, tx, record, checkpoint, commitment) {
  assert.equal(chain.transaction, null);
  assert.equal(record.state, 'attempted');
  assert.equal(record.hash, tx.hash.toLowerCase());
  assert.equal(record.nonce, tx.nonce);
  const intent = transactionIntent('railgun-native-shield', {
    ...tx.toJSON(),
    from: tx.from.toLowerCase(),
  });
  assert.deepEqual(intent, record.intent);
  assert.equal(checkpoint.to.number, chain.baselineTo);
  assert.equal(checkpoint.to.hash, chain.headers[chain.baselineTo].hash);
  assert.equal(checkpoint.state.trees.length, 1);
  const position = checkpoint.state.trees[0].length;
  assert.ok(Number.isSafeInteger(position) && position > 0 && position < 65536);
  const inclusion = chain.baselineTo + 1,
    header = chain.headers[inclusion];
  const [, calls] = abi.decodeFunctionData('multicall', tx.data);
  const [notes] = abi.decodeFunctionData('shield', calls[1].data);
  assert.equal(notes.length, 1);
  const net = BigInt(record.intent.noteValue),
    fee = tx.value - net;
  const event = abi.encodeEventLog('Shield', [
    0,
    position,
    [[notes[0].preimage.npk, notes[0].preimage.token, net]],
    [notes[0].ciphertext],
    [fee],
  ]);
  const log = {
    address: pins.proxy,
    blockNumber: inclusion,
    blockHash: header.hash,
    transactionHash: record.hash,
    transactionIndex: 0,
    logIndex: 4,
    topics: [...event.topics],
    data: event.data,
    removed: false,
  };
  assert.ok(!chain.logs.some((v) => v.blockNumber === inclusion));
  chain.transaction = {
    hash: record.hash,
    nonce: q(tx.nonce),
    chainId: q(tx.chainId),
    from: tx.from.toLowerCase(),
    to: tx.to.toLowerCase(),
    value: q(tx.value),
    input: tx.data,
    blockHash: header.hash,
    blockNumber: header.number,
  };
  chain.receipt = {
    transactionHash: record.hash,
    from: tx.from.toLowerCase(),
    to: tx.to.toLowerCase(),
    status: '0x1',
    blockHash: header.hash,
    blockNumber: header.number,
    gasUsed: '0x493e0',
    logs: [rpcLog(log)],
  };
  chain.expected = {
    tree: 0,
    position,
    commitment,
    noteValue: net.toString(),
    grossAmount: tx.value.toString(),
    fee: fee.toString(),
    npk: record.intent.npk,
  };
  header.transactions.push(record.hash);
  chain.logs.push(log);
  validateChain(chain);
  assert.equal(
    inspectRailgunShieldReceipt(record, chain.transaction, chain.receipt).status,
    'matched'
  );
  return chain;
}
function validateChain(chain) {
  exact(chain, [
    'version',
    'baselineTo',
    'logs',
    'headers',
    'latest',
    'finalized',
    'transaction',
    'receipt',
    'expected',
  ]);
  assert.equal(chain.version, 1);
  assert.ok(Number.isSafeInteger(chain.baselineTo) && chain.baselineTo > 0);
  assert.equal(chain.latest, chain.headers.length - 1);
  assert.equal(chain.finalized, chain.latest);
  for (const [n, h] of chain.headers.entries()) {
    exact(h, ['number', 'hash', 'parentHash', 'transactions']);
    assert.equal(h.number, q(n));
    assert.equal(h.hash, hash(n + 1));
    assert.equal(h.parentHash, hash(n));
    assert.ok(Array.isArray(h.transactions));
  }
  let last = [-1, -1];
  for (const l of chain.logs) {
    exact(l, [
      'address',
      'blockNumber',
      'blockHash',
      'transactionHash',
      'transactionIndex',
      'logIndex',
      'topics',
      'data',
      'removed',
    ]);
    assert.equal(l.address, pins.proxy);
    assert.equal(l.removed, false);
    assert.ok(l.blockNumber > last[0] || (l.blockNumber === last[0] && l.logIndex > last[1]));
    last = [l.blockNumber, l.logIndex];
    assert.equal(l.blockHash, chain.headers[l.blockNumber].hash);
    assert.match(l.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.ok(Array.isArray(l.topics));
    assert.match(l.data, /^0x(?:[0-9a-f]{2})*$/);
  }
  if (chain.transaction === null) {
    assert.equal(chain.receipt, null);
    assert.equal(chain.expected, null);
    return chain;
  }
  const tx = chain.transaction,
    r = chain.receipt,
    e = chain.expected;
  exact(tx, [
    'hash',
    'nonce',
    'chainId',
    'from',
    'to',
    'value',
    'input',
    'blockHash',
    'blockNumber',
  ]);
  exact(r, [
    'transactionHash',
    'from',
    'to',
    'status',
    'blockHash',
    'blockNumber',
    'gasUsed',
    'logs',
  ]);
  exact(e, ['tree', 'position', 'commitment', 'noteValue', 'grossAmount', 'fee', 'npk']);
  assert.equal(tx.chainId, q(pins.chainId));
  assert.match(tx.from, /^0x[0-9a-f]{40}$/);
  assert.equal(tx.to, pins.relayAdapt);
  assert.match(tx.nonce, /^0x(?:0|[1-9a-f][0-9a-f]*)$/);
  assert.equal(tx.blockNumber, q(chain.baselineTo + 1));
  assert.equal(tx.blockHash, chain.headers[chain.baselineTo + 1].hash);
  assert.equal(r.transactionHash, tx.hash);
  assert.equal(r.from, tx.from);
  assert.equal(r.to, tx.to);
  assert.equal(r.status, '0x1');
  assert.equal(r.blockHash, tx.blockHash);
  assert.equal(r.blockNumber, tx.blockNumber);
  assert.equal(r.logs.length, 1);
  assert.deepEqual(r.logs[0], rpcLog(chain.logs.at(-1)));
  assert.ok(chain.latest - chain.baselineTo >= 3);
  assert.deepEqual(chain.headers[chain.baselineTo + 1].transactions, [tx.hash]);
  assert.equal(e.tree, 0);
  assert.ok(Number.isSafeInteger(e.position) && e.position > 0 && e.position < 65536);
  assert.match(e.commitment, /^0x[0-9a-f]{64}$/);
  const intent = transactionIntent('railgun-native-shield', {
    chainId: tx.chainId,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    data: tx.input,
  });
  const matched = inspectRailgunShieldReceipt(
    { hash: tx.hash, nonce: Number(BigInt(tx.nonce)), intent },
    tx,
    r
  );
  assert.equal(matched.status, 'matched');
  for (const k of ['tree', 'position', 'npk', 'noteValue', 'fee']) assert.equal(matched[k], e[k]);
  assert.equal(e.grossAmount, intent.amount);
  assert.equal(e.noteValue, intent.noteValue);
  return chain;
}
function receivedDigest(owned, exclude) {
  const keep = (v) => v.id !== exclude;
  return digest({ received: owned.read.received.filter(keep), owned: owned.ownedPoi.filter(keep) });
}
function wethAmount(owned) {
  return owned.read.received
    .filter(
      (v) =>
        v.spentTxid === false &&
        v.asset.__type === 'erc20' &&
        v.asset.contract.toLowerCase() === pins.wrappedNative
    )
    .reduce((n, v) => n + v.amount, 0n);
}
function assertCredit(owned, chain, baseline) {
  const e = chain.expected,
    id = e.tree + ':' + e.position;
  const notes = owned.read.received.filter((v) => v.id === id),
    records = owned.ownedPoi.filter((v) => v.id === id);
  assert.equal(notes.length, 1);
  assert.equal(records.length, 1);
  const note = notes[0],
    record = records[0];
  assert.equal(note.txid, chain.transaction.hash);
  assert.equal(note.hash, e.commitment);
  assert.equal(note.spentTxid, false);
  assert.equal(note.amount, BigInt(e.noteValue));
  assert.deepEqual(note.asset, { __type: 'erc20', contract: pins.wrappedNative });
  assert.equal(record.type, 'Shield');
  assert.equal(record.npk, e.npk);
  assert.equal(record.hash, e.commitment);
  assert.equal(record.blockNumber, chain.baselineTo + 1);
  assert.equal(receivedDigest(owned, id), baseline.notesSha256);
  assert.equal(
    digest((wethAmount(owned) - BigInt(e.noteValue)).toString()),
    baseline.balanceSha256
  );
  assert.equal(owned.trees.length, 1);
  assert.equal(owned.trees[0].length, e.position + 1);
  assert.equal(owned.read.readiness.to.number, chain.baselineTo + 1);
}
function inventory(directory) {
  const out = {};
  function visit(dir) {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, entry.name),
        rel = path.relative(directory, f);
      if (rel === 'profile-open.lock' || rel.startsWith('profile-open.lock/')) continue;
      const stat = fs.lstatSync(f);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) visit(f);
      else {
        assert.ok(stat.isFile() && stat.nlink === 1);
        out[rel] = digest(fs.readFileSync(f));
      }
    }
  }
  visit(directory);
  return out;
}
module.exports = {
  json,
  digest,
  q,
  hash,
  exact,
  sourceLog,
  rpcLog,
  createChain,
  acceptSigned,
  validateChain,
  receivedDigest,
  wethAmount,
  assertCredit,
  inventory,
};
