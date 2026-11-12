'use strict';

/**
 * Signing through main (freedom-core design 0011, step PRQ-5a):
 * `personal_sign` and `eth_signTypedData_v4`, from every account kind,
 * a Safe's EIP-1271 messages included.
 *
 * The chrome's `dapp-provider.js` ran these for a page and asked main for a
 * token (`wallet:confirm-signing`) or claimed the site's rule
 * (`{ autoApprove, webContentsId }`). Main runs them now, for the attested
 * requester, in today's order:
 *
 *   1. A document with no key is refused ("This page has no address to
 *      connect from yet"). A DNS name over IPNS is checked again before the
 *      key is first used, after every wait, and just before the effect; a
 *      name that has moved answers as a keyless document's would.
 *   2. A tab in Agent custody is offered to the agent service, which
 *      answers within the request (`walletOperation`): it holds the
 *      document's wallet slot, is withdrawn when main answers the request,
 *      and signs only once main's checks pass just before the signature.
 *   3. The site must be connected; a Safe signs only on Gnosis.
 *   4. The site's signing rule ("always allow"), read by main for the
 *      requester's key, is chosen only outside Agent custody, read live,
 *      and never for a 32-byte message (#89).
 *   5. What the request signs, from main and the identity core (#88): the
 *      bytes of a message, or the core's view of typed data, before any
 *      prompt. One main can't show is refused, unprompted, and one the view
 *      warns about always prompts, rule or not.
 *   6. The rule answers with no prompt, but a locked vault's unlock
 *      (`vault.unlock`, which the chrome still renders until APS-2). Just
 *      before the effect, after the last wait (the core's view, the name,
 *      the vault), custody is read again, the rule read again and the
 *      document must hold its key: a guest that entered custody meanwhile
 *      is refused (`agent_custody`), with nothing signed.
 *   7. Otherwise main prompts (`eth.sign`, with main's view). On the user's
 *      approval main's own issuer mints the token for that approval, bound
 *      to the prompt's handle and the requester's key, with the account and
 *      payload main holds, and the dispatcher spends it just before the
 *      signature, once the name, the grant and the document have been
 *      checked again. "Always allow", the prompt's one choice, sets the
 *      site's signing rule after the signature, for the requester's key.
 *
 * Device steps keep today's paths after the decision: a Ledger signs in
 * main, a phone account's job goes through main's bridge to the chrome's
 * session. A Safe's message opens a session main owns (`safe-messages.js`,
 * `owner: 'main'`): the vault owners sign at once, and a Safe that needs a
 * device owner's signature shows its signing board as a second prompt
 * (`eth.safe_message`), whose approval main completes and answers. The
 * session is cancelled if the request ends any other way.
 */

const { KINDS: CONFIRM_KINDS } = require('../wallet/signing-confirmation');

const SIGNING_METHODS = Object.freeze(['personal_sign', 'eth_signTypedData_v4']);

const INTERNAL_ERROR_CODE = -32603;
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
const NOT_CONNECTED = Object.freeze({ code: 4100, message: 'Not connected. Call eth_requestAccounts first.' });
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
const UNLOCK_CANCELLED = Object.freeze({ code: 4001, message: 'User cancelled unlock' });
// As Swarm and Radicle answer a request Agent custody refuses.
const AGENT_CUSTODY = Object.freeze({
  code: 4100,
  message: 'The origin is not authorized for this operation',
  data: Object.freeze({ reason: 'agent_custody' }),
});
const RULE_GONE = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: "Signing was not confirmed: this request is not covered by the site's auto-approve rules",
});
const ACCOUNT_GONE = Object.freeze({ code: INTERNAL_ERROR_CODE, message: 'The connected account is no longer available' });
const SAFE_OFF_GNOSIS = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: 'This multi-owner account can only sign on Gnosis Chain — switch the app to Gnosis first.',
});

// v1 Safes live on Gnosis: an EIP-1271 signature only verifies there.
const GNOSIS_CHAIN_ID = 100;

// A device's own "declined" is the user's rejection.
const DEVICE_REJECTIONS = new Set(['LEDGER_USER_REJECTED', 'REMOTE_USER_REJECTED', 'REMOTE_USER_CANCELLED']);

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });

function failure(err, fallback = 'Signing failed') {
  if (DEVICE_REJECTIONS.has(err?.code)) return error(USER_REJECTED);
  const message = typeof err?.message === 'string' && err.message ? err.message : fallback;
  return { error: { code: INTERNAL_ERROR_CODE, message } };
}

function defaultSigningDependencies() {
  return {
    inCustody: (guestId) => {
      const { webContents } = require('electron');
      let contents;
      try {
        contents = webContents.fromId(guestId);
      } catch {
        contents = null;
      }
      return require('../wallet/agent-tab-custody').isAgentPage(contents);
    },
    isVaultUnlocked: () => require('../identity-manager').isVaultUnlocked(),
    messageView: (message) => require('../wallet/wallet-ipc').messageViewFor(message),
    typedDataView: (typedData, chainId) => require('../wallet/wallet-ipc').typedDataViewFor(typedData, chainId),
    signsRawHash: (message) => require('../wallet/signing-utils').signsRawHash(message),
    getSigner: (walletIndex) => require('../wallet/signers').getSigner(walletIndex),
    setSigningAutoApprove: (key, enabled) => require('../wallet/dapp-permissions').setSigningAutoApprove(key, enabled),
    startSafeMessage: (options) => require('../wallet/safe/safe-messages').startSafeMessage(options),
    completeSafeMessage: (safeIndex, token) => require('../wallet/safe/safe-messages').completeSafeMessage(safeIndex, token),
    cancelSafeMessage: (safeIndex, token) => require('../wallet/safe/safe-messages').cancelSafeMessage(safeIndex, token),
  };
}

/**
 * @param {object} shared from page-ethereum.js: `getPermission`,
 *   `updateLastUsed`, `walletList`, `chainIdOf`, `chainName`, `networks`
 *   and `agentAnswer`.
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {Record<string, (context: object) => Promise<object>>} keyed
 *   `ethereum:<method>`.
 */
function createSigningDispatchers(shared, deps = {}) {
  const { getPermission, updateLastUsed, walletList, chainIdOf, chainName, networks, agentAnswer } = shared;
  const {
    inCustody,
    isVaultUnlocked,
    messageView,
    typedDataView,
    signsRawHash,
    getSigner,
    setSigningAutoApprove,
    startSafeMessage,
    completeSafeMessage,
    cancelSafeMessage,
  } = { ...defaultSigningDependencies(), ...deps };

  const custody = (guest) => {
    try {
      return inCustody(guest) === true;
    } catch {
      // Unknown custody counts as custody: no rule answers for it.
      return true;
    }
  };

  // The key's grant, but only while it exposes exactly `walletIndex`: a
  // rule, or a confirmed signature, is for the account the site is
  // connected with.
  function grantExposes(key, walletIndex) {
    const permission = getPermission(key);
    return permission && permission.walletIndex === walletIndex ? permission : null;
  }

  function chainLabel(chainId) {
    try {
      return chainName(chainId) || null;
    } catch {
      return null;
    }
  }

  // The chain names a typed-data warning quotes: the page's chain and the
  // one the data names.
  function warningChains(chainId, view) {
    const chains = {};
    let known;
    try {
      known = networks() || {};
    } catch {
      known = {};
    }
    const ids = [String(chainId)];
    try {
      if (view?.domain?.chainId !== undefined) ids.push(BigInt(view.domain.chainId).toString());
    } catch {
      // Named by id alone.
    }
    for (const id of ids) {
      const name = known?.[id]?.name;
      if (typeof name === 'string') chains[id] = { name };
    }
    return chains;
  }

  // What the request signs, before any prompt (#88): the message's bytes,
  // or the core's view of the typed data against the page's chain.
  async function prepare(method, params, chainId) {
    if (method === 'personal_sign') {
      const message = params?.[0];
      const view = messageView(message);
      return { payload: message, message: { hex: view.hex, rawHash: view.rawHash === true }, warned: view.rawHash === true };
    }
    const typedData = params?.[1];
    const { hash, view, warnings } = await typedDataView(typedData, chainId);
    const list = Array.isArray(warnings) ? warnings.slice() : [];
    return {
      payload: typedData,
      typedData: { hash, view, warnings: list },
      chains: list.includes('chain-mismatch') ? warningChains(chainId, view) : {},
      warned: list.length > 0,
    };
  }

  // Whether the site's signing rule would answer this request: main's own
  // reading, for the requester's key and the account its grant exposes.
  // Never a personal_sign of exactly 32 bytes, whatever the account (#89),
  // nor, once main has viewed it, a warned request (#88).
  function ruleCovers(key, walletIndex, method, params, prepared = null) {
    const permission = grantExposes(key, walletIndex);
    if (!permission || permission.autoApprove?.signing !== true) return false;
    if (prepared?.warned) return false;
    return !(method === 'personal_sign' && signsRawHash(params?.[0]));
  }

  const accountView = (account) => ({
    index: account.index,
    name: typeof account.name === 'string' ? account.name : '',
    address: typeof account.address === 'string' ? account.address : null,
    type: typeof account.type === 'string' ? account.type : 'mnemonic',
  });

  // The signature itself, for a vault, Ledger or phone account.
  async function signWith(walletIndex, method, prepared, expectedHash) {
    const signer = getSigner(walletIndex);
    if (method === 'personal_sign') return signer.signMessage(prepared.payload);
    return signer.signTypedData(prepared.payload, { expectedHash });
  }

  // A write under the key after the signature's wait (a Ledger, the phone
  // bridge, the core): the name resolved again, then, in the same run as the
  // write, the document holding its key and the grant exposing the account.
  async function writableAfterEffect(context, ctx) {
    if (!(await context.nameHolds(ctx.keyless))) return false;
    return context.holdsKey() && Boolean(grantExposes(context.requester.key, ctx.walletIndex));
  }

  async function vaultUnlocked() {
    try {
      return (await isVaultUnlocked()) === true;
    } catch {
      return false;
    }
  }

  /**
   * A Safe's message, once main has authorized it: a session main owns,
   * bound to the requester, whose vault owners sign at once. A Safe that
   * needs a device owner's signature shows its board (`eth.safe_message`),
   * and main completes the session on its approval. Cancelled if the
   * request ends any other way.
   */
  async function safeMessage(context, ctx) {
    const { requester, method, params } = context;
    let state;
    try {
      state = await startSafeMessage({
        safeIndex: ctx.walletIndex,
        request: { method, params },
        display: { kind: 'message', site: requester.key, method },
        requester: { origin: requester.key, webContentsId: requester.guest },
        owner: 'main',
      });
    } catch (err) {
      return failure(err);
    }
    const token = state?.token;
    let completed = false;
    try {
      if (!state?.complete) {
        const board = await context.prompt({
          kind: 'eth.safe_message',
          view: { safeIndex: ctx.walletIndex, state },
          choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
        });
        if (board.error) return { error: board.error };
        if (board.closed || board.approve !== true) return error(USER_REJECTED);
      }
      // The signature goes to the page only while the name holds and the
      // document keeps its key.
      if (!(await context.nameHolds(ctx.keyless)) || !context.holdsKey()) return error(NO_ADDRESS);
      let signature;
      try {
        ({ signature } = completeSafeMessage(ctx.walletIndex, token));
      } catch (err) {
        return failure(err);
      }
      completed = true;
      return { result: signature };
    } finally {
      if (!completed) {
        try {
          cancelSafeMessage(ctx.walletIndex, token);
        } catch {
          // A device step still running: the session goes with its page.
        }
      }
    }
  }

  // The site's rule answers: no prompt but a locked vault's unlock.
  async function autoSign(context, ctx) {
    const { requester, method, params } = context;
    if (!(await vaultUnlocked())) {
      const unlock = await context.prompt({
        kind: 'vault.unlock',
        view: { account: ctx.account, reason: 'sign' },
        choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
      });
      if (unlock.error) return { error: unlock.error };
      if (unlock.closed || unlock.approve !== true) return error(UNLOCK_CANCELLED);
    }
    if (!(await context.nameHolds(ctx.keyless))) return error(NO_ADDRESS);
    // Just before the effect, after the last wait.
    if (custody(requester.guest)) return error(AGENT_CUSTODY);
    if (!ruleCovers(requester.key, ctx.walletIndex, method, params, ctx.prepared)) return error(RULE_GONE);
    if (!context.holdsKey()) return error(NO_ADDRESS);
    if (ctx.safe) {
      const out = await safeMessage(context, ctx);
      if (!out.error && (await writableAfterEffect(context, ctx))) updateLastUsed(requester.key);
      return out;
    }
    let signature;
    try {
      signature = await signWith(ctx.walletIndex, method, ctx.prepared, ctx.prepared.typedData?.hash);
    } catch (err) {
      return failure(err);
    }
    // The site's last use, only while the name still answers: a name that
    // moved meanwhile also gets no signature (`nameHolds`' keyless answer).
    if (await writableAfterEffect(context, ctx)) updateLastUsed(requester.key);
    return { result: signature };
  }

  // The user decides, on main's prompt, and main's issuer mints the token.
  async function promptedSign(context, ctx) {
    const { requester, method } = context;
    const view = {
      method,
      account: ctx.account,
      chain: { id: ctx.chainId, name: chainLabel(ctx.chainId) },
      ...(ctx.prepared.message ? { message: ctx.prepared.message } : {}),
      ...(ctx.prepared.typedData ? { typedData: ctx.prepared.typedData, chains: ctx.prepared.chains } : {}),
    };
    const decision = await context.prompt({
      kind: 'eth.sign',
      view,
      // The one thing the user picks: "always allow".
      choices: (raw) =>
        Object.keys(raw).every((name) => name === 'alwaysAllow') &&
        (raw.alwaysAllow === undefined || typeof raw.alwaysAllow === 'boolean')
          ? { alwaysAllow: raw.alwaysAllow === true }
          : null,
    });
    if (decision.error) return { error: decision.error };
    if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
    // After the prompt: the name again, then, in one run just before the
    // effect, the grant still exposing the account shown, the document
    // holding its key, and the token minted for this approval and spent.
    if (!(await context.nameHolds(ctx.keyless))) return error(NO_ADDRESS);
    if (!grantExposes(requester.key, ctx.walletIndex)) return error(NOT_CONNECTED);
    if (!context.holdsKey()) return error(NO_ADDRESS);
    const kind = ctx.safe
      ? CONFIRM_KINDS.SAFE_MESSAGE
      : method === 'personal_sign'
        ? CONFIRM_KINDS.SIGN_MESSAGE
        : CONFIRM_KINDS.SIGN_TYPED_DATA;
    const payload = ctx.safe ? { method, params: context.params } : ctx.prepared.payload;
    let bound;
    try {
      const token = context.confirm(
        kind,
        ctx.walletIndex,
        payload,
        kind === CONFIRM_KINDS.SIGN_TYPED_DATA ? { hash: ctx.prepared.typedData.hash } : undefined
      );
      bound = context.spend(token, kind, ctx.walletIndex, payload);
    } catch (err) {
      return failure(err);
    }
    let out;
    if (ctx.safe) {
      out = await safeMessage(context, ctx);
    } else {
      try {
        out = { result: await signWith(ctx.walletIndex, method, ctx.prepared, bound.hash) };
      } catch (err) {
        return failure(err);
      }
    }
    // "Always allow": the site's rule, for the requester's key, from the
    // prompt the user just approved, once its signature is made, and only
    // while the name still answers after the signature's wait.
    if (!out.error && decision.choices?.alwaysAllow === true && (await writableAfterEffect(context, ctx))) {
      try {
        setSigningAutoApprove(requester.key, true);
      } catch {
        // The signature stands; the rule wasn't saved.
      }
    }
    return out;
  }

  async function sign(context) {
    const { requester, method, params } = context;
    if (!requester.key) return error(NO_ADDRESS);
    const keyless = { keyless: error(NO_ADDRESS) };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    // A tab the agent holds: the agent service answers, within the request.
    // Only a tab in custody is offered to it (the agent registers custody on
    // every tab it drives), so a page's other requests, its rule-answered
    // signatures among them, don't wait on the agent's wallet slot.
    const agent = custody(requester.guest) ? await agentAnswer(context, keyless) : null;
    if (agent) return context.holdsKey() ? agent : error(NO_ADDRESS);
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    const permission = getPermission(requester.key);
    if (!permission) return error(NOT_CONNECTED);
    const walletIndex = permission.walletIndex;
    const chainId = chainIdOf(requester);
    const account = (await walletList()).find((candidate) => candidate?.index === walletIndex);
    if (!account) return error(ACCOUNT_GONE);
    const safe = account.type === 'safe';
    if (safe && chainId !== GNOSIS_CHAIN_ID) return error(SAFE_OFF_GNOSIS);
    // A standing rule is chosen only outside Agent custody, read live now.
    // A request that goes to its prompt keeps it, whatever custody does
    // next; one the rule answers reads custody again just before its effect,
    // after every wait (the core's view, the name, the vault).
    const ruled = !custody(requester.guest) && ruleCovers(requester.key, walletIndex, method, params);
    let prepared;
    try {
      prepared = await prepare(method, params, chainId);
    } catch (err) {
      return failure(err, method === 'personal_sign' ? 'This message can’t be shown' : 'This typed data can’t be shown');
    }
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    const ctx = { keyless, walletIndex, chainId, account: accountView(account), safe, prepared };
    // A warned request always shows its prompt, rule or not (#88).
    if (ruled && !prepared.warned) return autoSign(context, ctx);
    return promptedSign(context, ctx);
  }

  const dispatchers = {};
  for (const method of SIGNING_METHODS) dispatchers[`ethereum:${method}`] = sign;
  return dispatchers;
}

module.exports = {
  SIGNING_METHODS,
  createSigningDispatchers,
};
