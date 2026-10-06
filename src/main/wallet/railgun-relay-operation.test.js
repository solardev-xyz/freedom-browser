// Genuine account/enrollment/source/identity issuers and durable storage are
// explicit structural seams. Canonical ABI, intent, history, binding and record
// normalizers are real. No engine, credential, database or service is opened.
const mock = {};
jest.mock(
  './railgun-account-wallet',
  () =>
    new Proxy(
      {},
      {
        get:
          (_t, key) =>
          (...args) =>
            mock.wallet[key](...args),
      }
    )
);
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment: (...args) => mock.fence(...args),
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (...args) => mock.identity(...args),
  assertRailgunRelaySigner: (...args) => mock.signer(...args),
  assertRailgunRelayCredentialIssuance: (...args) => mock.issuing(...args),
  signRailgunRelayIntent: (...args) => mock.sign(...args),
}));
jest.mock(
  './railgun-account-poi',
  () =>
    new Proxy(
      {},
      {
        get:
          (_t, key) =>
          (...args) =>
            mock.poi[key](...args),
      }
    )
);
jest.mock('./railgun-private-preflight', () => ({
  createRailgunRelayPreflight: (...args) => mock.preflight(...args),
  assertRailgunRelayPreflight: (...args) => mock.preflightAssert(...args),
}));
jest.mock('./railgun-relay-signature-verify', () => ({
  verifyRailgunRelaySignature: (...args) => mock.verify(...args),
}));
jest.mock('./railgun-relay-transact-staging', () => ({
  assertRailgunRelayTransactStagingAvailable: (...args) => mock.available(...args),
}));
jest.mock('./railgun-relay-transact-provenance', () => ({
  openRailgunRelayTransactProvenance: (...args) => mock.openProvenance(...args),
  assertRailgunRelayTransactProvenanceOperation: (...args) => mock.provenanceOperation(...args),
  assertRailgunRelayTransactProvenance: (...args) => mock.provenanceResult(...args),
}));
const api = require('./railgun-relay-operation');
const { createHash } = require('crypto');
const {
  createRailgunRelayMainProofData,
} = require('../../../scripts/fixtures/railgun-relay-main-proof-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const {
  decodeRailgunRelayLocalRecord,
  digestRailgunRelayLocalIntent,
} = require('./railgun-relay-recovery-data');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const unknown = () => Object.assign(Error('unknown'), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
let f;
function setup(type = 'Shield') {
  const original = createRailgunRelayMainProofData().record;
  original.history.note.type = type;
  original.history.event.signedPOIEvent.type = type;
  const draft = normalizeRailgunRelayDraftCapsule(original.draft),
    intent = normalizeRailgunRelayUnsignedIntent(draft.data.intent),
    history = normalizeRailgunRelayPoiHistory(original.history);
  const controller = new AbortController(),
    closed = deferred(),
    window = Object.freeze({}),
    signer = Object.freeze({});
  const events = [];
  const selected = {
    id: `${draft.data.selection.tree}:${draft.data.selection.position}`,
    type,
    hash: draft.data.noteHash,
    nullifier: intent.data.expected.nullifier,
    blindedCommitment: history.data.note.blindedCommitment,
  };
  const baseline = {
    ownedPoi: [selected],
    checkpointHash: original.checkpointHash,
    read: { readiness: { to: { number: 30 } } },
  };
  let row,
    local = false,
    issuing = false,
    fenced = true;
  const descriptor = { walletId: original.walletId };
  const account = { signal: controller.signal, generationId: original.generationId };
  const enrollment = {
    signal: controller.signal,
    binding: original.binding,
    getContext: jest.fn(() => 'handle'),
  };
  const owners = {
    identity: { signal: controller.signal },
    enrollment,
    coordinator: { signal: controller.signal },
  };
  const data = {
    signal: controller.signal,
    deadline: performance.now() + 180000,
    started: performance.now(),
    owned: baseline,
    selection: draft.data.selection,
    draftDigest: draft.digest,
    summaryDigest: '12'.repeat(32),
    checkpointHash: original.checkpointHash,
  };
  const check = () => {
    if (!fenced || controller.signal.aborted) throw Error('revoked');
  };
  const pair = () => {
    const record = decodeRailgunRelayLocalRecord(JSON.stringify(row));
    const recordDigest = digestRailgunRelayLocalIntent(JSON.stringify(record));
    return {
      receipt: {},
      record,
      recordDigest,
      interruptedStep: null,
      entry: {
        state: record.state === 'held' ? 'held' : 'signing-local',
        signing:
          record.state === 'held'
            ? null
            : { recordDigest, gatesDigest: record.authorizationDigest },
      },
    };
  };
  const reservations = {
    reserveRelay: jest.fn(async (store, text) => {
      events.push('reserve');
      expect(store).toBe(recoveryStore);
      row = decodeRailgunRelayLocalRecord(text);
      return pair();
    }),
    markRelaySigning: jest.fn(async () => {
      events.push('marker');
      row = { ...row, state: 'signing-local' };
      return pair();
    }),
    readRelay: jest.fn(async () => {
      events.push('pair');
      return pair();
    }),
  };
  const recoveryStore = {
    saveSignature: jest.fn(async (id, signature) => {
      events.push('save-signature');
      expect(id).toBe(row.id);
      row = { ...row, state: 'signed', signature };
      return row;
    }),
  };
  enrollment.openReservations = jest.fn(async () => reservations);
  enrollment.openRelayRecoveryStore = jest.fn(async () => recoveryStore);
  mock.fence = jest.fn((v) => {
    expect(v).toBe(enrollment);
    check();
  });
  mock.identity = jest.fn((v, h) => {
    expect(v).toBe(owners.identity);
    expect(h).toBe('handle');
    check();
    return descriptor;
  });
  mock.signer = jest.fn((token, id, binding) => {
    expect(token).toBe(signer);
    expect(id).toBe(owners.identity);
    expect(binding.recordDigest).toBe(digestRailgunRelayLocalIntent(JSON.stringify(row)));
    check();
  });
  mock.issuing = jest.fn((...args) => {
    mock.signer(...args);
    expect(issuing).toBe(true);
  });
  const poiValue = {
    input: { ...selected, noteHash: selected.hash, checkpointHash: original.checkpointHash },
    listKey: history.data.listKey,
  };
  const source = {
    closed: closed.promise,
    close: jest.fn(() => {
      events.push('poi-close');
      closed.resolve();
    }),
    acquire: jest.fn(async () => {
      events.push('membership');
      return { status: 'verified', receipt: {} };
    }),
  };
  mock.poi = {
    openRailgunRelayWindowPoi: jest.fn((v) => {
      events.push('open-poi');
      api.consumeRailgunRelayDisclosurePermit(v.disclosure, account, owners, window);
      return source;
    }),
    assertRailgunRelayWindowPoi: jest.fn(() => {
      check();
      if (local) throw Error('fresh after issuance');
      return poiValue;
    }),
    readRailgunRelayWindowPoiHistory: jest.fn(() => history),
  };
  let preflightValue;
  const preflight = {
    close: jest.fn(),
    acquire: jest.fn(async () => {
      events.push('preflight');
      return { receipt: {} };
    }),
  };
  mock.preflight = jest.fn((v) => {
    preflightValue = { input: v.input };
    return preflight;
  });
  mock.preflightAssert = jest.fn(() => {
    check();
    if (local) throw Error('fresh after issuance');
    return preflightValue;
  });
  const localAssert = jest.fn(() => {
    expect(local).toBe(true);
    check();
  });
  mock.wallet = {
    readRailgunAccountOwnedNotes: jest.fn(() => baseline),
    assertRailgunAccountRelayWindow: jest.fn((_window, _account, _owners, margin = 0) => {
      expect(margin).toBeLessThan(120000);
      check();
      if (local) throw Error('prekey window unavailable');
      return data;
    }),
    retainRailgunRelayWindowPoi: jest.fn(),
    prepareRailgunAccountRelayPrePoi: jest.fn(async () => {
      events.push('binding');
      return {
        binding: original.prePoiBinding,
        historyDigest: history.digest,
        draftDigest: draft.digest,
        expectedHash: intent.data.expectedHash,
      };
    }),
    recordRailgunAccountRelayCredentialIssuance: jest.fn((w, a, o, s, p) => {
      api.consumeRailgunRelayIssuancePermit(p, a, o, w, s);
      local = true;
      events.push('issued');
      return Object.freeze({ assertCurrent: localAssert });
    }),
    completeRailgunAccountRelayProof: jest.fn(async (a, o, { window: w, permit }) => {
      events.push('proof');
      f.proofPermit = permit;
      const value = api.consumeRailgunRelayProofPermit(permit, a, o, w);
      expect(value.recordText).toBe(JSON.stringify(row));
      value.assertCurrent();
      f.proofCurrent = value.assertCurrent;
      return { status: 'proof-staged', operationId: row.id };
    }),
    operateRailgunAccountRelayIntent: jest.fn(async (a, o, r, { review, onPrepared }) => {
      events.push('review');
      expect(await review({ summary: 'account-owned' })).toBe(true);
      await onPrepared(
        { preparation: draft, reconstruction: {}, review: { summaryDigest: data.summaryDigest } },
        { window, signal: controller.signal }
      );
      events.push('refresh');
      f.proofCurrent?.();
      return { status: 'ready-local', operationId: row.id };
    }),
  };
  mock.sign = jest.fn(async (opts) => {
    events.push('signer-start');
    f.signOptions = opts;
    const validated = {
      recordDigest: opts.recordDigest,
      intentDigest: intent.digest,
      expectedHash: intent.data.expectedHash,
    };
    const permit = await opts.onKeyRequest(validated, signer);
    f.signPermit = permit;
    const gate = api.consumeRailgunRelaySigningPermit(permit, owners.identity, signer);
    await gate.assertCurrent();
    events.push('key-derive');
    await gate.assertCurrent();
    issuing = true;
    try {
      expect(gate.issued()).toBeUndefined();
    } finally {
      issuing = false;
    }
    events.push('signer-closed');
    return {
      signature: original.signature,
      message: intent.data.expectedHash,
      recordDigest: opts.recordDigest,
      intentDigest: intent.digest,
    };
  });
  mock.verify = jest.fn(async (opts) => {
    events.push('signature-c-closed');
    return {
      recordDigest: opts.recordDigest,
      intentDigest: intent.digest,
      message: intent.data.expectedHash,
      signatureDigest: createHash('sha256').update(JSON.stringify(opts.signature)).digest('hex'),
      signatureVerified: true,
    };
  });
  const options = {
    account,
    owners,
    request: {
      noteId: selected.id,
      quote: intent.data.context.quote,
      gas: intent.data.context.gas,
      maxFee: intent.data.context.feeCap,
      signal: controller.signal,
    },
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    review: jest.fn(async () => true),
    reviewDisclosure: jest.fn(async () => {
      events.push('disclosure');
      return true;
    }),
  };
  return {
    options,
    events,
    controller,
    closed,
    source,
    preflight,
    reservations,
    recoveryStore,
    window,
    signer,
    data,
    draft,
    intent,
    history,
    original,
    selected,
    localAssert,
    get row() {
      return row;
    },
    set row(v) {
      row = v;
    },
    revoke() {
      fenced = false;
    },
  };
}
beforeEach(() => {
  f = setup();
});
afterEach(() => {
  f.controller.abort();
  f.closed.resolve();
  jest.restoreAllMocks();
});
const run = () => api.proveRailgunAccountRelayOperation(f.options);
test('fresh Shield path orders exact durable signing, original B/C, signature save and account proof/refresh', async () => {
  const value = await run();
  expect(value).toEqual({ status: 'ready-local', operationId: f.row.id });
  expect(f.row.state).toBe('signed');
  const important = f.events.filter((x) => !['pair', 'poi-close'].includes(x));
  expect(important).toEqual([
    'review',
    'disclosure',
    'open-poi',
    'membership',
    'binding',
    'preflight',
    'reserve',
    'marker',
    'signer-start',
    'key-derive',
    'issued',
    'signer-closed',
    'signature-c-closed',
    'save-signature',
    'proof',
    'refresh',
  ]);
  expect(f.localAssert).toHaveBeenCalled();
  expect(Object.keys(value)).toEqual(['status', 'operationId']);
});
test.each(['Transact', 'Unknown'])(
  'rejects %s input before account review/disclosure',
  async (type) => {
    f.selected.type = type;
    expect(await run()).toMatchObject({ status: 'refused' });
    expect(mock.wallet.operateRailgunAccountRelayIntent).not.toHaveBeenCalled();
    expect(mock.sign).not.toHaveBeenCalled();
  }
);
test('explicit disclosure false prevents POI, nullifier and storage work', async () => {
  f.options.reviewDisclosure.mockResolvedValue(false);
  expect(await run()).toMatchObject({ status: 'refused', stage: 'disclosure' });
  expect(mock.poi.openRailgunRelayWindowPoi).not.toHaveBeenCalled();
  expect(mock.preflight).not.toHaveBeenCalled();
  expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
});
test.each(['disclosure', 'signing', 'issuance', 'proof'])(
  'forged %s token cannot grant authority',
  (kind) => {
    const names = {
      disclosure: 'consumeRailgunRelayDisclosurePermit',
      signing: 'consumeRailgunRelaySigningPermit',
      issuance: 'consumeRailgunRelayIssuancePermit',
      proof: 'consumeRailgunRelayProofPermit',
    };
    expect(() =>
      api[names[kind]]({}, f.options.account, f.options.owners, f.window, f.signer)
    ).toThrow();
  }
);
test('consumed signing and proof tokens cannot replay or cross domains after completion', async () => {
  expect((await run()).status).toBe('ready-local');
  expect(() =>
    api.consumeRailgunRelaySigningPermit(f.signPermit, f.options.owners.identity, f.signer)
  ).toThrow();
  expect(() =>
    api.consumeRailgunRelayProofPermit(f.proofPermit, f.options.account, f.options.owners, f.window)
  ).toThrow();
  expect(() =>
    api.consumeRailgunRelayDisclosurePermit(
      f.signPermit,
      f.options.account,
      f.options.owners,
      f.window
    )
  ).toThrow();
});
test('cold permit path refuses explicitly', () => {
  expect(() =>
    api.consumeRailgunRelayProofPermit({}, f.options.account, f.options.owners)
  ).toThrow();
});
test('remaining budget refuses before holds and key admission', async () => {
  f.data.deadline = performance.now() + 99999;
  expect(await run()).toMatchObject({ status: 'refused' });
  expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
  expect(mock.sign).not.toHaveBeenCalled();
});
test('postissuance signature verifier timeout retains signing marker without save or new key', async () => {
  mock.verify.mockRejectedValue(Error('timeout'));
  const value = await run();
  expect(value).toMatchObject({
    status: 'recovery-required',
    signingAttempted: true,
    signatureSaved: false,
  });
  expect(f.row.state).toBe('signing-local');
  expect(f.recoveryStore.saveSignature).not.toHaveBeenCalled();
  expect(mock.sign).toHaveBeenCalledTimes(1);
});
test.each(['recordDigest', 'intentDigest', 'message', 'signatureDigest', 'signatureVerified'])(
  'independent signature C mismatched %s cannot reach persistence',
  async (key) => {
    const real = mock.verify.getMockImplementation();
    mock.verify.mockImplementation(async (opts) => ({
      ...(await real(opts)),
      [key]: key === 'signatureVerified' ? false : '00'.repeat(32),
    }));
    expect(await run()).toMatchObject({ status: 'recovery-required', signatureSaved: false });
    expect(f.recoveryStore.saveSignature).not.toHaveBeenCalled();
  }
);
test.each(['reserve', 'marker', 'save-signature'])(
  'ambiguous %s write never compensates, retries or grants next step',
  async (step) => {
    const [object, key] =
      step === 'reserve'
        ? [f.reservations, 'reserveRelay']
        : step === 'marker'
          ? [f.reservations, 'markRelaySigning']
          : [f.recoveryStore, 'saveSignature'];
    const real = object[key].getMockImplementation();
    object[key].mockImplementation(async (...args) => {
      await real(...args);
      throw Error('postwrite');
    });
    expect(await run()).toMatchObject({ status: 'recovery-required' });
    expect(object[key]).toHaveBeenCalledTimes(1);
    expect(mock.wallet.completeRailgunAccountRelayProof).not.toHaveBeenCalled();
    if (step !== 'save-signature') expect(mock.sign).not.toHaveBeenCalled();
  }
);
test('revocation after C and before original signature save refuses', async () => {
  const real = mock.verify.getMockImplementation();
  mock.verify.mockImplementation(async (opts) => {
    const v = await real(opts);
    f.revoke();
    return v;
  });
  expect(await run()).toMatchObject({ status: 'recovery-required' });
  expect(f.recoveryStore.saveSignature).not.toHaveBeenCalled();
});
test('held disclosure original survives abort and prevents concurrent owner', async () => {
  const hold = deferred();
  f.options.reviewDisclosure.mockReturnValue(hold.promise);
  const work = run();
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  expect(mock.sign).not.toHaveBeenCalled();
  expect(await run()).toMatchObject({ status: 'refused' });
  f.controller.abort();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  hold.resolve(true);
  expect(await work).toMatchObject({ status: 'refused' });
  expect(mock.poi.openRailgunRelayWindowPoi).not.toHaveBeenCalled();
});
test('unknown original signer exit retains controller exclusion after account refusal', async () => {
  mock.sign.mockRejectedValue(unknown());
  await expect(run()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(await run()).toMatchObject({ status: 'refused' });
  expect(mock.sign).toHaveBeenCalledTimes(1);
});
test('POI close drains original before result and admission release', async () => {
  f.source.close.mockImplementation(() => {});
  const work = run();
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  expect(await run()).toMatchObject({ status: 'refused' });
  f.closed.resolve();
  expect((await work).status).toBe('ready-local');
});

test('caller options and nested quote/gas are detached before first account await', async () => {
  const entered = deferred(),
    hold = deferred();
  const real = mock.wallet.operateRailgunAccountRelayIntent.getMockImplementation();
  let captured;
  mock.wallet.operateRailgunAccountRelayIntent.mockImplementation(async (a, o, r, op) => {
    captured = r;
    entered.resolve();
    await hold.promise;
    return real(a, o, r, op);
  });
  const quoteData = f.options.request.quote.data,
    gasPrice = f.options.request.gas.gasPrice;
  const work = run();
  await entered.promise;
  f.options.request.quote = { data: '00', signature: '00' };
  f.options.request.gas = { ...f.options.request.gas, gasPrice: '999' };
  f.options.request.noteId = 'alien';
  f.options.archive = '/other';
  f.options.owners = {};
  expect(captured.quote.data).toBe(quoteData);
  expect(captured.gas.gasPrice).toBe(gasPrice);
  expect(Object.isFrozen(captured.quote)).toBe(true);
  hold.resolve();
  expect((await work).status).toBe('ready-local');
  expect(f.signOptions.archive).toBe('/engine.asar');
});
test.each(['accessor', 'proxy', 'extra'])(
  'descriptor-only options refuse %s without callback',
  (mode) => {
    let calls = 0;
    if (mode === 'accessor')
      Object.defineProperty(f.options, 'archive', {
        get() {
          calls++;
          return '/engine';
        },
      });
    if (mode === 'proxy')
      f.options = new Proxy(f.options, {
        get() {
          calls++;
          throw Error('trap');
        },
      });
    if (mode === 'extra') f.options.authority = true;
    return run().then((value) => {
      expect(value.status).toBe('refused');
      expect(calls).toBe(0);
      expect(mock.wallet.operateRailgunAccountRelayIntent).not.toHaveBeenCalled();
    });
  }
);
test.each(['identity', 'enrollment', 'coordinator', 'window', 'signer'])(
  'signing/issuance permits reject wrong %s binding before key',
  async (field) => {
    const actual = mock.sign.getMockImplementation();
    mock.sign.mockImplementation(async (opts) => {
      const onKeyRequest = opts.onKeyRequest;
      return actual({
        ...opts,
        onKeyRequest: async (...args) => {
          const token = await onKeyRequest(...args);
          if (field === 'identity' || field === 'signer')
            expect(() =>
              api.consumeRailgunRelaySigningPermit(
                token,
                field === 'identity' ? {} : f.options.owners.identity,
                field === 'signer' ? {} : f.signer
              )
            ).toThrow();
          else
            expect(() =>
              api.consumeRailgunRelayDisclosurePermit(
                token,
                f.options.account,
                { ...f.options.owners, [field]: {} },
                f.window
              )
            ).toThrow();
          return token;
        },
      });
    });
    expect((await run()).status).toBe('ready-local');
  }
);
test.each(['recordDigest', 'gatesDigest', 'state', 'interrupted'])(
  'reauthenticated paired %s mismatch never reaches spending key',
  async (mode) => {
    const real = f.reservations.readRelay.getMockImplementation();
    f.reservations.readRelay.mockImplementation(async () => {
      const value = await real();
      if (mode === 'recordDigest') return { ...value, recordDigest: '00'.repeat(32) };
      if (mode === 'gatesDigest')
        return {
          ...value,
          entry: {
            ...value.entry,
            signing: { ...value.entry.signing, gatesDigest: '00'.repeat(32) },
          },
        };
      if (mode === 'state') return { ...value, record: { ...value.record, state: 'signed' } };
      return { ...value, interruptedStep: 'mark-recovery-signing' };
    });
    expect(await run()).toMatchObject({ status: 'recovery-required' });
    expect(mock.sign).not.toHaveBeenCalled();
    expect(f.events).not.toContain('key-derive');
  }
);
test('selected current POI mismatch refuses before binding/hold', async () => {
  const real = mock.poi.assertRailgunRelayWindowPoi.getMockImplementation();
  mock.poi.assertRailgunRelayWindowPoi.mockImplementation(() => {
    const v = real();
    return { ...v, input: { ...v.input, nullifier: '0x' + '01'.repeat(32) } };
  });
  expect((await run()).status).toBe('refused');
  expect(mock.wallet.prepareRailgunAccountRelayPrePoi).not.toHaveBeenCalled();
  expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
});
test('budget exhaustion after membership is refused before creating durable hold', async () => {
  const real = f.source.acquire.getMockImplementation();
  f.source.acquire.mockImplementation(async (...args) => {
    const v = await real(...args);
    f.data.deadline = performance.now() + 80000;
    return v;
  });
  expect((await run()).status).toBe('refused');
  expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
  expect(mock.sign).not.toHaveBeenCalled();
});
test('original signature verifier held across abort is drained before return, without saving', async () => {
  const hold = deferred(),
    entered = deferred();
  const real = mock.verify.getMockImplementation();
  mock.verify.mockImplementation(async (opts) => {
    entered.resolve();
    await hold.promise;
    return real(opts);
  });
  const work = run();
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await entered.promise;
  f.controller.abort();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  expect(f.recoveryStore.saveSignature).not.toHaveBeenCalled();
  hold.resolve();
  expect(await work).toMatchObject({ status: 'recovery-required', signatureSaved: false });
});
test('rejected original POI drain retains exclusion even after successful proof staging', async () => {
  f.source.close.mockImplementation(() => f.closed.reject(Error('unobserved drain')));
  await expect(run()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(await run()).toMatchObject({ status: 'refused' });
  expect(mock.sign).toHaveBeenCalledTimes(1);
});
test('caller thenable disclosure is never invoked and unknown work quarantines', async () => {
  const then = jest.fn();
  f.options.reviewDisclosure.mockReturnValue({ then });
  await expect(run()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(then).not.toHaveBeenCalled();
  expect(await run()).toMatchObject({ status: 'refused' });
});
test('callback native species return cannot complete original disclosure early', async () => {
  const hold = deferred(),
    then = jest.fn((resolve) => resolve(true));
  function Species(executor) {
    executor(
      () => {},
      () => {}
    );
    return { then };
  }
  Object.defineProperty(hold.promise, 'constructor', { value: { [Symbol.species]: Species } });
  f.options.reviewDisclosure.mockReturnValue(hold.promise);
  const work = run();
  await new Promise(setImmediate);
  expect(mock.poi.openRailgunRelayWindowPoi).not.toHaveBeenCalled();
  expect(then).not.toHaveBeenCalled();
  hold.resolve(true);
  expect((await work).status).toBe('ready-local');
  expect(then).not.toHaveBeenCalled();
});

test.each(['identity', 'enrollment', 'coordinator', 'account', 'window'])(
  'actual disclosure capability refuses wrong %s without burning matching owner',
  async (field) => {
    const real = mock.poi.openRailgunRelayWindowPoi.getMockImplementation();
    mock.poi.openRailgunRelayWindowPoi.mockImplementation((v) => {
      const owners = { ...f.options.owners };
      if (['identity', 'enrollment', 'coordinator'].includes(field)) owners[field] = {};
      expect(() =>
        api.consumeRailgunRelayDisclosurePermit(
          v.disclosure,
          field === 'account' ? {} : f.options.account,
          owners,
          field === 'window' ? {} : f.window
        )
      ).toThrow();
      return real(v);
    });
    expect((await run()).status).toBe('ready-local');
  }
);
test('proof capability refuses different window and stays usable only by exact local owner', async () => {
  const real = mock.wallet.completeRailgunAccountRelayProof.getMockImplementation();
  mock.wallet.completeRailgunAccountRelayProof.mockImplementation(async (a, o, input) => {
    expect(() => api.consumeRailgunRelayProofPermit(input.permit, a, o, {})).toThrow();
    return real(a, o, input);
  });
  expect((await run()).status).toBe('ready-local');
});
test('disclosure deadline aborts but waits original callback before refusal', async () => {
  const hold = deferred(),
    entered = deferred();
  let timeout;
  const real = global.setTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (ms <= 30000) {
      timeout = callback;
      return { unref() {} };
    }
    return real(callback, ms, ...args);
  });
  f.options.reviewDisclosure.mockImplementation((_summary, { signal }) => {
    f.callbackSignal = signal;
    entered.resolve();
    return hold.promise;
  });
  const work = run();
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await entered.promise;
  timeout();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  hold.resolve(true);
  expect((await work).status).toBe('refused');
  expect(mock.poi.openRailgunRelayWindowPoi).not.toHaveBeenCalled();
});
test('post-save proof timing refusal retains the exact original signature without retry', async () => {
  mock.wallet.completeRailgunAccountRelayProof.mockRejectedValue(Error('insufficient remaining'));
  expect(await run()).toMatchObject({ status: 'recovery-required', signatureSaved: true });
  expect(f.row.state).toBe('signed');
  expect(f.row.signature).toEqual(f.original.signature);
  expect(mock.sign).toHaveBeenCalledTimes(1);
  expect(f.recoveryStore.saveSignature).toHaveBeenCalledTimes(1);
});

// Real paired-ledger originals use this sentinel when a floor/work observation
// cannot be established. Never translate it to a reusable operation refusal.
test.each(['reserveRelay', 'markRelaySigning', 'readRelay'])(
  'unknown original custody %s retains controller exclusion',
  async (method) => {
    f.reservations[method].mockRejectedValue(
      Object.assign(Error('unobserved floor'), {
        code: 'RAILGUN_RESERVATIONS_DRAIN_UNOBSERVED',
      })
    );
    await expect(run()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
    expect(await run()).toMatchObject({ status: 'refused' });
    expect(f.reservations[method]).toHaveBeenCalledTimes(1);
    expect(mock.sign).not.toHaveBeenCalled();
  }
);

// Transact staging/provenance issuers below are explicit structural seams.
// A's separate suites exercise actual creator parsing and root-source lifetime.
function transact() {
  f = setup('Transact');
  const stageScope = new AbortController(),
    rootScope = new AbortController();
  const stagingReceipt = Object.freeze({}),
    rootReceipt = Object.freeze({});
  const binding = Object.freeze({
    stagingReceipt,
    draftDigest: f.draft.digest,
    summaryDigest: f.data.summaryDigest,
    checkpointHash: f.data.checkpointHash,
    creatorEvidenceSha256: '23'.repeat(32),
    witnessInputSha256: '34'.repeat(32),
    point: Object.freeze({ index: 7, root: '45'.repeat(32) }),
  });
  const observation = Object.freeze({
    creatorEvidenceSha256: binding.creatorEvidenceSha256,
    witnessInputSha256: binding.witnessInputSha256,
    root: binding.point,
    pathVerified: true,
    creatorSourceAuthenticated: true,
    boundParamsChecked: false,
    globalTxidCompleteness: false,
    spendingEnabled: false,
  });
  let stale = false;
  const prekey = () => {
    expect(f.localAssert).not.toHaveBeenCalled();
    if (stale || stageScope.signal.aborted || rootScope.signal.aborted)
      throw Error('stale provenance');
  };
  const operation = {
    signal: rootScope.signal,
    close: jest.fn(async () => {
      f.events.push('root-close');
      rootScope.abort();
    }),
    acquireRoot: jest.fn(async ({ permit, timeoutMs }) => {
      f.rootPermit = permit;
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(20000);
      api.consumeRailgunRelayRootDisclosurePermit(
        permit,
        operation,
        f.options.account,
        f.options.owners,
        f.window
      );
      f.events.push('root-query');
      return { receipt: rootReceipt, observation };
    }),
  };
  f.options.stagingReceipt = stagingReceipt;
  f.options.reviewRootDisclosure = jest.fn(async () => {
    f.events.push('root-consent');
    return true;
  });
  mock.available = jest.fn((receipt, a, o, r) => {
    expect(receipt).toBe(stagingReceipt);
    expect(a).toBe(f.options.account);
    expect(o).toEqual(f.options.owners);
    expect(r.signal).toBe(f.options.request.signal);
    expect(r).toEqual(f.options.request);
    prekey();
    return { evidence: {}, signal: stageScope.signal };
  });
  mock.openProvenance = jest.fn((v) => {
    expect(v.stagingReceipt).toBe(stagingReceipt);
    expect(v.window).toBe(f.window);
    expect(v.request.signal).toBe(f.options.request.signal);
    expect(v.request).toEqual(f.options.request);
    prekey();
    return operation;
  });
  mock.provenanceOperation = jest.fn((op, a, o, w) => {
    expect(op).toBe(operation);
    expect(a).toBe(f.options.account);
    expect(o).toEqual(f.options.owners);
    expect(w).toBe(f.window);
    prekey();
    return binding;
  });
  mock.provenanceResult = jest.fn((op, receipt, a, o, w, margin) => {
    expect(receipt).toBe(rootReceipt);
    expect(margin).toBe(5000);
    mock.provenanceOperation(op, a, o, w);
    return observation;
  });
  Object.assign(f, {
    stageScope,
    rootScope,
    operation,
    rootBinding: binding,
    rootObservation: observation,
    stale: () => {
      stale = true;
    },
  });
}

test('staged Transact retains original request signal and distinct exact root consent before late one-use query', async () => {
  transact();
  expect(await run()).toEqual({ status: 'ready-local', operationId: f.row.id });
  expect(f.row.history.note.type).toBe('Transact');
  const summary = f.options.reviewRootDisclosure.mock.calls[0][0];
  expect(summary).toEqual({
    purpose: 'railgun-relay-selected-root-disclosure-v1',
    draftDigest: f.draft.digest,
    summaryDigest: f.data.summaryDigest,
    checkpointHash: f.data.checkpointHash,
    creatorEvidenceSha256: f.rootBinding.creatorEvidenceSha256,
    witnessInputSha256: f.rootBinding.witnessInputSha256,
    service: 'sepolia-ppoi-fdi',
    queries: [
      { method: 'latestTxid' },
      { method: 'validateTxidRoot', params: { tree: 0, ...f.rootBinding.point } },
    ],
    signingEnabled: false,
    relaySendPermitted: false,
  });
  expect(Object.isFrozen(summary.queries[1].params)).toBe(true);
  expect(summary).not.toHaveProperty('stagingReceipt');
  expect(f.events.indexOf('root-consent')).toBeLessThan(f.events.indexOf('disclosure'));
  expect(f.events.indexOf('root-query')).toBeGreaterThan(f.events.indexOf('preflight'));
  expect(f.events.indexOf('root-query')).toBeLessThan(f.events.indexOf('reserve'));
  expect(f.operation.acquireRoot).toHaveBeenCalledTimes(1);
  expect(f.operation.close).toHaveBeenCalledTimes(1);
  expect(f.options.request.signal.aborted).toBe(false);
});
test.each(['stagingReceipt', 'reviewRootDisclosure'])(
  'Shield refuses optional Transact %s before callbacks',
  async (key) => {
    f.options[key] = key === 'stagingReceipt' ? {} : jest.fn();
    expect((await run()).status).toBe('refused');
    expect(f.options.review).not.toHaveBeenCalled();
  }
);
test.each(['stagingReceipt', 'reviewRootDisclosure'])('Transact requires %s', async (key) => {
  transact();
  delete f.options[key];
  expect((await run()).status).toBe('refused');
  expect(f.options.review).not.toHaveBeenCalled();
});
test('unavailable/foreign staged receipt refuses before account review', async () => {
  transact();
  mock.available.mockImplementation(() => {
    throw Error('foreign');
  });
  expect((await run()).status).toBe('refused');
  expect(f.options.review).not.toHaveBeenCalled();
});
test.each(['draftDigest', 'summaryDigest', 'checkpointHash', 'stagingReceipt'])(
  'claimed root binding wrong %s refuses before disclosure',
  async (key) => {
    transact();
    mock.provenanceOperation.mockReturnValue({
      ...f.rootBinding,
      [key]: key === 'stagingReceipt' ? {} : 'ff'.repeat(32),
    });
    expect((await run()).status).toBe('refused');
    expect(f.options.reviewRootDisclosure).not.toHaveBeenCalled();
    expect(f.operation.acquireRoot).not.toHaveBeenCalled();
    expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
  }
);
test.each(['false', 'throw'])(
  'root disclosure %s refuses without root queries or holds',
  async (mode) => {
    transact();
    f.options.reviewRootDisclosure.mockImplementation(() => {
      if (mode === 'throw') throw Error('no');
      return false;
    });
    expect((await run()).status).toBe('refused');
    expect(f.operation.acquireRoot).not.toHaveBeenCalled();
    expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
    expect(mock.sign).not.toHaveBeenCalled();
    expect(f.operation.close).toHaveBeenCalledTimes(1);
  }
);
test('aborted held original root consent drains before refusal and closes sources', async () => {
  transact();
  const held = deferred(),
    entered = deferred();
  f.options.reviewRootDisclosure.mockImplementation(() => {
    entered.resolve();
    return held.promise;
  });
  let settled = false;
  const work = run().then((v) => {
    settled = true;
    return v;
  });
  await entered.promise;
  f.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve(true);
  expect((await work).status).toBe('refused');
  expect(f.operation.acquireRoot).not.toHaveBeenCalled();
});
test('native root callback species return cannot manufacture an early true decision', async () => {
  transact();
  const held = deferred(),
    entered = deferred(),
    then = jest.fn();
  Object.defineProperty(held.promise, 'constructor', {
    value: {
      [Symbol.species]: class {
        constructor(executor) {
          executor(
            () => {},
            () => {}
          );
          this.then = then;
        }
      },
    },
  });
  f.options.reviewRootDisclosure.mockImplementation(() => {
    entered.resolve();
    return held.promise;
  });
  let settled = false;
  const work = run().then((v) => {
    settled = true;
    return v;
  });
  await entered.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(then).not.toHaveBeenCalled();
  expect(f.operation.acquireRoot).not.toHaveBeenCalled();
  held.resolve(false);
  expect((await work).status).toBe('refused');
  expect(then).not.toHaveBeenCalled();
});
test('cross-domain root permit refuses membership token and replay/wrong operation', async () => {
  transact();
  const acquire = f.operation.acquireRoot.getMockImplementation();
  f.operation.acquireRoot.mockImplementation(async (options) => {
    const membership = mock.poi.openRailgunRelayWindowPoi.mock.calls[0][0].disclosure;
    expect(() =>
      api.consumeRailgunRelayRootDisclosurePermit(
        membership,
        f.operation,
        f.options.account,
        f.options.owners,
        f.window
      )
    ).toThrow();
    const result = await acquire(options);
    expect(() =>
      api.consumeRailgunRelayRootDisclosurePermit(
        options.permit,
        f.operation,
        f.options.account,
        f.options.owners,
        f.window
      )
    ).toThrow();
    return result;
  });
  expect((await run()).status).toBe('ready-local');
  expect(() =>
    api.consumeRailgunRelayRootDisclosurePermit(
      f.rootPermit,
      {},
      f.options.account,
      f.options.owners,
      f.window
    )
  ).toThrow();
});
test('root rejection prevents reservation and original close is drained', async () => {
  transact();
  f.operation.acquireRoot.mockRejectedValue(Error('root denied'));
  const close = deferred(),
    entered = deferred();
  f.operation.close.mockImplementation(() => {
    entered.resolve();
    return close.promise;
  });
  let settled = false;
  const work = run().then((v) => {
    settled = true;
    return v;
  });
  await entered.promise;
  expect(settled).toBe(false);
  expect(f.source.close).toHaveBeenCalled();
  close.resolve();
  expect((await work).status).toBe('refused');
  expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
});
test('late stale root gate after reserve refuses before signing, preserving held record', async () => {
  transact();
  const reserve = f.reservations.reserveRelay.getMockImplementation();
  f.reservations.reserveRelay.mockImplementation(async (...args) => {
    const value = await reserve(...args);
    f.stale();
    return value;
  });
  expect((await run()).status).toBe('recovery-required');
  expect(f.row.state).toBe('held');
  expect(mock.sign).not.toHaveBeenCalled();
});
test('pre-key staging abort prevents key while post-issuance stage/root abort cannot revoke local proof', async () => {
  transact();
  const verify = mock.verify.getMockImplementation();
  mock.verify.mockImplementation(async (options) => {
    f.stageScope.abort();
    f.rootScope.abort();
    return verify(options);
  });
  expect((await run()).status).toBe('ready-local');
  expect(f.localAssert).toHaveBeenCalled();
});
test('pre-key evidence abort after consent prevents membership and keys', async () => {
  transact();
  f.options.reviewRootDisclosure.mockImplementation(() => {
    f.stageScope.abort();
    return true;
  });
  expect((await run()).status).toBe('refused');
  expect(f.source.acquire).not.toHaveBeenCalled();
  expect(mock.sign).not.toHaveBeenCalled();
});
test('unknown original root cleanup retains controller exclusion', async () => {
  transact();
  f.operation.close.mockRejectedValue(unknown());
  await expect(run()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect((await run()).status).toBe('refused');
});

test('Transact immutable authorization digest binds exact historical provenance observation', async () => {
  transact();
  expect((await run()).status).toBe('ready-local');
  const expected = {
    draftDigest: f.draft.digest,
    summaryDigest: f.data.summaryDigest,
    history: f.history.data,
    binding: f.original.prePoiBinding,
    poi: mock.poi.assertRailgunRelayWindowPoi.mock.results[0].value,
    preflight: mock.preflightAssert.mock.results[0].value,
    provenance: f.rootObservation,
  };
  expect(f.row.authorizationDigest).toBe(
    createHash('sha256')
      .update('freedom:railgun:relay-local-gates-v4\0')
      .update(JSON.stringify(expected))
      .digest('hex')
  );
});
test('cancelled root query retains original callback until late unknown settlement and keeps exclusion', async () => {
  transact();
  const held = deferred(),
    entered = deferred();
  f.operation.acquireRoot.mockImplementation(() => {
    entered.resolve();
    return held.promise;
  });
  let ended = false;
  const work = run().finally(() => {
    ended = true;
  });
  work.catch(() => {});
  await entered.promise;
  f.controller.abort();
  await Promise.resolve();
  expect(ended).toBe(false);
  expect(f.operation.close).not.toHaveBeenCalled();
  held.reject(unknown());
  await expect(work).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
  expect((await run()).status).toBe('refused');
});

test.each(['membership', 'root'])(
  '%s consent refuses fulfilled-native value with later-added then without assimilation',
  async (kind) => {
    if (kind === 'root') transact();
    const value = {},
      then = jest.fn((resolve) => resolve(true));
    const supplied = Promise.resolve(value);
    value.then = then;
    f.options[kind === 'root' ? 'reviewRootDisclosure' : 'reviewDisclosure'].mockReturnValue(
      supplied
    );
    expect((await run()).status).toBe('refused');
    expect(then).not.toHaveBeenCalled();
    expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
    expect(mock.sign).not.toHaveBeenCalled();
    expect(f.source.acquire).not.toHaveBeenCalled();
    if (kind === 'root') expect(f.operation.acquireRoot).not.toHaveBeenCalled();
  }
);
test.each(['membership', 'root'])(
  '%s consent checks actual 30s deadline when timer delivery is delayed',
  async (kind) => {
    if (kind === 'root') transact();
    let now = performance.now();
    f.data.deadline = now + 180000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const delivered = jest.fn();
    jest.spyOn(global, 'setTimeout').mockImplementation(() => ({ unref: delivered }));
    f.options[kind === 'root' ? 'reviewRootDisclosure' : 'reviewDisclosure'].mockImplementation(
      () => {
        now += 30001;
        return Promise.resolve(true);
      }
    );
    expect((await run()).status).toBe('refused');
    expect(f.data.deadline - now).toBeGreaterThan(115000);
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.source.acquire).not.toHaveBeenCalled();
    expect(f.reservations.reserveRelay).not.toHaveBeenCalled();
    if (kind === 'root') expect(f.operation.acquireRoot).not.toHaveBeenCalled();
  }
);
test('non-consent signature owner fulfillment is boxed without invoking a later-added then', async () => {
  const then = jest.fn((resolve) => resolve({ signatureVerified: true }));
  mock.verify.mockImplementation((opts) => {
    const value = {
      recordDigest: opts.recordDigest,
      intentDigest: f.intent.digest,
      message: f.intent.data.expectedHash,
      signatureDigest: createHash('sha256').update(JSON.stringify(opts.signature)).digest('hex'),
      signatureVerified: true,
    };
    const supplied = Promise.resolve(value);
    value.then = then;
    return supplied;
  });
  expect((await run()).status).toBe('recovery-required');
  expect(then).not.toHaveBeenCalled();
  expect(f.recoveryStore.saveSignature).not.toHaveBeenCalled();
  expect(f.row.state).toBe('signing-local');
});
