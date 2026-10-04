const { createHash } = require('crypto');
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.enrollment,
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => {
    if (value !== '/selector.asar') throw Error('PRIVATE archive');
    return value;
  },
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'public-policy' }));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      policy !== 'public-policy' ||
      !mock.publicCurrent
    )
      throw Error('PRIVATE public');
    return { ...mock.publicIdentity };
  },
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (identity, handle) => {
    const context = require('../networks/privacy-context').getPrivacyContext(handle);
    if (
      identity !== mock.identity ||
      identity.signal.aborted ||
      !mock.identityCurrent ||
      context.subject.operation !== 'poi-transact-selector'
    )
      throw Error('PRIVATE identity');
    return JSON.parse(JSON.stringify(identity.descriptor));
  },
  withRailgunViewingCredential: jest.fn((identity, use) => {
    if (identity !== mock.identity) throw Error('PRIVATE identity');
    return mock.credential(use);
  }),
}));
jest.mock('./railgun-own-witness', () => ({
  captureRailgunOwnTransactPoiMembershipInput: jest.fn((options) => mock.preflight(options)),
}));
jest.mock('./railgun-own-operation', () => ({
  captureRailgunOwnOperation: jest.fn((options) => mock.recapture(options)),
  withRailgunOwnOperationRecovery: jest.fn(async (options, use) => {
    const claim = require('./railgun-account-phase').claimRailgunAccountPhase(
      mock.enrollment,
      'recovery'
    );
    mock.phase = true;
    const deadline = performance.now() + options.timeoutMs;
    const current = (margin = 0) => {
      claim.assertCurrent();
      if (options.signal.aborted || performance.now() + margin >= deadline)
        throw Error('PRIVATE recovery');
    };
    mock.window = {
      signal: options.signal,
      capture: JSON.parse(JSON.stringify(mock.capture)),
      assertCurrent: jest.fn(current),
      reattest: jest.fn(async () => {
        current();
        const value = await mock.reattest();
        current();
        return value;
      }),
    };
    try {
      const value = await use(mock.window);
      current();
      return { status: 'used', value };
    } catch {
      return { status: 'refused', stage: 'callback' };
    } finally {
      mock.phase = false;
      claim.release();
    }
  }),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    if (!mock.phase) throw Error('PRIVATE phase');
    let readyYes, readyNo, exitYes, exitNo;
    const ready = new Promise((yes, no) => {
      readyYes = yes;
      readyNo = no;
    });
    const closed = new Promise((yes, no) => {
      exitYes = yes;
      exitNo = no;
    });
    const task = {
      options,
      ready,
      closed,
      close: jest.fn(() => {
        mock.closedCalls++;
        if (!mock.holdExit) exitYes({ code: 'RAILGUN_PROCESS_CLOSED' });
        if (mock.closeThrows) throw Error('PRIVATE close');
      }),
    };
    const job = {
      options,
      task,
      readyYes,
      readyNo,
      exit: () => exitYes({ code: 'RAILGUN_PROCESS_CLOSED' }),
      rejectExit: () => exitNo(Error('PRIVATE exit')),
      send: (value) =>
        options.broker.dispatch(typeof value === 'string' ? value : JSON.stringify(value)),
    };
    mock.jobs.push(job);
    Promise.resolve()
      .then(() => mock.script(job))
      .then(readyYes, readyNo);
    return task;
  }),
}));
jest.mock('./railgun-poi-source', () => {
  throw Error('No owned-list source');
});
jest.mock('./railgun-poi-prover', () => {
  throw Error('No prover');
});
jest.mock('./railgun-poi-intent-store', () => {
  throw Error('No store');
});
const { createPrivacyScope } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { deriveRailgunOwnTransactPoiSelector: derive } = require('./railgun-poi-transact-selector');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
let scope, caller, identityOwner, options;
function configure(unshield = false) {
  const evidence = sample(unshield),
    capsule = evidence.capsule;
  const descriptor = {
    walletId: capsule.walletId,
    instanceId: '0zk1' + 'q'.repeat(123),
    masterPublicKey: hex(3).slice(2),
    spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
    viewingPublicKey: hex(6).slice(2),
    accountIndex: 0,
  };
  mock.identity.descriptor = copy(descriptor);
  mock.enrollment.descriptor = copy(descriptor);
  const creator = {
    type: 'Transact',
    tree: capsule.selection.tree,
    position: capsule.selection.position,
    hash: capsule.noteHash,
    ciphertext: {
      ciphertext: [hex(7), hex(8), hex(9), hex(10)],
      blindedSenderViewingKey: hex(11),
      blindedReceiverViewingKey: hex(12),
      annotationData: '0x',
      memo: '0x',
    },
  };
  mock.capture = {
    capsule,
    record: evidence.record,
    bindingDigest: 'b'.repeat(64),
    capsuleDigest: 'c'.repeat(64),
    selector: {
      tree: 0,
      position: 1,
      noteHash: capsule.noteHash,
      nullifier: capsule.preparation.expected.nullifier,
    },
    facts: { kind: capsule.selection.kind },
    submitter: evidence.transaction.from,
    provedTransaction: evidence.transaction,
    intent: evidence.record.intent,
    projection: { included: true, blockHash: evidence.receipt.blockHash },
  };
  mock.historical = {
    status: 'captured',
    publicIdentity: copy(mock.publicIdentity),
    publicPolicy: 'public-policy',
    creatorClassification: {
      type: 'Transact',
      legacy: false,
      blockNumber: require('./railgun-owned-poi-records').POI_LAUNCH_BLOCK,
    },
    observations: { archiveAnchorChecked: true },
    creatorProvenance: {
      note: {
        type: 'Transact',
        tree: creator.tree,
        position: creator.position,
        hash: creator.hash,
      },
    },
    capture: copy(mock.capture),
    poiPreparation: { creator, ownEvidence: evidence },
  };
  options.selector = copy(mock.capture.selector);
}
const key = (job) => ({
  id: 1,
  method: 'key',
  purpose: 'poi-transact-selector',
  inputSha256: sha(job.options.input),
});
const result = (job) => ({
  id: 2,
  method: 'result',
  value: {
    inputSha256: sha(job.options.input),
    bindingDigest: JSON.parse(job.options.input).bindingDigest,
    blindedCommitment: hex(77),
    type: 'Transact',
    selectorDerived: true,
    receiverMatched: true,
    sourceAuthenticated: false,
    currentFinalityVerified: false,
    txidRootAccepted: false,
    membershipAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
    guards: { attempts: 0, canaries: 1, hooks: ['network'] },
  },
});
async function healthy(job) {
  const bytes = await job.send(key(job));
  mock.keyCopies.push(bytes);
  await job.send(result(job));
}
beforeEach(() => {
  jest.clearAllMocks();
  scope = createPrivacyScope({ profileId: 'selector-test', signal: new AbortController().signal });
  caller = new AbortController();
  identityOwner = new AbortController();
  mock = {
    publicCurrent: true,
    identityCurrent: true,
    publicIdentity: {
      generationId: '1'.repeat(64),
      publicId: '2'.repeat(64),
      sourceId: '3'.repeat(64),
    },
    identity: { signal: identityOwner.signal },
    enrollment: {
      directory: '/selector-test',
      signal: scope.signal,
      getContext: (role, operation) =>
        scope.getContext({
          kind: 'private-account',
          principal: 'railgun:0',
          protocol: 'railgun',
          deployment: 'sepolia',
          chainId: 11155111,
          role,
          ...(operation ? { operation } : {}),
        }),
    },
    coordinator: { signal: scope.signal },
    jobs: [],
    keyCopies: [],
    phase: false,
    holdExit: false,
    closeThrows: false,
    closedCalls: 0,
    script: healthy,
  };
  options = {
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    archive: '/selector.asar',
    selector: {},
    signal: caller.signal,
  };
  configure();
  mock.preflight = jest.fn(async () => copy(mock.historical));
  mock.recapture = jest.fn(async () => ({ status: 'captured', capture: copy(mock.capture) }));
  mock.reattest = jest.fn(async () => copy(mock.capture));
  mock.credential = jest.fn(async (use) => {
    const bytes = Buffer.alloc(32, 17);
    mock.credentialBytes = bytes;
    try {
      return await use({ viewingKey: bytes });
    } finally {
      bytes.fill(0);
    }
  });
});
afterEach(() => {
  for (const job of mock.jobs) job.exit();
  caller.abort();
  scope.close();
  identityOwner.abort();
  jest.useRealTimers();
});
const expected = {
  status: 'derived',
  selectorDerived: true,
  receiverMatched: true,
  utilityExitObserved: true,
  sourceAuthenticated: false,
  currentFinalityVerified: false,
  txidRootAccepted: false,
  membershipAuthenticated: false,
  disclosureEnabled: false,
  spendingEnabled: false,
};
test.each([false, true])(
  'success has exact unlinkable diagnostic and one input viewing release, unshield=%s',
  async (unshield) => {
    configure(unshield);
    const value = await derive(options);
    expect(value).toEqual(expected);
    expect(Object.isFrozen(value)).toBe(true);
    expect(mock.preflight).toHaveBeenCalledTimes(1);
    expect(mock.preflight.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(200000);
    expect(mock.credential).toHaveBeenCalledTimes(1);
    expect(mock.window.reattest.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(mock.keyCopies.every((bytes) => bytes.equals(Buffer.alloc(32)))).toBe(true);
    expect(mock.credentialBytes.equals(Buffer.alloc(32))).toBe(true);
    expect(mock.phase).toBe(false);
    expect(mock.recapture).toHaveBeenCalledTimes(1);
    const job = mock.jobs[0];
    expect(job.options.filename).toBe(require.resolve('./railgun-poi-transact-selector-job'));
    expect(job.options.binaryKey).toBe(true);
    expect(job.options.lifetimeMs).toBeLessThanOrEqual(15000);
  }
);
test.each(['completion', 'creator', 'witness', 'viewingKey', 'observed', 'sourceDestination'])(
  'no caller supplied %s can be admitted',
  async (name) => {
    expect(await derive({ ...options, [name]: {} })).toEqual({
      status: 'refused',
      stage: 'context',
    });
    expect(mock.preflight).not.toHaveBeenCalled();
  }
);
test.each([
  'identity',
  'enrollment',
  'coordinator',
  'accountIndex',
  'masterPublicKey',
  'viewingPublicKey',
  'spendingPublicKey',
  'walletId',
  'instanceId',
])('exact owner/full descriptor %s refuses before preflight', async (name) => {
  if (['identity', 'enrollment', 'coordinator'].includes(name))
    options[name] = { ...options[name] };
  else if (name === 'accountIndex') mock.enrollment.descriptor[name] = 1;
  else if (name === 'spendingPublicKey')
    mock.enrollment.descriptor[name] = [hex(90).slice(2), hex(91).slice(2)];
  else mock.enrollment.descriptor[name] = 'a'.repeat(64);
  expect((await derive(options)).status).toBe('refused');
  expect(mock.preflight).not.toHaveBeenCalled();
  expect(mock.credential).not.toHaveBeenCalled();
});
test.each([0, -1, 300001, 1.5, NaN, null])(
  'invalid timeout %s refuses before preflight',
  async (timeoutMs) => {
    expect((await derive({ ...options, timeoutMs })).status).toBe('refused');
    expect(mock.preflight).not.toHaveBeenCalled();
  }
);
test('100-second retained headroom refuses before preflight rather than renewing budget', async () => {
  expect((await derive({ ...options, timeoutMs: 100000 })).status).toBe('refused');
  expect(mock.preflight).not.toHaveBeenCalled();
});
test('inner source diagnostic is bounded internally and omitted from public refusal', async () => {
  mock.preflight.mockResolvedValue({
    status: 'refused',
    stage: 'snapshot',
    sourceOutcome: { fatal: true, reason: 'fatal', rpcFailure: 'response' },
  });
  expect(await derive(options)).toEqual({ status: 'refused', stage: 'preflight:snapshot' });
  expect(mock.jobs).toHaveLength(0);
});
test.each(['generation', 'identity', 'capsule', 'archival'])(
  'historical or fresh local %s drift refuses before key',
  async (kind) => {
    if (kind === 'generation')
      mock.preflight.mockImplementation(async () => {
        mock.publicIdentity.generationId = '9'.repeat(64);
        return copy(mock.historical);
      });
    if (kind === 'identity')
      mock.preflight.mockImplementation(async () => {
        mock.identityCurrent = false;
        return copy(mock.historical);
      });
    if (kind === 'capsule') mock.capture.capsule.pathElements[0] = hex(90);
    if (kind === 'archival') mock.capture.record.archivedAt = 123;
    expect((await derive(options)).status).toBe('refused');
    expect(mock.credential).not.toHaveBeenCalled();
  }
);
test.each([
  'bad-key',
  'result-first',
  'duplicate-key',
  'bad-then-valid',
  'valid-then-bad',
  'duplicate-result',
  'wrong-hash',
  'wrong-binding',
  'authority',
  'extra-result',
])('sticky broker refusal for %s cannot be rescued', async (kind) => {
  let immediateAborted;
  mock.script = async (job) => {
    const k = key(job),
      r = result(job);
    if (kind === 'bad-key') k.purpose = 'wallet-viewing';
    if (kind === 'result-first') await job.send(r).catch(() => {});
    if (kind === 'bad-then-valid') job.send('{').catch(() => {});
    await job.send(k).then(
      (bytes) => mock.keyCopies.push(bytes),
      () => {}
    );
    if (kind === 'duplicate-key') await job.send(k).catch(() => {});
    if (kind === 'wrong-hash') r.value.inputSha256 = '0'.repeat(64);
    if (kind === 'wrong-binding') r.value.bindingDigest = '0'.repeat(64);
    if (kind === 'authority') r.value.disclosureEnabled = true;
    if (kind === 'extra-result') r.value.inputNpk = 'PRIVATE';
    await job.send(r).catch(() => {});
    if (kind === 'valid-then-bad') job.send('{').catch(() => {});
    if (kind === 'duplicate-result') await job.send(r).catch(() => {});
    immediateAborted = job.options.broker.signal.aborted;
  };
  const value = await derive(options);
  expect(immediateAborted).toBe(true);
  expect(value.status).toBe('refused');
  expect(JSON.stringify(value)).not.toContain('PRIVATE');
  expect(mock.recapture).not.toHaveBeenCalled();
  expect(mock.keyCopies.every((bytes) => bytes.equals(Buffer.alloc(32)))).toBe(true);
});
test('held child exit retains exact owner and recovery; competing call cannot revoke first', async () => {
  mock.holdExit = true;
  const entered = gate();
  mock.script = async (job) => {
    await healthy(job);
    entered.resolve();
  };
  let settled = false;
  const pending = derive(options).then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  try {
    await turn();
    expect(settled).toBe(false);
    expect(mock.phase).toBe(true);
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
    expect(await derive(options)).toEqual({ status: 'refused', stage: 'busy' });
    expect(mock.jobs[0].options.broker.signal.aborted).toBe(false);
  } finally {
    mock.jobs[0].exit();
  }
  expect(await pending).toEqual(expected);
  mock.holdExit = false;
  expect(await derive(options)).toEqual(expected);
});
test.each(['key', 'reattest'])(
  'early child exit cannot release borrowed %s work or recovery',
  async (kind) => {
    const entered = gate(),
      release = gate();
    if (kind === 'key')
      mock.credential.mockImplementation(async (use) => {
        entered.resolve();
        await release.promise;
        return use({ viewingKey: Buffer.alloc(32, 17) });
      });
    else {
      let calls = 0;
      mock.reattest.mockImplementation(async () => {
        if (++calls === 2) {
          entered.resolve();
          await release.promise;
        }
        return copy(mock.capture);
      });
    }
    mock.script = async (job) => {
      job.send(key(job)).catch(() => {});
      await entered.promise;
    };
    let settled = false;
    const pending = derive(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await turn();
      expect(mock.jobs[0].options.broker.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(mock.phase).toBe(true);
      expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
      expect(await derive(options)).toEqual({ status: 'refused', stage: 'busy' });
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBe('refused');
    expect(mock.phase).toBe(false);
  }
);
test('duplicate key consumes attempt before asynchronous reattestation', async () => {
  const entered = gate(),
    release = gate();
  let count = 0;
  mock.reattest.mockImplementation(async () => {
    if (++count === 2) {
      entered.resolve();
      await release.promise;
    }
    return copy(mock.capture);
  });
  mock.script = async (job) => {
    const first = job.send(key(job)).catch(() => {});
    await entered.promise;
    await job.send(key(job)).catch(() => {});
    expect(job.options.broker.signal.aborted).toBe(true);
    release.resolve();
    await first;
  };
  expect((await derive(options)).status).toBe('refused');
  expect(mock.credential).not.toHaveBeenCalled();
});
test.each(['close-throw', 'exit-reject'])(
  '%s cannot publish success or skip cleanup',
  async (kind) => {
    if (kind === 'close-throw') mock.closeThrows = true;
    else
      mock.script = async (job) => {
        await healthy(job);
        job.rejectExit();
      };
    expect((await derive(options)).status).toBe('refused');
    expect(mock.phase).toBe(false);
    expect(mock.keyCopies.every((bytes) => bytes.equals(Buffer.alloc(32)))).toBe(true);
  }
);
test('late final capture drift refuses after actual child barrier and wipes copy', async () => {
  mock.recapture.mockImplementation(async () => {
    const capture = copy(mock.capture);
    capture.record.archivedAt = 1;
    return { status: 'captured', capture };
  });
  expect((await derive(options)).status).toBe('refused');
  expect(mock.credential).toHaveBeenCalledTimes(1);
  expect(mock.keyCopies[0].equals(Buffer.alloc(32))).toBe(true);
});
test.each(['before-key', 'inside-credential'])(
  '5-second key admission margin at %s yields no released copy',
  async (at) => {
    jest.useFakeTimers();
    if (at === 'before-key')
      mock.script = async (job) => {
        jest.advanceTimersByTime(10001);
        await job.send(key(job));
      };
    else
      mock.credential.mockImplementation(async (use) => {
        jest.advanceTimersByTime(10001);
        return use({ viewingKey: Buffer.alloc(32, 17) });
      });
    expect((await derive(options)).status).toBe('refused');
    expect(mock.keyCopies).toHaveLength(0);
    if (at === 'before-key') expect(mock.credential).not.toHaveBeenCalled();
  }
);
test('export and production import inventory keep the historical producer unwired elsewhere', () => {
  expect(Object.keys(require('./railgun-poi-transact-selector'))).toEqual([
    'deriveRailgunOwnTransactPoiSelector',
  ]);
  const fs = require('fs'),
    path = require('path'),
    files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(name);
    }
  }
  visit(path.resolve(__dirname, '..'));
  const consumers = files
    .filter((file) =>
      fs.readFileSync(file, 'utf8').includes('captureRailgunOwnTransactPoiMembershipInput')
    )
    .map((file) => path.basename(file))
    .sort();
  expect(consumers).toEqual(['railgun-own-witness.js', 'railgun-poi-transact-selector.js']);
});

test.each(['type', 'tree', 'position', 'hash'])(
  'historical provenance %s must bind actual creator before key',
  async (field) => {
    mock.historical.creatorProvenance.note[field] =
      field === 'type' ? 'Shield' : field === 'hash' ? hex(90) : 99;
    expect((await derive(options)).status).toBe('refused');
    expect(mock.credential).not.toHaveBeenCalled();
    expect(mock.jobs).toHaveLength(0);
  }
);

test.each(['caller', 'identity', 'generation', 'deadline'])(
  'late %s during preflight refuses any utility or key admission',
  async (kind) => {
    if (kind === 'deadline') jest.useFakeTimers();
    mock.preflight.mockImplementation(async () => {
      if (kind === 'caller') caller.abort();
      if (kind === 'identity') identityOwner.abort();
      if (kind === 'generation') mock.publicIdentity.generationId = '9'.repeat(64);
      if (kind === 'deadline') jest.advanceTimersByTime(300001);
      return copy(mock.historical);
    });
    expect((await derive(options)).status).toBe('refused');
    expect(mock.jobs).toHaveLength(0);
    expect(mock.credential).not.toHaveBeenCalled();
  }
);
test.each(['caller', 'generation', 'descriptor', 'throw', 'margin'])(
  'credential callback reattestation %s refuses before copying the viewing credential',
  async (kind) => {
    if (kind === 'margin') jest.useFakeTimers();
    let count = 0;
    mock.reattest.mockImplementation(async () => {
      if (++count === 3) {
        if (kind === 'caller') caller.abort();
        if (kind === 'generation') mock.publicIdentity.generationId = '9'.repeat(64);
        if (kind === 'descriptor') mock.enrollment.descriptor.accountIndex = 1;
        if (kind === 'throw') throw Error('PRIVATE late reattest');
        if (kind === 'margin') jest.advanceTimersByTime(10001);
      }
      return copy(mock.capture);
    });
    expect((await derive(options)).status).toBe('refused');
    expect(mock.credential).toHaveBeenCalledTimes(1);
    expect(mock.keyCopies).toHaveLength(0);
    expect(mock.credentialBytes.equals(Buffer.alloc(32))).toBe(true);
  }
);
test('throwing child close still waits actual exit before releasing recovery and owner', async () => {
  mock.closeThrows = true;
  mock.holdExit = true;
  const entered = gate();
  mock.script = async (job) => {
    await healthy(job);
    entered.resolve();
  };
  let settled = false;
  const pending = derive(options).then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  try {
    await turn();
    expect(settled).toBe(false);
    expect(mock.phase).toBe(true);
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
    expect(await derive(options)).toEqual({ status: 'refused', stage: 'busy' });
  } finally {
    mock.jobs[0].exit();
  }
  expect((await pending).status).toBe('refused');
  expect(mock.keyCopies[0].equals(Buffer.alloc(32))).toBe(true);
});
test('caller abort is nonthrowing even when child close throws and borrowed key derivation ignores abort', async () => {
  const entered = gate(),
    release = gate();
  mock.closeThrows = true;
  mock.credential.mockImplementation(async (use) => {
    entered.resolve();
    await release.promise;
    const bytes = Buffer.alloc(32, 17);
    try {
      return await use({ viewingKey: bytes });
    } finally {
      bytes.fill(0);
    }
  });
  let settled = false;
  const pending = derive(options).then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  try {
    expect(() => caller.abort()).not.toThrow();
    await turn();
    expect(settled).toBe(false);
    expect(mock.phase).toBe(true);
    expect(mock.jobs[0].options.broker.signal.aborted).toBe(true);
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe('refused');
  expect(mock.phase).toBe(false);
});
test('caller option mutation cannot replace the captured selector after admission', async () => {
  const before = copy(options.selector);
  mock.preflight.mockImplementation(async (received) => {
    options.selector.position = 999;
    options.archive = '/evil.asar';
    expect(received.selector).toEqual(before);
    expect(Object.isFrozen(received.selector)).toBe(true);
    return copy(mock.historical);
  });
  expect(await derive(options)).toEqual(expected);
  expect(mock.recapture.mock.calls[0][0].selector).toEqual(before);
});
test('successful child result followed by generation change at exit cannot publish diagnostic', async () => {
  mock.holdExit = true;
  const entered = gate();
  mock.script = async (job) => {
    await healthy(job);
    entered.resolve();
  };
  const pending = derive(options);
  await entered.promise;
  await turn();
  mock.publicIdentity.generationId = '9'.repeat(64);
  mock.jobs[0].exit();
  expect((await pending).status).toBe('refused');
  expect(mock.keyCopies[0].equals(Buffer.alloc(32))).toBe(true);
});
