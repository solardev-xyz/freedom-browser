/** Canonical public projection of pinned engine9.6 UTXO V2/Sepolia records.
 * Digests deliberately exclude later TXID/POI annotations, timestamps and sender
 * enrichment. They cover the event payload, not validity/completeness of its RPC
 * source. Hex case and optional prefixes normalize semantic projections, not
 * raw stored bytes. Full sorted-set hashing is O(N), currently Sepolia-only.
 * No wallet-specific note or unpublished nullifier is queried here.
 */
const { createHash } = require('crypto');
const { paths } = require('./railgun-frontier');
const prefix = paths.metadata().toString();
// Engine9.6 writes one outside-tree padding node at levels1–16. Only its
// independently pinned zero is accepted there; no cryptographic runtime in host.
const ZERO_NODES = Object.freeze([
  '0488f89b25bc7011eaf6a5edce71aeafb9fe706faa3c0a5cd9cbe868ae3b9ffc',
  '01c405064436affeae1fc8e30b2e417b4243bbb819adca3b55bb32efc3e43a4f',
  '0888d37652d10d1781db54b70af87b42a2916e87118f507218f9a42a58e85ed2',
  '183f531ead7217ebc316b4c02a2aad5ad87a1d56d4fb9ed81bf84f644549eaf5',
  '093c48f1ecedf2baec231f0af848a57a76c6cf05b290a396707972e1defd17df',
  '1437bb465994e0453357c17a676b9fdba554e215795ebc17ea5012770dfb77c7',
  '12359ef9572912b49f44556b8bbbfa69318955352f54cfa35cb0f41309ed445a',
  '2dc656dadc82cf7a4707786f4d682b0f130b6515f7927bde48214d37ec25a46c',
  '2500bdfc1592791583acefd050bc439a87f1d8e8697eb773e8e69b44973e6fdc',
  '244ae3b19397e842778b254cd15c037ed49190141b288ff10eb1390b34dc2c31',
  '0ca2b107491c8ca6e5f7e22403ea8529c1e349a1057b8713e09ca9f5b9294d46',
  '18593c75a9e42af27b5e5b56b99c4c6a5d7e7d6e362f00c8e3f69aeebce52313',
  '17aca915b237b04f873518947a1f440f0c1477a6ac79299b3be46858137d4bfb',
  '2726c22ad3d9e23414887e8233ee83cc51603f58c48a9c9e33cb1f306d4365c0',
  '08c5bd0f85cef2f8c3c1412a2b69ee943c6925ecf79798bb2b84e1b76d26871f',
  '27f7c465045e0a4d8bec7c13e41d793734c50006ca08920732ce8c3096261435',
  '14fceeac99eb8419a2796d1958fc2050d489bf5a3eb170ef16a667060344ba90',
]);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun public records unavailable'), {
    code: 'RAILGUN_PUBLIC_RECORDS_INVALID',
  });
const check = (condition) => {
  if (!condition) throw fail();
};
const integer = (value, max = Number.MAX_SAFE_INTEGER) => {
  check(Number.isSafeInteger(value) && value >= 0 && value <= max);
  return value;
};
function hex(value, length) {
  check(typeof value === 'string');
  const bare = value.replace(/^0x/, '');
  check(bare.length === length * 2 && /^[0-9a-fA-F]*$/.test(bare));
  return bare.toLowerCase();
}
function variableHex(value) {
  check(
    typeof value === 'string' &&
      value.startsWith('0x') &&
      value.length <= 1024 * 1024 &&
      value.length % 2 === 0
  );
  return hex(value, (value.length - 2) / 2);
}
function field(value) {
  const result = hex(value, 32);
  check(BigInt('0x' + result) < FIELD);
  return result;
}
function decimal(value, bits = 256) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78);
  check(BigInt(value) < 1n << BigInt(bits));
  return value;
}
function array(value, length, normalize) {
  check(Array.isArray(value) && value.length === length);
  return value.map(normalize);
}
function data(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length <= 1024 * 1024);
  const text = bytes.toString('utf8');
  check(Buffer.from(text).equals(bytes));
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail();
  }
  check(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed;
}
function shape(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(
    required.every((name) => Object.hasOwn(value, name)) &&
      Object.keys(value).every((name) => required.includes(name) || optional.includes(name))
  );
}
function commitment(value, tree, index) {
  const common = ['commitmentType', 'hash', 'txid', 'blockNumber', 'utxoTree', 'utxoIndex'];
  check(value.utxoTree === tree && value.utxoIndex === index);
  const shared = [
    value.commitmentType,
    field(value.hash),
    hex(value.txid, 32),
    integer(value.blockNumber),
    tree,
    index,
  ];
  if (value.commitmentType === 'ShieldCommitment') {
    shape(
      value,
      [...common, 'preImage', 'encryptedBundle', 'shieldKey'],
      ['timestamp', 'fee', 'from']
    );
    const pre = value.preImage,
      token = pre?.token;
    shape(pre, ['npk', 'token', 'value']);
    shape(token, ['tokenType', 'tokenAddress', 'tokenSubID']);
    return [
      ...shared,
      field(pre.npk),
      [integer(token.tokenType, 2), hex(token.tokenAddress, 20), hex(token.tokenSubID, 32)],
      hex(pre.value, 16),
      array(value.encryptedBundle, 3, (v) => hex(v, 32)),
      hex(value.shieldKey, 32),
      value.fee === undefined ? null : decimal(value.fee),
    ];
  }
  check(value.commitmentType === 'TransactCommitmentV2');
  shape(value, [...common, 'ciphertext'], ['timestamp', 'railgunTxid']);
  const bundle = value.ciphertext,
    cipher = bundle?.ciphertext;
  shape(bundle, [
    'ciphertext',
    'blindedSenderViewingKey',
    'blindedReceiverViewingKey',
    'annotationData',
    'memo',
  ]);
  shape(cipher, ['iv', 'tag', 'data']);
  return [
    ...shared,
    [hex(cipher.iv, 16), hex(cipher.tag, 16), array(cipher.data, 3, (v) => hex(v, 32))],
    hex(bundle.blindedSenderViewingKey, 32),
    hex(bundle.blindedReceiverViewingKey, 32),
    variableHex(bundle.annotationData),
    variableHex(bundle.memo),
  ];
}
function unshield(value, txid, index) {
  shape(
    value,
    [
      'txid',
      'toAddress',
      'tokenType',
      'tokenAddress',
      'tokenSubID',
      'amount',
      'fee',
      'blockNumber',
      'eventLogIndex',
    ],
    ['timestamp', 'railgunTxid', 'poisPerList']
  );
  check(hex(value.txid, 32) === txid && value.eventLogIndex === index);
  return [
    txid,
    index,
    integer(value.blockNumber),
    hex(value.toAddress, 20),
    integer(value.tokenType, 2),
    hex(value.tokenAddress, 20),
    decimal(value.tokenSubID),
    decimal(value.amount),
    decimal(value.fee),
  ];
}
function projectPublicRecord(key, value, trees) {
  check(Buffer.isBuffer(key) && key.length <= 4096);
  const text = key.toString('ascii');
  check(Buffer.from(text, 'ascii').equals(key));
  if (text === prefix) return null;
  check(text.startsWith(prefix + ':'));
  const parts = text.slice(prefix.length + 1).split(':');
  check(parts.length === 3 && parts.every((part) => /^[0-9a-f]{64}$/.test(part)));
  const first = BigInt('0x' + parts[0]);
  if (first === 0xfffffffdn) {
    const index = Number(BigInt('0x' + parts[2]));
    integer(index);
    return ['unshields', unshield(data(value), parts[1], index)];
  }
  const tree = Number(first),
    entry = trees[tree];
  integer(tree, 255);
  check(entry && entry.tree === tree);
  const kind = BigInt('0x' + parts[1]);
  if (kind === 0xfffffffen) {
    check(Buffer.isBuffer(value) && value.length === 32);
    return ['nullifiers', [tree, field(parts[2]), value.toString('hex')]];
  }
  const index = Number(BigInt('0x' + parts[2]));
  integer(index);
  if (kind === 0xffffffffn) {
    check(index < entry.length);
    return ['commitments', commitment(data(value), tree, index)];
  }
  // Hash-node rows are not public event records; roots/counts are inspected
  // separately. Reject unexpected subspaces instead of hiding extra records.
  check(kind <= 16n && index <= 65536 >> Number(kind));
  check(Buffer.isBuffer(value) && value.length === 32);
  const node = field(value.toString('hex'));
  if (kind === 0n) check(index < entry.length);
  else if (index === 65536 >> Number(kind)) check(node === ZERO_NODES[Number(kind)]);
  return null;
}
function createPublicRecordDigest(namespace) {
  check(['commitments', 'nullifiers', 'unshields'].includes(namespace));
  const digest = createHash('sha256').update(
    'freedom:railgun:public-records-v1:' + namespace + '\0'
  );
  let count = 0,
    bytes = 0,
    previous = null,
    ended = false;
  return {
    add(key, projected) {
      check(
        !ended &&
          Buffer.isBuffer(key) &&
          key.length <= 4096 &&
          (!previous || Buffer.compare(previous, key) < 0)
      );
      const value = Buffer.from(JSON.stringify(projected));
      count++;
      bytes += key.length + value.length;
      check(count <= 2000000 && bytes <= 1024 * 1024 * 1024 && value.length <= 1024 * 1024);
      const lengths = Buffer.alloc(8);
      lengths.writeUInt32BE(key.length);
      lengths.writeUInt32BE(value.length, 4);
      digest.update(lengths).update(key).update(value);
      previous = Buffer.from(key);
    },
    finish() {
      check(!ended);
      ended = true;
      return { count, sha256: digest.digest('hex') };
    },
  };
}
function emptyPublicState(storeId) {
  return {
    schema: 'public-records-v1',
    storeId,
    trees: [],
    ...Object.fromEntries(
      ['commitments', 'nullifiers', 'unshields'].map((name) => [
        name,
        createPublicRecordDigest(name).finish(),
      ])
    ),
  };
}
function inspectPublicRecords(store, frontier) {
  const storeId = store.getInstanceId?.();
  check(typeof storeId === 'string' && /^[0-9a-f]{64}$/.test(storeId));
  check(['unscanned', 'persisted-unverified'].includes(frontier.status));
  const trees = frontier.trees.map(({ tree, length, root }) => ({ tree, length, root }));
  const digests = Object.fromEntries(
    ['commitments', 'nullifiers', 'unshields'].map((name) => [name, createPublicRecordDigest(name)])
  );
  const cursor = store.openSnapshot({ gte: Buffer.from(prefix), lt: Buffer.from(prefix + '~') });
  let records = 0,
    bytes = 0;
  try {
    for (let row; (row = cursor.next());) {
      const [key, value] = row;
      try {
        records++;
        bytes += key.length + value.length;
        check(records <= 2000000 && bytes <= 1024 * 1024 * 1024);
        const projected = projectPublicRecord(key, value, trees);
        if (projected) digests[projected[0]].add(key, projected[1]);
      } finally {
        key.fill(0);
        value.fill(0);
      }
    }
  } finally {
    cursor.close();
  }
  const result = {
    schema: 'public-records-v1',
    storeId,
    trees,
    ...Object.fromEntries(Object.entries(digests).map(([name, value]) => [name, value.finish()])),
  };
  check(result.commitments.count === trees.reduce((sum, tree) => sum + tree.length, 0));
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(result);
}
module.exports = {
  ZERO_NODES,
  projectPublicRecord,
  createPublicRecordDigest,
  emptyPublicState,
  inspectPublicRecords,
};
