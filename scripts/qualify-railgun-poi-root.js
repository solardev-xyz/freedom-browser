/** Native host lifecycle with a counted in-memory service, public synthetic
 * roots and real privacy scopes/timers. No Tor socket or remote request.
 * Usage: electron script NEW_DIRECTORY
 */
const { app, net } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function main() {
  const [directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 3);
  assert.ok(path.isAbsolute(directory) && !fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const guard = require('../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
    electronNet: net,
    onRefusal() {},
  });
  const sources = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-poi-root.js',
    'src/main/wallet/railgun-poi-root.js',
    'src/main/wallet/railgun-poi-root.test.js',
    'src/main/wallet/railgun-poi-records.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/networks/privacy-context.js',
    'src/main/networks/wallet-tor-transport.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      sources.map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', name)))
          .digest('hex'),
      ])
    );
  const before = hashes(),
    started = performance.now();
  const transport = require('../src/main/networks/wallet-tor-transport'),
    tor = require('../src/main/tor-manager'),
    settings = require('../src/main/settings-store');
  assert.equal(require.cache[require.resolve('../src/main/wallet/railgun-poi-root')], undefined);
  const originals = {
    transport: transport.createWalletTorTransport,
    endpoint: tor.getWalletSocksEndpoint,
    enabled: settings.isWalletTorExperimentAvailable,
  };
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
  const { REQUIRED_LIST } = require('../src/main/wallet/railgun-poi-records');
  const root = '1'.padStart(64, '0');
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'poi',
    operation: 'poi:' + 'a'.repeat(64),
  };
  let endpoint,
    scope,
    source,
    hold,
    mode = 'valid';
  let creates = 0,
    closes = 0,
    requests = 0,
    validatedRequests = 0,
    pendingRequests = 0;
  const clients = new Set(),
    operations = new Set(),
    runs = [];
  settings.isWalletTorExperimentAvailable = () => true;
  tor.getWalletSocksEndpoint = () => endpoint;
  transport.createWalletTorTransport = () => {
    creates++;
    let closed = false;
    const client = {
      close() {
        if (!closed) closes++;
        closed = true;
      },
      async request(handle, url, options) {
        requests++;
        assert.equal(closed, false);
        assert.equal(url, 'https://ppoi.fdi.network');
        assert.deepEqual(getPrivacyContext(handle).subject, subject);
        assert.notEqual(
          getPrivacyContext(handle).isolationToken,
          getPrivacyContext(scope.getContext(subject)).isolationToken
        );
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.headers, { 'content-type': 'application/json' });
        assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
        assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 45000);
        const body = JSON.parse(options.body);
        assert.equal(typeof body.id, 'string');
        assert.deepEqual(body, {
          jsonrpc: '2.0',
          id: body.id,
          method: 'ppoi_validate_poi_merkleroots',
          params: {
            chainType: '0',
            chainID: '11155111',
            txidVersion: 'V2_PoseidonMerkle',
            listKey: REQUIRED_LIST,
            poiMerkleroots: [root],
          },
        });
        validatedRequests++;
        pendingRequests++;
        try {
          if (hold) await hold.promise; // Deliberately ignore abort until released.
          const reply = {
            jsonrpc: '2.0',
            id: mode === 'id' ? 'wrong' : body.id,
            result: mode !== 'false',
          };
          if (mode === 'extra') reply.extra = true;
          if (mode === 'error') {
            delete reply.result;
            reply.error = { code: -1, message: 'synthetic error' };
          }
          return {
            status: mode === 'http' ? 503 : 200,
            body:
              mode === 'oversized' ? Buffer.alloc(4097, 32) : Buffer.from(JSON.stringify(reply)),
          };
        } finally {
          pendingRequests--;
        }
      },
    };
    clients.add(client);
    return client;
  };
  const { createRailgunPoiRootSource } = require('../src/main/wallet/railgun-poi-root');
  const open = () => {
    const controller = new AbortController();
    endpoint = { signal: controller.signal };
    scope = createPrivacyScope({
      profileId: 'synthetic-poi-root',
      signal: new AbortController().signal,
    });
    source = createRailgunPoiRootSource({ handle: scope.getContext(subject), root });
    return controller;
  };
  const close = async () => {
    source.close();
    await source.closed;
    scope.close();
    assert.equal(pendingRequests, 0);
  };
  const acquire = (options) => {
    const work = source.acquire(options);
    operations.add(work);
    work.then(
      () => operations.delete(work),
      () => operations.delete(work)
    );
    return work;
  };
  try {
    open();
    const first = await acquire();
    assert.equal(source.assertResult(first.receipt), first.observation);
    assert.equal(first.observation.trust, 'unverified-service');
    assert.equal(first.observation.membershipVerified, false);
    assert.equal(first.observation.disclosureEnabled, false);
    assert.equal(first.observation.spendingEnabled, false);
    assert.ok(
      Object.isFrozen(first) && Object.isFrozen(first.receipt) && Object.isFrozen(first.observation)
    );
    assert.throws(() => source.assertResult({}), { code: 'RAILGUN_POI_ROOT_REFUSED' });
    const second = await acquire();
    assert.throws(() => source.assertResult(first.receipt));
    assert.equal(source.assertResult(second.receipt), second.observation);
    await close();
    runs.push({ mode: 'accepted-renewed-forgery-refused', requests: 2, drained: true });
    for (mode of ['false', 'id', 'extra', 'error', 'http', 'oversized']) {
      open();
      await assert.rejects(acquire(), {
        code: mode === 'false' ? 'RAILGUN_POI_ROOT_REJECTED' : 'RAILGUN_POI_ROOT_REFUSED',
      });
      assert.equal(source.signal.aborted, true);
      await close();
      runs.push({ mode, refused: true, drained: true });
    }
    mode = 'valid';
    open();
    hold = deferred();
    const one = acquire();
    await assert.rejects(acquire(), { code: 'RAILGUN_POI_ROOT_REFUSED' });
    assert.equal(source.signal.aborted, false);
    hold.resolve();
    const admitted = await one;
    assert.equal(source.assertResult(admitted.receipt), admitted.observation);
    hold = undefined;
    await close();
    runs.push({ mode: 'overlap-preserves-pending-read', drained: true });
    for (const cancellation of [
      'explicit-close',
      'parent-close',
      'endpoint-abort',
      'endpoint-change',
      'timeout',
    ]) {
      const endpointController = open();
      assert.equal(source.signal.aborted, false);
      hold = deferred();
      const workStarted = performance.now();
      let revokedAt;
      source.signal.addEventListener('abort', () => (revokedAt = performance.now()), {
        once: true,
      });
      const work = acquire(cancellation === 'timeout' ? { timeoutMs: 30 } : undefined);
      let closedSettled = false,
        workSettled = false;
      source.closed.then(() => (closedSettled = true));
      work.then(
        () => (workSettled = true),
        () => (workSettled = true)
      );
      if (cancellation === 'explicit-close') source.close();
      if (cancellation === 'parent-close') scope.close();
      if (cancellation === 'endpoint-abort') endpointController.abort();
      if (cancellation === 'endpoint-change') endpoint = { signal: new AbortController().signal };
      if (cancellation === 'timeout') {
        await new Promise((resolve) => setTimeout(resolve, 45));
        assert.ok(Number.isFinite(revokedAt));
        assert.ok(revokedAt - workStarted >= 29 && revokedAt - workStarted < 5000);
      }
      await Promise.resolve();
      assert.equal(closedSettled, false);
      assert.equal(workSettled, false);
      assert.equal(pendingRequests, 1);
      if (cancellation !== 'endpoint-change') assert.equal(source.signal.aborted, true);
      hold.resolve();
      await assert.rejects(work, { code: 'RAILGUN_POI_ROOT_REFUSED' });
      hold = undefined;
      await close();
      assert.equal(closedSettled, true);
      runs.push({
        mode: cancellation,
        refused: true,
        pendingTransportDrained: true,
        ...(cancellation === 'timeout'
          ? { timeoutMs: 30, revokedAfterMs: Math.round(revokedAt - workStarted) }
          : {}),
      });
    }
    assert.equal(runs.length, 13);
    assert.equal(requests, 14);
    assert.equal(validatedRequests, requests);
    assert.equal(creates, 13);
    assert.equal(closes, creates);
    const guards = guard.report();
    assert.equal(guards.attempts, 0);
    assert.equal(guards.canaries, guards.hooks.length);
    assert.ok(guards.hooks.length > 0);
    assert.deepEqual(hashes(), before);
    const report = {
      fixture: 'synthetic-poi-fixed-root-host',
      elapsedMs: Math.round(performance.now() - started),
      sourceSha256: before,
      runs,
      transportCreates: creates,
      transportCloses: closes,
      simulatedRequests: requests,
      validatedRequests,
      guards,
      realPrivacyScopesAndTimers: true,
      torSocketsExercised: false,
      accountEnrollmentExercised: false,
      membershipVerified: false,
      disclosureEnabled: false,
      spendingEnabled: false,
      liveQueries: 0,
      submissions: 0,
    };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ scenarios: runs.length, liveQueries: 0 }));
  } finally {
    source?.close();
    hold?.resolve();
    await Promise.allSettled([...operations]);
    if (source) await source.closed;
    scope?.close();
    for (const client of clients) client.close();
    transport.createWalletTorTransport = originals.transport;
    tor.getWalletSocksEndpoint = originals.endpoint;
    settings.isWalletTorExperimentAvailable = originals.enabled;
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
