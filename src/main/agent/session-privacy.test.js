'use strict';

const { SessionPrivacy, normalizePrivacy, withSessionPrivacy } = require('./session-privacy');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('tracks actual destinations and roles without retaining request contents or credentials', async () => {
  const ledger = new SessionPrivacy();
  const fetch = jest.fn(async () => ({ ok: true }));
  const runtime = { streamSimple: (_model, _context, options) => options.fetch('https://user:secret@cloud.test/infer?token=secret',
    { body: 'private prompt', headers: { Authorization: 'secret' } }) };
  for (const role of ['agent', 'helper', 'permission']) {
    await withSessionPrivacy(runtime, ledger, role).streamSimple({ provider: 'test', id: 'model' }, {}, { fetch });
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(ledger.snapshot().routes.map(r => [r.role, r.origin, r.requests])).toEqual([
    ['agent', 'https://cloud.test', 1], ['helper', 'https://cloud.test', 1], ['permission', 'https://cloud.test', 1],
  ]);
  expect(JSON.stringify(ledger.snapshot())).not.toMatch(/secret|prompt|Authorization/);
});

test('preserves mixed routes, failed attempts and earlier unknown history', async () => {
  const ledger = new SessionPrivacy(null);
  const runtime = { completeSimple: (_model, _context, options) => options.fetch('https://cloud.test') };
  const fetch = jest.fn().mockRejectedValue(new Error('connection failed'));
  await expect(withSessionPrivacy(runtime, ledger, 'permission').completeSimple({ id: 'a', provider: 'near-ai' }, {}, { fetch })).rejects.toThrow('connection failed');
  ledger.record({ id: 'b', provider: 'venice' }, 'helper', 'https://api.venice.ai');
  expect(ledger.snapshot().earlierUnknown).toBe(true);
  expect(ledger.snapshot().routes).toHaveLength(2);
  expect(ledger.snapshot().routes[0].requests).toBe(1);
});

test('hardware results remain endpoint evidence and never upgrade requests to verified inference', async () => {
  let finish;
  const check = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const ledger = new SessionPrivacy();
  const route = ledger.record({ provider: 'near-ai', id: 'qwen' }, 'agent', 'https://cloud-api.near.ai', { claim: 'tee' });
  ledger.check(route, check);
  await flush();
  expect(route.hardware.status).toBe('pending');
  finish({ status: 'advisory', checkedAt: 123, reports: [{ status: 'advisory', tcb: 'OutOfDate', advisories: ['INTEL-SA-01192', 'private text'] }] });
  await flush();
  expect(ledger.snapshot().routes[0].hardware.reports[0].advisories).toEqual(['INTEL-SA-01192']);
  expect(ledger.snapshot().routes[0].requests).toBe(1);
  expect(JSON.stringify(ledger.snapshot())).not.toContain('verified');
  const second = ledger.record({ provider: 'near-ai', id: 'qwen' }, 'helper', 'https://cloud-api.near.ai');
  ledger.check(second, check);
  await flush();
  expect(check).toHaveBeenCalledTimes(1);
  expect(second.hardware.status).toBe('advisory');
});

test('bounds persisted routes and evidence without silently losing coverage gaps', () => {
  const ledger = new SessionPrivacy();
  for (let i = 0; i < 100; i++) ledger.record({ id: String(i) }, 'agent', 'https://example.test');
  expect(ledger.snapshot().routes).toHaveLength(32);
  expect(ledger.snapshot().omittedRequests).toBe(68);
  expect(normalizePrivacy({ version: 2, earlierUnknown: false }).earlierUnknown).toBe(true);
  expect(normalizePrivacy({ version: 1, routes: [{ requests: -2, body: 'secret', hardware: { status: 'verified', secret: true } }] }).routes[0].hardware).toBeNull();
});

test('restores pending checks as unavailable and retains the historical check time', () => {
  const previous = { version: 1, earlierUnknown: false, routes: [{ hardware: { status: 'pending' } },
    { hardware: { status: 'checked', checkedAt: 123, verifier: 'dcap-qvl/0.6.5', reports: [] } }] };
  const ledger = new SessionPrivacy(previous);
  expect(ledger.snapshot().routes.map(r => r.hardware.status)).toEqual(['unavailable', 'checked']);
  expect(ledger.snapshot().routes[1].hardware.checkedAt).toBe(123);
});

test('forwards the original runtime receiver and does not break non-streaming methods', () => {
  const runtime = { name: 'private runtime', getModel() { return this.name; } };
  expect(withSessionPrivacy(runtime, new SessionPrivacy(), 'agent').getModel()).toBe('private runtime');
});

test('request receipts retain partial coverage across roles, restarts and later successes', () => {
  const ledger = new SessionPrivacy();
  const route = ledger.record({ id: 'qwen', provider: 'near-ai' }, 'agent', 'https://cloud-api.near.ai');
  const first = ledger.requestReporter(route);
  first({ connection: 'checked', response: 'unavailable' });
  first({ connection: 'checked', response: 'gateway' }); // A receipt finishes exactly once.
  ledger.record({ id: 'qwen', provider: 'near-ai' }, 'agent', 'https://cloud-api.near.ai');
  ledger.requestReporter(route)({ connection: 'checked', response: 'gateway',
    hardware: { status: 'checked', reports: [{ signingAddress: 'private-to-main', tlsFingerprint: 'internal', tcb: 'UpToDate' }] } });
  const pending = ledger.record({ id: 'qwen', provider: 'near-ai' }, 'helper', 'https://cloud-api.near.ai');
  ledger.requestReporter(pending);
  const saved = ledger.snapshot();
  expect(saved.routes[0].binding).toEqual({ attempts: 2, pending: 0, connections: 2, gateway: 1, model: 0, failed: 0, unavailable: 1 });
  expect(JSON.stringify(saved)).not.toMatch(/private-to-main|internal/);
  const restored = new SessionPrivacy(saved).snapshot();
  expect(restored.routes[1].binding.pending).toBe(0);
  expect(restored.routes[1].binding.unavailable).toBe(1);
  expect(restored.routes[0].binding.gateway).toBe(1);
});

test('request-bound transport covers main, helper and permission runtimes at the actual fetch boundary', async () => {
  const ledger = new SessionPrivacy();
  const runtime = {
    privacyDescriptor: () => ({ providerId: 'near-ai', attestation: true }),
    completeSimple: (_model, _context, opts) => opts.fetch('https://cloud-api.near.ai/v1/chat/completions', { method: 'POST' }),
    fetchPrivacyRequest: jest.fn(async (_model, _input, _options, tracking) => {
      tracking.report({ connection: 'checked', response: 'gateway' }); return 'done';
    }),
  };
  for (const role of ['agent', 'helper', 'permission']) {
    expect(await withSessionPrivacy(runtime, ledger, role).completeSimple({ id: 'qwen' }, {})).toBe('done');
  }
  expect(runtime.fetchPrivacyRequest).toHaveBeenCalledTimes(3);
  expect(ledger.snapshot().routes.map(r => [r.role, r.binding.gateway])).toEqual([
    ['agent', 1], ['helper', 1], ['permission', 1],
  ]);
});
