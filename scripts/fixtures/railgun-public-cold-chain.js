/** Cold-installed synthetic transport below real RPC/constraints, never a capability issuer. */
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
const { Transaction } = require('ethers');
const { q, rpcLog, json } = require('./railgun-public-cold-data');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const URL = 'https://synthetic.invalid/railgun-public-cold-credit';
const lost = Symbol('accepted-response-loss');
function install({ chain, bytecodes, phase, mode }) {
  for (const file of [
    '../../src/main/networks/wallet-tor-transport',
    '../../src/main/networks/private-rpc',
    '../../src/main/wallet/private-transaction-network',
    '../../src/main/wallet/railgun-account-public',
    '../../src/main/wallet/railgun-shield-recovery',
    '../../src/main/wallet/railgun-kohaku-plugin',
  ])
    assert.equal(
      !!require.cache[require.resolve(file)],
      false,
      'Install cold transport before consumers'
    );
  const { getPrivacyContext } = require('../../src/main/networks/privacy-context');
  const transport = require('../../src/main/networks/wallet-tor-transport'),
    registry = require('../../src/main/networks/network-registry'),
    settings = require('../../src/main/settings-store'),
    tor = require('../../src/main/tor-manager');
  const saved = {
    factory: transport.createWalletTorTransport,
    network: registry.getNetwork,
    endpoints: registry.getEndpoints,
    sources: registry.getEndpointSources,
    available: settings.isWalletTorExperimentAvailable,
    endpoint: tor.getWalletSocksEndpoint,
  };
  const endpoint = new AbortController(),
    deployment = require('./railgun-shield-offline-deployment').createOfflineShieldDeployment(
      bytecodes
    );
  const activity = {
    attempted: { source: {}, deployment: {}, transaction: {} },
    validated: { source: {}, deployment: {}, transaction: {} },
    creates: 0,
    releases: 0,
    revokedGroups: 0,
    closes: 0,
    sends: 0,
    controlledLosses: 0,
    unexpected: 0,
  };
  const instances = [];
  const groups = new Map();
  let active = true,
    owner,
    send,
    hidden = false,
    badCipher = false,
    simulated;
  const count = (map, lane, method) => {
    map[lane][method] = (map[lane][method] ?? 0) + 1;
  };
  const revoke = (handle) => {
    const group = groups.get(handle);
    if (group) {
      group.signal.removeEventListener('abort', group.abort);
      groups.delete(handle);
      activity.revokedGroups++;
    }
  };
  registry.getNetwork = () => ({ access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } });
  registry.getEndpoints = () => [URL];
  registry.getEndpointSources = () => [{ keyed: false, coverage: { 11155111: URL } }];
  settings.isWalletTorExperimentAvailable = () => true;
  const descriptor = Object.freeze({ signal: endpoint.signal });
  tor.getWalletSocksEndpoint = () => descriptor;
  transport.createWalletTorTransport = () => {
    activity.creates++;
    assert.equal(activity.creates, 1);
    let pending = 0;
    let closed = false,
      resolveClosed;
    const drained = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const instance = {
      closed: drained,
      release(handle) {
        activity.releases++;
        revoke(handle);
      },
      close() {
        if (closed) return;
        closed = true;
        activity.closes++;
        for (const handle of [...groups.keys()]) revoke(handle);
        if (pending === 0) resolveClosed();
      },
      async request(handle, url, options) {
        let lane;
        try {
          assert.ok(active && !closed);
          const context = getPrivacyContext(handle),
            s = context.subject;
          assert.equal(options.signal.aborted, false);
          assert.equal(url, URL);
          assert.equal(options.method, 'POST');
          assert.equal(s.chainId, pins.chainId);
          lane =
            s.role === 'transaction-rpc'
              ? 'transaction'
              : s.operation === 'shield-preflight'
                ? 'deployment'
                : 'source';
          const call = JSON.parse(options.body);
          count(activity.attempted, lane, call.method);
          assert.deepEqual(Object.keys(call).sort(), ['id', 'jsonrpc', 'method', 'params']);
          assert.equal(call.jsonrpc, '2.0');
          assert.match(
            call.id,
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          );
          if (!groups.has(handle)) {
            const abort = () => revoke(handle);
            groups.set(handle, { signal: context.signal, abort, lane });
            context.signal.addEventListener('abort', abort, { once: true });
          }
          let result;
          if (lane === 'deployment') {
            assert.equal(phase, 'setup');
            assert.equal(s.role, 'protocol-rpc');
            assert.equal(s.kind, 'private-account');
            assert.equal(s.principal, 'railgun:0');
            assert.equal(s.protocol, 'railgun');
            assert.equal(s.deployment, 'sepolia');
            result = deployment.request(call);
          } else if (lane === 'source') {
            assert.equal(s.role, 'protocol-rpc');
            assert.equal(s.kind, 'private-account');
            assert.equal(s.principal, 'railgun:0');
            assert.equal(s.operation, null);
            assert.equal(s.protocol, 'railgun');
            assert.equal(s.deployment, 'sepolia');
            if (call.method === 'eth_chainId') {
              assert.deepEqual(call.params, []);
              result = q(pins.chainId);
            } else if (call.method === 'eth_getLogs') {
              const [filter] = call.params;
              assert.equal(call.params.length, 1);
              assert.deepEqual(Object.keys(filter).sort(), ['address', 'fromBlock', 'toBlock']);
              assert.equal(filter.address, pins.proxy);
              const from = Number(BigInt(filter.fromBlock)),
                to = Number(BigInt(filter.toBlock));
              assert.ok(from >= 0 && from <= to && to <= chain.latest);
              result = chain.logs
                .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
                .map(rpcLog);
            } else {
              assert.equal(call.method, 'eth_getBlockByNumber');
              assert.equal(call.params.length, 2);
              assert.equal(call.params[1], false);
              const n =
                call.params[0] === 'finalized' ? chain.finalized : Number(BigInt(call.params[0]));
              result = chain.headers[n];
              assert.ok(result);
            }
          } else {
            assert.equal(s.role, 'transaction-rpc');
            assert.equal(s.kind, 'public-address');
            assert.equal(s.principal, owner);
            assert.equal(s.operation, null);
            if (
              call.method === 'eth_chainId' ||
              call.method === 'eth_gasPrice' ||
              call.method === 'eth_blockNumber'
            ) {
              assert.deepEqual(call.params, []);
              result =
                call.method === 'eth_chainId'
                  ? q(pins.chainId)
                  : call.method === 'eth_gasPrice'
                    ? '0x64'
                    : q(chain.latest);
            } else if (
              ['eth_getCode', 'eth_getBalance', 'eth_getTransactionCount'].includes(call.method)
            ) {
              assert.equal(phase, 'setup');
              assert.match(call.params[0], /^0x[0-9a-f]{40}$/i);
              assert.equal(call.params[0].toLowerCase(), owner);
              assert.ok(['latest', 'pending'].includes(call.params[1]));
              assert.equal(call.params.length, 2);
              result =
                call.method === 'eth_getCode'
                  ? '0x'
                  : call.method === 'eth_getBalance'
                    ? '0xde0b6b3a7640000'
                    : '0x0';
            } else if (['eth_estimateGas', 'eth_call'].includes(call.method)) {
              assert.equal(phase, 'setup');
              const tx = call.params[0];
              assert.deepEqual(Object.keys(tx).sort(), ['data', 'from', 'to', 'value']);
              assert.equal(tx.from, owner);
              assert.equal(tx.to, pins.relayAdapt);
              require('../../src/main/wallet/railgun-shield-intent').shieldIntentBinding({
                ...tx,
                chainId: pins.chainId,
              });
              if (call.method === 'eth_estimateGas') {
                assert.equal(call.params.length, 1);
                assert.equal(simulated, undefined);
                simulated = structuredClone(tx);
                result = '0x493e0';
              } else {
                assert.equal(call.params.length, 2);
                assert.equal(call.params[1], 'latest');
                assert.deepEqual(tx, simulated);
                result = '0x';
              }
            } else if (call.method === 'eth_sendRawTransaction') {
              assert.equal(phase, 'setup');
              assert.equal(call.params.length, 1);
              assert.equal(activity.sends++, 0);
              assert.equal(typeof send, 'function');
              const tx = Transaction.from(call.params[0]);
              assert.equal(tx.from.toLowerCase(), owner);
              assert.equal(tx.data, simulated.data);
              assert.equal(tx.to.toLowerCase(), simulated.to);
              assert.equal(q(tx.value), simulated.value);
              await send(handle, tx);
              result = tx.hash.toLowerCase();
              count(activity.validated, lane, call.method);
              if (mode === 'lost-response') {
                activity.controlledLosses++;
                const error = Error('Synthetic accepted response unavailable');
                error[lost] = true;
                throw error;
              }
              return {
                status: 200,
                body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result })),
              };
            } else if (call.method === 'eth_getBlockByNumber') {
              assert.equal(call.params.length, 2);
              assert.equal(call.params[1], false);
              const n =
                call.params[0] === 'finalized' ? chain.finalized : Number(BigInt(call.params[0]));
              result = chain.headers[n];
              assert.ok(result);
            } else {
              assert.ok(
                ['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(call.method)
              );
              assert.deepEqual(call.params, [chain.transaction.hash]);
              result =
                call.method === 'eth_getTransactionByHash'
                  ? chain.transaction
                  : hidden
                    ? null
                    : chain.receipt;
              if (badCipher && call.method === 'eth_getTransactionReceipt') {
                result = structuredClone(result);
                const log = result.logs[0];
                // Alter one authenticated ciphertext byte, preserve valid ABI shape.
                const { Interface } = require('ethers');
                const a = new Interface([
                  require('../../src/main/wallet/railgun-shield-receipt').SHIELD_EVENT,
                ]);
                const decoded = a.decodeEventLog('Shield', log.data, log.topics);
                const bundle = [...decoded.shieldCiphertext[0].encryptedBundle];
                bundle[0] = '0x' + (BigInt(bundle[0]) ^ 1n).toString(16).padStart(64, '0');
                log.data = a.encodeEventLog('Shield', [
                  decoded.treeNumber,
                  decoded.startPosition,
                  decoded.commitments,
                  [[bundle, decoded.shieldCiphertext[0].shieldKey]],
                  decoded.fees,
                ]).data;
              }
            }
          }
          getPrivacyContext(handle);
          assert.equal(options.signal.aborted, false);
          count(activity.validated, lane, call.method);
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result })),
          };
        } catch (error) {
          if (!error?.[lost]) {
            activity.unexpected++;
            sticky.record(error, 'public-cold.transport');
          }
          throw error;
        }
      },
    };
    const rawRequest = instance.request;
    instance.request = (...args) => {
      pending++;
      let task;
      try {
        task = rawRequest(...args);
      } catch (error) {
        task = Promise.reject(error);
      }
      return Promise.resolve(task).finally(() => {
        pending--;
        if (closed && pending === 0) resolveClosed();
      });
    };
    instances.push(instance);
    return instance;
  };
  return Object.freeze({
    url: URL,
    setOwner(value) {
      assert.equal(owner, undefined);
      assert.match(value, /^0x[0-9a-f]{40}$/);
      owner = value;
    },
    onSend(fn) {
      assert.equal(send, undefined);
      send = fn;
    },
    receiptVisibility(value) {
      hidden = !value;
    },
    corruptReceipt(value) {
      badCipher = value;
    },
    snapshot: () => JSON.parse(json(activity)),
    activeRecoveryGroups: () => [...groups.values()].filter((g) => g.lane === 'transaction').length,
    async close() {
      active = false;
      endpoint.abort();
      for (const instance of instances) instance.close();
      await Promise.all(instances.map((instance) => instance.closed));
      transport.createWalletTorTransport = saved.factory;
      registry.getNetwork = saved.network;
      registry.getEndpoints = saved.endpoints;
      registry.getEndpointSources = saved.sources;
      settings.isWalletTorExperimentAvailable = saved.available;
      tor.getWalletSocksEndpoint = saved.endpoint;
    },
  });
}
module.exports = { install, URL };
