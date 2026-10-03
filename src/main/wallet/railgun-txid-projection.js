/** Bounded public TXID projection. Crypto functions come from the guarded,
 * pinned engine runtime. Storage writes are returned for the host's journalled
 * apply window; this module neither writes nor grants account/spend authority.
 */
const { createHash } = require('crypto');
const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun TXID projection refused'), {
    code: 'RAILGUN_TXID_PROJECTION_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const shape = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const hex = (v, bytes) => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);
const field = (v) => hex(v, 32) && BigInt('0x' + v) < FIELD;
const prefixed = (v, bytes) =>
  typeof v === 'string' && v.startsWith('0x') && hex(v.slice(2), bytes);
const field0x = (v) => prefixed(v, 32) && field(v.slice(2));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const nodeKey = (level, index) => `txid:node:${level}:${index}`;
function row(value) {
  const keys = [
    'version',
    'graphID',
    'commitments',
    'nullifiers',
    'boundParamsHash',
    'blockNumber',
    'txid',
    'timestamp',
    'utxoTreeIn',
    'utxoTreeOut',
    'utxoBatchStartPositionOut',
    'verificationHash',
  ];
  if (Object.hasOwn(value ?? {}, 'unshield')) keys.push('unshield');
  check(shape(value, keys) && value.version === 'V2' && prefixed(value.graphID, 96));
  check(
    integer(value.blockNumber, Number.MAX_SAFE_INTEGER) &&
      BigInt('0x' + value.graphID.slice(2, 66)) === BigInt(value.blockNumber)
  );
  check(integer(value.timestamp, Number.MAX_SAFE_INTEGER) && hex(value.txid, 32));
  for (const values of [value.commitments, value.nullifiers])
    check(
      Array.isArray(values) &&
        values.length >= 1 &&
        values.length <= 13 &&
        values.every(field0x) &&
        new Set(values).size === values.length
    );
  check(field0x(value.boundParamsHash) && prefixed(value.verificationHash, 32));
  check(
    integer(value.utxoTreeIn, 0xffffffff) &&
      integer(value.utxoTreeOut, 0xffffffff) &&
      integer(value.utxoBatchStartPositionOut, 99999)
  );
  if (value.utxoTreeOut === 99999 || value.utxoBatchStartPositionOut === 99999)
    check(
      value.unshield &&
        value.commitments.length === 1 &&
        value.utxoTreeOut === 99999 &&
        value.utxoBatchStartPositionOut === 99999
    );
  else check(value.utxoBatchStartPositionOut < 65536);
  if (value.unshield) {
    const u = value.unshield;
    check(
      shape(u, ['tokenData', 'toAddress', 'value']) &&
        shape(u.tokenData, ['tokenType', 'tokenAddress', 'tokenSubID'])
    );
    check(
      integer(u.tokenData.tokenType, 2) &&
        prefixed(u.tokenData.tokenAddress, 20) &&
        prefixed(u.tokenData.tokenSubID, 32) &&
        prefixed(u.toAddress, 20)
    );
    check(
      typeof u.value === 'string' &&
        /^(0|[1-9][0-9]*)$/.test(u.value) &&
        u.value.length <= 39 &&
        BigInt(u.value) < 1n << 120n
    );
  }
  return value;
}
function createRailgunTxidProjection({ hashPair, transactionHash, verificationHash, zeroNodes }) {
  check([hashPair, transactionHash, verificationHash].every((v) => typeof v === 'function'));
  check(Array.isArray(zeroNodes) && zeroNodes.length === 17 && zeroNodes.every(field));
  const zeros = [...zeroNodes];
  const pair = (left, right) => {
    check(field(left) && field(right));
    const result = hashPair(left, right);
    check(field(result));
    return result;
  };
  for (let n = 0; n < 16; n++) check(pair(zeros[n], zeros[n]) === zeros[n + 1]);
  const empty = () =>
    freeze({
      version: 1,
      count: 0,
      root: zeros[16],
      after: '0x00',
      verificationHash: null,
      branches: Array(16).fill(null),
      breaks: [],
      transcript: sha(''),
    });
  function state(value) {
    check(
      shape(value, [
        'version',
        'count',
        'root',
        'after',
        'verificationHash',
        'branches',
        'breaks',
        'transcript',
      ])
    );
    check(
      value.version === 1 &&
        integer(value.count, 65536) &&
        field(value.root) &&
        hex(value.transcript, 32)
    );
    check(
      Array.isArray(value.branches) &&
        value.branches.length === 16 &&
        value.branches.every((v) => v === null || field(v))
    );
    if (value.count === 0) check(JSON.stringify(value) === JSON.stringify(empty()));
    else {
      check(prefixed(value.after, 96) && prefixed(value.verificationHash, 32));
      classifyRailgunTxidContinuity(value.count - 1, value.breaks);
    }
    return value;
  }
  async function append(previous, input, read) {
    check(
      typeof read === 'function' && Array.isArray(input) && input.length >= 1 && input.length <= 100
    );
    check(Buffer.byteLength(JSON.stringify(input)) <= 1024 * 1024);
    const next = JSON.parse(JSON.stringify(state(previous))),
      rows = JSON.parse(JSON.stringify(input));
    check(next.count + rows.length <= 65536);
    const writes = new Map();
    for (const item of rows) {
      row(item);
      check(item.graphID > next.after);
      const hashed = transactionHash(item);
      check(hashed && field(hashed.hash) && field(hashed.railgunTxid));
      const lookup = `txid:lookup:${hashed.railgunTxid}`;
      check(!writes.has(lookup) && (await read(lookup)) === null);
      const expected = verificationHash(next.verificationHash ?? undefined, item.nullifiers[0]);
      check(prefixed(expected, 32));
      if (expected !== item.verificationHash) {
        next.breaks.push({
          index: next.count,
          precedingRoot: next.root,
          blockNumber: item.blockNumber,
          txid: item.txid,
          graphID: item.graphID,
          firstNullifier: item.nullifiers[0],
          expected,
          actual: item.verificationHash,
        });
      }
      classifyRailgunTxidContinuity(next.count, next.breaks);
      const record = {
        row: item,
        leaf: hashed.hash,
        railgunTxid: hashed.railgunTxid,
        rowSha256: sha(JSON.stringify(item)),
      };
      writes.set(lookup, String(next.count));
      writes.set(`txid:row:${next.count}`, JSON.stringify(record));
      let node = hashed.hash,
        index = next.count;
      writes.set(nodeKey(0, index), node);
      for (let level = 0; level < 16; level++) {
        if (index & 1) {
          check(field(next.branches[level]));
          node = pair(next.branches[level], node);
        } else {
          next.branches[level] = node;
          node = pair(node, zeros[level]);
        }
        index >>= 1;
        writes.set(nodeKey(level + 1, index), node);
      }
      next.root = node;
      next.count++;
      next.after = item.graphID;
      next.verificationHash = item.verificationHash;
      next.transcript = sha(next.transcript + '\n' + JSON.stringify(record));
    }
    state(next);
    writes.set('txid:state', JSON.stringify(next));
    return freeze({ state: next, writes: [...writes].map(([key, value]) => ({ key, value })) });
  }
  function inspectRecord(recordText) {
    check(typeof recordText === 'string' && Buffer.byteLength(recordText) <= 16384);
    const record = JSON.parse(recordText);
    check(shape(record, ['row', 'leaf', 'railgunTxid', 'rowSha256']));
    row(record.row);
    const hashed = transactionHash(record.row);
    check(
      hashed.railgunTxid === record.railgunTxid &&
        hashed.hash === record.leaf &&
        record.rowSha256 === sha(JSON.stringify(record.row))
    );
    return freeze(record);
  }
  async function witness(input, txid, read) {
    const current = state(JSON.parse(JSON.stringify(input)));
    check(current.count > 0 && field(txid) && typeof read === 'function');
    const position = await read(`txid:lookup:${txid}`);
    check(typeof position === 'string' && /^(0|[1-9][0-9]{0,4})$/.test(position));
    const index = Number(position);
    check(index < current.count);
    const recordText = await read(`txid:row:${index}`);
    const record = inspectRecord(recordText);
    check(record.railgunTxid === txid);
    let node = record.leaf,
      cursor = index;
    const elements = [];
    for (let level = 0; level < 16; level++) {
      const siblingIndex = cursor ^ 1;
      const sibling =
        siblingIndex * 2 ** level >= current.count
          ? zeros[level]
          : await read(nodeKey(level, siblingIndex));
      check(field(sibling));
      elements.push(sibling);
      node = cursor & 1 ? pair(sibling, node) : pair(node, sibling);
      cursor >>= 1;
    }
    check(node === current.root);
    return freeze({
      ...record,
      index,
      leaf: record.leaf,
      elements,
      root: node,
      checkpointIndex: current.count - 1,
      transcript: current.transcript,
      continuity: classifyRailgunTxidContinuity(current.count - 1, current.breaks),
      globalTxidCompleteness: false,
    });
  }
  return Object.freeze({
    empty,
    append,
    witness,
    inspectRecord,
    inspect: (value) => freeze(state(JSON.parse(JSON.stringify(value)))),
  });
}
module.exports = { createRailgunTxidProjection, validateRailgunTxidRow: row };
