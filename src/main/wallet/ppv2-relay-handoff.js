/** One final, proved request -> explicit review -> durable intent -> one HTTP
 * call. Main retains prepare/submit; the SDK receives only the fetch facade. */
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { validateRelay } = require('./ppv2-relay-policy');
const refused = () => privacyError('PRIVATE_PPV2_RELAY_REFUSED', 'Relay handoff refused');
const uncertain = () => privacyError('PRIVATE_PPV2_RELAY_UNCERTAIN', 'Relay outcome is uncertain; inspect the recorded attempt');
function createPPv2RelayHandoff({ handle, journal, network, verifyProof }) {
  const context = getPrivacyContext(handle), s = context.subject;
  if (s.kind !== 'private-account' || s.role !== 'relayer' || s.protocol !== 'privacy-pools-v2' ||
      s.deployment !== 'sepolia' || s.chainId !== 11155111 || s.operation !== null || typeof verifyProof !== 'function' ||
      typeof network?.fetch !== 'function') throw refused();
  journal.assertScope(handle);
  const issued = new WeakMap();
  let active = null, busy = false;
  function check(signal) { getPrivacyContext(handle); if (signal?.aborted) throw refused(); }
  async function reviewBeforeDeadline(review, summary, expiresAt) {
    let timer, onAbort;
    try {
      const approved = await Promise.race([
        Promise.resolve().then(() => { check(); return review(summary); }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(refused()), Math.max(0, expiresAt - Date.now()));
          onAbort = () => reject(refused());
          context.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      check(); if (approved !== true || Date.now() >= expiresAt) throw refused();
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', onAbort); }
  }
  const sdkNetwork = Object.freeze({
    async fetch(input, init = {}) {
      const plan = active;
      const checkPlan = () => { check(init.signal); if (active !== plan || plan?.controller.signal.aborted) throw refused(); };
      checkPlan();
      // Only the candidate's documented string-body JSON POST shape. Snapshot
      // strings before awaiting review/storage; never forward caller options.
      if (!plan || plan.used || input !== plan.endpoint || init.method !== 'POST' || init.body !== plan.body ||
          Object.keys(init).some((k) => !['method', 'headers', 'body', 'signal'].includes(k))) throw refused();
      const headers = new Headers(init.headers);
      if ([...headers].length !== 1 || headers.get('content-type') !== 'application/json') throw refused();
      plan.used = true;
      await journal.assertCanSubmit(); checkPlan();
      await reviewBeforeDeadline(plan.review, plan.summary, plan.expiresAt); checkPlan();
      await journal.begin(plan.attempt);
      // Any failure after begin remains possibly submitted, including a crash
      // or lock just before fetch. No retry or release based on an HTTP error.
      try {
        checkPlan(); if (Date.now() >= plan.expiresAt) throw refused();
        const response = await network.fetch(plan.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: plan.body, signal: AbortSignal.any([context.signal, plan.controller.signal, ...(init.signal ? [init.signal] : [])]) });
        checkPlan();
        if (!(response instanceof Response) || !response.ok) throw uncertain();
        // The real host transport already buffers a bounded response. A small
        // txHash-only acknowledgement is all this boundary exposes to the SDK.
        const reader = response.body?.getReader();
        if (!reader) throw uncertain();
        let bytes = 0; const chunks = [];
        try {
          for (;;) {
            const { done, value } = await reader.read(); checkPlan();
            if (done) break;
            bytes += value.byteLength; if (bytes > 1024) throw uncertain(); chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || Object.keys(data).length !== 1 || typeof data.txHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(data.txHash)) throw uncertain();
        await journal.acknowledge(plan.attempt.id, data.txHash.toLowerCase()); checkPlan();
        plan.acknowledged = true;
        return new Response(JSON.stringify({ txHash: data.txHash.toLowerCase() }), { headers: { 'content-type': 'application/json' } });
      } catch { getPrivacyContext(handle); throw uncertain(); }
    },
  });
  return Object.freeze({
    network: sdkNetwork,
    async prepare(request) {
      check();
      let copy;
      try { copy = structuredClone(request); } catch { throw refused(); }
      const validated = validateRelay(copy);
      await journal.assertCanSubmit();
      // Only a main-owned verifier belongs here, never an SDK-supplied boolean.
      if (await verifyProof(structuredClone(validated.proof)) !== true) throw refused();
      check(); if (Date.now() >= validated.expiresAt) throw refused();
      const summary = Object.freeze(validated.summary);
      issued.set(summary, { ...validated, endpoint: copy.endpoint, body: copy.body });
      return summary;
    },
    async submit(prepared, { review, invoke }) {
      check();
      const plan = issued.get(prepared);
      if (!plan || busy || typeof review !== 'function' || typeof invoke !== 'function' || Date.now() >= plan.expiresAt) throw refused();
      issued.delete(prepared); busy = true; active = { ...plan, review, used: false, acknowledged: false, controller: new AbortController() };
      const current = active;
      try {
        await journal.assertCanSubmit(); check();
        const result = await invoke(sdkNetwork); check();
        if (!current.used || !current.acknowledged) throw refused();
        return result;
      } catch { getPrivacyContext(handle); if (current.used && (await journal.list()).length) throw uncertain(); throw refused(); }
      finally { current.controller.abort(); active = null; busy = false; }
    },
  });
}
module.exports = { createPPv2RelayHandoff };
