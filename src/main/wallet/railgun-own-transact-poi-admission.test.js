let mockSigningKey;
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  const pair = actual.generateKeyPairSync('ed25519');
  mockSigningKey = pair.privateKey;
  const anchor =
    '302a300506032b6570032100efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';
  return {
    ...actual,
    createPublicKey: (input) =>
      Buffer.isBuffer(input?.key) && input.key.toString('hex') === anchor
        ? pair.publicKey
        : actual.createPublicKey(input),
  };
});
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
      !['poi-transact-selector', 'poi-prove'].includes(context.subject.operation)
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
  preflightRailgunOwnPoi: jest.fn((options) => mock.shieldPreflight(options)),
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
  const actual = jest.requireActual('./railgun-poi-source');
  return {
    ...actual,
    createRailgunPoiSource: (options) => {
      const source = actual.createRailgunPoiSource(options);
      mock.source = source;
      return source;
    },
  };
});
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mock.endpoint }));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => {
    let resolve;
    const closed = new Promise((done) => {
      resolve = done;
    });
    const transport = {
      closed,
      isList: false,
      exit: resolve,
      close: jest.fn(() => {
        if (!transport.isList || !mock.holdList) resolve();
      }),
      request: (handle, url, options) => mock.transportRequest(handle, url, options, transport),
    };
    mock.transports.push(transport);
    return transport;
  },
}));
jest.mock('./railgun-poi-membership', () => ({
  verifyRailgunPoiMembership: jest.fn((options) => mock.verify(options)),
  assertRailgunPoiMembership: jest.fn((receipt, handle, margin = 0) => {
    if (receipt !== mock.membershipReceipt) throw Error('PRIVATE receipt');
    mock.source.assertResult(mock.sourceReceipt, margin);
    require('../networks/privacy-context').getPrivacyContext(handle);
    return mock.verified;
  }),
}));
jest.mock('./railgun-poi-shield-selector', () => ({
  deriveRailgunPoiShieldSelector: jest.fn(async () => ({
    selectorDerived: true,
    utilityExitObserved: true,
    blindedCommitment: hex(77),
    bindingDigest: 'd'.repeat(64),
    inputSha256: 'e'.repeat(64),
  })),
}));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (value) => value }));
jest.mock('./railgun-poi-verifier', () => ({
  verifyRailgunPoiPayload: () => {
    throw Error('No POI proving');
  },
}));
jest.mock('./railgun-poi-prover', () => {
  throw Error('No prover');
});
jest.mock('./railgun-poi-intent-store', () => {
  throw Error('No store');
});
const { createPrivacyScope } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
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
    state: { count: 2, root: hex(88).slice(2) },
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
  for (const op of mock.opened || []) op.close?.();
  mock.sourceExit?.();
  scope.close();
  identityOwner.abort();
  jest.useRealTimers();
});
const {
  openRailgunOwnTransactPoiMembership: open,
  assertRailgunOwnPoiMembership: attest,
} = require('./railgun-own-poi-membership');
const { getPrivacyContext } = require('../networks/privacy-context');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const methods = [
  'ppoi_pois_per_list',
  'ppoi_merkle_proofs',
  'ppoi_poi_events',
  'ppoi_validate_poi_merkleroots',
];
let clock;
beforeEach(() => {
  clock = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  mock.endpoint = { signal: new AbortController().signal };
  mock.transports = [];
  mock.opened = [];
  mock.admitted = [];
  mock.holdList = false;
  mock.latestIndex = 20;
  mock.rootAccepted = true;
  mock.historical.poiPreparation.state = copy(mock.historical.state);
  mock.historical.poiPreparation.witness = {};
  const event = { index: 0, blindedCommitment: hex(77), type: 'Transact' };
  mock.event = {
    signedPOIEvent: {
      ...event,
      signature: require('crypto')
        .sign(null, Buffer.from(JSON.stringify(event)), mockSigningKey)
        .toString('hex'),
    },
    validatedMerkleroot: hex(90).slice(2),
  };
  mock.proof = {
    leaf: hex(77).slice(2),
    indices: hex(0).slice(2),
    root: hex(90).slice(2),
    elements: Array(16).fill(hex(0).slice(2)),
  };
  mock.beforeAuthenticate = () => {};
  mock.beforeResponse = async () => {};
  mock.transportRequest = jest.fn(async (handle, _url, options, transport) => {
    const body = JSON.parse(options.body);
    transport.isList = methods.includes(body.method);
    mock.beforeAuthenticate(body, handle);
    getPrivacyContext(handle);
    mock.admitted.push(body.method);
    await mock.beforeResponse(body, transport);
    let result;
    if (body.method === 'ppoi_validated_txid')
      result = { validatedTxidIndex: mock.latestIndex, validatedTxidMerkleroot: hex(89).slice(2) };
    else if (body.method === 'ppoi_validate_txid_merkleroot') {
      expect(body.params).toMatchObject({
        tree: 0,
        index: mock.historical.state.count - 1,
        merkleroot: mock.historical.state.root,
      });
      result = mock.rootAccepted;
    } else if (body.method === 'ppoi_pois_per_list') {
      expect(body.params.blindedCommitmentDatas).toEqual([
        { type: 'Transact', blindedCommitment: hex(77) },
      ]);
      result = { [hex(77)]: { [REQUIRED_LIST]: 'Valid' } };
    } else if (body.method === 'ppoi_merkle_proofs') result = [mock.proof];
    else if (body.method === 'ppoi_poi_events') result = [mock.event];
    else if (body.method === 'ppoi_validate_poi_merkleroots') result = true;
    else throw Error('PRIVATE unexpected RPC');
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
    };
  });
  mock.verify = jest.fn(async ({ receipt, source, handle }) => {
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
    getPrivacyContext(handle);
    mock.sourceReceipt = receipt;
    mock.membershipReceipt = {};
    mock.verified = { ...source.assertResult(receipt), membershipVerified: true };
    return { receipt: mock.membershipReceipt, observation: mock.verified };
  });
});
afterEach(() => {
  for (const transport of mock.transports) transport.exit();
  jest.restoreAllMocks();
});
const run = async () => {
  const op = await open(options);
  mock.opened.push(op);
  return op;
};
test('real root/list normalization admits exact fifth pair and four signed Transact reads', async () => {
  const op = await run();
  expect(op.status).toBe('verified');
  expect(mock.admitted).toEqual([
    'ppoi_validated_txid',
    'ppoi_validate_txid_merkleroot',
    ...methods,
  ]);
  expect(attest(op.receipt, mock.enrollment, mock.coordinator)).toBe(op.observation);
  expect(op.observation.recordedRoot).toMatchObject({
    index: 1,
    root: hex(88).slice(2),
    latestIndex: 20,
    accepted: true,
  });
  expect(mock.credential).toHaveBeenCalledTimes(1);
  expect(mock.verify).toHaveBeenCalledTimes(1);
});
test.each(methods)(
  'root expiry after source check admits no next %s at derived transport handle',
  async (method) => {
    mock.holdList = true;
    const entered = gate();
    mock.beforeAuthenticate = (body) => {
      if (body.method === method) {
        clock = 60100;
        entered.resolve();
      }
    };
    let settled = false;
    const pending = run().then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await turn();
      expect(mock.admitted).toEqual([
        'ppoi_validated_txid',
        'ppoi_validate_txid_merkleroot',
        ...methods.slice(0, methods.indexOf(method)),
      ]);
      expect(mock.source.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(mock.verify).not.toHaveBeenCalled();
    } finally {
      mock.transports.forEach((transport) => transport.exit());
    }
    expect((await pending).status).toBe('refused');
  }
);
test('already-admitted request can complete late but admits no subsequent method and awaits list drain', async () => {
  mock.holdList = true;
  const entered = gate(),
    release = gate();
  mock.beforeResponse = async (body) => {
    if (body.method === methods[0]) {
      entered.resolve();
      await release.promise;
    }
  };
  let settled = false;
  const pending = run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  clock = 60100;
  release.resolve();
  try {
    await turn();
    expect(mock.admitted).toEqual([
      'ppoi_validated_txid',
      'ppoi_validate_txid_merkleroot',
      methods[0],
    ]);
    expect(settled).toBe(false);
    expect(mock.source.signal.aborted).toBe(true);
  } finally {
    mock.transports.forEach((transport) => transport.exit());
  }
  expect((await pending).status).toBe('refused');
});
test.each(['rejected', 'wrong-latest'])(
  'invalid fifth root %s admits no list disclosure',
  async (mode) => {
    if (mode === 'rejected') mock.rootAccepted = false;
    else mock.latestIndex = 1;
    expect((await run()).status).toBe('refused');
    expect(mock.admitted.some((method) => methods.includes(method))).toBe(false);
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test.each(['signature', 'type', 'leaf', 'index'])(
  'real source refuses signed event/path %s substitution',
  async (fault) => {
    if (fault === 'signature') mock.event.signedPOIEvent.signature = '0'.repeat(128);
    if (fault === 'type') {
      const event = { index: 0, blindedCommitment: hex(77), type: 'Shield' };
      mock.event.signedPOIEvent = {
        ...event,
        signature: require('crypto')
          .sign(null, Buffer.from(JSON.stringify(event)), mockSigningKey)
          .toString('hex'),
      };
    }
    if (fault === 'leaf') mock.proof.leaf = hex(78).slice(2);
    if (fault === 'index') mock.proof.indices = hex(1).slice(2);
    expect((await run()).status).toBe('refused');
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.admitted).not.toContain(methods[3]);
  }
);
test('real root age becomes historical before verifier and receipt while signed list stays fresh', async () => {
  mock.beforeResponse = async (body) => {
    if (body.method === 'ppoi_validated_txid') clock += 14999;
    if (body.method === methods[0]) clock += 29999;
  };
  const verify = mock.verify.getMockImplementation();
  mock.verify.mockImplementation(async (options) => {
    clock += 9000;
    return verify(options);
  });
  mock.recapture.mockImplementation(async () => {
    if (mock.verify.mock.calls.length) clock += 9000;
    return { status: 'captured', capture: copy(mock.capture) };
  });
  const op = await run();
  expect(op.status).toBe('verified');
  expect(clock).toBe(63098);
  expect(attest(op.receipt, mock.enrollment, mock.coordinator)).toBe(op.observation);
  expect(mock.admitted).toHaveLength(6);
  expect(mock.transports.find((transport) => !transport.isList).close).toHaveBeenCalled();
});

test('root-only timer is cleared at acquisition while list timer still bounds receipt', async () => {
  jest.useFakeTimers();
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  const advance = async (ms) => {
    clock += ms;
    await jest.advanceTimersByTimeAsync(ms);
  };
  mock.beforeResponse = async (body) => {
    if (body.method === 'ppoi_validated_txid') await advance(14999);
    if (body.method === methods[0]) await advance(29999);
  };
  const verify = mock.verify.getMockImplementation();
  mock.verify.mockImplementation(async (options) => {
    await advance(9000);
    return verify(options);
  });
  mock.recapture.mockImplementation(async () => {
    if (mock.verify.mock.calls.length) await advance(9000);
    return { status: 'captured', capture: copy(mock.capture) };
  });
  const op = await run();
  expect(op.status).toBe('verified');
  expect(clock).toBe(63098);
  expect(op.signal.aborted).toBe(false);
  expect(attest(op.receipt, mock.enrollment, mock.coordinator)).toBe(op.observation);
  await advance(12001);
  expect(op.signal.aborted).toBe(true);
  await op.closed;
  expect(() => attest(op.receipt, mock.enrollment, mock.coordinator)).toThrow();
});

test('the original REQUIRED_LIST trust anchor rejects the disposable fixture signature', () => {
  const actual = jest.requireActual('crypto');
  const key = actual.createPublicKey({
    key: Buffer.from('302a300506032b6570032100' + REQUIRED_LIST, 'hex'),
    format: 'der',
    type: 'spki',
  });
  const event = mock.event.signedPOIEvent;
  const message = Buffer.from(
    JSON.stringify({
      index: event.index,
      blindedCommitment: event.blindedCommitment,
      type: event.type,
    })
  );
  expect(actual.verify(null, message, key, Buffer.from(event.signature, 'hex'))).toBe(false);
  expect(
    actual.verify(
      null,
      message,
      actual.createPublicKey(mockSigningKey),
      Buffer.from(event.signature, 'hex')
    )
  ).toBe(true);
});
