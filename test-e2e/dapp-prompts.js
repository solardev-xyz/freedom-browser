// A site's connection and its signing rule for an e2e spec, obtained the way
// a user obtains them: the page asks, and the window's approvals panel
// approves the identity core's own prompt (freedom-core design 0012). Main
// writes no grant and no rule of its own since APB-5b, and from APR-7 the
// core refuses main's page `approval.grant` and `approval.issue`, so a spec
// can no longer seed either; these keep working against both cores.
//
// `run(js)` runs a script in the requesting page and resolves with its value
// (a spec's own `inTab`, bound to that page). The page must be in its
// window's visible tab, since its prompt waits for its tab, and its window's
// panel is the one decided (`windowId`, `panel`: decideInPanel's).

const { expect } = require('./fixtures');
const { decideInPanel } = require('./approvals-fixtures');

const ALWAYS_SIGN = 'Always allow this site to request signatures without asking';
const RULE_MESSAGE = '0x' + Buffer.from('Always allow, from the prompt', 'utf8').toString('hex');

/** Send `method` from the page; its answer waits in the page under `slot`. */
const ask = (run, slot, method, params) =>
  run(`
    window.__dappPrompts = window.__dappPrompts || {};
    window.__dappPrompts[${JSON.stringify(slot)}] = window.ethereum
      .request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })
      .then((ok) => ({ ok }), (e) => ({ code: e?.code, message: String(e?.message || e) }));
    true
  `);
const answer = (run, slot) => run(`window.__dappPrompts[${JSON.stringify(slot)}]`);

/**
 * Connect the page's site: its `eth_requestAccounts`, and the core's
 * `eth.connect` prompt approved for `account` (the panel's label of the
 * account, e.g. 'Main Wallet'; the prompt's default when omitted). Resolves
 * with the address the page got.
 */
async function connectByPrompt(electronApp, run, { account, windowId, panel } = {}) {
  await ask(run, 'connect', 'eth_requestAccounts', []);
  await decideInPanel(electronApp, { heading: 'Connect', check: account ? [account] : [], windowId, panel });
  const got = await answer(run, 'connect');
  expect(got, 'the page connected from the core\'s prompt').toEqual({ ok: [expect.stringMatching(/^0x[0-9a-fA-F]{40}$/)] });
  return got.ok[0];
}

/**
 * Set the page's site's signing rule: a `personal_sign` from `address`, and
 * the core's `eth.sign` prompt approved with "Always allow". Resolves with
 * the signature the page got.
 */
async function signingRuleByPrompt(electronApp, run, address, { windowId, panel } = {}) {
  await ask(run, 'rule', 'personal_sign', [RULE_MESSAGE, address]);
  await decideInPanel(electronApp, { heading: 'Sign Message', check: [ALWAYS_SIGN], windowId, panel });
  const got = await answer(run, 'rule');
  expect(got, 'the page signed with "Always allow"').toEqual({ ok: expect.stringMatching(/^0x[0-9a-f]{130}$/i) });
  return got.ok;
}

module.exports = { connectByPrompt, signingRuleByPrompt, ALWAYS_SIGN };
