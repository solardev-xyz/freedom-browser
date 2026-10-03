/** Main-only interpretation of engine 9.6.0 UTXO V2/Sepolia records.
 * Authenticated engine records are still engine claims. These observations never
 * grant scan completeness, a balance or signing permission.
 */
const refused = (code = 'RAILGUN_FRONTIER_INVALID') =>
  Object.assign(new Error('Railgun frontier unavailable'), { code });
const segment = (value) => value.toLowerCase().padStart(64, '0');
const network = segment('aa36a7');
const prefix = [segment(Buffer.from('merkletree-erc20').toString('hex')), network, segment('5632')];
const key = (parts) => Buffer.from(parts.map(segment).join(':'));
const paths = Object.freeze({
  metadata: () => key(prefix),
  history: () => key(['chain_sync_info', 'merkleetree_history_version', network]),
  synced: () => key(['chain_sync_info', 'last_synced_block', 'v2_poseidonmerkle', network]),
  node: (tree, level, index) =>
    key([...prefix, tree.toString(16), level.toString(16), index.toString(16)]),
  data: (tree, index) => key([...prefix, tree.toString(16), 'ffffffff', index.toString(16)]),
});

// Deliberately a schema subset, not a general MessagePack decoder: no arrays,
// extensions, floats, negative integers, binary values or unsafe map keys.
function decodeMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536) throw refused();
  let offset = 0,
    items = 0;
  const take = (n) => {
    if (offset + n > bytes.length) throw refused();
    const value = bytes.subarray(offset, offset + n);
    offset += n;
    return value;
  };
  const uint = (n) => {
    const b = take(n);
    const value = n === 8 ? Number(b.readBigUInt64BE()) : b.readUIntBE(0, n);
    if (!Number.isSafeInteger(value)) throw refused();
    return value;
  };
  function read(depth = 0) {
    if (depth > 6 || ++items > 4096) throw refused();
    const tag = uint(1);
    if (tag < 0x80) return tag;
    if (tag === 0xc0) return null;
    if (tag >= 0xcc && tag <= 0xcf) return uint(2 ** (tag - 0xcc));
    let length;
    if ((tag & 0xe0) === 0xa0 || [0xd9, 0xda, 0xdb].includes(tag)) {
      length = (tag & 0xe0) === 0xa0 ? tag & 0x1f : uint(2 ** (tag - 0xd9));
      if (!length || length > 64) throw refused();
      const raw = take(length);
      if ([...raw].some((b) => b < 0x20 || b > 0x7e)) throw refused();
      return raw.toString('ascii');
    }
    if ((tag & 0xf0) === 0x80 || tag === 0xde || tag === 0xdf) {
      length = (tag & 0xf0) === 0x80 ? tag & 0xf : uint(tag === 0xde ? 2 : 4);
      if (length > 256) throw refused();
      const result = Object.create(null);
      for (let i = 0; i < length; i++) {
        const name = read(depth + 1);
        if (
          typeof name !== 'string' ||
          ['__proto__', 'prototype', 'constructor'].includes(name) ||
          Object.hasOwn(result, name)
        )
          throw refused();
        result[name] = read(depth + 1);
      }
      return result;
    }
    throw refused();
  }
  const result = read();
  if (offset !== bytes.length) throw refused();
  return result;
}
const shape = (value, required, optional = []) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  required.every((k) => Object.hasOwn(value, k)) &&
  Object.keys(value).every((k) => [...required, ...optional].includes(k));
const integer = (n, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(n) && n >= 0 && n <= maximum;
function decimal(bytes) {
  if (bytes === null) return null;
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 16 ||
    !/^(0|[1-9][0-9]*)$/.test(bytes.toString('ascii')) ||
    [...bytes].some((b) => b < 48 || b > 57)
  )
    throw refused();
  const n = Number(bytes.toString('ascii'));
  if (!integer(n)) throw refused();
  return n;
}
function hash(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== 32 ||
    BigInt('0x' + bytes.toString('hex')) >=
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
  )
    throw refused();
  return '0x' + bytes.toString('hex');
}
function readRailgunFrontier(read) {
  const metadataBytes = read(paths.metadata());
  const historyVersion = decimal(read(paths.history()));
  const lastSyncedBlock = decimal(read(paths.synced()));
  const trees = [],
    reasons = [];
  if (historyVersion !== 13) reasons.push('history-version-unconfirmed');
  if (lastSyncedBlock === null) reasons.push('scan-cursor-missing');
  let orphaned = false;
  if (metadataBytes === null) {
    reasons.push('tree-metadata-missing');
    orphaned = read(paths.node(0, 16, 0)) !== null || read(paths.data(0, 0)) !== null;
    if (orphaned) reasons.push('tree-records-without-metadata');
  } else {
    const metadata = decodeMetadata(metadataBytes);
    if (
      !shape(metadata, ['trees']) ||
      !shape(metadata.trees, [], Object.keys(metadata.trees ?? {}))
    )
      throw refused();
    const entries = Object.entries(metadata.trees);
    for (const [index, value] of entries) {
      if (
        !/^(0|[1-9][0-9]*)$/.test(index) ||
        !integer(Number(index), 65535) ||
        !shape(value, ['scannedHeight'], ['invalidMerklerootDetails']) ||
        !integer(value.scannedHeight, 65536)
      )
        throw refused();
      const invalid = value.invalidMerklerootDetails;
      if (invalid !== undefined && invalid !== null) {
        if (
          !shape(invalid, ['position', 'blockNumber']) ||
          !integer(invalid.position, 65535) ||
          !integer(invalid.blockNumber)
        )
          throw refused();
        reasons.push('invalid-root-reported');
      }
      const rootBytes = read(paths.node(Number(index), 16, 0));
      if (!rootBytes) reasons.push('tree-root-missing');
      const tree = Number(index),
        length = value.scannedHeight;
      if (
        length > 0 &&
        (read(paths.node(tree, 0, length - 1)) === null ||
          read(paths.data(tree, length - 1)) === null)
      )
        reasons.push('frontier-leaf-missing');
      if (
        length < 65536 &&
        (read(paths.node(tree, 0, length)) !== null || read(paths.data(tree, length)) !== null)
      )
        reasons.push('records-beyond-length');
      trees.push(
        Object.freeze({
          tree: Number(index),
          length: value.scannedHeight,
          root: rootBytes === null ? null : hash(rootBytes),
          invalidRoot: invalid != null,
        })
      );
    }
    trees.sort((a, b) => a.tree - b.tree);
    if (!trees.length) reasons.push('empty-tree-metadata');
    if (trees.some((t, i) => t.tree !== i)) reasons.push('tree-gap');
    const nextTree = trees.length ? trees[trees.length - 1].tree + 1 : 0;
    if (
      nextTree <= 65535 &&
      (read(paths.node(nextTree, 0, 0)) !== null || read(paths.data(nextTree, 0)) !== null)
    )
      reasons.push('records-beyond-last-tree');
  }
  const status =
    metadataBytes === null && historyVersion === null && lastSyncedBlock === null && !orphaned
      ? 'unscanned'
      : reasons.length
        ? 'incomplete'
        : 'persisted-unverified';
  return Object.freeze({
    status,
    engineVersion: '9.6.0',
    rootBinding: 'unverified',
    historyVersion,
    lastSyncedBlock,
    trees: Object.freeze(trees),
    reasons: Object.freeze([...new Set(reasons)]),
  });
}
function readRailgunPosition(read, frontier, tree, index) {
  if (frontier.status !== 'persisted-unverified' || !integer(tree, 65535) || !integer(index, 65535))
    throw refused('RAILGUN_FRONTIER_NOT_ELIGIBLE');
  const entry = frontier.trees.find((t) => t.tree === tree);
  if (!entry || index >= entry.length || entry.invalidRoot || !entry.root)
    throw refused('RAILGUN_FRONTIER_NOT_ELIGIBLE');
  const leaf = hash(read(paths.node(tree, 0, index)));
  const bytes = read(paths.data(tree, index));
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) throw refused();
  let commitment;
  try {
    commitment = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw refused();
  }
  if (
    !commitment ||
    typeof commitment.hash !== 'string' ||
    !/^(0x)?[0-9a-fA-F]{64}$/.test(commitment.hash) ||
    '0x' + commitment.hash.replace(/^0x/, '').toLowerCase() !== leaf
  )
    throw refused();
  return Object.freeze({ status: 'persisted-unverified', tree, index, root: entry.root, leaf });
}
module.exports = { readRailgunFrontier, readRailgunPosition, paths, decodeMetadata };
