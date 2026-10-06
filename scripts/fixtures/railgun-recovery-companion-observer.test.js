/** Mock-controller instrumentation controls, not native authority evidence. */
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const source = fs.readFileSync(
  path.join(__dirname, 'railgun-recovery-companion-observer.js'),
  'utf8'
);
function setup({ cache = false, exited = true, early = false } = {}) {
  const result = {
    observation: { utilityExitObserved: exited },
    process: { code: 'RAILGUN_PROCESS_CLOSED' },
  };
  const proof = { verifyRailgunPrivateProof: async () => result };
  const controller = {},
    submission = {
      submitRailgunRecoveredPrivateTransaction: () => Promise.resolve({ hash: 'same' }),
    };
  const req = (name) => {
    if (name === './railgun-native-assertions') return { assert: require('assert/strict') };
    if (name.endsWith('railgun-private-proof')) return proof;
    if (name.endsWith('railgun-private-proof-recovery')) {
      const verify = proof.verifyRailgunPrivateProof;
      controller.resumeRailgunAccountPrivateProof = early
        ? () => Promise.resolve(result)
        : (options) => verify(options);
      return controller;
    }
    if (name.endsWith('railgun-private-submission')) return submission;
    throw Error(name);
  };
  req.resolve = (name) => name;
  req.cache = cache ? { '../../src/main/wallet/railgun-private-proof-recovery': {} } : {};
  const context = { module: { exports: {} }, require: req, AbortSignal, Promise, performance };
  vm.runInNewContext(source, context);
  return { install: context.module.exports.install, proof, controller, result };
}
test('requires uncached original controller before installing', () => {
  expect(() => setup({ cache: true }).install({ hold: true })).toThrow();
});
test('holds exactly one genuine result and preserves original controller promise/settlement identity', async () => {
  const s = setup(),
    observer = s.install({ hold: true });
  const outer = new AbortController(),
    verifier = new AbortController(),
    store = new AbortController();
  const pending = s.controller.resumeRailgunAccountPrivateProof({ signal: verifier.signal });
  expect(observer.entry(0).promise).toBe(pending);
  try {
    await observer.reached;
    expect(observer.entry(0).settled).toBe(false);
    outer.abort();
    verifier.abort();
    expect(
      observer.pendingAtClose(outer.signal, { signal: store.signal }, { signal: store.signal })
    ).toMatchObject({ sourceDerivedCancellationCause: true, directPhaseSignalObserved: false });
    observer.release();
    expect(await pending).toBe(s.result);
    expect(observer.entry(0).value).toBe(s.result);
    const next = s.controller.resumeRailgunAccountPrivateProof({
      signal: new AbortController().signal,
    });
    expect(await next).toBe(s.result);
    expect(observer.report()).toEqual({ heldResults: 1, originalCalls: 2, originalSettlements: 2 });
  } finally {
    observer.close();
  }
});
test.each([
  'companion-live',
  'verifier-live',
  'stores-aborted',
  'early-release',
  'late-hold',
  'late-admission',
])('rejects broken causal or pending evidence: %s', async (mutation) => {
  const s = setup(),
    observer = s.install({ hold: true });
  const outer = new AbortController(),
    verifier = new AbortController(),
    store = new AbortController();
  const pending = s.controller.resumeRailgunAccountPrivateProof({ signal: verifier.signal });
  const clock = jest.spyOn(performance, 'now');
  try {
    await observer.reached;
    if (mutation !== 'companion-live') outer.abort();
    if (mutation !== 'verifier-live') verifier.abort();
    if (mutation === 'stores-aborted') store.abort();
    if (mutation === 'early-release') {
      observer.release();
      await pending;
    }
    if (mutation === 'late-hold') clock.mockReturnValue(performance.now() + 6000);
    if (mutation === 'late-admission') observer.entry(0).admitted -= 120001;
    expect(() =>
      observer.pendingAtClose(outer.signal, { signal: store.signal }, { signal: store.signal })
    ).toThrow();
  } finally {
    clock.mockRestore();
    observer.close();
    await pending;
  }
});
test('rejects missing actual verifier-exit observation', async () => {
  const s = setup({ exited: false }),
    observer = s.install({ hold: true });
  try {
    await expect(
      s.controller.resumeRailgunAccountPrivateProof({ signal: new AbortController().signal })
    ).rejects.toThrow();
  } finally {
    observer.close();
  }
});
test('cleanup releases a pending result and restores original verifier', async () => {
  const s = setup(),
    original = s.proof.verifyRailgunPrivateProof,
    observer = s.install({ hold: true });
  const pending = s.controller.resumeRailgunAccountPrivateProof({
    signal: new AbortController().signal,
  });
  await observer.reached;
  observer.close();
  observer.close();
  expect(await pending).toBe(s.result);
  expect(s.proof.verifyRailgunPrivateProof).toBe(original);
});
