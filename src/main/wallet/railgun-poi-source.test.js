let mockEndpoint;
const mockScopes = [];
const mockRequest = jest.fn(),
  mockClose = jest.fn(),
  mockFactory = jest.fn();
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: (...args) => mockFactory(...args),
}));
jest.mock('../networks/privacy-context', () => {
  const actual = jest.requireActual('../networks/privacy-context');
  return {
    ...actual,
    createPrivacyScope: (...args) => {
      const scope = actual.createPrivacyScope(...args);
      mockScopes.push(scope);
      return scope;
    },
  };
});
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunPoiSource, MAX_AGE_MS } = require('./railgun-poi-source');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => n.toString(16).padStart(64, '0');
const events = require('../../../scripts/fixtures/railgun-poi-signed-event.json');
const notes = [{ blindedCommitment: events[0].signedPOIEvent.blindedCommitment, type: 'Shield' }];
const proof = {
  leaf: notes[0].blindedCommitment.slice(2),
  elements: Array(16).fill(hex(0)),
  indices: hex(0),
  root: hex(9),
};
const subject = {
  kind: 'private-account',
  principal: 'railgun:0',
  protocol: 'railgun',
  deployment: 'sepolia',
  chainId: 11155111,
  role: 'poi',
  operation: 'poi:' + 'a'.repeat(64),
};
let scope, handle, source, replyStatus, accepted;
beforeEach(() => {
  jest.clearAllMocks();
  mockClose.mockReset();
  mockFactory.mockReset();
  mockScopes.length = 0;
  mockFactory.mockImplementation(() => {
    let resolve;
    const closed = new Promise((done) => {
      resolve = done;
    });
    return {
      request: mockRequest,
      closed,
      close: () => {
        mockClose();
        resolve();
      },
    };
  });
  mockEndpoint = { signal: new AbortController().signal };
  scope = createPrivacyScope({ profileId: 'poi-test', signal: new AbortController().signal });
  handle = scope.getContext(subject);
  replyStatus = 'Valid';
  accepted = true;
  mockRequest.mockImplementation(async (_h, _u, options) => {
    const body = JSON.parse(options.body);
    const result =
      body.method === 'ppoi_pois_per_list'
        ? { [notes[0].blindedCommitment]: { [REQUIRED_LIST]: replyStatus } }
        : body.method === 'ppoi_merkle_proofs'
          ? [proof]
          : body.method === 'ppoi_poi_events'
            ? events
            : accepted;
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
    };
  });
});
afterEach(() => {
  source?.close();
  source = undefined;
  scope.close();
  jest.restoreAllMocks();
});
const open = () => (source = createRailgunPoiSource({ handle, notes }));
test('fixed requests use an isolated account operation and only issue service observations', async () => {
  const client = open(),
    { receipt, observation } = await client.acquire();
  expect(JSON.parse(JSON.stringify(observation))).toStrictEqual(observation);
  expect(client.assertResult(receipt)).toBe(observation);
  expect(observation).toMatchObject({
    rootsAccepted: true,
    membershipVerified: false,
    spendingEnabled: false,
  });
  expect(mockRequest.mock.calls.map(([, , options]) => JSON.parse(options.body).method)).toEqual([
    'ppoi_pois_per_list',
    'ppoi_merkle_proofs',
    'ppoi_poi_events',
    'ppoi_validate_poi_merkleroots',
  ]);
  for (const [h, url, options] of mockRequest.mock.calls) {
    const c = getPrivacyContext(h);
    expect(c.subject).toEqual(subject);
    expect(c.isolationToken).not.toBe(getPrivacyContext(handle).isolationToken);
    expect(url).toBe('https://ppoi.fdi.network');
    expect(JSON.parse(options.body).params).toMatchObject({
      chainType: '0',
      chainID: '11155111',
      txidVersion: 'V2_PoseidonMerkle',
    });
  }
  expect(client.submit).toBeUndefined();
  const again = await client.acquire();
  expect(() => client.assertResult(receipt)).toThrow();
  expect(client.assertResult(again.receipt)).toBe(again.observation);
  expect(() => client.assertResult({})).toThrow();
});
test.each(['Missing', 'ShieldBlocked', 'ProofSubmitted'])(
  'advisory %s never fetches proofs or grants membership',
  async (value) => {
    replyStatus = value;
    const result = await open().acquire();
    expect(result.observation).toMatchObject({
      proofs: null,
      rootsAccepted: false,
      membershipVerified: false,
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  }
);
test('negative root acceptance stays negative', async () => {
  accepted = false;
  const result = await open().acquire();
  expect(source.assertResult(result.receipt).rootsAccepted).toBe(false);
});
test.each(['error', 'id', 'http', 'large', 'json', 'field', 'root-type'])(
  'invalid %s reply closes and sanitizes the error',
  async (kind) => {
    const normal = mockRequest.getMockImplementation();
    mockRequest.mockImplementation(async (...args) => {
      const reply = await normal(...args),
        value = JSON.parse(reply.body);
      if (kind === 'error') value.error = { message: 'sensitive remote payload' };
      if (kind === 'id') value.id = 'other';
      if (kind === 'http') reply.status = 302;
      if (kind === 'field') value.result = { extra: 'no' };
      if (
        kind === 'root-type' &&
        JSON.parse(args[2].body).method === 'ppoi_validate_poi_merkleroots'
      )
        value.result = 'true';
      reply.body =
        kind === 'large'
          ? Buffer.alloc(32769)
          : Buffer.from(kind === 'json' ? '{' : JSON.stringify(value));
      return reply;
    });
    const client = open();
    await expect(client.acquire()).rejects.toThrow('Railgun POI source unavailable');
    expect(client.signal.aborted).toBe(true);
    expect(mockClose).toHaveBeenCalledTimes(1);
  }
);
test.each(['lock', 'endpoint', 'overlap'])(
  'in-flight %s cannot expose stale observations',
  async (kind) => {
    const normal = mockRequest.getMockImplementation();
    let release;
    mockRequest.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return normal(...args);
    });
    const client = open(),
      pending = client.acquire();
    if (kind === 'overlap') {
      await expect(client.acquire()).rejects.toThrow();
      release();
      expect((await pending).observation.rootsAccepted).toBe(true);
    } else {
      const refused = expect(pending).rejects.toThrow();
      if (kind === 'lock') scope.close();
      else mockEndpoint = { signal: new AbortController().signal };
      release();
      await refused;
    }
  }
);
test('receipts expire, reject clock rollback, and are tied to this client', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const client = open(),
    result = await client.acquire();
  now = 99;
  expect(() => client.assertResult(result.receipt)).toThrow();
  now = 100 + MAX_AGE_MS;
  expect(() => client.assertResult(result.receipt)).toThrow();
  now = 100;
  const other = createRailgunPoiSource({ handle, notes });
  expect(() => other.assertResult(result.receipt)).toThrow();
  other.close();
  client.close();
  expect(() => client.assertResult(result.receipt)).toThrow();
});
test('receipt freshness starts before the first status request and enforces remaining margins', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (...args) => {
    now += 5000;
    return normal(...args);
  });
  const client = open(),
    result = await client.acquire();
  expect(now).toBe(20100);
  now = 40100;
  expect(client.assertResult(result.receipt, 19999)).toBe(result.observation);
  expect(() => client.assertResult(result.receipt, 20000)).toThrow();
  for (const margin of [-1, 0.5, 60000, NaN])
    expect(() => client.assertResult(result.receipt, margin)).toThrow();
});
test('one 45-second acquisition budget covers all requests, not 45 seconds per reply', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (...args) => {
    now += 15000;
    return normal(...args);
  });
  await expect(open().acquire()).rejects.toThrow();
  expect(mockRequest).toHaveBeenCalledTimes(3);
  expect(mockRequest.mock.calls.map((v) => v[2].timeoutMs)).toEqual([45000, 30000, 15000]);
  expect(source.signal.aborted).toBe(true);
});
test('the total deadline aborts a stalled transport and clears its lifetime', async () => {
  jest.useFakeTimers();
  try {
    mockRequest.mockImplementation(
      (_h, _u, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
        })
    );
    const pending = open().acquire();
    const refused = expect(pending).rejects.toThrow('Railgun POI source unavailable');
    await jest.advanceTimersByTimeAsync(45000);
    await refused;
    expect(source.signal.aborted).toBe(true);
    expect(mockClose).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
test('a caller can shorten but never extend the whole acquisition budget', async () => {
  const client = open();
  for (const timeoutMs of [0, -1, 0.5, 45001, NaN])
    await expect(client.acquire({ timeoutMs })).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
  await client.acquire({ timeoutMs: 1234 });
  expect(mockRequest.mock.calls.every((v) => v[2].timeoutMs <= 1234)).toBe(true);
});
test('public sync, wrong chain, unscoped operations and stronger requirements are refused before I/O', () => {
  for (const change of [
    { kind: 'service' },
    { principal: 'railgun:65536' },
    { principal: 'railgun:00' },
    { chainId: 1 },
    { deployment: 'mainnet' },
    { role: 'public-services' },
    { operation: undefined },
  ]) {
    expect(() =>
      createRailgunPoiSource({ handle: scope.getContext({ ...subject, ...change }), notes })
    ).toThrow();
  }
  expect(() =>
    createRailgunPoiSource({ handle: scope.getContext(subject, { correctness: 'proof' }), notes })
  ).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});

const drainedTurn = () => new Promise((resolve) => setImmediate(resolve));
const drainGate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function heldTransport() {
  const exit = drainGate();
  const transport = { request: mockRequest, close: mockClose, closed: exit.promise };
  mockFactory.mockReturnValueOnce(transport);
  return { exit, transport };
}
test('healthy repeated acquisitions leave the single terminal promise pending until close', async () => {
  const client = open();
  const closed = client.closed;
  let drained = false;
  closed.then(() => {
    drained = true;
  });
  const first = await client.acquire();
  expect(client.assertResult(first.receipt)).toBe(first.observation);
  const second = await client.acquire();
  expect(client.assertResult(second.receipt)).toBe(second.observation);
  await drainedTurn();
  expect(drained).toBe(false);
  expect(client.closed).toBe(closed);
  client.close();
  client.close();
  expect(client.signal.aborted).toBe(true);
  await closed;
  expect(drained).toBe(true);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
test.each(['explicit', 'parent', 'tor'])(
  'unused source %s revocation waits the actual transport barrier',
  async (kind) => {
    const tor = new AbortController();
    mockEndpoint = { signal: tor.signal };
    const { exit } = heldTransport();
    const client = open();
    let drained = false;
    client.closed.then(() => {
      drained = true;
    });
    if (kind === 'explicit') client.close();
    if (kind === 'parent') scope.close();
    if (kind === 'tor') tor.abort();
    expect(client.signal.aborted).toBe(true);
    expect(mockClose).toHaveBeenCalledTimes(1);
    await drainedTurn();
    expect(drained).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
    exit.resolve();
    await client.closed;
    expect(drained).toBe(true);
  }
);
test.each(['request-first', 'transport-first'])(
  'source close drains ignored-cancellation request and transport independently: %s',
  async (order) => {
    const { exit } = heldTransport(),
      reply = drainGate();
    const normal = mockRequest.getMockImplementation();
    mockRequest.mockImplementationOnce(async (...args) => {
      await reply.promise;
      return normal(...args);
    });
    const client = open();
    let settled = false,
      drained = false;
    client.closed.then(() => {
      drained = true;
    });
    const pending = client.acquire().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    client.close();
    try {
      expect(mockRequest.mock.calls[0][2].signal.aborted).toBe(true);
      if (order === 'request-first') reply.resolve();
      else exit.resolve();
      await drainedTurn();
      expect(settled).toBe(false);
      expect(drained).toBe(false);
      expect(mockRequest).toHaveBeenCalledTimes(1);
      if (order === 'request-first') exit.resolve();
      else reply.resolve();
      expect(await pending).toMatchObject({ error: { code: 'RAILGUN_POI_SOURCE_REFUSED' } });
      await client.closed;
      expect(drained).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    } finally {
      reply.resolve();
      exit.resolve();
      await pending;
    }
  }
);
test.each(['json', 'status', 'signature', 'root'])(
  '%s response refusal waits transport drain after inner acquisition settles',
  async (fault) => {
    const { exit } = heldTransport();
    const normal = mockRequest.getMockImplementation();
    mockRequest.mockImplementation(async (...args) => {
      const reply = await normal(...args),
        method = JSON.parse(args[2].body).method;
      if (fault === 'json') reply.body = Buffer.from('{');
      if (fault === 'status' && method === 'ppoi_pois_per_list')
        reply.body = Buffer.from(JSON.stringify({ ...JSON.parse(reply.body), result: {} }));
      if (fault === 'signature' && method === 'ppoi_poi_events') {
        const value = JSON.parse(reply.body);
        value.result[0].signedPOIEvent.signature = '0'.repeat(128);
        reply.body = Buffer.from(JSON.stringify(value));
      }
      if (fault === 'root' && method === 'ppoi_validate_poi_merkleroots')
        reply.body = Buffer.from(JSON.stringify({ ...JSON.parse(reply.body), result: 'true' }));
      return reply;
    });
    const client = open();
    let settled = false;
    const pending = client.acquire().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    try {
      await drainedTurn();
      expect(client.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      exit.resolve();
      expect(await pending).toMatchObject({
        error: { code: 'RAILGUN_POI_SOURCE_REFUSED', message: 'Railgun POI source unavailable' },
      });
      await client.closed;
    } finally {
      exit.resolve();
      await pending;
    }
  }
);
test.each(['throw', 'falsy', 'reentrant'])(
  'synchronous %s request failure clears inner work before awaiting drain',
  async (mode) => {
    const { exit } = heldTransport();
    const client = open();
    mockRequest.mockImplementation(() => {
      if (mode === 'reentrant') {
        client.close();
        return Promise.resolve({ status: 200, body: Buffer.from('{}') });
      }
      if (mode === 'falsy') throw undefined;
      throw Error('PRIVATE transport failure');
    });
    let settled = false;
    const pending = client.acquire().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    try {
      await drainedTurn();
      expect(client.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(mockRequest).toHaveBeenCalledTimes(1);
      exit.resolve();
      expect(await pending).toMatchObject({ error: { code: 'RAILGUN_POI_SOURCE_REFUSED' } });
      await client.closed;
    } finally {
      exit.resolve();
      await pending;
    }
  }
);
test('overlapping and malformed acquisition refusals preserve admitted work and healthy lifetime', async () => {
  const reply = drainGate();
  const normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementationOnce(async (...args) => {
    await reply.promise;
    return normal(...args);
  });
  const client = open(),
    pending = client.acquire();
  try {
    await expect(client.acquire()).rejects.toMatchObject({ code: 'RAILGUN_POI_SOURCE_REFUSED' });
    await expect(client.acquire({ timeoutMs: 0 })).rejects.toMatchObject({
      code: 'RAILGUN_POI_SOURCE_REFUSED',
    });
    expect(client.signal.aborted).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  } finally {
    reply.resolve();
  }
  expect((await pending).observation.rootsAccepted).toBe(true);
  client.close();
  await client.closed;
});
test('deadline abort retains request and transport barriers without a self-wait', async () => {
  jest.useFakeTimers();
  const { exit } = heldTransport(),
    reply = drainGate();
  const normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementationOnce(async (...args) => {
    await reply.promise;
    return normal(...args);
  });
  const client = open();
  let settled = false;
  const pending = client.acquire({ timeoutMs: 10 }).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );
  try {
    await jest.advanceTimersByTimeAsync(10);
    expect(client.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    reply.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    exit.resolve();
    expect(await pending).toMatchObject({ error: { code: 'RAILGUN_POI_SOURCE_REFUSED' } });
    await client.closed;
  } finally {
    reply.resolve();
    exit.resolve();
    await pending;
    jest.useRealTimers();
  }
});
test('rejecting transport closure revokes the source but cannot become successful drain evidence', async () => {
  const transport = {
    request: mockRequest,
    close: mockClose,
    closed: Promise.reject(Error('PRIVATE impossible transport rejection')),
  };
  mockFactory.mockReturnValueOnce(transport);
  const client = open();
  let drained = false;
  client.closed.then(() => {
    drained = true;
  });
  await drainedTurn();
  expect(client.signal.aborted).toBe(true);
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(drained).toBe(false);
  client.close();
  await drainedTurn();
  expect(drained).toBe(false);
  expect(mockRequest).not.toHaveBeenCalled();
});
test('throwing synchronous transport close cannot bypass its held closure proof', async () => {
  const { exit } = heldTransport();
  mockClose.mockImplementation(() => {
    throw Error('PRIVATE close failure');
  });
  const client = open();
  let drained = false;
  client.closed.then(() => {
    drained = true;
  });
  expect(() => client.close()).not.toThrow();
  expect(client.signal.aborted).toBe(true);
  await drainedTurn();
  expect(drained).toBe(false);
  exit.resolve();
  await client.closed;
});
test('transport factory failure revokes its newly allocated scope before throwing', () => {
  const before = mockScopes.length;
  mockFactory.mockImplementationOnce(() => {
    throw Error('PRIVATE factory failure');
  });
  expect(open).toThrow();
  expect(mockScopes.length).toBe(before + 1);
  expect(mockScopes.at(-1).signal.aborted).toBe(true);
  expect(scope.signal.aborted).toBe(false);
  expect(mockRequest).not.toHaveBeenCalled();
});
test('a returned transport without the genuine closed contract is refused and closed', () => {
  mockFactory.mockReturnValueOnce({ request: mockRequest, close: mockClose });
  expect(open).toThrow();
  expect(mockScopes.at(-1).signal.aborted).toBe(true);
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockRequest).not.toHaveBeenCalled();
});

test('parent cancellation during transport construction closes the returned resource and refuses', async () => {
  const exit = drainGate();
  mockFactory.mockImplementationOnce(() => {
    scope.close();
    return { request: mockRequest, close: mockClose, closed: exit.promise };
  });
  expect(open).toThrow('Railgun POI source unavailable');
  expect(mockScopes.at(-1).signal.aborted).toBe(true);
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockRequest).not.toHaveBeenCalled();
  exit.resolve();
  await drainedTurn();
});
test('an already revoked parent refuses before transport construction', () => {
  scope.close();
  expect(open).toThrow();
  expect(mockFactory).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

const fixedPoiMethods = [
  'ppoi_pois_per_list',
  'ppoi_merkle_proofs',
  'ppoi_poi_events',
  'ppoi_validate_poi_merkleroots',
];
test.each(
  ['expired', 'revoked', 'throwing'].flatMap((mode) =>
    fixedPoiMethods.map((method, index) => [mode, method, index])
  )
)(
  'retained parent %s between source check and transport authentication admits no %s',
  async (mode, method, index) => {
    let now = 100,
      current = true,
      throwCurrent = false;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    scope.close();
    scope = createPrivacyScope({
      profileId: 'poi-parent-admission',
      signal: new AbortController().signal,
      isCurrent: () => {
        if (throwCurrent) throw Error('PRIVATE parent check');
        return current && now < 200;
      },
    });
    handle = scope.getContext(subject);
    const { exit } = heldTransport(),
      entered = drainGate(),
      admitted = [],
      normal = mockRequest.getMockImplementation();
    let retained,
      refusedAtTransport = false,
      revokedAtTransport = false;
    mockRequest.mockImplementation(async (childHandle, url, options) => {
      const next = JSON.parse(options.body).method;
      retained = childHandle;
      if (next === method) {
        // This runs after source.active(), at the actual transport admission
        // seam. No timer or explicit parent close triggers this lazy failure.
        if (mode === 'expired') now = 200;
        if (mode === 'revoked') current = false;
        if (mode === 'throwing') throwCurrent = true;
      }
      try {
        getPrivacyContext(childHandle);
        admitted.push(next);
      } catch (error) {
        refusedAtTransport = true;
        revokedAtTransport = source.signal.aborted;
        throw error;
      } finally {
        if (next === method) entered.resolve();
      }
      return normal(childHandle, url, options);
    });
    const client = open();
    let settled = false,
      drained = false;
    client.closed.then(() => {
      drained = true;
    });
    const pending = client.acquire().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    await entered.promise;
    try {
      await drainedTurn();
      expect(admitted).toEqual(fixedPoiMethods.slice(0, index));
      expect(refusedAtTransport).toBe(true);
      expect(revokedAtTransport).toBe(true);
      expect(client.signal.aborted).toBe(true);
      expect(() => getPrivacyContext(retained)).toThrow();
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledTimes(index + 1);
      expect(settled).toBe(false);
      expect(drained).toBe(false);
      exit.resolve();
      expect(await pending).toMatchObject({
        error: { code: 'RAILGUN_POI_SOURCE_REFUSED', message: 'Railgun POI source unavailable' },
      });
      await client.closed;
      expect(drained).toBe(true);
    } finally {
      exit.resolve();
      await pending;
    }
  }
);
test('transport authentication traverses a healthy retained parent for every fixed request', async () => {
  let visits = 0;
  scope.close();
  scope = createPrivacyScope({
    profileId: 'poi-parent-healthy',
    signal: new AbortController().signal,
    isCurrent: () => {
      visits++;
      return true;
    },
  });
  handle = scope.getContext(subject);
  const normal = mockRequest.getMockImplementation(),
    transportVisits = [];
  mockRequest.mockImplementation(async (retained, url, options) => {
    const before = visits;
    expect(retained).not.toBe(handle);
    expect(getPrivacyContext(retained).subject).toEqual(subject);
    transportVisits.push(visits - before);
    return normal(retained, url, options);
  });
  const result = await open().acquire();
  expect(result.observation.rootsAccepted).toBe(true);
  expect(transportVisits).toEqual([1, 1, 1, 1]);
  expect(source.signal.aborted).toBe(false);
  source.close();
  await source.closed;
});

test('parent predicate reentrantly closes itself during transport authentication without listener throw', async () => {
  scope.close();
  let closeInPredicate = false,
    authenticationError,
    signalAlreadyRevoked;
  scope = createPrivacyScope({
    profileId: 'poi-parent-reentrant',
    signal: new AbortController().signal,
    isCurrent: () => {
      if (closeInPredicate) scope.close();
      return true;
    },
  });
  handle = scope.getContext(subject);
  const { exit } = heldTransport(),
    entered = drainGate(),
    admitted = [];
  mockRequest.mockImplementation(async (retained, _url, options) => {
    closeInPredicate = true;
    try {
      getPrivacyContext(retained);
      admitted.push(JSON.parse(options.body).method);
    } catch (error) {
      authenticationError = error;
      signalAlreadyRevoked = source.signal.aborted;
      throw error;
    } finally {
      entered.resolve();
    }
  });
  const client = open();
  let settled = false;
  const pending = client
    .acquire()
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    .then((result) => {
      settled = true;
      return result;
    });
  await entered.promise;
  try {
    await drainedTurn();
    expect(authenticationError).toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    expect(signalAlreadyRevoked).toBe(true);
    expect(scope.signal.aborted).toBe(true);
    expect(admitted).toEqual([]);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    exit.resolve();
    expect(await pending).toMatchObject({ error: { code: 'RAILGUN_POI_SOURCE_REFUSED' } });
    await client.closed;
  } finally {
    exit.resolve();
    await pending;
  }
});
test('lazy stale parent after admission refuses post-response and retains transport drain', async () => {
  scope.close();
  let current = true;
  scope = createPrivacyScope({
    profileId: 'poi-parent-inflight',
    signal: new AbortController().signal,
    isCurrent: () => current,
  });
  handle = scope.getContext(subject);
  const { exit } = heldTransport(),
    entered = drainGate(),
    reply = drainGate(),
    admitted = [],
    normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (retained, url, options) => {
    getPrivacyContext(retained);
    admitted.push(JSON.parse(options.body).method);
    entered.resolve();
    await reply.promise;
    return normal(retained, url, options);
  });
  const client = open();
  let settled = false,
    drained = false;
  client.closed.then(() => {
    drained = true;
  });
  const pending = client
    .acquire()
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    .then((result) => {
      settled = true;
      return result;
    });
  await entered.promise;
  try {
    current = false;
    expect(scope.signal.aborted).toBe(false);
    expect(client.signal.aborted).toBe(false);
    expect(admitted).toEqual(['ppoi_pois_per_list']);
    reply.resolve();
    await drainedTurn();
    expect(client.signal.aborted).toBe(true);
    expect(scope.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(admitted).toEqual(['ppoi_pois_per_list']);
    exit.resolve();
    expect(await pending).toMatchObject({ error: { code: 'RAILGUN_POI_SOURCE_REFUSED' } });
    await client.closed;
    expect(drained).toBe(true);
  } finally {
    reply.resolve();
    exit.resolve();
    await pending;
  }
});
