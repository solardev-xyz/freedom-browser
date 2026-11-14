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
 *   4. What the request signs, from main and the identity core (#88): the
 *      bytes of a message, or the core's view of typed data, before any
 *      prompt. One main can't show is refused, unprompted, and one the view
 *      warns about always prompts, rule or not.
 *   5. The site's signing rule ("always allow") is chosen only outside
 *      Agent custody, read live, and never for a 32-byte message (#89):
 *      the identity core reads it (design 0012, APB-1, `approval.check`),
 *      for the requester's key and the account its grant exposes, under the
 *      request's PageContext, from the file main still writes.
 *   6. The rule answers with no prompt, but a locked vault's unlock
 *      (`vault.unlock`, which the chrome still renders until APS-2). Just
 *      before the effect, after every other wait (the core's view, the
 *      vault, the name), the core reads the rule again, and in the same run
 *      as the signature custody is read again and the document must hold
 *      its key: a guest that entered custody meanwhile is refused
 *      (`agent_custody`), with nothing signed. For a Ledger, a phone or a
 *      Safe that reading is the core's verdict; a vault signature goes under
 *      `page` with `{ standing }`, and the core judges the rule once more as
 *      it signs.
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
 * session is cancelled if the request ends any other way. With the approvals
 * document on (APS-3b), main runs that board in the panel itself
 * (`approvals/safe-boards.js`): each owner the user picks signs in main,
 * and main completes the session once the threshold is met. The session's
 * token stays main's.
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

/** Whether the agent holds the tab `guestId` now (`agent-tab-custody.js`). */
function guestInCustody(guestId) {
  const { webContents } = require('electron');
  let contents;
  try {
    contents = webContents.fromId(guestId);
  } catch {
    contents = null;
  }
  return require('../wallet/agent-tab-custody').isAgentPage(contents);
}

function defaultSigningDependencies() {
  return {
    inCustody: guestInCustody,
    isVaultUnlocked: () => require('../identity-manager').isVaultUnlocked(),
    messageView: (message) => require('../wallet/wallet-ipc').messageViewFor(message),
    typedDataView: (typedData, chainId) => require('../wallet/wallet-ipc').typedDataViewFor(typedData, chainId),
    signsRawHash: (message) => require('../wallet/signing-utils').signsRawHash(message),
    getSigner: (walletIndex, authorized) => require('../wallet/signers').getSigner(walletIndex, authorized),
    // The site's standing rule, as the identity core reads it (design 0012).
    checkStanding: (page, request) => require('../wallet/signing-confirmation').checkStanding(page, request),
    // A Safe message's token, spent through the identity core (design 0012).
    spendSafe: (confirmation) => require('../wallet/signing-confirmation').spendSafeConfirmation(confirmation),
    discardToken: (token) => require('../wallet/signing-confirmation').discardConfirmation(token),
    setSigningAutoApprove: (key, enabled) => require('../wallet/dapp-permissions').setSigningAutoApprove(key, enabled),
    startSafeMessage: (options) => require('../wallet/safe/safe-messages').startSafeMessage(options),
    completeSafeMessage: (safeIndex, token) => require('../wallet/safe/safe-messages').completeSafeMessage(safeIndex, token),
    cancelSafeMessage: (safeIndex, token) => require('../wallet/safe/safe-messages').cancelSafeMessage(safeIndex, token),
    // The boards main runs in the approvals document (APS-3b).
    safeBoards: () => require('../approvals/safe-boards').getSafeBoards(),
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
    checkStanding,
    spendSafe,
    discardToken,
    setSigningAutoApprove,
    startSafeMessage,
    completeSafeMessage,
    cancelSafeMessage,
    safeBoards,
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

  // Whether the site's signing rule answers this request now: the identity
  // core's reading (design 0012, `approval.check`) for the requester's key
  // and the account its grant exposes, under the request's PageContext
  // (custody read live), the typed data viewed on the page's chain. Never a
  // personal_sign of exactly 32 bytes, whatever the account (#89), nor a
  // warned request (#88): main's own view gates both first. Advice: a vault
  // signature is judged again as the core signs. One the core can't judge
  // is not covered.
  async function ruleAnswers(context, ctx) {
    if (ctx.prepared.warned) return { covered: false, reason: 'warning' };
    if (context.method === 'personal_sign' && signsRawHash(context.params?.[0])) return { covered: false, reason: 'warning' };
    try {
      const answer = await checkStanding(context.pageContext(), {
        kind: context.method === 'personal_sign' ? 'message' : 'typed_data',
        account: ctx.walletIndex,
        accountType: ctx.account.type,
        payload: ctx.prepared.payload,
        chainId: ctx.chainId,
      });
      return answer?.covered === true ? { covered: true, reason: null } : { covered: false, reason: answer?.reason ?? null };
    } catch {
      return { covered: false, reason: null };
    }
  }

  // A standing rule's signature the core refused (`{ standing }`): custody
  // as the dispatcher answers it, a rule gone as before, anything else in
  // the core's words.
  function standingFailure(err) {
    if (err?.reason === 'custody') return error(AGENT_CUSTODY);
    if (err?.reason === 'no_rule') return error(RULE_GONE);
    return failure(err);
  }

  const accountView = (account) => ({
    index: account.index,
    name: typeof account.name === 'string' ? account.name : '',
    address: typeof account.address === 'string' ? account.address : null,
    type: typeof account.type === 'string' ? account.type : 'mnemonic',
  });

  // The signature itself, for a vault, Ledger or phone account: with the
  // request's confirmation, or, for a rule's answer, its page's PageContext
  // (design 0012), so a page's signature never goes as main's own.
  async function signWith(walletIndex, method, prepared, expectedHash, authorized) {
    const signer = getSigner(walletIndex, authorized);
    if (method === 'personal_sign') return signer.signMessage(prepared.payload);
    return signer.signTypedData(prepared.payload, { expectedHash });
  }

  /**
   * After a signature's wait (a Ledger, the phone bridge, the core, a Safe's
   * board): the name resolved again, whether or not anything is written.
   * Resolves false when the name no longer answers the document's key: the
   * request's keyless answer is registered (`nameHolds`), and the caller
   * withholds the signature. Otherwise `write`, if given, runs here, in the
   * same run as the checks it depends on (the document holding its key, the
   * grant exposing the account), never after an await of the caller's.
   */
  async function recheckThen(context, ctx, write = null) {
    if (!(await context.nameHolds(ctx.keyless))) return false;
    // From here to the write, one run: no other check can end the binding.
    if (!context.holdsKey()) return false;
    if (write && grantExposes(context.requester.key, ctx.walletIndex)) {
      try {
        write();
      } catch {
        // The signature stands; the write didn't happen.
      }
    }
    return true;
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
      if (!state?.complete && context.approvalsDocument) {
        // In the panel (APS-3b): main's board, the token never shown.
        const boards = safeBoards();
        if (!boards) return error(USER_REJECTED);
        const board = await boards.runMessageBoard(context, { safeIndex: ctx.walletIndex, token });
        if (board.error) return { error: board.error };
        if (board.outcome !== 'complete') return error(USER_REJECTED);
      } else if (!state?.complete) {
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
    const { requester, method } = context;
    if (!(await vaultUnlocked())) {
      const unlock = await context.prompt({
        kind: 'vault.unlock',
        view: { account: ctx.account, reason: 'sign' },
        choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
      });
      if (unlock.error) return { error: unlock.error };
      if (unlock.closed || unlock.approve !== true) return error(UNLOCK_CANCELLED);
    }
    // After the unlock's wait, the name; then the core's last reading of the
    // rule, the last wait before the effect, so a rule revoked while the name
    // resolved is seen; then, in the same run as the signature, custody and
    // the key. For a Ledger, a phone or a Safe this is the core's verdict:
    // their signatures present no `{ standing }` to judge again.
    if (!(await context.nameHolds(ctx.keyless))) return error(NO_ADDRESS);
    const still = await ruleAnswers(context, ctx);
    if (custody(requester.guest) || still.reason === 'custody') return error(AGENT_CUSTODY);
    if (!still.covered) return error(RULE_GONE);
    if (!context.holdsKey()) return error(NO_ADDRESS);
    let out;
    if (ctx.safe) {
      out = await safeMessage(context, ctx);
    } else {
      try {
        // Under `page` with `{ standing }`: the core judges the site's rule
        // as it signs, the typed data viewed on the page's chain.
        out = {
          result: await signWith(ctx.walletIndex, method, ctx.prepared, ctx.prepared.typedData?.hash, {
            page: context.pageContext(),
            standing: {},
            chainId: ctx.chainId,
          }),
        };
      } catch (err) {
        return standingFailure(err);
      }
    }
    if (out.error) return out;
    // After the signature's wait: the name again, and the site's last use
    // only while it still answers. A name that moved gets no signature.
    if (!(await recheckThen(context, ctx, () => updateLastUsed(requester.key)))) return error(NO_ADDRESS);
    return out;
  }

  // With the approvals document on, a vault account's prompt asks for the
  // vault unlocked first (APS-2): the document has no unlock of its own in
  // the signing screen, as the chrome's had. Devices and Safes need none.
  async function unlockFirst(context, ctx, reason) {
    if (!context.approvalsDocument || ctx.account?.type !== 'mnemonic' || (await vaultUnlocked())) return null;
    const unlock = await context.prompt({
      kind: 'vault.unlock',
      view: { account: ctx.account, reason },
      choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
    });
    if (unlock.error) return { error: unlock.error };
    if (unlock.closed || unlock.approve !== true) return error(UNLOCK_CANCELLED);
    return null;
  }

  // The user decides, on main's prompt, and main's issuer mints the token.
  async function promptedSign(context, ctx) {
    const { requester, method } = context;
    const locked = await unlockFirst(context, ctx, 'sign');
    if (locked) return locked;
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
    let confirmation = null;
    let out;
    try {
      try {
        // Minted by the identity core for this document and prompt (design
        // 0012), the typed data's against the page's chain, as it was viewed.
        confirmation = await context.confirm(kind, ctx.walletIndex, payload, { chainId: ctx.chainId });
        // What the core bound is what the user was shown.
        if (kind === CONFIRM_KINDS.SIGN_TYPED_DATA && confirmation.hash !== ctx.prepared.typedData.hash) {
          throw new Error('The typed data changed after it was shown');
        }
      } catch (err) {
        return failure(err);
      }
      // After the mint's wait, in the same run as the signature: the grant
      // still exposing the account shown, and the document holding its key.
      if (!grantExposes(requester.key, ctx.walletIndex)) return error(NOT_CONNECTED);
      try {
        context.spend(confirmation);
        // A Safe's message signs nothing here: its token is spent through
        // the core, and its owners sign on the board.
        if (ctx.safe) await spendSafe(confirmation);
      } catch (err) {
        return failure(err);
      }
      if (ctx.safe) {
        out = await safeMessage(context, ctx);
      } else {
        try {
          out = { result: await signWith(ctx.walletIndex, method, ctx.prepared, confirmation.hash, { confirmation }) };
        } catch (err) {
          return failure(err);
        }
      }
    } finally {
      // Spent at its presentation; one a request ended before is burnt.
      if (confirmation) discardToken(confirmation.token);
    }
    if (out.error) return out;
    // After the signature's wait, always: the name again. A name that moved
    // gets no signature, and no rule. "Always allow", the site's rule for the
    // requester's key from the prompt the user just approved, is written only
    // while it still answers.
    const alwaysAllow = decision.choices?.alwaysAllow === true ? () => setSigningAutoApprove(requester.key, true) : null;
    if (!(await recheckThen(context, ctx, alwaysAllow))) return error(NO_ADDRESS);
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
    const outsideCustody = !custody(requester.guest);
    let prepared;
    try {
      prepared = await prepare(method, params, chainId);
    } catch (err) {
      return failure(err, method === 'personal_sign' ? 'This message can’t be shown' : 'This typed data can’t be shown');
    }
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    const ctx = { keyless, walletIndex, chainId, account: accountView(account), safe, prepared };
    // The prompt or none: the core's reading of the rule. A warned request
    // always shows its prompt, rule or not (#88).
    if (outsideCustody && !prepared.warned && (await ruleAnswers(context, ctx)).covered) {
      if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
      return autoSign(context, ctx);
    }
    return promptedSign(context, ctx);
  }

  const dispatchers = {};
  for (const method of SIGNING_METHODS) dispatchers[`ethereum:${method}`] = sign;
  return dispatchers;
}

module.exports = {
  SIGNING_METHODS,
  createSigningDispatchers,
  guestInCustody,
};
