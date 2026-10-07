/** Synthetic per-destination latency for the offline cold-submission qualifier.
 *
 * Fixture only. It wraps the synthetic transport that the services and EOA
 * fixtures installed (so it must be installed after both, before any private
 * RPC or POI module loads) and passes every request straight through until
 * the qualifier arms it for its one submission phase. While armed, a request
 * is issued at its wrapper entry, reaches the synthetic service after
 * deliverMs and answers after ms. The real transport's abort rules apply:
 * the caller's signal, the privacy context's revocation, the client's close
 * and timeoutMs reject it as PRIVACY_REQUEST_ABORTED or TOR_REQUEST_TIMEOUT.
 * Aborted before delivery, the synthetic service never sees it; aborted after
 * delivery, the service saw it and its reply is lost.
 *
 * The POI phase follows the boundary suite's model (poiPhase in
 * src/main/wallet/railgun-private-submission-boundaries.test.js): the four
 * selected-POI source requests finish at evenly spaced points of
 * min(14 s, 65 %) of the phase, and the local membership job's result reply is
 * held until the rest of the phase has elapsed since that job started. In
 * production membership is local work; its hold is a simulated duration, not
 * network latency.
 *
 * Simulated service latency over a synthetic chain and synthetic services:
 * not live, not Tor, circuit isolation not applicable. No production module,
 * timer, receipt age or budget is replaced. The case table is fixed; the
 * qualifier accepts only its names. */
const fixtureChecks = require('./railgun-native-assertions');
const assert = fixtureChecks.assert;
const { Interface } = require('ethers');

const D1B_POI_MS = 18587;
const poiPhase = (total) => {
  const source = Math.min(14000, Math.round(total * 0.65));
  return { poiMs: total, poiSourceMs: source, membershipMs: total - source };
};
const ACK = Object.freeze({ outcome: 'acknowledged' });
const AT_NULLIFIER = Object.freeze({
  outcome: 'refused-before-disclosure-nullifier',
  diagnostic: {
    stage: 'preflight',
    substage: 'acquire',
    code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
    reason: 'stale',
    step: 'nullifiers',
  },
});
const healthy = {
  ...poiPhase(D1B_POI_MS),
  readMs: 150,
  resolved: 0,
  send: { ms: 1000, deliverMs: 500 },
  approve: { afterMs: 3000 },
  stall: null,
};
// Expectations are those of the committed policy (H = F, 10 s reserve) in
// the boundary suite's comparison, or its budget arithmetic where a case is
// not in that table (reads-650ms, send-9s-late).
const CASES = Object.freeze(
  Object.fromEntries(
    Object.entries({
      'healthy-empty': { ...healthy, expected: ACK },
      'healthy-four-resolved': { ...healthy, resolved: 4, expected: ACK },
      'poi-22s': { ...healthy, ...poiPhase(22000), resolved: 4, expected: ACK },
      'poi-25s': {
        ...healthy,
        ...poiPhase(25000),
        resolved: 4,
        expected: {
          outcome: 'refused-before-disclosure-nullifier',
          diagnostic: { stage: 'membership', code: 'RAILGUN_PRIVATE_REVIEW_BUDGET' },
        },
      },
      'reads-400ms': { ...healthy, readMs: 400, resolved: 4, expected: ACK },
      'reads-650ms': { ...healthy, readMs: 650, resolved: 4, expected: AT_NULLIFIER },
      // probe-1 shape: the seventh deployment read stalls 10 s but completes.
      'nullifier-deadline': {
        ...healthy,
        resolved: 4,
        stall: { deploymentRead: 6, ms: 10000 },
        expected: AT_NULLIFIER,
      },
      'send-9s-late': {
        ...healthy,
        send: { ms: 9000, deliverMs: 4500 },
        approve: { beforeMs: 1000 },
        expected: ACK,
      },
      'send-12s-late': {
        ...healthy,
        send: { ms: 12000, deliverMs: 6000 },
        approve: { beforeMs: 1000 },
        expected: { outcome: 'journaled-uncertain', nodeAccepted: true },
      },
    }).map(([name, value]) => [name, JSON.parse(JSON.stringify(value))])
  )
);
const preflightAbi = new Interface([
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function unshieldFee() view returns (uint120)',
  'function getVerificationKey(uint256,uint256)',
]);
// What leaves the wallet with each request, by destination. Public scan and
// account reads disclose no selected input; the classes below do.
function classify(subject, wire) {
  const method = typeof wire.method === 'string' ? wire.method : 'graphql';
  if (subject.kind === 'service')
    return { destination: 'public-services', operation: subject.role, method, name: method };
  if (subject.role === 'poi') {
    const selected = typeof subject.operation === 'string' && subject.operation.startsWith('poi:');
    return {
      destination: 'poi',
      operation: selected ? 'selected-poi' : String(subject.operation),
      method,
      name: method,
      disclosure: selected ? 'poi-selected-commitment' : undefined,
    };
  }
  if (subject.role === 'protocol-rpc') {
    // Deployment reads (shield-preflight) and retained public scan reads.
    const operation = subject.operation ?? 'retained-source';
    if (operation !== 'private-preflight')
      return { destination: 'protocol-rpc', operation, method, name: method };
    let name = method;
    if (method === 'eth_call') {
      try {
        name = preflightAbi.parseTransaction({ data: wire.params[0].data }).name;
      } catch {
        name = 'eth_call';
      }
    } else if (method === 'eth_getBlockByNumber') name = 'anchor-recheck';
    return {
      destination: 'protocol-rpc',
      operation,
      method,
      name,
      disclosure: {
        rootHistory: 'original-input-root',
        getVerificationKey: 'circuit-shape',
        nullifiers: 'selected-nullifier',
      }[name],
    };
  }
  assert.equal(subject.role, 'transaction-rpc');
  const name = method === 'eth_call' ? 'simulate' : method;
  return {
    destination: 'transaction-rpc',
    operation: 'eoa',
    method,
    name,
    disclosure: {
      eth_estimateGas: 'proved-calldata',
      simulate: 'proved-calldata',
      eth_sendRawTransaction: 'signed-transaction',
    }[name],
  };
}
const privacyError = (code) => Object.assign(new Error('Private HTTP request failed'), { code });

exports.CASES = CASES;
exports.install = function install({ name }) {
  assert.ok(Object.hasOwn(CASES, name));
  const definition = CASES[name];
  const transport = require('../../src/main/networks/wallet-tor-transport');
  const { getPrivacyContext } = require('../../src/main/networks/privacy-context');
  for (const filename of [
    '../../src/main/networks/private-rpc',
    '../../src/main/wallet/railgun-poi-source',
    '../../src/main/wallet/railgun-poi-root',
  ])
    assert.equal(require.cache[require.resolve(filename)], undefined);
  const originalTransport = transport.createWalletTorTransport;
  const clients = new Set();
  const requests = [],
    holds = [];
  let armed = false,
    armedAt,
    disarmedAt,
    active = true,
    poiStarted,
    poiIndex = 0,
    deploymentIndex = 0,
    sequence = 0,
    pending = 0;
  const now = () => performance.now();
  // Milliseconds since arming, to the microsecond.
  const since = (at) => Math.round((at - armedAt) * 1000) / 1000;
  // A request's plan is fixed at entry, from the case and its destination.
  const plan = (entry) => {
    if (entry.disclosure === 'poi-selected-commitment') {
      poiStarted ??= entry.at;
      const index = poiIndex++;
      assert.ok(index < 4);
      const release = poiStarted + (definition.poiSourceMs * (index + 1)) / 4;
      const ms = Math.max(0, Math.round(release - entry.at));
      return { ms, deliverMs: Math.floor(ms / 2), rule: 'poi-source-schedule' };
    }
    if (entry.name === 'eth_sendRawTransaction') return { ...definition.send, rule: 'send' };
    if (entry.operation === 'shield-preflight') {
      const index = deploymentIndex++;
      if (definition.stall && index === definition.stall.deploymentRead)
        return {
          ms: definition.stall.ms,
          deliverMs: Math.floor(definition.stall.ms / 2),
          rule: 'stalled-deployment-read',
        };
    }
    return {
      ms: definition.readMs,
      deliverMs: Math.floor(definition.readMs / 2),
      rule: 'read',
    };
  };
  // Resolves after ms unless one of the signals aborts first.
  const wait = (ms, signals) =>
    new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener('abort', stop);
        reject(Error('aborted'));
      };
      for (const signal of signals) {
        if (signal.aborted) {
          for (const other of signals) other.removeEventListener('abort', stop);
          reject(Error('aborted'));
          return;
        }
        signal.addEventListener('abort', stop, { once: true });
      }
      const timer = setTimeout(() => {
        for (const signal of signals) signal.removeEventListener('abort', stop);
        resolve();
      }, ms);
    });
  transport.createWalletTorTransport = (...args) => {
    assert.ok(active);
    const delegate = originalTransport(...args);
    const closer = new AbortController();
    let closed = false,
      waiting = 0,
      resolveDrained;
    const drained = new Promise((resolve) => {
      resolveDrained = resolve;
    });
    const finish = () => {
      if (closed && waiting === 0) resolveDrained();
    };
    const client = {
      ...delegate,
      closed: Promise.all([delegate.closed, drained]).then(() => undefined),
      close() {
        closed = true;
        closer.abort();
        try {
          delegate.close();
        } finally {
          finish();
        }
      },
      async request(handle, url, options) {
        if (!armed) return delegate.request(handle, url, options);
        // As in the real transport, a revoked context or an aborted caller
        // refuses before the request is issued.
        const context = getPrivacyContext(handle);
        if (options.signal?.aborted) throw privacyError('PRIVACY_REQUEST_ABORTED');
        const wire = JSON.parse(options.body);
        const issuedAt = now();
        const entry = {
          sequence: ++sequence,
          ...classify(context.subject, wire),
          at: since(issuedAt),
        };
        const { rule, ...timing } = plan({ ...entry, at: issuedAt });
        Object.assign(entry, { rule, plannedMs: timing.ms, plannedDeliverMs: timing.deliverMs });
        requests.push(entry);
        waiting++;
        pending++;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 30000);
        const signals = [closer.signal, context.signal, timeout.signal];
        if (options.signal) signals.push(options.signal);
        const settle = (outcome) => {
          entry.outcome = outcome;
          entry.end = since(now());
        };
        const failure = () =>
          privacyError(timeout.signal.aborted ? 'TOR_REQUEST_TIMEOUT' : 'PRIVACY_REQUEST_ABORTED');
        try {
          try {
            await wait(timing.deliverMs, signals);
          } catch {
            const error = failure();
            settle(error.code + ':before-delivery');
            throw error;
          }
          entry.delivered = since(now());
          const response = await delegate.request(handle, url, options);
          try {
            await wait(Math.max(0, timing.ms - timing.deliverMs), signals);
          } catch {
            const error = failure();
            settle(error.code + ':after-delivery');
            throw error;
          }
          settle('ok');
          return response;
        } catch (error) {
          entry.outcome ??= 'delegate-failed';
          entry.end ??= since(now());
          throw error;
        } finally {
          clearTimeout(timer);
          waiting--;
          pending--;
          finish();
        }
      },
    };
    clients.add(client);
    return client;
  };
  return Object.freeze({
    definition,
    arm() {
      assert.ok(active && !armed && armedAt === undefined);
      armed = true;
      armedAt = now();
    },
    disarm() {
      assert.ok(armed);
      armed = false;
      disarmedAt = now();
    },
    // The membership job's result reply, held until membershipMs after that
    // job started. A source revocation releases it early, and the genuine
    // membership broker then refuses as it would.
    async holdMembership(startedAt, signal) {
      if (!armed) return;
      const hold = {
        jobStarted: since(startedAt),
        resultAt: since(now()),
      };
      holds.push(hold);
      try {
        await wait(Math.max(0, startedAt + definition.membershipMs - now()), [signal]);
        hold.outcome = 'released';
      } catch {
        hold.outcome = 'source-revoked';
      }
      hold.releasedAt = since(now());
    },
    inventory: () => requests.map((entry) => ({ ...entry })),
    report: () => ({
      name,
      definition: JSON.parse(JSON.stringify(definition)),
      armed,
      armedAt,
      disarmedAt,
      pending,
      requests: requests.map((entry) => ({ ...entry })),
      membershipHolds: holds.map((hold) => ({ ...hold })),
      simulatedServiceLatency: true,
      simulatedMembershipDuration: true,
      syntheticChainAndServices: true,
      live: false,
      tor: false,
      circuitIsolation: 'not-applicable',
    }),
    async close() {
      if (!active) return;
      active = false;
      armed = false;
      for (const client of clients) client.close();
      await Promise.all([...clients].map((client) => client.closed));
      assert.equal(pending, 0);
      transport.createWalletTorTransport = originalTransport;
    },
  });
};
