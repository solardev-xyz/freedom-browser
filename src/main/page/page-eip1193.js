'use strict';

/**
 * Main's relay to the identity core's Ethereum dispatcher (freedom-core
 * design 0012, "fc-eip1193 and approval.request"; steps APB-4a to APB-4c).
 *
 * `page-ethereum.js` hands a page's request here for the methods the core
 * answers from cored 0.20.0: the reads (`eth_chainId`, `net_version`,
 * `eth_accounts` and the 23 read-only methods), the connect
 * (`eth_requestAccounts`), `wallet_switchEthereumChain`, and the
 * signatures (`personal_sign`, `eth_signTypedData_v4`, APB-4b), and the
 * sends (`eth_sendTransaction`, APB-4c).
 *
 *   - **The request** goes to `eip1193.request { method, params?, world }`
 *     under `page`, with the document's PageContext: its key as `origin`,
 *     or the empty origin `""` for a document with no key, which the core
 *     answers as such (`4100` for a connect, a switch or a signature, `[]`
 *     for `eth_accounts`). `world` is main's wallet state read as main sends
 *     it: the Identity & Wallet switch, an onchain app's own chain and the
 *     window's, the wallets as main lists them, the registry's networks
 *     (each one's name, whether it has a source, and its native symbol),
 *     the active account, and, for a send only (APB-4c), D12's pause.
 *   - **Its answer** is the page's: `{ result }` or `{ error }`, with the
 *     EIP-1193 code main gave before. `{ device }` (APB-4b) is main's to act
 *     on, and never reaches a page: a signature's goes to main's device
 *     step (`page-devices.js`), and a send's to main's send step
 *     (`page-core-sends.js`), once it is checked against the request (its
 *     kind for the method, its payload, and the handle main approved the
 *     core's prompt on), and anything else is an internal error, its token
 *     discarded. `{ send }` (APB-4c) is main's too: the core's prepared
 *     transaction, checked against the page's request (`to`, `value` and
 *     `data`, the page's chain, and the fee the user approved), with its
 *     token for that approve's handle, or `standing: true` for a send the
 *     site's rule answered and no prompt approved; it goes to main's send
 *     step, which adds the nonce and nothing else. A 0001 error (the core down, a crossed
 *     answer's `not_authorized`) is `-32603`. Where main itself refused the
 *     core a step (the name moved, the window's prompt budget, an unlock
 *     the user cancelled), the page gets main's own answer, as from main's
 *     route.
 *   - **The request is cancelled** when main answers the page's record (its
 *     deadline, its document gone), and its hang watchdog is held while
 *     main answers one of its prompts (0012's `Steps` class).
 *
 * The core asks main three things about a request it runs, each naming the
 * request by its 0001 id on the process main sent it to, and its
 * PageContext, which must be the one main sent:
 *
 *   - **`approval.request { request, prompt, page, kind, view, choices }`:**
 *     main opens its own prompt from the core's view and choices, on the
 *     request's record, whose handle record keeps the core's prompt id, and
 *     answers with the decision on that handle, echoing the prompt id and
 *     the handle: `{ prompt, handle, approve: true, choices, world }` once
 *     the user approves (the document still holding its key, name and
 *     all), `{ prompt, handle, approve: false, choices: {} }` on a
 *     rejection, `{ prompt, closed }` when the handle closes otherwise, and
 *     `{ prompt, busy: true }` when the document already has a wallet
 *     prompt. A core's cancel closes the prompt.
 *       - `eth.connect`: the connect prompt, the pick one of the accounts
 *         offered.
 *       - `eth.sign` (APB-4b): the signature prompt, with "Always allow"
 *         only where the core offers it (a vault account's, never a
 *         device's: main's view says which). With the approvals document
 *         on, a vault account's prompt asks for the vault unlocked first,
 *         as main's own route did.
 *       - `vault.unlock` (APB-4b, a rule's signature while the vault is
 *         locked): the unlock prompt. Its approve goes to the core as it
 *         is, and a vault still locked then refuses the signature.
 *       - `eth.send` (APB-4c): the send prompt, from the core's view (the
 *         account, the chain, the transaction, the core's quote and fee
 *         check), with "Always allow" and the fee's confirmation where the
 *         core offers them. With the approvals document on, a vault
 *         account's prompt asks for the vault unlocked first, as main's own
 *         route did. A fee asked again at the approve is the core's new
 *         prompt (`feeAskAgain`).
 *       - `vault.unlock` with reason "send" (APB-4c): a rule's send while
 *         the vault is locked, as for a signature.
 *   - **`approval.recheck { request, page }`:** `{ live, agent }`, read
 *     now: whether the request is still open and its document still holds
 *     its key (a DNS name over IPNS resolved again), and whether the Agent
 *     holds its tab.
 *   - **`eip1193.select_chain { request, page, chain_id }`:** a switch's
 *     selection, for the chain the page asked for and nothing else: main
 *     selects it for the request's window and sends `chainChanged` as its
 *     own switch did, then answers `{}`.
 *
 * Anything else, or a request main doesn't know, is `invalid_argument`,
 * which the core takes as a crossed answer: the page's request fails, with
 * nothing written or signed.
 */

const { ShellError } = require('../core/service-client');
const { txOf, selectorOf } = require('./page-sends');

// What the chrome's getCurrentChainId falls back to (`page-ethereum.js`).
const FALLBACK_CHAIN_ID = 100;
const INTERNAL_ERROR_CODE = -32603;
const PROMPT_PENDING_CODE = -32002;
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
// The core's prompt id: 16 random bytes, as 32 lowercase hex digits.
const PROMPT_ID = /^[0-9a-f]{32}$/;
// 0011's reasons a handle closes with no decision.
const CLOSED_REASONS = new Set(['navigated', 'closed', 'cancelled', 'expired']);
const SEND_METHOD = 'eth_sendTransaction';
// The signatures (APB-4b), and the token kind each one's `{ device }` names
// for a Ledger or a phone; a Safe's is `safe-message`.
const SIGN_KINDS = Object.freeze({ personal_sign: 'sign-message', eth_signTypedData_v4: 'sign-typed-data' });
// A rule's request asks for the vault's unlock with its reason.
const UNLOCK_REASONS = Object.freeze({ personal_sign: 'sign', eth_signTypedData_v4: 'sign', [SEND_METHOD]: 'send' });
const DEVICE_TYPES = new Set(['ledger', 'remote', 'safe']);
const DEVICE_KEYS = new Set(['type', 'kind', 'account', 'payload', 'expected_hash', 'handle', 'token']);
const HASH = /^0x[0-9a-f]{64}$/i;
const SIGN_VIEW_KEYS = new Set(['method', 'account', 'chain', 'message', 'typedData', 'chains']);
const UNLOCK_CANCELLED = Object.freeze({ code: 4001, message: 'User cancelled unlock' });
const DEVICE_MISMATCH = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: "The identity core's device answer doesn't match the request",
});
const SEND_MISMATCH = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: "The identity core's send doesn't match the request",
});
const SEND_KEYS = new Set(['kind', 'account', 'tx', 'handle', 'token', 'standing']);
const SEND_VIEW_KEYS = new Set(['account', 'chain', 'tx', 'fee', 'feeCheck', 'feeAskAgain', 'alwaysAllow']);
const SEND_CHOICES = Object.freeze(['alwaysAllow', 'feeAcknowledged']);
// `sign.transaction`'s form without a nonce, by type (design 0012).
const TX_FIELDS = Object.freeze({
  2: ['type', 'chain_id', 'to', 'value', 'data', 'gas_limit', 'max_fee_per_gas', 'max_priority_fee_per_gas'],
  0: ['type', 'chain_id', 'to', 'value', 'data', 'gas_limit', 'gas_price'],
});
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const PAGE_FIELDS = Object.freeze(['origin', 'top_origin', 'frame', 'navigation', 'agent']);
const SELECT_KEYS = new Set(['request', 'page', 'chain_id']);
const RECHECK_KEYS = new Set(['request', 'page']);
const PROMPT_KEYS = new Set(['request', 'prompt', 'page', 'kind', 'view', 'choices']);
// D12's pause is read only for a send's rule (APB-4c): the core reads it
// nowhere else, and a missing one counts as paused.
const PAUSE_METHODS = new Set(['eth_sendTransaction']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

const positive = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const hex = (chainId) => `0x${chainId.toString(16)}`;
const invalid = () => new ShellError('invalid_argument');

function defaultDependencies() {
  return {
    coreClient: () => require('../core/core-process').getCoreClient(),
    watchdogMs: () => require('../core/core-deadlines').watchdogMs('eip1193.request'),
    identityWalletEnabled: () => require('../settings-store').loadSettings()?.enableIdentityWallet === true,
    selectedChainOf: (windowId) => require('../wallet/selected-chain').selectedChainOf(windowId),
    getDerivedWallets: () => require('../identity-manager').getDerivedWallets(),
    networks: () => require('../networks/network-registry').getAllNetworks() || {},
    isChainAvailable: (chainId) => require('../networks/network-registry').isChainAvailable(chainId),
    getActiveWalletIndex: () => require('../identity-manager').getActiveWalletIndex(),
    rulePaused: (key) => require('../wallet/auto-approve-pause').transactionAutoApprovePaused(key),
    isVaultUnlocked: () => require('../identity-manager').isVaultUnlocked(),
    discardToken: (token) => require('../wallet/signing-confirmation').discardConfirmation(token),
    selectChainForPage: (windowId, chainId) =>
      require('../wallet/selected-chain').selectChainForPage(windowId, chainId),
  };
}

/**
 * The connect prompt's view, rebuilt to main's form from the core's, and
 * the indexes the core offers: the accounts shown, each once and in order.
 * Throws on anything else.
 */
function connectShown(view, choices) {
  if (!isPlainObject(view) || !isPlainObject(choices)) throw invalid();
  if (!hasOnlyKeys(choices, new Set(['walletIndex'])) || !Array.isArray(choices.walletIndex)) throw invalid();
  if (!hasOnlyKeys(view, new Set(['accounts', 'defaultIndex', 'chain'])) || !Array.isArray(view.accounts)) {
    throw invalid();
  }
  const offered = choices.walletIndex;
  if (offered.length !== view.accounts.length) throw invalid();
  const accounts = view.accounts.map((account, i) => {
    if (!isPlainObject(account) || !Number.isInteger(account.index) || account.index !== offered[i]) throw invalid();
    return {
      index: account.index,
      name: typeof account.name === 'string' ? account.name : '',
      address: typeof account.address === 'string' ? account.address : null,
      type: typeof account.type === 'string' ? account.type : 'mnemonic',
    };
  });
  if (new Set(offered).size !== offered.length) throw invalid();
  const { defaultIndex, chain } = view;
  if (defaultIndex !== null && !offered.includes(defaultIndex)) throw invalid();
  if (!isPlainObject(chain) || !positive(chain.id)) throw invalid();
  if (chain.name !== null && typeof chain.name !== 'string') throw invalid();
  return {
    view: { accounts, defaultIndex, chain: { id: chain.id, name: chain.name } },
    offered: new Set(offered),
  };
}

// An account in a core's view, in main's form. Throws on anything else.
function accountShown(account) {
  if (!isPlainObject(account) || !Number.isSafeInteger(account.index) || account.index < 0) throw invalid();
  return {
    index: account.index,
    name: typeof account.name === 'string' ? account.name : '',
    address: typeof account.address === 'string' ? account.address : null,
    type: typeof account.type === 'string' ? account.type : 'mnemonic',
  };
}

/**
 * The signature prompt's view for the request's `method`, rebuilt to main's
 * form from the core's (the reference's, `page-signing.js`), and the
 * "Always allow" values the core offers: `[false, true]` for a vault
 * account, `[false]` for a device's. Main adds `alwaysAllow`, whether the
 * box is offered at all. Throws on anything else.
 */
function signShown(view, choices, method) {
  if (!isPlainObject(view) || !isPlainObject(choices)) throw invalid();
  if (!hasOnlyKeys(choices, new Set(['alwaysAllow'])) || !Array.isArray(choices.alwaysAllow)) throw invalid();
  const offered = choices.alwaysAllow;
  if (!offered.every((value) => typeof value === 'boolean') || new Set(offered).size !== offered.length) throw invalid();
  if (!offered.includes(false)) throw invalid();
  if (!hasOnlyKeys(view, SIGN_VIEW_KEYS) || view.method !== method) throw invalid();
  const { chain } = view;
  if (!isPlainObject(chain) || !positive(chain.id)) throw invalid();
  if (chain.name !== null && typeof chain.name !== 'string') throw invalid();
  const shown = { method, account: accountShown(view.account), chain: { id: chain.id, name: chain.name } };
  if (method === 'personal_sign') {
    const { message } = view;
    if (view.typedData !== undefined || view.chains !== undefined || !isPlainObject(message)) throw invalid();
    if (typeof message.hex !== 'string' || typeof message.rawHash !== 'boolean') throw invalid();
    shown.message = { hex: message.hex, rawHash: message.rawHash };
  } else {
    const typed = view.typedData;
    if (view.message !== undefined || !isPlainObject(typed) || !isPlainObject(typed.view)) throw invalid();
    if (typeof typed.hash !== 'string' || !Array.isArray(typed.warnings)) throw invalid();
    if (view.chains !== undefined && !isPlainObject(view.chains)) throw invalid();
    shown.typedData = { hash: typed.hash, view: typed.view, warnings: typed.warnings.slice() };
    shown.chains = view.chains || {};
  }
  shown.alwaysAllow = offered.includes(true);
  return { view: shown, offered: new Set(offered) };
}

/** A rule's unlock prompt's view (`{ account, reason }`), its choices `{}`. */
function unlockShown(view, choices, method) {
  if (!isPlainObject(view) || !isPlainObject(choices) || Object.keys(choices).length !== 0) throw invalid();
  if (!hasOnlyKeys(view, new Set(['account', 'reason'])) || view.reason !== UNLOCK_REASONS[method]) throw invalid();
  return { view: { account: accountShown(view.account), reason: view.reason } };
}

// A flat object of the given value type, copied; throws on anything else.
function flatCopy(value, isValue) {
  if (!isPlainObject(value) || !Object.values(value).every(isValue)) throw invalid();
  return { ...value };
}

/**
 * The send prompt's view (APB-4c), rebuilt to main's form from the core's
 * (the reference's, `page-sends.js`'s `sendView`): the account, the chain
 * with its native symbol, the transaction (`to` checksummed), the core's
 * quoted fee (or none, or a Safe's executor), the fee check's verdict,
 * whether the fee is asked again, and whether "Always allow" is shown; and
 * the values the core offers for "Always allow" and the fee's
 * confirmation. Throws on anything else.
 */
function sendShown(view, choices) {
  if (!isPlainObject(view) || !isPlainObject(choices)) throw invalid();
  if (!hasOnlyKeys(choices, new Set(SEND_CHOICES))) throw invalid();
  const offered = {};
  for (const name of SEND_CHOICES) {
    const values = choices[name];
    if (!Array.isArray(values) || !values.every((value) => typeof value === 'boolean')) throw invalid();
    if (new Set(values).size !== values.length || !values.includes(false)) throw invalid();
    offered[name] = new Set(values);
  }
  if (!hasOnlyKeys(view, SEND_VIEW_KEYS)) throw invalid();
  const { chain, tx, fee, feeCheck } = view;
  if (!isPlainObject(chain) || !hasOnlyKeys(chain, new Set(['id', 'name', 'symbol'])) || !positive(chain.id)) {
    throw invalid();
  }
  if ((chain.name !== null && typeof chain.name !== 'string') || typeof chain.symbol !== 'string') throw invalid();
  if (!isPlainObject(tx) || !hasOnlyKeys(tx, new Set(['to', 'value', 'data']))) throw invalid();
  if (![tx.to, tx.value, tx.data].every((field) => typeof field === 'string')) throw invalid();
  if (typeof view.feeAskAgain !== 'boolean' || typeof view.alwaysAllow !== 'boolean') throw invalid();
  const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  return {
    view: {
      account: accountShown(view.account),
      chain: { id: chain.id, name: chain.name, symbol: chain.symbol },
      tx: { to: tx.to, value: tx.value, data: tx.data },
      fee: fee === null ? null : flatCopy(fee, (value) => typeof value === 'string'),
      feeCheck: feeCheck === null ? null : flatCopy(feeCheck, scalar),
      feeAskAgain: view.feeAskAgain,
      alwaysAllow: view.alwaysAllow,
    },
    offered,
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 */
function createEip1193Relay(deps = {}) {
  const {
    coreClient,
    watchdogMs,
    identityWalletEnabled,
    selectedChainOf,
    getDerivedWallets,
    networks,
    isChainAvailable,
    getActiveWalletIndex,
    rulePaused,
    selectChainForPage,
    isVaultUnlocked,
    discardToken,
  } = { ...defaultDependencies(), ...deps };

  // `${generation}:${id}` -> the request main sent the core, while it runs.
  const running = new Map();

  const read = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  async function walletList() {
    try {
      const listed = await getDerivedWallets();
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  }

  // The registry as the core reads it: each network's name, whether it has
  // a source, and its native symbol for a send's view.
  function networkTable() {
    const table = {};
    const all = read(networks, {});
    if (!all || typeof all !== 'object') return table;
    for (const [id, network] of Object.entries(all)) {
      if (!network || typeof network !== 'object') continue;
      const entry = { available: read(() => Boolean(isChainAvailable(Number(id))), false) };
      if (typeof network.name === 'string') entry.name = network.name;
      if (typeof network.nativeSymbol === 'string' && network.nativeSymbol) entry.symbol = network.nativeSymbol;
      table[id] = entry;
    }
    return table;
  }

  /** Main's wallet state for a request of `method`, read now. */
  async function worldFor(context, method) {
    const { requester } = context;
    const world = {
      enabled: read(() => identityWalletEnabled() === true, false),
      chain: positive(requester.chain),
      window_chain: positive(read(() => selectedChainOf(requester.window), null)),
      wallets: await walletList(),
      networks: networkTable(),
    };
    const active = read(getActiveWalletIndex, undefined);
    if (active !== undefined) world.active = active;
    if (PAUSE_METHODS.has(method)) {
      let paused;
      try {
        paused = requester.key ? (await rulePaused(requester.key)) === true : true;
      } catch {
        paused = true;
      }
      world.paused = paused;
    }
    return world;
  }

  /** The document's PageContext, with the empty origin for one with no key. */
  function pageOf(context) {
    const { requester } = context;
    const page = context.pageContext();
    return {
      origin: requester.key || '',
      top_origin: requester.topKey || requester.key || '',
      frame: page.frame,
      navigation: page.navigation,
      agent: page.agent === true,
    };
  }

  async function vaultOpen() {
    try {
      return (await isVaultUnlocked()) === true;
    } catch {
      return false;
    }
  }

  // A token the core gave main that main won't present: burnt now.
  function discard(token) {
    if (typeof token !== 'string' || !token) return;
    try {
      Promise.resolve(discardToken(token)).catch(() => {});
    } catch {
      // Burnt by the core at its life's end all the same.
    }
  }

  // The document still answers its key: a DNS name over IPNS resolved
  // again, and the key held in the same run.
  async function documentHolds(context) {
    return (await context.nameHolds({ keyless: { error: { ...NO_ADDRESS } } })) && context.holdsKey();
  }

  /**
   * A `{ device }` answer checked against the request it answers: a
   * signature's (`SIGN_KINDS`, or a Safe's `safe-message`) from a device's
   * account, with the token the core minted for the handle main approved
   * the core's prompt on for this request, and the payload the token binds.
   * Null for anything else.
   */
  function deviceOf(entry, device) {
    if (!isPlainObject(device) || !hasOnlyKeys(device, DEVICE_KEYS)) return null;
    const { type, kind, account, payload, handle, token } = device;
    const expectedHash = device.expected_hash;
    if (typeof token !== 'string' || !token) return null;
    // Only the decision main relayed for this request, on its own handle.
    if (entry.approved === null || handle !== entry.approved) return null;
    if (!DEVICE_TYPES.has(type) || !Number.isSafeInteger(account) || account < 0 || !isPlainObject(payload)) return null;
    if (entry.method === SEND_METHOD) return sendDeviceOf(entry, device);
    if (!SIGN_KINDS[entry.method] || kind !== (type === 'safe' ? 'safe-message' : SIGN_KINDS[entry.method])) return null;
    if (kind === 'sign-message') {
      if (!hasOnlyKeys(payload, new Set(['message'])) || typeof payload.message !== 'string') return null;
      if (expectedHash !== undefined) return null;
    } else if (kind === 'sign-typed-data') {
      if (!isPlainObject(payload.typed_data) || typeof expectedHash !== 'string' || !HASH.test(expectedHash)) return null;
    } else if (payload.method !== entry.method || !Array.isArray(payload.params) || expectedHash !== undefined) {
      return null;
    }
    return Object.freeze({ type, kind, account, payload, expectedHash, handle, token });
  }

  // The chain a send of this request is for: the one the page reads, as
  // main sent it in `world` (an onchain app's own, or the window's).
  const sendChainOf = (entry) => entry.world?.chain || entry.world?.window_chain || FALLBACK_CHAIN_ID;

  // The page's own transaction, as main's route checked its form, or null.
  function askedTx(entry) {
    try {
      return txOf(entry.params);
    } catch {
      return null;
    }
  }

  /**
   * A prepared transaction in `sign.transaction`'s form, with no nonce
   * (design 0012), checked against the request: the page's `to`, `value`
   * and `data`, the page's chain, and, for a send the user approved, the
   * gas limit and fees the approved prompt showed. Null for anything else.
   */
  function preparedTx(entry, tx) {
    if (!isPlainObject(tx)) return null;
    const fields = TX_FIELDS[tx.type];
    if (!fields || Object.keys(tx).length !== fields.length || !hasOnlyKeys(tx, new Set(fields))) return null;
    const quantities = fields.filter((field) => !['type', 'to', 'data'].includes(field));
    if (!quantities.every((field) => typeof tx[field] === 'string' && DECIMAL.test(tx[field]))) return null;
    if (typeof tx.to !== 'string' || !ADDRESS.test(tx.to) || typeof tx.data !== 'string' || !HEX.test(tx.data)) {
      return null;
    }
    const asked = askedTx(entry);
    if (!asked || tx.to.toLowerCase() !== asked.to.toLowerCase() || tx.value !== asked.value) return null;
    if (tx.data.toLowerCase() !== asked.data.toLowerCase() || Number(tx.chain_id) !== sendChainOf(entry)) return null;
    if (entry.approved !== null) {
      const fee = entry.approvedFee;
      if (!isPlainObject(fee) || fee.gasLimit !== tx.gas_limit) return null;
      const same =
        tx.type === 2
          ? fee.maxFeePerGas === tx.max_fee_per_gas && fee.maxPriorityFeePerGas === tx.max_priority_fee_per_gas
          : fee.gasPrice === tx.gas_price;
      if (!same) return null;
    }
    return Object.freeze({ ...tx });
  }

  // "Always allow" the user ticked, for a contract call (the core carries
  // it in the token only for one).
  const remembers = (entry, tx) => entry.remember === true && Boolean(selectorOf(tx.data));

  /**
   * A send's `{ device }` checked against its request: a Ledger's or a
   * phone's `dapp-send` with `payload: { tx }`, or a Safe's `safe-send` with
   * `payload: { safe, chain_id, tx: { to, value, data } }` for the Safe main
   * listed and the page's chain, each with the token for the handle main
   * approved the core's prompt on. Null for anything else.
   */
  function sendDeviceOf(entry, device) {
    const { type, kind, account, payload, handle, token } = device;
    if (device.expected_hash !== undefined) return null;
    if (type === 'safe') {
      if (kind !== 'safe-send' || !hasOnlyKeys(payload, new Set(['safe', 'chain_id', 'tx']))) return null;
      const { tx } = payload;
      if (!isPlainObject(tx) || !hasOnlyKeys(tx, new Set(['to', 'value', 'data']))) return null;
      if (![tx.to, tx.value, tx.data].every((field) => typeof field === 'string')) return null;
      const asked = askedTx(entry);
      if (!asked || tx.to.toLowerCase() !== asked.to.toLowerCase() || tx.value !== asked.value) return null;
      if (tx.data.toLowerCase() !== asked.data.toLowerCase()) return null;
      if (String(payload.chain_id) !== String(sendChainOf(entry))) return null;
      const safe = (entry.world?.wallets || []).find((wallet) => wallet?.index === account);
      if (typeof payload.safe !== 'string' || typeof safe?.address !== 'string') return null;
      if (payload.safe.toLowerCase() !== safe.address.toLowerCase()) return null;
      return Object.freeze({ type, kind, account, payload, handle, token, remember: false });
    }
    if (kind !== 'dapp-send' || !hasOnlyKeys(payload, new Set(['tx']))) return null;
    const tx = preparedTx(entry, payload.tx);
    if (!tx) return null;
    return Object.freeze({ type, kind, account, payload: { tx }, handle, token, remember: remembers(entry, tx) });
  }

  /**
   * A `{ send }` checked against the request it answers: a vault account's
   * prepared transaction with the token the core minted for the handle main
   * approved the core's prompt on for this request, or a rule's
   * (`standing: true`) with no token, for a request no prompt of main's
   * approved. Null for anything else.
   */
  function sendOf(entry, send) {
    if (entry.method !== SEND_METHOD || !isPlainObject(send) || !hasOnlyKeys(send, SEND_KEYS)) return null;
    const { kind, account, handle, token } = send;
    if (kind !== 'dapp-send' || !Number.isSafeInteger(account) || account < 0) return null;
    // A vault account main listed for the request (a device's send comes
    // as `{ device }`).
    const wallet = (entry.world?.wallets || []).find((candidate) => candidate?.index === account);
    if (!wallet || !['mnemonic', undefined, null].includes(wallet.type)) return null;
    if (send.standing !== undefined) {
      if (send.standing !== true || handle !== undefined || token !== undefined || entry.approved !== null) return null;
    } else if (typeof token !== 'string' || !token || entry.approved === null || handle !== entry.approved) {
      return null;
    }
    const tx = preparedTx(entry, send.tx);
    if (!tx) return null;
    if (send.standing === true) return Object.freeze({ kind, account, tx, standing: true });
    return Object.freeze({ kind, account, tx, handle, token, remember: remembers(entry, tx) });
  }

  // Main's send step for a checked `{ send }`, or the page's error.
  async function sendAnswer(entry, send, step) {
    const checked = !entry.override && step ? sendOf(entry, send) : null;
    if (!checked) {
      discard(send?.token);
      return { error: { ...SEND_MISMATCH } };
    }
    if (checked.token) entry.context.traceCoreToken?.('minted', checked.kind);
    try {
      return await step(checked, entry.page);
    } catch (err) {
      return failure(err);
    }
  }

  // Main's device step for a checked `{ device }`, or the page's error.
  async function deviceAnswer(entry, device, step) {
    const checked = !entry.override && step ? deviceOf(entry, device) : null;
    if (!checked) {
      discard(device?.token);
      return { error: { ...DEVICE_MISMATCH } };
    }
    entry.context.traceCoreToken?.('minted', checked.kind);
    try {
      return await step(checked, entry.page);
    } catch (err) {
      return failure(err);
    }
  }

  const isDevice = (reply) => isPlainObject(reply) && Object.keys(reply).length === 1 && reply.device !== undefined;
  const isSend = (reply) => isPlainObject(reply) && Object.keys(reply).length === 1 && reply.send !== undefined;

  // The core's answer as the page gets it.
  function pageAnswer(reply) {
    if (isPlainObject(reply)) {
      const keys = Object.keys(reply);
      if (keys.length === 1 && keys[0] === 'result') return { result: reply.result };
      if (keys.length === 1 && keys[0] === 'error' && isPlainObject(reply.error)) {
        const { code, message, data } = reply.error;
        return { error: data === undefined ? { code, message } : { code, message, data } };
      }
    }
    // Anything else, `{ send }` for a method that gets none among it.
    return { error: { code: INTERNAL_ERROR_CODE, message: 'The identity core gave no answer for the page' } };
  }

  function failure(err) {
    const message = typeof err?.message === 'string' && err.message ? err.message : 'Internal error';
    return { error: { code: INTERNAL_ERROR_CODE, message } };
  }

  /**
   * Run the page's request in the core. `params` are sent only where the
   * core reads them; `announce(context, account, chainId, written)` tells a
   * new grant's events, queued at the approve (`page-ethereum.js`);
   * `device(device, page)` answers the page from a device, for a
   * signature's or a send's `{ device }` (`page-devices.js`,
   * `page-core-sends.js`); `send(send, page)` answers it for a `{ send }`
   * (`page-core-sends.js`).
   */
  async function request(context, { params, announce = null, device = null, send = null } = {}) {
    const method = context.method;
    const client = read(coreClient, null);
    if (!client) return { error: { code: INTERNAL_ERROR_CODE, message: 'The identity core is not running' } };
    const page = pageOf(context);
    const world = await worldFor(context, method);
    const body = { method, world };
    if (params !== undefined) body.params = params;
    const entry = { context, method, page, params, world, client, announce, id: null, generation: null };
    entry.override = null;
    entry.granted = null;
    // The handle main approved the core's prompt on, for this request, and
    // for a send the fee that prompt showed and "Always allow" as ticked.
    entry.approved = null;
    entry.approvedFee = null;
    entry.remember = false;
    let key = null;
    let answer;
    let reply = null;
    try {
      reply = await client.request('eip1193.request', body, { caller: 'page', page }, {
        watchdogMs: read(watchdogMs, null),
        signal: context.signal,
        onSent: (id, generation) => {
          entry.id = id;
          entry.generation = generation;
          key = `${generation}:${id}`;
          running.set(key, entry);
        },
      });
    } catch (err) {
      answer = failure(err);
    } finally {
      if (key !== null && running.get(key) === entry) running.delete(key);
    }
    if (!answer && isDevice(reply)) answer = await deviceAnswer(entry, reply.device, device);
    if (!answer && isSend(reply)) answer = await sendAnswer(entry, reply.send, send);
    if (!answer) {
      answer = pageAnswer(reply);
      // The core made the signature on the approve main relayed: it minted
      // the request's token for that handle and spent it (design 0012).
      if (entry.approved !== null && SIGN_KINDS[method] && answer.result !== undefined) {
        context.traceCoreToken?.('minted', SIGN_KINDS[method]);
        context.traceCoreToken?.('spent', SIGN_KINDS[method]);
      }
    }
    if (entry.granted) {
      const account = Array.isArray(answer.result) && typeof answer.result[0] === 'string' ? answer.result[0] : null;
      if (account && !entry.override) entry.granted.resolve(account);
      else entry.granted.reject(new Error('no grant written'));
    }
    return entry.override ? { error: { ...entry.override } } : answer;
  }

  // The request a core's request names, with the PageContext main sent.
  function runningFor(params, generation, keys) {
    if (!isPlainObject(params) || !hasOnlyKeys(params, keys) || !Number.isSafeInteger(params.request)) throw invalid();
    const entry = running.get(`${generation}:${params.request}`);
    if (!entry) throw invalid();
    const page = params.page;
    if (!isPlainObject(page) || !hasOnlyKeys(page, new Set(PAGE_FIELDS))) throw invalid();
    if (!PAGE_FIELDS.every((field) => page[field] === entry.page[field])) throw invalid();
    return entry;
  }

  function grantWritten(entry, chainId) {
    let settle;
    const written = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    written.catch(() => {});
    entry.granted = settle;
    try {
      entry.announce?.(entry.context, null, chainId, written);
    } catch {
      // The grant's events never change the answer.
    }
  }

  // Main's answer to the core for a decision that approves nothing: busy,
  // closed or rejected. Null for an approve.
  function unapproved(entry, prompt, decision) {
    if (decision.error) {
      // The document's one wallet prompt is taken (`-32002`), or the
      // window's prompt budget is spent (`-32005`, which the page gets
      // instead of the core's `-32002`). Nothing opened.
      if (decision.error.code !== PROMPT_PENDING_CODE) entry.override = { ...decision.error };
      return { prompt, busy: true };
    }
    // The handle's record keeps the core's id from here on.
    const id = typeof decision.prompt === 'string' ? decision.prompt : prompt;
    if (decision.closed !== undefined) {
      return { prompt: id, closed: CLOSED_REASONS.has(decision.closed) ? decision.closed : 'cancelled' };
    }
    if (decision.approve !== true) return { prompt: id, handle: decision.handle, approve: false, choices: {} };
    return null;
  }

  // Main's answer to the core for its connect prompt's decision.
  async function connectAnswer(entry, prompt, decision) {
    const { context } = entry;
    const done = unapproved(entry, prompt, decision);
    if (done) return done;
    const id = typeof decision.prompt === 'string' ? decision.prompt : prompt;
    // Name-revalidated: once the user has approved, the document must still
    // hold its key, a DNS name over IPNS resolved again, or the core writes
    // nothing and the page hears what a keyless document would.
    const keyless = { keyless: { error: { ...NO_ADDRESS } } };
    if (!(await context.nameHolds(keyless)) || !context.holdsKey()) {
      entry.override = { ...NO_ADDRESS };
      return { prompt: id, closed: 'cancelled' };
    }
    const world = await worldFor(context, entry.method);
    grantWritten(entry, world.chain || world.window_chain || FALLBACK_CHAIN_ID);
    return {
      prompt: id,
      handle: decision.handle,
      approve: true,
      choices: { walletIndex: decision.choices.walletIndex },
      world,
    };
  }

  // The connect's prompt, and main's answer for its decision.
  async function connectAsk(entry, prompt, shown) {
    const decision = await entry.context.prompt({
      kind: 'eth.connect',
      view: shown.view,
      corePrompt: prompt,
      // The one thing the user picks: which offered account.
      choices: (raw) =>
        Object.keys(raw).every((name) => name === 'walletIndex') &&
        Number.isInteger(raw.walletIndex) &&
        shown.offered.has(raw.walletIndex)
          ? { walletIndex: raw.walletIndex }
          : null,
    });
    return connectAnswer(entry, prompt, decision);
  }

  // The vault's unlock on the request's record: the approvals document's
  // takes the password and unlocks (`page-requests.js`), the chrome's
  // unlocks itself before it approves.
  const unlockPrompt = (entry, prompt, view) =>
    entry.context.prompt({
      kind: 'vault.unlock',
      view,
      corePrompt: prompt,
      choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
    });

  /**
   * The signature's prompt (APB-4b), and main's answer for its decision.
   * With the approvals document on, a vault account's prompt asks for the
   * vault unlocked first, as main's own route did (APS-2): the document's
   * signature screen has no unlock of its own. "Always allow" is picked
   * only where the core offers it: a device's account's never is, and its
   * ticked box is refused at the decision, with the prompt still open.
   */
  async function signAsk(entry, prompt, shown) {
    const { context } = entry;
    const { account } = shown.view;
    if (context.approvalsDocument && account.type === 'mnemonic' && !(await vaultOpen())) {
      const unlock = await unlockPrompt(entry, prompt, { account, reason: 'sign' });
      const done = unapproved(entry, prompt, unlock);
      if (done?.busy) return done;
      if (done) {
        entry.override = { ...UNLOCK_CANCELLED };
        return { prompt, closed: 'cancelled' };
      }
    }
    const decision = await context.prompt({
      kind: 'eth.sign',
      view: shown.view,
      corePrompt: prompt,
      choices: (raw) =>
        Object.keys(raw).every((name) => name === 'alwaysAllow') &&
        (raw.alwaysAllow === undefined || typeof raw.alwaysAllow === 'boolean') &&
        shown.offered.has(raw.alwaysAllow === true)
          ? { alwaysAllow: raw.alwaysAllow === true }
          : null,
    });
    const done = unapproved(entry, prompt, decision);
    if (done) return done;
    const id = typeof decision.prompt === 'string' ? decision.prompt : prompt;
    // With the approvals document on, only its decision approves, as main's
    // own issuer minted a page's token only on it.
    if (context.approvalsDocument && decision.from !== 'approvals') return { prompt: id, closed: 'cancelled' };
    // Name-revalidated: once the user has approved, the document must still
    // hold its key, or the core signs nothing and the page hears what a
    // keyless document would.
    if (!(await documentHolds(context))) {
      entry.override = { ...NO_ADDRESS };
      return { prompt: id, closed: 'cancelled' };
    }
    entry.approved = decision.handle;
    return {
      prompt: id,
      handle: decision.handle,
      approve: true,
      choices: { alwaysAllow: decision.choices.alwaysAllow === true },
      world: await worldFor(context, entry.method),
    };
  }

  // A rule's unlock (APB-4b): the user's approve goes to the core as it is,
  // as main's own route went on to the signature. The core rechecks the
  // document, and a vault still locked refuses the signature (-32603 "Vault
  // is locked", as the reference's signer did).
  async function unlockAsk(entry, prompt, shown) {
    const decision = await unlockPrompt(entry, prompt, shown.view);
    const done = unapproved(entry, prompt, decision);
    if (done) return done;
    const id = typeof decision.prompt === 'string' ? decision.prompt : prompt;
    return { prompt: id, handle: decision.handle, approve: true, choices: {}, world: await worldFor(entry.context, entry.method) };
  }

  /**
   * The send's prompt (APB-4c), and main's answer for its decision. With
   * the approvals document on, a vault account's prompt asks for the vault
   * unlocked first, as main's own route did. "Always allow" and the fee's
   * confirmation are picked only where the core offers them. The fee the
   * prompt showed, and the tick, are kept for the `{ send }` the approve
   * leads to.
   */
  async function sendAsk(entry, prompt, shown) {
    const { context } = entry;
    const { account } = shown.view;
    if (context.approvalsDocument && account.type === 'mnemonic' && !(await vaultOpen())) {
      const unlock = await unlockPrompt(entry, prompt, { account, reason: 'send' });
      const done = unapproved(entry, prompt, unlock);
      if (done?.busy) return done;
      if (done) {
        entry.override = { ...UNLOCK_CANCELLED };
        return { prompt, closed: 'cancelled' };
      }
    }
    const { offered } = shown;
    const decision = await context.prompt({
      kind: 'eth.send',
      view: shown.view,
      corePrompt: prompt,
      choices: (raw) =>
        Object.keys(raw).every((name) => SEND_CHOICES.includes(name)) &&
        SEND_CHOICES.every((name) => raw[name] === undefined || typeof raw[name] === 'boolean') &&
        SEND_CHOICES.every((name) => offered[name].has(raw[name] === true))
          ? { alwaysAllow: raw.alwaysAllow === true, feeAcknowledged: raw.feeAcknowledged === true }
          : null,
    });
    const done = unapproved(entry, prompt, decision);
    if (done) return done;
    const id = typeof decision.prompt === 'string' ? decision.prompt : prompt;
    if (context.approvalsDocument && decision.from !== 'approvals') return { prompt: id, closed: 'cancelled' };
    // Name-revalidated: once the user has approved, the document must still
    // hold its key, or the core mints nothing. No keyless answer is set on
    // the record (`nameHolds`' option), as on main's own route: a refusal
    // answers 4100 itself, and once a send that passed main's gate has gone
    // out, its hash is the page's even if the name moves after it.
    if (!((await context.nameHolds()) && context.holdsKey())) {
      entry.override = { ...NO_ADDRESS };
      return { prompt: id, closed: 'cancelled' };
    }
    entry.approved = decision.handle;
    entry.approvedFee = shown.view.fee;
    entry.remember = decision.choices.alwaysAllow === true;
    return {
      prompt: id,
      handle: decision.handle,
      approve: true,
      choices: {
        alwaysAllow: decision.choices.alwaysAllow === true,
        feeAcknowledged: decision.choices.feeAcknowledged === true,
      },
      world: await worldFor(context, entry.method),
    };
  }

  // The prompt main opens for a core's request of `kind`, its view checked.
  function askFor(entry, prompt, { kind, view, choices }) {
    const { method } = entry;
    if (kind === 'eth.connect' && method === 'eth_requestAccounts') {
      const shown = connectShown(view, choices);
      return () => connectAsk(entry, prompt, shown);
    }
    if (kind === 'eth.sign' && SIGN_KINDS[method]) {
      const shown = signShown(view, choices, method);
      return () => signAsk(entry, prompt, shown);
    }
    if (kind === 'eth.send' && method === SEND_METHOD) {
      const shown = sendShown(view, choices);
      return () => sendAsk(entry, prompt, shown);
    }
    if (kind === 'vault.unlock' && UNLOCK_REASONS[method]) {
      const shown = unlockShown(view, choices, method);
      return () => unlockAsk(entry, prompt, shown);
    }
    throw invalid();
  }

  async function approvalRequest(params, { signal, generation } = {}) {
    const entry = runningFor(params, generation, PROMPT_KEYS);
    const { prompt } = params;
    if (typeof prompt !== 'string' || !PROMPT_ID.test(prompt)) throw invalid();
    const ask = askFor(entry, prompt, params);
    if (signal?.aborted) return { prompt, closed: 'cancelled' };
    const { context } = entry;
    // No overall deadline while main answers its prompt.
    const release = entry.client.holdWatchdog?.(entry.generation, entry.id) || (() => {});
    const onAbort = () => context.cancelPrompt(prompt);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await ask();
    } finally {
      signal?.removeEventListener('abort', onAbort);
      release();
    }
  }

  async function approvalRecheck(params, { generation } = {}) {
    const entry = runningFor(params, generation, RECHECK_KEYS);
    const { context } = entry;
    const live =
      !context.signal.aborted &&
      context.isCurrent() &&
      context.holdsKey() &&
      (await context.nameHolds()) &&
      !context.signal.aborted &&
      context.holdsKey();
    return { live: live === true, agent: context.pageContext().agent === true };
  }

  // The chain the page asked for, as main's own switch read it.
  function askedChain(params) {
    const first = Array.isArray(params) || isPlainObject(params) ? params[0] : undefined;
    const raw = isPlainObject(first) ? first.chainId : undefined;
    return typeof raw === 'string' || typeof raw === 'number' ? parseInt(raw, 16) : NaN;
  }

  function windowChainOf(windowId) {
    return positive(read(() => selectedChainOf(windowId), null)) || FALLBACK_CHAIN_ID;
  }

  async function selectChain(params, { generation } = {}) {
    const entry = runningFor(params, generation, SELECT_KEYS);
    if (entry.method !== 'wallet_switchEthereumChain') throw invalid();
    const chainId = params.chain_id;
    // The chain the page asked for, which main's registry knows and has a
    // source for, and an onchain app's own: nothing else is selected.
    if (!positive(chainId) || chainId !== askedChain(entry.params)) throw invalid();
    if (!read(() => networks()?.[chainId], null) || !read(() => isChainAvailable(chainId), false)) throw invalid();
    const { context } = entry;
    const { requester } = context;
    const pinned = positive(requester.chain);
    if (pinned && chainId !== pinned) throw invalid();
    if (context.signal.aborted || !context.isCurrent()) throw invalid();
    // The name rechecked moments ago; the key held at the effect itself.
    if (!context.holdsKey()) {
      entry.override = { ...NO_ADDRESS };
      throw invalid();
    }
    const previous = windowChainOf(requester.window);
    selectChainForPage(requester.window, chainId);
    // The chain changed for every other page of the window too, but the
    // onchain apps.
    const others =
      previous === chainId
        ? []
        : context
          .liveDocuments()
          .filter(
            (doc) =>
              doc.window === requester.window &&
              !doc.chain &&
              !(doc.guest === requester.guest && doc.navigation === requester.navigation)
          );
    // In the window's order with the chain switcher's events (PRQ-6), and
    // before the page's answer, as main's own switch sent them.
    await context.inChainOrder(requester.window, async () => {
      if (!pinned) await context.sendEvent(requester, 'chainChanged', hex(chainId));
      for (const doc of others) await context.sendEvent(doc, 'chainChanged', hex(chainId));
    });
    return {};
  }

  /** Serve the core's requests about the page requests main relays. */
  function attach(client) {
    client.handle('approval.request', approvalRequest);
    client.handle('approval.recheck', approvalRecheck);
    client.handle('eip1193.select_chain', selectChain);
  }

  return {
    request,
    attach,
    worldFor,
    approvalRequest,
    approvalRecheck,
    selectChain,
    running: () => running.size,
  };
}

let shared = null;

/** Main's relay, shared by the page dispatchers and the core's client. */
function getEip1193Relay() {
  if (!shared) shared = createEip1193Relay();
  return shared;
}

/** core-process.js: serve the core's requests before anything is sent. */
function attachEip1193(client) {
  getEip1193Relay().attach(client);
}

module.exports = {
  createEip1193Relay,
  getEip1193Relay,
  attachEip1193,
  connectShown,
  signShown,
  unlockShown,
  sendShown,
};
