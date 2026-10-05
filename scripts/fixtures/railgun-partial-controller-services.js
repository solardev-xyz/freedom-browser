/** Offline service boundary only. Account/POI/preflight/RPC capabilities remain
 * production objects. Chain state and service-key trust are synthetic. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Interface, toBeHex } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { createOfflineShieldDeployment } = require('./railgun-shield-offline-deployment');
const hash = (n) => toBeHex(BigInt(n), 32);
const quantity = (n) => '0x' + BigInt(n).toString(16);
const blockHash = (n) => hash(BigInt(n) + 1000n);
const copy = (v) => JSON.parse(JSON.stringify(v));
const abi = new Interface([
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function unshieldFee() view returns (uint120)',
  'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
]);
let installed = false;
exports.install = function install({ bytecodes, artifactDirectory, source, anchor }) {
  assert.equal(installed, false);
  installed = true;
  assert.ok(path.isAbsolute(artifactDirectory));
  assert.ok(Number.isSafeInteger(anchor.number) && anchor.number >= 5944700);
  assert.equal(anchor.hash, blockHash(anchor.number));
  const publicAnchor = copy(anchor);
  const logs = copy(source.logs);
  assert.ok(Array.isArray(logs) && logs.length > 0 && logs.length <= 1000);
  for (const log of logs) {
    assert.ok(Number.isSafeInteger(log.blockNumber) && log.blockNumber <= publicAnchor.number);
    assert.equal(log.address.toLowerCase(), pins.proxy);
    assert.equal(log.blockHash, blockHash(log.blockNumber));
  }
  for (const filename of [
    '../../src/main/networks/private-rpc',
    '../../src/main/wallet/railgun-public-services',
    '../../src/main/wallet/railgun-poi-source',
    '../../src/main/wallet/railgun-poi-root',
    '../../src/main/wallet/railgun-account-poi',
    '../../src/main/wallet/railgun-private-preflight',
    '../../src/main/wallet/railgun-private-operation',
  ])
    assert.equal(require.cache[require.resolve(filename)], undefined);
  const {
    createPrivacyScope,
    getPrivacyContext,
  } = require('../../src/main/networks/privacy-context');
  const deployment = createOfflineShieldDeployment(bytecodes);
  const manifest = require('../../src/main/wallet/railgun-artifacts').manifest;
  const verifiers = {};
  for (const variant of ['01x01', '01x02']) {
    const entry = manifest[variant].find((v) => v.kind === 'vkey');
    const bytes = fs.readFileSync(path.join(artifactDirectory, entry.name));
    assert.equal(bytes.length, entry.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    const value = JSON.parse(bytes.toString());
    const g1 = (p) => ({ x: BigInt(p[0]), y: BigInt(p[1]) });
    const g2 = (p) => ({
      x: [BigInt(p[0][1]), BigInt(p[0][0])],
      y: [BigInt(p[1][1]), BigInt(p[1][0])],
    });
    verifiers[variant] = abi
      .encodeFunctionResult('getVerificationKey', [
        {
          artifactsIPFSHash: 'offline-pinned-' + variant,
          alpha1: g1(value.vk_alpha_1),
          beta2: g2(value.vk_beta_2),
          gamma2: g2(value.vk_gamma_2),
          delta2: g2(value.vk_delta_2),
          ic: value.IC.map(g1),
        },
      ])
      .toLowerCase();
  }
  const signature = require('./railgun-own-poi-membership-signature').install();
  const {
    REQUIRED_LIST,
    normalizePoiProofs,
  } = require('../../src/main/wallet/railgun-poi-records');
  const transport = require('../../src/main/networks/wallet-tor-transport');
  const registry = require('../../src/main/networks/network-registry');
  const tor = require('../../src/main/tor-manager');
  const settings = require('../../src/main/settings-store');
  const original = {
    transport: transport.createWalletTorTransport,
    network: registry.getNetwork,
    endpoints: registry.getEndpoints,
    sources: registry.getEndpointSources,
    endpoint: tor.getWalletSocksEndpoint,
    available: settings.isWalletTorExperimentAvailable,
  };
  const endpointOwner = new AbortController();
  const endpoint = Object.freeze({ signal: endpointOwner.signal });
  const rpcUrl = 'https://synthetic.invalid/railgun-partial-controller';
  const poiMethods = Object.fromEntries(
    [
      'ppoi_pois_per_list',
      'ppoi_merkle_proofs',
      'ppoi_poi_events',
      'ppoi_validate_poi_merkleroots',
    ].map((v) => [v, 0])
  );
  const privatePreflightMethods = Object.fromEntries(
    ['rootHistory', 'unshieldFee', 'getVerificationKey', 'nullifiers'].map((v) => [v, 0])
  );
  const counts = {
    transportEntries: 0,
    unexpectedTransportFailures: 0,
    transportCreates: 0,
    transportCloses: 0,
    transportReleases: 0,
    pendingRequests: 0,
    poiRequests: 0,
    selectedNullifierQueries: 0,
    deploymentRequests: 0,
    publicScanRequests: 0,
    eoaRequests: 0,
    poiPathJobs: 0,
    poiPathExits: 0,
    poiPathGuardHooks: 0,
  };
  const clients = new Set();
  const verificationKeyQueries = [],
    privateCallOrder = [];
  let active = true,
    mode = 'healthy',
    selected,
    selectedTree,
    selectedRoot,
    submitter,
    note,
    proof;
  let accountIndex, internalAnchor, latest;
  const header = (number) => ({
    number: quantity(number),
    hash: blockHash(number),
    parentHash: number === 0 ? hash(0) : blockHash(number - 1),
    timestamp: quantity(Math.floor(Date.now() / 1000)),
  });
  const current = () => assert.ok(active);
  registry.getNetwork = () => ({ access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } });
  registry.getEndpoints = () => [rpcUrl];
  registry.getEndpointSources = () => [{ keyed: false, coverage: { 11155111: rpcUrl } }];
  tor.getWalletSocksEndpoint = () => endpoint;
  settings.isWalletTorExperimentAvailable = () => true;
  function publicRead(wire) {
    counts.publicScanRequests++;
    if (wire.method === 'eth_getBlockByNumber') {
      assert.equal(wire.params.length, 2);
      assert.equal(wire.params[1], false);
      const number =
        wire.params[0] === 'finalized' ? publicAnchor.number : Number(BigInt(wire.params[0]));
      assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= publicAnchor.number);
      return header(number);
    }
    assert.equal(wire.method, 'eth_getLogs');
    assert.equal(wire.params.length, 1);
    const filter = wire.params[0];
    assert.deepEqual(Object.keys(filter).sort(), ['address', 'fromBlock', 'toBlock']);
    assert.equal(filter.address, pins.proxy);
    const from = Number(BigInt(filter.fromBlock)),
      to = Number(BigInt(filter.toBlock));
    assert.ok(from >= 0 && to >= from && to <= publicAnchor.number && to - from < 100000);
    return logs
      .filter((v) => v.blockNumber >= from && v.blockNumber <= to)
      .map((v) => ({
        ...v,
        blockNumber: quantity(v.blockNumber),
        transactionIndex: quantity(v.transactionIndex),
        logIndex: quantity(v.logIndex),
        removed: false,
      }));
  }
  function deploymentRead(wire) {
    counts.deploymentRequests++;
    if (wire.method === 'eth_getBlockByNumber') {
      assert.deepEqual(wire.params, [wire.params[0], false]);
      if (wire.params[0] === 'latest') {
        internalAnchor = deployment.request(wire);
        latest = header(11834513);
      } else assert.equal(wire.params[0], latest?.number);
      return latest;
    }
    assert.ok(internalAnchor && latest);
    assert.deepEqual(wire.params.at(-1), { blockHash: latest.hash, requireCanonical: true });
    const translated = copy(wire);
    translated.params[translated.params.length - 1] = {
      blockHash: internalAnchor.hash,
      requireCanonical: true,
    };
    return deployment.request(translated);
  }
  function preflightRead(wire) {
    assert.ok(selected && latest);
    if (wire.method === 'eth_getBlockByNumber') {
      assert.deepEqual(wire.params, [latest.number, false]);
      return latest;
    }
    assert.equal(wire.method, 'eth_call');
    assert.equal(wire.params.length, 2);
    assert.deepEqual(wire.params[1], { blockHash: latest.hash, requireCanonical: true });
    assert.deepEqual(Object.keys(wire.params[0]).sort(), ['data', 'to']);
    assert.equal(wire.params[0].to, pins.proxy);
    const call = abi.parseTransaction(wire.params[0]);
    assert.ok(Object.hasOwn(privatePreflightMethods, call.name));
    privatePreflightMethods[call.name]++;
    if (call.name === 'getVerificationKey') {
      verificationKeyQueries.push([...call.args].map(Number));
      privateCallOrder.push('getVerificationKey:' + [...call.args].join(':'));
      assert.deepEqual([...call.args], [1n, 2n]);
      return verifiers[mode === 'wrong-verifier' ? '01x01' : '01x02'];
    }
    privateCallOrder.push(call.name);
    if (call.name === 'unshieldFee') {
      assert.equal(call.args.length, 0);
      return abi.encodeFunctionResult(call.name, [25n]);
    }
    assert.deepEqual(
      [...call.args],
      [BigInt(selectedTree), call.name === 'rootHistory' ? selectedRoot : selected.nullifier]
    );
    if (call.name === 'nullifiers') counts.selectedNullifierQueries++;
    return abi.encodeFunctionResult(call.name, [call.name === 'rootHistory']);
  }
  function poiRead(wire, client) {
    assert.ok(note && proof && Object.hasOwn(poiMethods, wire.method));
    counts.poiRequests++;
    poiMethods[wire.method]++;
    assert.equal(wire.method, Object.keys(poiMethods)[client.poiCursor++ % 4]);
    const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
    if (wire.method === 'ppoi_pois_per_list') {
      assert.deepEqual(wire.params, {
        ...base,
        listKeys: [REQUIRED_LIST],
        blindedCommitmentDatas: [note],
      });
      return { [note.blindedCommitment]: { [REQUIRED_LIST]: 'Valid' } };
    }
    if (wire.method === 'ppoi_merkle_proofs') {
      assert.deepEqual(wire.params, {
        ...base,
        listKey: REQUIRED_LIST,
        blindedCommitments: [note.blindedCommitment],
      });
      const result = copy(proof);
      if (mode === 'bad-membership')
        result.elements[0] = hash(BigInt('0x' + result.elements[0]) + 1n).slice(2);
      return [result];
    }
    if (wire.method === 'ppoi_poi_events') {
      const index = Number(BigInt('0x' + proof.indices));
      assert.deepEqual(wire.params, {
        ...base,
        listKey: REQUIRED_LIST,
        startIndex: index,
        endIndex: index,
      });
      const event = { index, blindedCommitment: note.blindedCommitment, type: note.type };
      return [
        {
          signedPOIEvent: { ...event, signature: signature.sign(event) },
          validatedMerkleroot: proof.root,
        },
      ];
    }
    assert.deepEqual(wire.params, {
      ...base,
      listKey: REQUIRED_LIST,
      poiMerkleroots: [proof.root],
    });
    return true;
  }
  transport.createWalletTorTransport = () => {
    current();
    counts.transportCreates++;
    let closed = false,
      pending = 0,
      resolveClosed;
    const drained = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const finish = () => {
      if (closed && pending === 0) resolveClosed();
    };
    const client = {
      poiCursor: 0,
      closed: drained,
      // The real RPC transport is shared across contexts. Releasing a context
      // has no socket work in this fixture and must not close the shared client
      // or inspect a privacy scope which the caller has already revoked.
      release(_handle) {
        counts.transportReleases++;
      },
      close() {
        if (!closed) counts.transportCloses++;
        closed = true;
        finish();
      },
      async request(handle, url, options) {
        counts.transportEntries++;
        pending++;
        counts.pendingRequests++;
        try {
          current();
          assert.equal(closed, false);
          assert.equal(options.signal.aborted, false);
          const { subject } = getPrivacyContext(handle);
          assert.equal(options.method, 'POST');
          const wire = JSON.parse(options.body);
          assert.deepEqual(Object.keys(wire).sort(), ['id', 'jsonrpc', 'method', 'params']);
          assert.equal(wire.jsonrpc, '2.0');
          assert.equal(typeof wire.id, 'string');
          assert.equal(subject.chainId, pins.chainId);
          let result;
          if (subject.role === 'poi') {
            assert.equal(url, 'https://ppoi.fdi.network');
            assert.equal(subject.kind, 'private-account');
            assert.equal(subject.protocol, 'railgun');
            assert.equal(subject.deployment, 'sepolia');
            assert.equal(subject.principal, 'railgun:' + accountIndex);
            assert.match(subject.operation, /^poi:[0-9a-f]{64}$/);
            client.operation ??= subject.operation;
            assert.equal(subject.operation, client.operation);
            result = poiRead(wire, client);
          } else {
            assert.equal(url, rpcUrl);
            assert.ok(Array.isArray(wire.params));
            if (subject.role === 'protocol-rpc') {
              assert.equal(subject.kind, 'private-account');
              assert.equal(subject.protocol, 'railgun');
              assert.equal(subject.deployment, 'sepolia');
              assert.match(subject.principal, /^railgun:(0|[1-9][0-9]{0,4})$/);
              if (accountIndex !== undefined)
                assert.equal(subject.principal, 'railgun:' + accountIndex);
              assert.ok(
                [null, 'shield-preflight', 'private-preflight'].includes(subject.operation)
              );
            } else {
              assert.equal(subject.role, 'transaction-rpc');
              assert.equal(subject.kind, 'public-address');
              assert.equal(subject.principal, submitter);
              assert.equal(subject.operation, null);
            }
            if (wire.method === 'eth_chainId') {
              assert.deepEqual(wire.params, []);
              result = '0xaa36a7';
            } else if (subject.role === 'protocol-rpc') {
              assert.equal(subject.kind, 'private-account');
              assert.equal(subject.protocol, 'railgun');
              assert.equal(subject.deployment, 'sepolia');
              if (subject.operation === 'shield-preflight') result = deploymentRead(wire);
              else if (subject.operation === 'private-preflight') result = preflightRead(wire);
              else {
                assert.equal(subject.operation, null);
                result = publicRead(wire);
              }
            } else {
              assert.equal(subject.role, 'transaction-rpc');
              assert.equal(subject.kind, 'public-address');
              assert.equal(subject.principal, submitter);
              assert.equal(subject.operation, null);
              assert.ok(['eth_getCode', 'eth_getBalance'].includes(wire.method));
              assert.deepEqual(wire.params, [submitter, 'pending']);
              counts.eoaRequests++;
              result = wire.method === 'eth_getCode' ? '0x' : '0xde0b6b3a7640000';
            }
          }
          current();
          assert.equal(options.signal.aborted, false);
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
          };
        } catch (error) {
          counts.unexpectedTransportFailures++;
          throw error;
        } finally {
          pending--;
          counts.pendingRequests--;
          finish();
        }
      },
    };
    clients.add(client);
    return client;
  };
  return Object.freeze({
    async setSelected({ archive, enrollment, record, merkleRoot, submitter: owner }) {
      current();
      assert.equal(selected, undefined);
      assert.match(merkleRoot, /^0x[0-9a-f]{64}$/);
      assert.match(owner, /^0x[0-9a-f]{40}$/);
      selected = copy(record);
      assert.match(selected.id, /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/);
      selectedTree = Number(selected.id.split(':')[0]);
      assert.ok(Number.isSafeInteger(selectedTree) && selectedTree < 65536);
      selectedRoot = merkleRoot;
      submitter = owner;
      note = { blindedCommitment: selected.blindedCommitment, type: selected.type };
      const parent = getPrivacyContext(enrollment.getContext('engine'));
      accountIndex = Number(parent.subject.principal.slice('railgun:'.length));
      const scope = createPrivacyScope({ profileId: parent.profileId, signal: parent.signal });
      let task, result;
      try {
        counts.poiPathJobs++;
        task = require('../../src/main/wallet/railgun-process').startRailgunProcess({
          handle: scope.getContext({
            ...parent.subject,
            operation: 'partial-controller-poi-fixture',
          }),
          filename: require.resolve('./railgun-partial-controller-poi-input-job'),
          input: JSON.stringify({ archive, note }),
          startupMs: 30000,
          lifetimeMs: 60000,
          broker: {
            signal: scope.signal,
            dispatch: async (wire) => {
              assert.equal(result, undefined);
              assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 8192);
              const message = JSON.parse(wire);
              assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
              assert.equal(message.id, 1);
              assert.equal(message.method, 'result');
              result = message.value;
              assert.deepEqual(Object.keys(result).sort(), ['guards', 'inventory', 'proof']);
              assert.equal(
                result.inventory,
                require('../../src/main/wallet/railgun-engine-manifest.json').inventory.sha256
              );
              assert.equal(result.guards.attempts, 0);
              assert.ok(Array.isArray(result.guards.hooks) && result.guards.hooks.length > 0);
              assert.equal(result.guards.canaries, result.guards.hooks.length);
              assert.equal(new Set(result.guards.hooks).size, result.guards.hooks.length);
              counts.poiPathGuardHooks = result.guards.hooks.length;
              normalizePoiProofs([result.proof], [note]);
              return JSON.stringify({ id: 1, value: null });
            },
          },
        });
        await task.ready;
        assert.ok(result);
        assert.ok(!scope.signal.aborted);
        current();
        task.close();
        assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
        counts.poiPathExits++;
        proof = copy(result.proof);
      } finally {
        try {
          task?.close();
        } finally {
          await task?.closed;
          scope.close();
        }
      }
    },
    setMode(next) {
      current();
      assert.ok(['healthy', 'wrong-verifier', 'bad-membership'].includes(next));
      mode = next;
    },
    report: () => ({
      ...counts,
      poiMethods: { ...poiMethods },
      privatePreflightMethods: { ...privatePreflightMethods },
      verificationKeyQueries: copy(verificationKeyQueries),
      privateCallOrder: [...privateCallOrder],
      signatureChecks: signature.attempts(),
      publicBytecodeMatchesPins: deployment.report().publicBytecodeMatchesPins,
      publicBytecodeInputSha256: deployment.report().inputSha256,
      pinnedVerifierArtifacts: true,
      syntheticChainAndServiceTrust: true,
      torSettingForcedForOfflineFixture: true,
      listRootAcceptanceSimulated: true,
      servicePublicKeyReplacedWithEphemeralFixtureKey: true,
      realTorOrLiveServicesQualified: false,
    }),
    async close() {
      if (!active) return;
      active = false;
      endpointOwner.abort();
      for (const client of clients) client.close();
      await Promise.all([...clients].map((client) => client.closed));
      transport.createWalletTorTransport = original.transport;
      registry.getNetwork = original.network;
      registry.getEndpoints = original.endpoints;
      registry.getEndpointSources = original.sources;
      tor.getWalletSocksEndpoint = original.endpoint;
      settings.isWalletTorExperimentAvailable = original.available;
      signature.close();
    },
  });
};
