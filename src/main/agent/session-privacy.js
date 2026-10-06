'use strict';

const MAX_ROUTES = 32;
const STATES = new Set(['pending', 'checked', 'advisory', 'failed', 'unavailable', 'unsupported']);
const CLAIMS = new Set(['private', 'tee', 'e2ee', 'anonymized', 'external', 'routing', 'standard']);
const ROLES = new Set(['agent', 'helper', 'permission']);
const bounded = value => typeof value === 'string' ? value.slice(0, 240) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const BINDING_COUNTS = ['attempts', 'pending', 'connections', 'gateway', 'model', 'failed', 'unavailable'];
const normalizeBinding = value => Object.fromEntries(BINDING_COUNTS.map(key => [key, count(value?.[key])]));

function normalizeHardware(value) {
  if (!value || !STATES.has(value.status)) return null;
  return {
    status: value.status,
    checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : null,
    verifier: value.verifier === 'dcap-qvl/0.6.5' ? value.verifier : null,
    reports: (Array.isArray(value.reports) ? value.reports : []).slice(0, 16).map(report => ({
      status: report.status === 'checked' ? 'checked' : 'advisory',
      tcb: ['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded',
        'OutOfDate', 'OutOfDateConfigurationNeeded', 'Revoked', 'Unknown'].includes(report.tcb) ? report.tcb : 'Unknown',
      advisories: (Array.isArray(report.advisories) ? report.advisories : [])
        .filter(id => typeof id === 'string' && /^INTEL-SA-\d{5}$/.test(id)).slice(0, 32),
      quoteHash: typeof report.quoteHash === 'string' && /^[a-f0-9]{64}$/.test(report.quoteHash) ? report.quoteHash : null,
    })),
  };
}

function safeOrigin(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.origin.slice(0, 300) : ''; }
  catch { return ''; }
}

function normalizePrivacy(value) {
  if (!value || value.version !== 1) return { version: 1, earlierUnknown: true, omittedRequests: 0, routes: [] };
  return { version: 1, earlierUnknown: value.earlierUnknown !== false,
    omittedRequests: count(value.omittedRequests),
    routes: (Array.isArray(value.routes) ? value.routes : []).slice(0, MAX_ROUTES).map(route => ({
      providerId: bounded(route.providerId), modelId: bounded(route.modelId), origin: safeOrigin(route.origin),
      role: ROLES.has(route.role) ? route.role : 'agent', requests: count(route.requests),
      claim: CLAIMS.has(route.claim) ? route.claim : 'unknown',
      hardware: normalizeHardware(route.hardware),
      binding: normalizeBinding(route.binding),
    })),
  };
}

// Endpoint evidence and per-request connection/signature counters have different
// scopes. Neither establishes approved software or GPU verification. Never turn
// these counters into a "verified conversation" flag.
class SessionPrivacy {
  constructor(previous, changed = () => {}) {
    this.summary = previous === undefined
      ? { version: 1, earlierUnknown: false, omittedRequests: 0, routes: [] }
      : normalizePrivacy(previous);
    for (const route of this.summary.routes) {
      if (route.hardware?.status === 'pending') route.hardware = { status: 'unavailable' };
      route.binding.unavailable += route.binding.pending;
      route.binding.pending = 0;
    }
    this.changed = changed;
    this.checks = new Map();
  }

  snapshot() { return normalizePrivacy(this.summary); }

  record(model, role, destination, descriptor = {}) {
    const entry = { providerId: bounded(descriptor.providerId || model?.provider), modelId: bounded(model?.id),
      origin: safeOrigin(destination), role: ROLES.has(role) ? role : 'agent',
      claim: CLAIMS.has(descriptor.claim) ? descriptor.claim : 'unknown' };
    let route = this.summary.routes.find(r => ['providerId', 'modelId', 'origin', 'role', 'claim'].every(k => r[k] === entry[k]));
    if (!route && this.summary.routes.length < MAX_ROUTES) {
      route = { ...entry, requests: 0, hardware: null };
      this.summary.routes.push(route);
    }
    if (route) route.requests += 1;
    else this.summary.omittedRequests += 1;
    this.changed(this.snapshot());
    return route;
  }

  check(route, check, signal) {
    if (!route || route.hardware || typeof check !== 'function' || signal?.aborted) return;
    const key = JSON.stringify([route.providerId, route.modelId]);
    let pending = this.checks.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => check(signal)).catch(() => ({ status: 'unavailable' }));
      this.checks.set(key, pending);
    }
    route.hardware = { status: 'pending' };
    this.changed(this.snapshot());
    void pending.then(result => {
      route.hardware = normalizeHardware(result) || { status: 'unavailable' };
      this.changed(this.snapshot());
    });
  }

  requestReporter(route) {
    if (!route) return () => {};
    route.binding = normalizeBinding(route.binding);
    route.binding.attempts += 1;
    route.binding.pending += 1;
    this.changed(this.snapshot());
    let finished = false;
    return result => {
      if (finished) return;
      if (result.hardware) {
        const incoming = normalizeHardware(result.hardware);
        // Preserve an earlier adverse result; later success cannot erase it.
        const severity = value => ({ failed: 3, advisory: 2 }[value?.status] || 0);
        if (severity(incoming) >= severity(route.hardware)) route.hardware = incoming;
      }
      if (result.response !== 'pending') {
        finished = true;
        route.binding.pending -= 1;
        if (result.connection === 'checked') route.binding.connections += 1;
        if (['gateway', 'model'].includes(result.response)) route.binding[result.response] += 1;
        else route.binding[result.response === 'failed' ? 'failed' : 'unavailable'] += 1;
        if (result.connection === 'failed' && result.response !== 'failed') route.binding.failed += 1;
      }
      this.changed(this.snapshot());
    };
  }
}

function withSessionPrivacy(runtime, ledger, role, getSignal = () => undefined) {
  if (!runtime) return runtime;
  const methods = new Map();
  return new Proxy(runtime, {
    get(target, property) {
      if (methods.has(property)) return methods.get(property);
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = ['stream', 'streamSimple', 'complete', 'completeSimple'].includes(property)
        ? (model, context, options = {}) => {
          const fetchImpl = options.fetch || globalThis.fetch;
          return value.call(target, model, context, { ...options, fetch: async (...args) => {
            const descriptor = target.privacyDescriptor?.(model) || {};
            const route = ledger.record(model, role, args[0]?.url || args[0], descriptor);
            if (descriptor.attestation === true && descriptor.providerId === 'near-ai' && target.fetchPrivacyRequest) {
              return target.fetchPrivacyRequest(model, args[0], args[1], {
                signal: getSignal(), report: ledger.requestReporter(route), fetchImpl,
              });
            }
            if (descriptor.attestation === true) ledger.check(route,
              signal => target.checkPrivacyAttestation(model, signal), getSignal());
            return fetchImpl(...args);
          } });
        } : value.bind(target);
      methods.set(property, method);
      return method;
    },
  });
}

module.exports = { SessionPrivacy, normalizePrivacy, normalizeHardware, withSessionPrivacy };
