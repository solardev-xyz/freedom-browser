/** Main-owned, read-only Sepolia service acquisition. Fixed public chain queries
 * only: no wallet commitments, nullifiers, addresses, proofs or submissions.
 * Replies remain unverified service assertions until checked against local data.
 */
const { randomUUID } = require('crypto');
const { getPrivacyContext } = require('../networks/privacy-context');
const { createWalletTorTransport } = require('../networks/wallet-tor-transport');
const POI_URL = 'https://ppoi.fdi.network';
const INDEXER_URL = 'https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql';
const TXID_VERSION = 'V2_PoseidonMerkle';
const PAGE_SIZE = 100;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun public service unavailable'), {
    code: 'RAILGUN_PUBLIC_SERVICE_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
const shape = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function hex(value, bytes, field = false) {
  check(
    typeof value === 'string' &&
      /^0x[0-9a-f]+$/.test(value) &&
      value.length > 2 &&
      value.length <= bytes * 2 + 2
  );
  const result = value.slice(2).padStart(bytes * 2, '0');
  if (field) check(BigInt('0x' + result) < FIELD);
  return '0x' + result;
}
function decimal(value, max = Number.MAX_SAFE_INTEGER) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 16);
  const n = Number(value);
  check(Number.isSafeInteger(n) && n <= max);
  return n;
}
function cursor(value) {
  check(value === '0x00' || (typeof value === 'string' && /^0x[0-9a-f]{192}$/.test(value)));
  return value;
}
function normalizeTxidPage(values, after) {
  cursor(after);
  check(Array.isArray(values) && values.length <= PAGE_SIZE);
  let previous = after;
  const result = values.map((v) => {
    check(
      shape(v, [
        'id',
        'nullifiers',
        'commitments',
        'transactionHash',
        'boundParamsHash',
        'blockNumber',
        'utxoTreeIn',
        'utxoTreeOut',
        'utxoBatchStartPositionOut',
        'hasUnshield',
        'unshieldToken',
        'unshieldToAddress',
        'unshieldValue',
        'blockTimestamp',
        'verificationHash',
      ])
    );
    check(v.id !== '0x00' && cursor(v.id) > previous);
    previous = v.id;
    const blockNumber = decimal(v.blockNumber);
    check(BigInt('0x' + v.id.slice(2, 66)) === BigInt(blockNumber));
    for (const name of ['nullifiers', 'commitments']) {
      check(Array.isArray(v[name]) && v[name].length >= 1 && v[name].length <= 13);
    }
    check(typeof v.hasUnshield === 'boolean');
    check(shape(v.unshieldToken, ['tokenType', 'tokenSubID', 'tokenAddress']));
    const tokenType = ['ERC20', 'ERC721', 'ERC1155'].indexOf(v.unshieldToken.tokenType);
    check(tokenType >= 0);
    const tokenAddress = hex(v.unshieldToken.tokenAddress, 20);
    const tokenSubID = hex(v.unshieldToken.tokenSubID, 32);
    const toAddress = hex(v.unshieldToAddress, 20);
    check(
      typeof v.unshieldValue === 'string' &&
        /^(0|[1-9][0-9]*)$/.test(v.unshieldValue) &&
        v.unshieldValue.length <= 39 &&
        BigInt(v.unshieldValue) < 1n << 120n
    );
    const commitments = v.commitments.map((n) => hex(n, 32, true));
    const nullifiers = v.nullifiers.map((n) => hex(n, 32, true));
    const utxoTreeOut = decimal(v.utxoTreeOut, 0xffffffff);
    const utxoBatchStartPositionOut = decimal(v.utxoBatchStartPositionOut, 99999);
    // Pinned engine global-tree-position reserves this pair for unshield-only
    // transactions. It is not a leaf index in the ordinary 2^16 UTXO tree.
    if (utxoTreeOut === 99999 || utxoBatchStartPositionOut === 99999)
      check(
        v.hasUnshield &&
          commitments.length === 1 &&
          utxoTreeOut === 99999 &&
          utxoBatchStartPositionOut === 99999
      );
    else check(utxoBatchStartPositionOut < 65536);
    check(
      new Set(nullifiers).size === nullifiers.length &&
        new Set(commitments).size === commitments.length
    );
    return {
      version: 'V2',
      graphID: v.id,
      commitments,
      nullifiers,
      boundParamsHash: hex(v.boundParamsHash, 32, true),
      blockNumber,
      txid: hex(v.transactionHash, 32).slice(2),
      timestamp: decimal(v.blockTimestamp),
      utxoTreeIn: decimal(v.utxoTreeIn, 0xffffffff),
      utxoTreeOut,
      utxoBatchStartPositionOut,
      verificationHash: hex(v.verificationHash, 32),
      ...(v.hasUnshield
        ? {
            unshield: {
              tokenData: { tokenType, tokenAddress, tokenSubID },
              toAddress,
              value: v.unshieldValue,
            },
          }
        : {}),
    };
  });
  return freeze({ transactions: result, after: previous, exhausted: result.length < PAGE_SIZE });
}
function normalizeTxidStatus(value) {
  // The deployed node uses validatedTxidMerkleroot; pinned wallet SDK types use
  // validatedMerkleroot. Accept either exact schema, never ambiguous aliases.
  const field = Object.hasOwn(value ?? {}, 'validatedTxidMerkleroot')
    ? 'validatedTxidMerkleroot'
    : 'validatedMerkleroot';
  check(shape(value, ['validatedTxidIndex', field]));
  check(
    Number.isSafeInteger(value.validatedTxidIndex) &&
      value.validatedTxidIndex >= 0 &&
      value.validatedTxidIndex < 16 * 65536
  );
  check(typeof value[field] === 'string' && /^[0-9a-f]{64}$/.test(value[field]));
  check(BigInt('0x' + value[field]) < FIELD);
  return Object.freeze({ index: value.validatedTxidIndex, root: value[field] });
}
function createRailgunPublicServices(handle) {
  const context = getPrivacyContext(handle);
  const { subject, requirements } = context;
  check(
    subject.kind === 'service' &&
      subject.principal === 'railgun-public-sync' &&
      subject.protocol === 'railgun' &&
      subject.deployment === 'sepolia' &&
      subject.chainId === 11155111 &&
      subject.role === 'public-services' &&
      subject.operation === null &&
      requirements.content === 'public' &&
      requirements.correctness === 'any' &&
      requirements.maxAgeMs === null
  );
  check(require('../settings-store').isWalletTorExperimentAvailable());
  const tor = require('../tor-manager'),
    endpoint = tor.getWalletSocksEndpoint();
  check(endpoint && !endpoint.signal.aborted);
  const { createPrivacyScope } = require('../networks/privacy-context');
  const controller = new AbortController();
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, endpoint.signal, controller.signal]),
    isCurrent: () => tor.getWalletSocksEndpoint() === endpoint,
  });
  const handles = Object.fromEntries(
    ['poi', 'indexer'].map((role) => [
      role,
      scope.getContext({ ...subject, operation: undefined, role }),
    ])
  );
  const transport = createWalletTorTransport();
  let busy = false,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scope.signal.removeEventListener('abort', close);
    controller.abort();
    scope.close();
    transport.close();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  function active() {
    check(!closed && !scope.signal.aborted);
    getPrivacyContext(handle);
    check(tor.getWalletSocksEndpoint() === endpoint);
  }
  async function request(role, body, normalize) {
    active();
    check(!busy);
    busy = true;
    try {
      const response = await transport.request(
        handles[role],
        role === 'poi' ? POI_URL : INDEXER_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: scope.signal,
          timeoutMs: 45000,
        }
      );
      active();
      check(
        response.status === 200 &&
          Buffer.isBuffer(response.body) &&
          response.body.length <= 1024 * 1024
      );
      const value = JSON.parse(response.body.toString('utf8'));
      const result = normalize(value);
      active();
      return result;
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    close,
    signal: scope.signal,
    trust: Object.freeze({
      level: 'unverified-service',
      chainId: 11155111,
      txidVersion: TXID_VERSION,
      poi: POI_URL,
      indexer: INDEXER_URL,
      transport: 'tor-experimental',
      circuitIsolation: 'unqualified',
    }),
    latestTxid() {
      const id = randomUUID();
      return request(
        'poi',
        {
          jsonrpc: '2.0',
          id,
          method: 'ppoi_validated_txid',
          params: { chainType: '0', chainID: '11155111', txidVersion: TXID_VERSION },
        },
        (value) => {
          check(
            shape(value, ['jsonrpc', 'id', 'result']) && value.jsonrpc === '2.0' && value.id === id
          );
          return normalizeTxidStatus(value.result);
        }
      );
    },
    validateTxidRoot(checkpoint) {
      check(shape(checkpoint, ['tree', 'index', 'root']));
      check(Number.isSafeInteger(checkpoint.tree) && checkpoint.tree >= 0 && checkpoint.tree < 16);
      check(
        Number.isSafeInteger(checkpoint.index) && checkpoint.index >= 0 && checkpoint.index < 65536
      );
      check(typeof checkpoint.root === 'string' && /^[0-9a-f]{64}$/.test(checkpoint.root));
      check(BigInt('0x' + checkpoint.root) < FIELD);
      const id = randomUUID();
      return request(
        'poi',
        {
          jsonrpc: '2.0',
          id,
          method: 'ppoi_validate_txid_merkleroot',
          params: {
            chainType: '0',
            chainID: '11155111',
            txidVersion: TXID_VERSION,
            tree: checkpoint.tree,
            index: checkpoint.index,
            merkleroot: checkpoint.root,
          },
        },
        (value) => {
          check(
            shape(value, ['jsonrpc', 'id', 'result']) &&
              value.jsonrpc === '2.0' &&
              value.id === id &&
              typeof value.result === 'boolean'
          );
          return value.result;
        }
      );
    },
    txidPage(after = '0x00') {
      cursor(after);
      return request(
        'indexer',
        {
          query:
            'query RailgunPublicTxids($after: String!) { transactions(orderBy: id_ASC, limit: 100, where: { id_gt: $after }) { id nullifiers commitments transactionHash boundParamsHash blockNumber utxoTreeIn utxoTreeOut utxoBatchStartPositionOut hasUnshield unshieldToken { tokenType tokenSubID tokenAddress } unshieldToAddress unshieldValue blockTimestamp verificationHash } }',
          variables: { after },
        },
        (value) => {
          check(shape(value, ['data']) && shape(value.data, ['transactions']));
          return normalizeTxidPage(value.data.transactions, after);
        }
      );
    },
  });
}
module.exports = {
  createRailgunPublicServices,
  normalizeTxidPage,
  normalizeTxidStatus,
  POI_URL,
  INDEXER_URL,
};
