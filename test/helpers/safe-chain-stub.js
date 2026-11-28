/**
 * Gnosis for SAFE-3's real-cored suite (the SAFE-3 plan's point 12 and PR
 * 10's gates; freedom-core design 0016): one chain state behind two
 * endpoints, so the real freedom-cored's quorum of two distinct endpoints
 * agrees and its Safe reads are `verified` (design 0016, "Chain reads").
 * `fetch(url, init)` is main's hop for the chain shell (core/naming-shell.js
 * `makeHop`): each URL in `urls` is one endpoint, and every JSON-RPC call
 * either gets is answered from the same state and recorded in `calls`
 * (`{ endpoint, method, params }`). `refuse(methods, endpoints?)` makes
 * those methods fail there, `-32601`, until called again with none.
 *
 * It plays what the core and main read of a Safe 1.4.1 on Gnosis, and what
 * their sends change:
 * - **A deployment** (`createProxyWithNonce` to the pinned factory, sent
 *   raw): the Safe's address computed as the factory computes it (CREATE2
 *   over the pinned proxy creation code, the singleton and the
 *   initializer's salt), and the Safe deployed there with `setup`'s owners,
 *   threshold and fallback handler, nonce 0, no guard and no module; its
 *   receipt carries the factory's `ProxyCreation(proxy, singleton)` log,
 *   which `safe.deployed` reads from both endpoints.
 * - **An execution** (`execTransaction` to a deployed Safe): run as the
 *   Safe checks it, the SafeTx's EIP-712 hash at the Safe's nonce, each
 *   65-byte signature an owner's ECDSA signature over it (v 27 or 28) or
 *   over its EIP-191 message (v 31 or 32), the owners strictly ascending,
 *   at least the threshold. Executed (the nonce moves on, the value moves
 *   from the Safe's balance) or reverted (status 0), and kept in
 *   `executions` with the owners it recovered.
 * - The eight setup reads (fc-safe `reads.rs`): `eth_getCode`, the
 *   singleton, guard and fallback-handler slots, `getOwners()`,
 *   `getThreshold()`, `getModulesPaginated(0x1, 1)` and `nonce()`.
 * - Accounts' balances and nonces, receipts, blocks (one per transaction,
 *   EIP-1559 with a 1 gwei base fee), a fee quote (`eth_gasPrice` 2 gwei,
 *   `eth_maxPriorityFeePerGas` 1 gwei, `eth_feeHistory`) and an estimate of
 *   200,000 gas.
 * Any other method, or a call to a contract it doesn't play, is an error,
 * and recorded.
 */

const {
  AbiCoder,
  Interface,
  Signature,
  Transaction,
  TypedDataEncoder,
  getAddress,
  getCreate2Address,
  hashMessage,
  id: topicOf,
  keccak256,
  recoverAddress,
  solidityPacked,
  zeroPadValue,
  toBeHex,
} = require('ethers');

const CHAIN_ID = 100;
// fc-safe's constants (crates/fc-safe/src/constants.rs, cored-v0.32.0).
const SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const SENTINEL = '0x0000000000000000000000000000000000000001';
const ZERO = '0x0000000000000000000000000000000000000000';
const PROXY_CREATION_CODE =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e683398181016040526020' +
  '81101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffff' +
  'ffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100' +
  'ca576040517f08c379a0000000000000000000000000000000000000000000000000000000008152' +
  '6004018080602001828103825260228152602001806101c460229139604001915050604051809103' +
  '90fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff0219169083' +
  '73ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3' +
  'fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e00000000' +
  '00000000000000000000000000000000000000000000000060003514156050578060005260206000' +
  'f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2' +
  '64697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f3144' +
  '1364736f6c63430007060033496e76616c69642073696e676c65746f6e2061646472657373207072' +
  '6f7669646564';
const PROXY_CREATION_CODE_HASH = '0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f';
if (keccak256(PROXY_CREATION_CODE) !== PROXY_CREATION_CODE_HASH) {
  throw new Error("safe-chain-stub: the proxy creation code isn't the pinned factory's");
}
// SafeProxy's runtime code, from the creation code above (any non-empty
// code is a deployed Safe to the core's reads).
const PROXY_RUNTIME = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e';

// Storage slots (fc-safe reads.rs).
const SINGLETON_SLOT = '0x' + '00'.repeat(32);
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
const FALLBACK_HANDLER_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';

const SAFE_ABI = new Interface([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]);
const FACTORY_ABI = new Interface([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);
const PROXY_CREATION_TOPIC = topicOf('ProxyCreation(address,address)');
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const GWEI = 1_000_000_000n;
const BASE_FEE = GWEI;
const GAS_PRICE = 2n * GWEI;
const PRIORITY_FEE = GWEI;
const ESTIMATE = 200_000n;
const GAS_USED = 100_000n;
const ETHER = 10n ** 18n;

const hex = (n) => toBeHex(BigInt(n));
const word = (n) => zeroPadValue(toBeHex(BigInt(n)), 32);
const addressWord = (address) => zeroPadValue(address, 32);
const key = (address) => getAddress(address).toLowerCase();

/** The address the pinned factory gives `createProxyWithNonce(singleton, initializer, saltNonce)`. */
function proxyAddress(singleton, initializer, saltNonce) {
  const salt = keccak256(solidityPacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]));
  const initCode = solidityPacked(['bytes', 'uint256'], [PROXY_CREATION_CODE, BigInt(singleton)]);
  return getCreate2Address(PROXY_FACTORY, salt, keccak256(initCode));
}

/**
 * The owners `signatures` recover for SafeTx hash `hash`, as Safe 1.4.1's
 * `checkNSignatures` reads ECDSA and eth_sign signatures; null for any
 * other kind, a short blob, or owners not strictly ascending.
 */
function recoverOwners(hash, signatures, count) {
  const bytes = signatures.slice(2);
  if (bytes.length < count * 130) return null;
  const owners = [];
  for (let i = 0; i < count; i += 1) {
    const part = bytes.slice(i * 130, (i + 1) * 130);
    const r = '0x' + part.slice(0, 64);
    const s = '0x' + part.slice(64, 128);
    const v = parseInt(part.slice(128, 130), 16);
    let owner;
    if (v === 27 || v === 28) {
      owner = recoverAddress(hash, Signature.from({ r, s, v }));
    } else if (v === 31 || v === 32) {
      owner = recoverAddress(hashMessage(Buffer.from(hash.slice(2), 'hex')), Signature.from({ r, s, v: v - 4 }));
    } else {
      return null;
    }
    if (owners.length && BigInt(owner) <= BigInt(owners.at(-1))) return null;
    owners.push(owner);
  }
  return owners;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.urls] - the two endpoints' URLs
 * @param {bigint} [options.balance] - every account's balance until set (1 xDAI)
 */
function startSafeChainStub({ urls = ['https://a.gnosis.test/', 'https://b.gnosis.test/'], balance = ETHER } = {}) {
  const state = {
    block: 1,
    balances: new Map(),
    nonces: new Map(),
    safes: new Map(),
    receipts: new Map(),
    transactions: new Map(),
  };
  const calls = [];
  const sent = [];
  const executions = [];
  const deployments = [];
  let refused = { methods: new Set(), endpoints: new Set() };

  const balanceOf = (address) => state.balances.get(key(address)) ?? balance;
  const nonceOf = (address) => state.nonces.get(key(address)) ?? 0;
  const safeAt = (address) => (address ? state.safes.get(key(address)) ?? null : null);

  function block(number) {
    return {
      number: hex(number),
      hash: keccak256(solidityPacked(['string', 'uint256'], ['block', number])),
      parentHash: keccak256(solidityPacked(['string', 'uint256'], ['block', number - 1])),
      timestamp: hex(Math.floor(Date.now() / 1000)),
      baseFeePerGas: hex(BASE_FEE),
      gasLimit: hex(30_000_000),
      gasUsed: hex(0),
      miner: ZERO,
      transactions: [],
    };
  }

  function call({ to, data = '0x' }) {
    const safe = safeAt(to);
    if (!safe) throw new Error(`no contract this stub plays at ${to}`);
    const selector = data.slice(0, 10);
    if (selector === SAFE_ABI.getFunction('getOwners').selector) {
      return AbiCoder.defaultAbiCoder().encode(['address[]'], [safe.owners]);
    }
    if (selector === SAFE_ABI.getFunction('getThreshold').selector) return word(safe.threshold);
    if (selector === SAFE_ABI.getFunction('nonce').selector) return word(safe.nonce);
    if (selector === SAFE_ABI.getFunction('getModulesPaginated').selector) {
      return AbiCoder.defaultAbiCoder().encode(['address[]', 'address'], [[], SENTINEL]);
    }
    throw new Error(`the Safe at ${to} has no call ${selector} here`);
  }

  function storage(address, slot) {
    const safe = safeAt(address);
    if (!safe) return word(0);
    const at = zeroPadValue(slot, 32).toLowerCase();
    if (at === SINGLETON_SLOT) return addressWord(SINGLETON);
    if (at === FALLBACK_HANDLER_SLOT) return addressWord(safe.fallbackHandler);
    if (at === GUARD_SLOT) return word(0);
    return word(0);
  }

  /** A deployment's effect: the Safe at the factory's address, as `setup` leaves it. */
  function deploy(data) {
    const [singleton, initializer, saltNonce] = FACTORY_ABI.decodeFunctionData('createProxyWithNonce', data);
    const address = proxyAddress(singleton, initializer, saltNonce);
    if (safeAt(address)) return { status: 0, logs: [] };
    const setup = SAFE_ABI.decodeFunctionData('setup', initializer);
    state.safes.set(key(address), {
      address,
      singleton: getAddress(singleton),
      owners: setup[0].map((owner) => getAddress(owner)),
      threshold: Number(setup[1]),
      fallbackHandler: getAddress(setup[4]),
      nonce: 0,
    });
    deployments.push({ address, singleton: getAddress(singleton), owners: setup[0].map(getAddress), threshold: Number(setup[1]), saltNonce: saltNonce.toString() });
    return {
      status: 1,
      logs: [{ address: PROXY_FACTORY, topics: [PROXY_CREATION_TOPIC, addressWord(address)], data: addressWord(singleton) }],
    };
  }

  /** An execution's effect, checked as the Safe checks it. */
  function execute(safe, data, executor) {
    const args = SAFE_ABI.decodeFunctionData('execTransaction', data);
    const safeTx = {
      to: getAddress(args[0]),
      value: args[1].toString(),
      data: args[2],
      operation: Number(args[3]),
      safeTxGas: args[4].toString(),
      baseGas: args[5].toString(),
      gasPrice: args[6].toString(),
      gasToken: getAddress(args[7]),
      refundReceiver: getAddress(args[8]),
      nonce: safe.nonce,
    };
    const hash = TypedDataEncoder.hash({ chainId: CHAIN_ID, verifyingContract: safe.address }, SAFE_TX_TYPES, safeTx);
    const owners = recoverOwners(hash, args[9], safe.threshold);
    const ownersOk = owners !== null && owners.every((owner) => safe.owners.includes(owner));
    const funded = balanceOf(safe.address) >= BigInt(safeTx.value);
    const ok = ownersOk && funded && safeTx.operation === 0;
    executions.push({ safe: safe.address, safeTx, safeTxHash: hash, owners, executor, ok });
    if (!ok) return { status: 0, logs: [] };
    safe.nonce += 1;
    state.balances.set(key(safe.address), balanceOf(safe.address) - BigInt(safeTx.value));
    state.balances.set(key(safeTx.to), balanceOf(safeTx.to) + BigInt(safeTx.value));
    return { status: 1, logs: [] };
  }

  function broadcast(raw) {
    const tx = Transaction.from(raw);
    if (Number(tx.chainId) !== CHAIN_ID) throw new Error(`chain ${tx.chainId} isn't Gnosis`);
    if (state.receipts.has(tx.hash)) return tx.hash;
    if (tx.nonce !== nonceOf(tx.from)) throw new Error(`nonce too ${tx.nonce < nonceOf(tx.from) ? 'low' : 'high'}`);
    const price = tx.type === 2 ? BASE_FEE + tx.maxPriorityFeePerGas : tx.gasPrice;
    const fee = GAS_USED * (tx.type === 2 && tx.maxFeePerGas < price ? tx.maxFeePerGas : price);
    if (balanceOf(tx.from) < fee + tx.value) throw new Error('insufficient funds for gas * price + value');
    sent.push(tx);
    state.nonces.set(key(tx.from), tx.nonce + 1);
    state.balances.set(key(tx.from), balanceOf(tx.from) - fee - tx.value);
    let effect = { status: 1, logs: [] };
    if (tx.to && getAddress(tx.to) === PROXY_FACTORY) effect = deploy(tx.data);
    else if (safeAt(tx.to) && tx.data.startsWith(SAFE_ABI.getFunction('execTransaction').selector)) {
      effect = execute(safeAt(tx.to), tx.data, tx.from);
    } else if (tx.to) {
      state.balances.set(key(tx.to), balanceOf(tx.to) + tx.value);
    }
    state.block += 1;
    const blockHash = block(state.block).hash;
    state.transactions.set(tx.hash, {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      nonce: hex(tx.nonce),
      value: hex(tx.value),
      input: tx.data,
      blockNumber: hex(state.block),
      blockHash,
      type: hex(tx.type),
    });
    state.receipts.set(tx.hash, {
      transactionHash: tx.hash,
      transactionIndex: '0x0',
      blockNumber: hex(state.block),
      blockHash,
      from: tx.from,
      to: tx.to,
      status: hex(effect.status),
      gasUsed: hex(GAS_USED),
      cumulativeGasUsed: hex(GAS_USED),
      effectiveGasPrice: hex(price),
      contractAddress: null,
      logsBloom: '0x' + '00'.repeat(256),
      type: hex(tx.type),
      logs: effect.logs.map((log, logIndex) => ({
        ...log,
        blockNumber: hex(state.block),
        blockHash,
        transactionHash: tx.hash,
        transactionIndex: '0x0',
        logIndex: hex(logIndex),
        removed: false,
      })),
    });
    return tx.hash;
  }

  function answer(method, params = []) {
    switch (method) {
      case 'eth_chainId':
        return hex(CHAIN_ID);
      case 'net_version':
        return String(CHAIN_ID);
      case 'eth_blockNumber':
        return hex(state.block);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        const number = typeof tag === 'string' && tag.startsWith('0x') ? Number(BigInt(tag)) : state.block;
        return number > state.block ? null : block(number);
      }
      case 'eth_gasPrice':
        return hex(GAS_PRICE);
      case 'eth_maxPriorityFeePerGas':
        return hex(PRIORITY_FEE);
      case 'eth_feeHistory': {
        const count = Math.max(1, Math.min(Number(BigInt(params[0] ?? 1)), 10));
        return {
          oldestBlock: hex(Math.max(1, state.block - count + 1)),
          baseFeePerGas: Array.from({ length: count + 1 }, () => hex(BASE_FEE)),
          gasUsedRatio: Array.from({ length: count }, () => 0.5),
          reward: Array.from({ length: count }, () => (params[2] ?? []).map(() => hex(PRIORITY_FEE))),
        };
      }
      case 'eth_estimateGas':
        return hex(ESTIMATE);
      case 'eth_getBalance':
        return hex(balanceOf(params[0]));
      case 'eth_getTransactionCount':
        return hex(nonceOf(params[0]));
      case 'eth_getCode':
        return safeAt(params[0]) ? PROXY_RUNTIME : '0x';
      case 'eth_getStorageAt':
        return storage(params[0], params[1]);
      case 'eth_call':
        return call(params[0] ?? {});
      case 'eth_sendRawTransaction':
        return broadcast(params[0]);
      case 'eth_getTransactionReceipt':
        return state.receipts.get(params[0]) ?? null;
      case 'eth_getTransactionByHash':
        return state.transactions.get(params[0]) ?? null;
      default:
        throw Object.assign(new Error(`${method} isn't served here`), { code: -32601 });
    }
  }

  function respond(endpoint, body) {
    calls.push({ endpoint, method: body?.method, params: body?.params });
    if (refused.methods.has(body?.method) && (refused.endpoints.size === 0 || refused.endpoints.has(endpoint))) {
      return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: `${body.method} is refused here` } };
    }
    try {
      return { jsonrpc: '2.0', id: body?.id ?? null, result: answer(body?.method, body?.params) };
    } catch (err) {
      return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: err.code ?? -32000, message: err.message } };
    }
  }

  const endpointOf = (url) => urls.findIndex((base) => String(url).startsWith(base));

  /** Main's hop for the chain shell: each endpoint's JSON-RPC, answered here. */
  async function fetch(url, init = {}) {
    const endpoint = endpointOf(url);
    if (endpoint < 0) return new Response('not found', { status: 404 });
    const text = typeof init.body === 'string' ? init.body : Buffer.from(init.body ?? '').toString('utf8');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}', { status: 200 });
    }
    const reply = Array.isArray(body) ? body.map((one) => respond(endpoint, one)) : respond(endpoint, body);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return {
    urls,
    fetch,
    calls,
    sent,
    executions,
    deployments,
    safeAt,
    balanceOf,
    nonceOf,
    setBalance: (address, wei) => state.balances.set(key(address), BigInt(wei)),
    /** `methods` fail at `endpoints` (indexes; all when none) until called again with none. */
    refuse: (methods = [], endpoints = []) => {
      refused = { methods: new Set(methods), endpoints: new Set(endpoints) };
    },
    /** The calls made since `from` (an index into `calls`), as `endpoint:method`. */
    since: (from) => calls.slice(from).map((c) => `${c.endpoint}:${c.method}`),
  };
}

module.exports = {
  CHAIN_ID,
  ETHER,
  FALLBACK_HANDLER,
  PROXY_FACTORY,
  SAFE_TX_TYPES,
  SINGLETON,
  proxyAddress,
  recoverOwners,
  startSafeChainStub,
};
