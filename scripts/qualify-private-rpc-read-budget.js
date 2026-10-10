/** Offline Node/Electron RPC admission qualification. Actual privacy contexts and
 * private RPC; simulated registry, Tor endpoint and transport. No wallet or network.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const app = process.versions.electron ? require('electron').app : null;
const root = path.join(__dirname, '..');
const sources = [
  'scripts/qualify-private-rpc-read-budget.js',
  'src/main/networks/private-rpc.js',
  'src/main/networks/private-rpc-read-budget.test.js',
  'src/main/networks/privacy-context.js',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((name) => [
      name,
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, name)))
        .digest('hex'),
    ])
  );
let phase = 'setup';
function fail() {
  console.error(JSON.stringify({ failed: true, phase }));
  if (app) app.exit(1);
  else process.exit(1);
}
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const watchdog = setTimeout(fail, 60000);
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  if (app) await app.whenReady();
  const before = hashes(),
    started = performance.now(),
    runs = [];
  const modulePath = require.resolve('../src/main/networks/private-rpc');
  assert.equal(
    require.cache[modulePath],
    undefined,
    'RPC must be cold before fixture interception'
  );
  async function scenario(name, exercise) {
    phase = name;
    const lifetime = new AbortController(),
      tor = new AbortController();
    const scope = createPrivacyScope({ profileId: 'offline-rpc-budget', signal: lifetime.signal });
    const handle = scope.getContext({
      kind: 'private-account',
      protocol: 'railgun',
      deployment: 'sepolia',
      principal: 'railgun:0',
      chainId: 11155111,
      role: 'protocol-rpc',
    });
    const endpoint = { signal: tor.signal },
      url = 'https://rpc.example.test/offline-budget';
    const wires = [],
      budgets = [],
      originals = new Map();
    let factoryHook = () => {},
      responseHook = null,
      factories = 0;
    const response = (wire, result) => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
    });
    const intercept = (relative, exports) => {
      const file = require.resolve(relative);
      originals.set(file, require.cache[file]);
      require.cache[file] = { id: file, filename: file, loaded: true, exports };
    };
    intercept('../src/main/settings-store', { isWalletTorExperimentAvailable: () => true });
    intercept('../src/main/tor-manager', { getWalletSocksEndpoint: () => endpoint });
    intercept('../src/main/networks/network-registry', {
      getNetwork: () => ({}),
      getEndpoints: () => [url],
      getEndpointSources: () => [{ keyed: false, coverage: { 11155111: url } }],
    });
    intercept('../src/main/networks/wallet-tor-transport', {
      createWalletTorTransport: () => {
        factories++;
        factoryHook();
        return {
          release() {},
          request(_handle, destination, options) {
            assert.equal(_handle, handle);
            assert.equal(destination, url);
            const wire = JSON.parse(options.body);
            wires.push(wire);
            return responseHook
              ? responseHook(wire)
              : Promise.resolve(
                  response(
                    wire,
                    wire.method === 'eth_chainId' ? '0xaa36a7' : { number: wire.params[0] }
                  )
                );
          },
        };
      },
    });
    try {
      const api = require(modulePath),
        client = api.createPrivateRpc(handle, 'protocol-rpc');
      const create = (
        envelope = { headers: [{ tag: 'finalized', maxRequests: 1 }] },
        timeout = 5000
      ) => {
        const caller = new AbortController();
        const operation = api.createPrivateRpcReadBudget({
          client,
          handle,
          destination: api.getPrivateRpcDestination(client, handle),
          signal: caller.signal,
          deadline: performance.now() + timeout,
          envelope,
        });
        budgets.push(operation);
        return {
          ...operation,
          caller,
          outcome: () => api.getPrivateRpcReadBudgetOutcome(operation.budget),
        };
      };
      const read = (operation, tag = 'finalized', validate = () => true) =>
        client.request('eth_getBlockByNumber', [tag, false], validate, operation.budget);
      await exercise({
        create,
        read,
        client,
        api,
        handle,
        scope,
        tor,
        wires,
        response,
        onFactory: (hook) => {
          factoryHook = hook;
        },
        onResponse: (hook) => {
          responseHook = hook;
        },
      });
      for (const operation of budgets) operation.close();
      await Promise.all(budgets.map((operation) => operation.closed));
      runs.push({
        name,
        passed: true,
        factories,
        methods: Object.fromEntries(
          [...new Set(wires.map((wire) => wire.method))].map((method) => [
            method,
            wires.filter((wire) => wire.method === method).length,
          ])
        ),
      });
    } finally {
      scope.close();
      tor.abort();
      delete require.cache[modulePath];
      for (const [file, original] of originals) {
        if (original) require.cache[file] = original;
        else delete require.cache[file];
      }
    }
  }
  await scenario('idle-close-zero-admissions', async ({ create, wires }) => {
    const operation = create();
    operation.close();
    await operation.closed;
    assert.equal(operation.outcome().status, 'closed');
    assert.equal(wires.length, 0);
  });
  await scenario(
    'pre-dispatch-reentrant-cancellation',
    async ({ create, read, onFactory, wires }) => {
      const a = create(),
        b = create();
      let second;
      onFactory(() => {
        second = assert.rejects(read(b));
        a.caller.abort();
      });
      await assert.rejects(read(a));
      await second;
      await Promise.all([a.closed, b.closed]);
      assert.equal(wires.length, 0);
      assert.equal(a.outcome().integrityFailure, false);
      assert.equal(b.outcome().reason, 'shared-no-admission');
      assert.equal(b.outcome().integrityFailure, false);
    }
  );
  for (const invalid of [false, true]) {
    await scenario(
      invalid ? 'cancelled-shared-chain-integrity' : 'cancelled-shared-chain-healthy-waiter',
      async ({ create, read, onResponse, response, wires }) => {
        const gate = deferred(),
          a = create(),
          b = create();
        let second;
        onResponse((wire) => {
          if (wire.method !== 'eth_chainId') return Promise.resolve(response(wire, {}));
          second = invalid ? assert.rejects(read(b)) : read(b);
          a.caller.abort();
          return gate.promise.then(() => response(wire, invalid ? '0x1' : '0xaa36a7'));
        });
        const first = assert.rejects(read(a));
        let drained = false;
        a.closed.then(() => {
          drained = true;
        });
        await turn();
        assert.equal(drained, false);
        assert.equal(wires.length, 1);
        gate.resolve();
        await Promise.all([first, second]);
        b.close();
        await Promise.all([a.closed, b.closed]);
        assert.equal(a.outcome().admissions.chainId, 1);
        assert.equal(b.outcome().admissions.chainId, 0);
        assert.equal(a.outcome().integrityFailure, invalid);
        assert.equal(b.outcome().integrityFailure, invalid);
        assert.equal(wires.length, invalid ? 1 : 2);
      }
    );
  }
  await scenario(
    'detached-parameters-and-envelope',
    async ({ create, client, onResponse, response, wires }) => {
      const gate = deferred(),
        envelope = { headers: [{ tag: '0x1', maxRequests: 1 }] };
      const operation = create(envelope),
        params = ['0x1', false];
      onResponse((wire) =>
        wire.method === 'eth_chainId'
          ? gate.promise.then(() => response(wire, '0xaa36a7'))
          : Promise.resolve(response(wire, {}))
      );
      const pending = client.request('eth_getBlockByNumber', params, () => true, operation.budget);
      params[0] = '0x2';
      envelope.headers[0].tag = '0x2';
      gate.resolve();
      await pending;
      assert.deepEqual(wires[1].params, ['0x1', false]);
    }
  );
  await scenario('validator-integrity-dominates-cancellation', async ({ create, read, wires }) => {
    const operation = create();
    let validated = 0;
    await assert.rejects(
      read(operation, 'finalized', () => {
        validated++;
        operation.caller.abort();
        return false;
      })
    );
    await operation.closed;
    assert.equal(validated, 1);
    assert.equal(operation.caller.signal.aborted, true);
    assert.equal(wires.length, 2);
    assert.deepEqual(operation.outcome().admissions, {
      chainId: 1,
      headers: 1,
      eventHeaders: 0,
      logs: 0,
    });
    assert.equal(operation.outcome().integrityFailure, true);
  });
  await scenario('cancelled-validator-drains-before-close', async ({ create, read }) => {
    const operation = create(),
      entered = deferred(),
      gate = deferred();
    const pending = assert.rejects(
      read(operation, 'finalized', async () => {
        entered.resolve();
        await gate.promise;
        return true;
      })
    );
    await entered.promise;
    operation.caller.abort();
    let drained = false;
    operation.closed.then(() => {
      drained = true;
    });
    await turn();
    assert.equal(drained, false);
    assert.equal(operation.outcome().status, 'draining');
    gate.resolve();
    await pending;
    await operation.closed;
    assert.equal(operation.outcome().integrityFailure, false);
  });
  await scenario(
    'copied-token-refuses-without-poisoning',
    async ({ create, read, client, wires }) => {
      const operation = create();
      await assert.rejects(
        client.request('eth_getBlockByNumber', ['finalized', false], () => true, {
          ...operation.budget,
        })
      );
      assert.equal(wires.length, 0);
      assert.equal(operation.outcome().status, 'active');
      await read(operation);
      assert.equal(operation.outcome().integrityFailure, false);
    }
  );
  await scenario('unused-deadline-revokes', async ({ create, read, wires }) => {
    const operation = create(undefined, 20);
    await operation.closed;
    await assert.rejects(read(operation));
    assert.equal(operation.outcome().reason, 'expired');
    assert.equal(wires.length, 0);
  });
  await scenario('exact-and-event-quota-overlap', async ({ create, read, wires }) => {
    const operation = create({
      headers: [{ tag: '0x1', maxRequests: 2 }],
      eventHeaders: { fromBlock: '0x1', toBlock: '0x3', maxRequests: 2 },
    });
    for (const tag of ['0x1', '0x1', '0x1', '0x2']) await read(operation, tag);
    await assert.rejects(read(operation, '0x3'));
    assert.deepEqual(operation.outcome().admissions, {
      chainId: 1,
      headers: 2,
      eventHeaders: 2,
      logs: 0,
    });
    assert.equal(operation.outcome().integrityFailure, false);
    assert.equal(wires.length, 5);
  });
  await scenario('event-header-limit-512', async ({ create, read, wires }) => {
    const operation = create({
      headers: [],
      eventHeaders: { fromBlock: '0x0', toBlock: '0x200', maxRequests: 512 },
    });
    for (let height = 0; height < 512; height++) await read(operation, '0x' + height.toString(16));
    await assert.rejects(read(operation, '0x200'));
    assert.equal(operation.outcome().admissions.eventHeaders, 512);
    assert.equal(wires.length, 513);
    assert.equal(operation.outcome().integrityFailure, false);
  });
  await scenario('event-header-height-once', async ({ create, read, wires }) => {
    const operation = create({
      headers: [],
      eventHeaders: { fromBlock: '0x0', toBlock: '0x5', maxRequests: 5 },
    });
    await read(operation, '0x2');
    await assert.rejects(read(operation, '0x2'));
    assert.equal(operation.outcome().admissions.eventHeaders, 1);
    assert.equal(wires.length, 2);
    assert.equal(operation.outcome().integrityFailure, false);
  });
  for (const late of ['valid', 'malformed', 'wrong-chain', 'reject'])
    await scenario(
      'owner-revocation-late-' + late,
      async ({ create, read, scope, onResponse, response, wires }) => {
        const operation = create(),
          gate = deferred();
        onResponse((wire) =>
          gate.promise.then(() => {
            if (late === 'reject') throw new Error('synthetic late transport failure');
            if (late === 'malformed') return { status: 200, body: Buffer.from('{}') };
            return response(wire, late === 'wrong-chain' ? '0x1' : '0xaa36a7');
          })
        );
        const pending = assert.rejects(read(operation));
        assert.equal(wires.length, 1);
        scope.close();
        assert.equal(operation.outcome().status, 'draining');
        gate.resolve();
        await pending;
        await operation.closed;
        const outcome = operation.outcome();
        assert.equal(outcome.fatal, true);
        const integrityFailure = ['malformed', 'wrong-chain'].includes(late);
        assert.equal(
          outcome.failure,
          integrityFailure ? 'response' : late === 'reject' ? 'transport' : 'revoked'
        );
        assert.equal(outcome.integrityFailure, integrityFailure);
        assert.equal(wires.length, 1);
      }
    );
  await scenario(
    'transport-rejection-is-fatal-without-corruption-claim',
    async ({ create, read, onResponse, response, wires }) => {
      const operation = create();
      onResponse((wire) =>
        wire.method === 'eth_chainId'
          ? Promise.resolve(response(wire, '0xaa36a7'))
          : Promise.reject(
              Object.assign(new Error('synthetic transport refusal'), {
                code: 'PRIVATE_RPC_READ_BUDGET_REFUSED',
              })
            )
      );
      await assert.rejects(read(operation));
      await operation.closed;
      const outcome = operation.outcome();
      assert.equal(outcome.fatal, true);
      assert.equal(outcome.failure, 'transport');
      assert.equal(outcome.integrityFailure, false);
      assert.equal(wires.length, 2);
    }
  );
  assert.deepEqual(hashes(), before, 'qualification source changed during run');
  fs.writeFileSync(
    path.join(directory, 'report.json'),
    JSON.stringify(
      {
        version: 1,
        passed: true,
        runtime: process.versions,
        elapsedMs: Math.round(performance.now() - started),
        disclosureEnabled: false,
        spendingEnabled: false,
        registrySimulated: true,
        transportSimulated: true,
        circuitIsolationQualified: false,
        physicalSocketDrainQualified: false,
        sources: before,
        runs,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  clearTimeout(watchdog);
  console.log(JSON.stringify({ passed: true, scenarios: runs.length }));
  if (app) app.exit(0);
}
main().catch(fail);
