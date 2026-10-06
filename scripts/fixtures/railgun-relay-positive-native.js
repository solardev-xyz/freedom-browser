/** Opt-in public synthetic-list Shield composition. This runs only from the
 * reviewed isolated source copy; real cryptographic checks and owners remain. */
const native = require('./railgun-native-assertions');
const { assert } = native;
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const network = '../../src/main/networks/';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const SOURCE_SHA = 'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41';
const OFFSET = 5944700;
const THROUGH = OFFSET + 30;
const ANCHOR = OFFSET + 100;
const SCENARIOS = ['synthetic-list'];
const TEST_LIST = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';
const AUDIT_CASES = ['unmodified', 'signature', 'transaction-proof', 'pre-poi-proof'];
const hex = (v) => '0x' + v.toString(16).padStart(64, '0');
function select(flag, args, env) {
  if (flag === undefined) return null;
  assert.ok(SCENARIOS.includes(flag));
  assert.equal(args.length, 6);
  const [sourceFilename, directory, archive, composition, proverArchive, artifactDirectory] = args;
  assert.equal(composition, 'enrolled');
  for (const p of [sourceFilename, directory, archive, proverArchive, artifactDirectory])
    assert.ok(typeof p === 'string' && path.isAbsolute(p));
  for (const key of Object.keys(env))
    if (key.startsWith('FREEDOM_RAILGUN_') && key !== 'FREEDOM_RAILGUN_RELAY_POSITIVE')
      assert.equal(env[key], undefined);
  return { scenario: flag, sourceFilename, directory, archive, proverArchive, artifactDirectory };
}
function translate(bytes) {
  assert.equal(sha(bytes), SOURCE_SHA);
  const original = JSON.parse(bytes);
  assert.deepEqual(
    original.logs.map((v) => v.blockNumber),
    [10, 20, 30]
  );
  const logs = original.logs.map((v) => ({
    ...v,
    blockNumber: OFFSET + v.blockNumber,
    blockHash: hex(OFFSET + v.blockNumber + 1),
    transactionHash: hex(OFFSET + v.blockNumber + 1000),
  }));
  return { logs, originalSha256: sha(bytes), translatedSha256: sha(JSON.stringify(logs)) };
}
function ranges() {
  const values = [];
  for (let from = 0; from <= THROUGH; from += 100000)
    values.push({ from, to: Math.min(from + 99999, THROUGH) });
  assert.equal(values.length, 60);
  return values;
}
function installServices(logs, expectedNote, scenario, protocol) {
  assert.equal(scenario, 'synthetic-list');
  // Install only registry/transport leaves before the genuine RPC module captures them.
  assert.equal(!!require.cache[require.resolve(network + 'private-rpc')], false);
  for (const name of [
    'railgun-account-public',
    'railgun-poi-source',
    'railgun-public-services',
    'railgun-poi-root',
    'railgun-private-preflight',
    'railgun-shield-preflight',
  ])
    assert.equal(!!require.cache[require.resolve(wallet + name)], false);
  const transport = require(network + 'wallet-tor-transport');
  const registry = require(network + 'network-registry');
  const settings = require('../../src/main/settings-store');
  const tor = require('../../src/main/tor-manager');
  const { getPrivacyContext } = require(network + 'privacy-context');
  const { REQUIRED_LIST } = require(wallet + 'railgun-poi-records');
  const originals = [
    transport.createWalletTorTransport,
    registry.getNetwork,
    registry.getEndpoints,
    registry.getEndpointSources,
    settings.isWalletTorExperimentAvailable,
    tor.getWalletSocksEndpoint,
  ];
  const endpointOwner = new AbortController();
  const endpoint = Object.freeze({ signal: endpointOwner.signal });
  const rpcUrl = 'https://synthetic.invalid/railgun';
  const requests = [],
    poiMethods = [],
    clients = [];
  let fixture,
    stopped = false;
  const header = (n) => ({ number: '0x' + n.toString(16), hash: hex(n + 1), parentHash: hex(n) });
  function rpcRead(subject, method, params) {
    assert.equal(subject.kind, 'private-account');
    assert.equal(subject.role, 'protocol-rpc');
    assert.equal(subject.protocol, 'railgun');
    assert.equal(subject.deployment, 'sepolia');
    assert.ok([null, 'shield-preflight', 'relay-preflight'].includes(subject.operation));
    requests.push({ method, params: structuredClone(params), operation: subject.operation });
    if (method === 'eth_chainId') {
      assert.deepEqual(params, []);
      return '0xaa36a7';
    }
    if (['shield-preflight', 'relay-preflight'].includes(subject.operation))
      return protocol(method, params);
    let result;
    if (method === 'eth_getLogs') {
      assert.equal(params.length, 1);
      const f = params[0];
      assert.equal(
        f.address.toLowerCase(),
        require(wallet + 'railgun-shield-pins.json').proxy.toLowerCase()
      );
      result = logs
        .filter(
          (v) =>
            v.blockNumber >= Number(BigInt(f.fromBlock)) &&
            v.blockNumber <= Number(BigInt(f.toBlock))
        )
        .map((v) => ({
          ...v,
          blockNumber: '0x' + v.blockNumber.toString(16),
          transactionIndex: '0x0',
          logIndex: '0x0',
        }));
    } else {
      assert.equal(method, 'eth_getBlockByNumber');
      assert.equal(params.length, 2);
      assert.equal(params[1], false);
      const number = params[0] === 'finalized' ? ANCHOR : Number(BigInt(params[0]));
      assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= ANCHOR);
      result = header(number);
    }

    return result;
  }
  function poiRead(v) {
    assert.ok(fixture);
    const note = expectedNote();
    assert.ok(note && note.type === 'Shield');
    const context = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
    let result;
    if (poiMethods.length === 0) {
      assert.equal(v.method, 'ppoi_pois_per_list');
      assert.deepEqual(v.params, {
        ...context,
        listKeys: [REQUIRED_LIST],
        blindedCommitmentDatas: [note],
      });
      result = { [note.blindedCommitment]: { [REQUIRED_LIST]: 'Valid' } };
    } else if (poiMethods.length === 1) {
      assert.equal(v.method, 'ppoi_merkle_proofs');
      assert.deepEqual(v.params, {
        ...context,
        listKey: REQUIRED_LIST,
        blindedCommitments: [note.blindedCommitment],
      });
      result = [structuredClone(fixture.proof)];
    } else if (poiMethods.length === 2) {
      assert.equal(v.method, 'ppoi_poi_events');
      assert.deepEqual(v.params, {
        ...context,
        listKey: REQUIRED_LIST,
        startIndex: 0,
        endIndex: 0,
      });
      result = [structuredClone(fixture.event)];
    } else {
      assert.equal(poiMethods.length, 3);
      assert.equal(v.method, 'ppoi_validate_poi_merkleroots');
      assert.deepEqual(v.params, {
        ...context,
        listKey: REQUIRED_LIST,
        poiMerkleroots: [fixture.proof.root],
      });
      result = true;
    }
    poiMethods.push(v.method);
    return result;
  }
  const transportFactory = () => {
    assert.equal(stopped, false);
    assert.ok(clients.length < 2);
    let closed = false,
      pending = 0,
      resolve;
    const barrier = new Promise((yes) => {
      resolve = yes;
    });
    const finish = () => {
      if (closed && pending === 0) resolve();
    };
    const state = { kind: null, closed: false };
    const client = {
      closed: barrier,
      release(_handle) {},
      close() {
        closed = true;
        state.closed = true;
        finish();
      },
      async request(handle, url, options) {
        pending++;
        try {
          assert.equal(stopped, false);
          assert.equal(closed, false);
          const { subject } = getPrivacyContext(handle);
          assert.equal(subject.chainId, 11155111);
          assert.equal(options.method, 'POST');
          assert.equal(options.signal.aborted, false);
          const v = JSON.parse(options.body);
          assert.deepEqual(Object.keys(v).sort(), ['id', 'jsonrpc', 'method', 'params']);
          assert.equal(v.jsonrpc, '2.0');
          assert.equal(typeof v.id, 'string');
          const kind = subject.role === 'poi' ? 'poi' : 'rpc';
          state.kind ??= kind;
          assert.equal(state.kind, kind);
          assert.equal(url, kind === 'poi' ? 'https://ppoi.fdi.network' : rpcUrl);
          const result = kind === 'poi' ? poiRead(v) : rpcRead(subject, v.method, v.params);
          assert.equal(options.signal.aborted, false);
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: v.id, result })),
          };
        } catch (error) {
          native.record(error, 'synthetic-service');
          throw error;
        } finally {
          pending--;
          finish();
        }
      },
    };
    clients.push({ client, state });
    return client;
  };
  const available = () => true,
    socks = () => endpoint;
  const networkInfo = (chainId) => {
    assert.equal(chainId, 11155111);
    return { access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } };
  };
  const endpoints = (chainId, role) => {
    assert.equal(chainId, 11155111);
    assert.equal(role, 'rpc');
    return [rpcUrl];
  };
  const sources = (chainId, role) => {
    endpoints(chainId, role);
    return [{ keyed: false, coverage: { 11155111: rpcUrl } }];
  };
  transport.createWalletTorTransport = transportFactory;
  registry.getNetwork = networkInfo;
  registry.getEndpoints = endpoints;
  registry.getEndpointSources = sources;
  settings.isWalletTorExperimentAvailable = available;
  tor.getWalletSocksEndpoint = socks;
  return {
    requests,
    poiMethods,
    fixture(value) {
      assert.equal(fixture, undefined);
      fixture = structuredClone(value);
    },
    assertClosed() {
      assert.equal(clients.length, 2);
      assert.deepEqual(
        clients.map(({ state }) => state),
        [
          { kind: 'rpc', closed: false },
          { kind: 'poi', closed: true },
        ]
      );
      assert.deepEqual(poiMethods, [
        'ppoi_pois_per_list',
        'ppoi_merkle_proofs',
        'ppoi_poi_events',
        'ppoi_validate_poi_merkleroots',
      ]);
    },
    async close() {
      stopped = true;
      endpointOwner.abort();
      for (const { client } of clients) client.close();
      await Promise.all(clients.map(({ client }) => client.closed));
    },
    restore() {
      assert.equal(stopped, true);
      assert.ok(clients.every(({ state }) => state.closed));
      assert.equal(transport.createWalletTorTransport, transportFactory);
      assert.equal(registry.getNetwork, networkInfo);
      assert.equal(registry.getEndpoints, endpoints);
      assert.equal(registry.getEndpointSources, sources);
      assert.equal(settings.isWalletTorExperimentAvailable, available);
      assert.equal(tor.getWalletSocksEndpoint, socks);
      [
        transport.createWalletTorTransport,
        registry.getNetwork,
        registry.getEndpoints,
        registry.getEndpointSources,
        settings.isWalletTorExperimentAvailable,
        tor.getWalletSocksEndpoint,
      ] = originals;
    },
  };
}
function installJobs(onDraft = () => {}, onSigningReply = () => {}) {
  for (const name of [
    'railgun-identity',
    'railgun-public-run',
    'railgun-wallet-run',
    'railgun-relay-quote-verify',
    'railgun-poi-membership',
    'railgun-relay-signature-verify',
    'railgun-relay-proof',
  ])
    assert.equal(!!require.cache[require.resolve(wallet + name)], false);
  const runtime = require(wallet + 'railgun-process'),
    original = runtime.startRailgunProcess;
  const rows = [],
    pending = new Set();
  const observed = function (options, ...rest) {
    const input = JSON.parse(options.input);
    let role;
    if (options.filename === require.resolve(wallet + 'railgun-identity-job')) role = input.purpose;
    else if (options.filename === require.resolve(wallet + 'railgun-public-job'))
      role = 'public-' + input.mode;
    else if (options.filename === require.resolve(wallet + 'railgun-wallet-job'))
      role = input.restore ? 'wallet-restore' : 'wallet-scan';
    else if (options.filename === require.resolve(wallet + 'railgun-relay-quote-job'))
      role = 'quote';
    else if (options.filename === require.resolve(wallet + 'railgun-relay-wallet-job'))
      role = input.relayRequest ? 'construct' : 'reconstruct';
    else if (options.filename === require.resolve('./railgun-relay-positive-membership-job'))
      role = 'membership-fixture';
    else if (options.filename === require.resolve('./railgun-relay-positive-audit-job'))
      role = 'audit-' + input.auditCase;
    else {
      const fixed = {
        'railgun-poi-job.js': 'membership',
        'railgun-relay-pre-poi-job.js': 'pre-poi-binding',
        'railgun-relay-sign-job.js': 'relay-sign',
        'railgun-relay-signature-verify-job.js': 'signature-C',
        'railgun-relay-prove-job.js': 'proof-A',
        'railgun-relay-verify-job.js': 'dual-proof-C',
      };
      role = fixed[path.basename(options.filename)];
      assert.ok(role);
      assert.equal(options.filename, require.resolve(wallet + path.basename(options.filename)));
    }
    assert.ok(expectedRoles()[rows.length] === role, 'Unexpected original utility order: ' + role);
    if (rows.length) assert.equal(rows.at(-1).closedObserved, true);
    const row = {
      role,
      inputSha256: sha(options.input),
      messages: 0,
      keyRequests: 0,
      keyReplies: 0,
      results: 0,
      closedObserved: false,
      methods: {},
      streamManifest: input.recordStream
        ? require(wallet + 'railgun-relay-record-stream').normalizeRailgunRelayRecordStreamManifest(
            input.recordStream
          )
        : null,
    };
    rows.push(row);
    const dispatch = function (...args) {
      const message = JSON.parse(args[0]);
      assert.equal(message.id, ++row.messages);
      const method = message.method ?? message.channel + '.' + JSON.parse(message.wire).method;
      row.methods[method] = (row.methods[method] ?? 0) + 1;
      if (['relay-proof-record', 'relay-verify-record'].includes(message.method)) {
        assert.ok(row.streamManifest);
        assert.equal(message.index, row.methods[method] - 1);
        assert.ok(message.index < row.streamManifest.chunks);
      }
      if (message.method === 'result' && row.streamManifest)
        assert.equal(
          row.methods[role === 'proof-A' ? 'relay-proof-record' : 'relay-verify-record'],
          row.streamManifest.chunks
        );
      if (
        ['construct', 'reconstruct', 'pre-poi-binding', 'proof-A'].includes(role) &&
        message.channel !== undefined
      ) {
        assert.ok(['public', 'wallet'].includes(message.channel));
        assert.ok(
          ['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end'].includes(
            JSON.parse(message.wire).method
          )
        );
      }
      if (['quote', 'membership-fixture', 'signature-C'].includes(role))
        assert.equal(message.method, 'result');
      if (
        ['construct', 'reconstruct', 'pre-poi-binding', 'proof-A'].includes(role) &&
        message.channel === undefined
      )
        assert.ok(
          ['key', 'result', ...(role === 'proof-A' ? ['relay-proof-record'] : [])].includes(
            message.method
          )
        );
      if (role === 'relay-sign') assert.ok(['key', 'result'].includes(message.method));
      if (role === 'membership') assert.ok(['input', 'result'].includes(message.method));
      if (role.startsWith('audit-') || role === 'dual-proof-C')
        assert.ok(['relay-verify-record', 'result'].includes(message.method));
      if (['spending-public', 'viewing-identity'].includes(role))
        assert.ok(['key', 'result'].includes(message.method));
      if (message.method === 'key') {
        row.keyRequests++;
        const purpose = {
          'spending-public': 'spending-public',
          'viewing-identity': 'viewing-identity',
          'wallet-scan': 'wallet-viewing',
          'wallet-restore': 'wallet-viewing',
          construct: 'relay-prepare',
          reconstruct: 'relay-reconstruct',
          'pre-poi-binding': 'relay-pre-poi',
          'proof-A': 'relay-prove-local',
          'relay-sign': 'relay-sign',
        }[role];
        assert.ok(purpose);
        assert.equal(message.purpose, purpose);
      }
      const returned = Reflect.apply(options.broker.dispatch, this, args);
      if (message.method === 'key' || ['result', 'jobResult'].includes(message.method)) {
        const observation = Promise.prototype.then.call(
          returned,
          (reply) => {
            if (message.method === 'key') {
              assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
              row.keyReplies++;
              if (role === 'relay-sign') onSigningReply();
            } else {
              row.results++;
              if (role === 'construct') onDraft(message.value);
              row.guards = structuredClone(message.guards ?? message.value.guards);
            }
          },
          (error) => {
            native.record(error, 'relay-positive.broker');
          }
        );
        pending.add(observation);
        observation
          .finally(() => pending.delete(observation))
          .catch((error) => native.record(error, 'relay-positive.observer'));
      }
      return returned;
    };
    const task = Reflect.apply(original, this, [
      { ...options, broker: { ...options.broker, dispatch } },
      ...rest,
    ]);
    native.observeClosed(
      task.closed,
      (value) => {
        // Preserve the observed original exit even when the unchanged checks
        // below reject it. Sticky native assertions still prevent qualification.
        row.closed = structuredClone(value);
        row.closedObserved = true;
        assert.equal(row.results, 1);
        assert.equal(value.code, 'RAILGUN_PROCESS_CLOSED');
        assert.equal(value.exitCode, 15);
        assert.equal(value.escalated, false);
        assert.equal(value.peerDisconnected, false);
      },
      'relay-positive.' + role
    );
    return task;
  };
  runtime.startRailgunProcess = observed;
  return {
    rows,
    async finish() {
      await Promise.all([...pending]);
      assert.deepEqual(
        rows.map((r) => r.role),
        expectedRoles()
      );
      for (const row of rows) {
        assert.equal(row.closedObserved, true);
        assert.equal(row.results, 1);
        assert.deepEqual(row.guards, require(wallet + 'railgun-relay-quote-data').EXPECTED_GUARDS);
        assert.equal(
          row.keyRequests,
          [
            'spending-public',
            'viewing-identity',
            'wallet-scan',
            'wallet-restore',
            'construct',
            'reconstruct',
            'pre-poi-binding',
            'proof-A',
            'relay-sign',
          ].includes(row.role)
            ? 1
            : 0
        );
        assert.equal(row.keyReplies, row.keyRequests);
        assert.equal(
          Object.values(row.methods).reduce((sum, count) => {
            assert.ok(Number.isSafeInteger(count) && count > 0);
            return sum + count;
          }, 0),
          row.messages
        );
        if (row.role === 'membership') assert.deepEqual(row.methods, { input: 1, result: 1 });
        if (['membership-fixture', 'quote', 'signature-C'].includes(row.role))
          assert.deepEqual(row.methods, { result: 1 });
        if (row.role === 'relay-sign') assert.deepEqual(row.methods, { key: 1, result: 1 });
        if (row.role === 'dual-proof-C' || row.role.startsWith('audit-'))
          assert.deepEqual(row.methods, {
            'relay-verify-record': row.streamManifest.chunks,
            result: 1,
          });
      }
      native.assertEmpty();
    },
    restore() {
      assert.equal(runtime.startRailgunProcess, observed);
      runtime.startRailgunProcess = original;
    },
  };
}
function expectedRoles() {
  return [
    'spending-public',
    'viewing-identity',
    ...ranges().flatMap((range) =>
      range.to < OFFSET + 10 ? ['public-plan'] : ['public-plan', 'public-apply']
    ),
    'wallet-scan',
    'wallet-restore',
    'membership-fixture',
    'quote',
    'construct',
    'reconstruct',
    'membership',
    'pre-poi-binding',
    'relay-sign',
    'signature-C',
    'proof-A',
    'dual-proof-C',
    ...AUDIT_CASES.map((value) => 'audit-' + value),
  ];
}
function createProtocol(artifactDirectory) {
  const { Interface } = require('ethers');
  const pins = require(wallet + 'railgun-shield-pins.json');
  const deployment = require('./railgun-shield-offline-deployment').createOfflineShieldDeployment(
    path.join(
      __dirname,
      '../../docs/qualification/railgun-public-contract-bytecodes-2026-10-04.json'
    )
  );
  const abi = new Interface([
    'function rootHistory(uint256,bytes32) view returns (bool)',
    'function nullifiers(uint256,bytes32) view returns (bool)',
    'function unshieldFee() view returns (uint120)',
  ]);
  // Use the exact deployed ABI, including delta2 (kept separate for readability).
  const verifierAbi = new Interface([
    'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
  ]);
  const entry = require(wallet + 'railgun-artifacts').manifest['01x02'].find(
    (v) => v.kind === 'vkey'
  );
  const filename = path.join(artifactDirectory, entry.name);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.size);
  const bytes = fs.readFileSync(filename);
  assert.equal(sha(bytes), entry.sha256);
  const vkey = JSON.parse(bytes);
  const g1 = (p) => ({ x: BigInt(p[0]), y: BigInt(p[1]) });
  const g2 = (p) => ({
    x: [BigInt(p[0][1]), BigInt(p[0][0])],
    y: [BigInt(p[1][1]), BigInt(p[1][0])],
  });
  const encodedKey = verifierAbi
    .encodeFunctionResult('getVerificationKey', [
      {
        artifactsIPFSHash: 'offline-pinned-01x02',
        alpha1: g1(vkey.vk_alpha_1),
        beta2: g2(vkey.vk_beta_2),
        gamma2: g2(vkey.vk_gamma_2),
        delta2: g2(vkey.vk_delta_2),
        ic: vkey.IC.map(g1),
      },
    ])
    .toLowerCase();
  let selected, block;
  return {
    draft(value) {
      assert.equal(selected, undefined);
      const draft = require(wallet + 'railgun-relay-capsule').normalizeRailgunRelayDraftCapsule(
        value.relayDraft
      ).data;
      selected = { tree: draft.selection.tree, ...draft.intent.expected };
    },
    request(method, params) {
      assert.ok(selected);
      const call = { jsonrpc: '2.0', id: 1, method, params };
      if (method === 'eth_getBlockByNumber') {
        const value = deployment.request(call);
        block = { blockHash: value.hash, requireCanonical: true };
        return value;
      }
      if (method !== 'eth_call') return deployment.request(call);
      assert.equal(params.length, 2);
      const selector = params[0]?.data?.slice(0, 10);
      const names = ['rootHistory', 'nullifiers', 'unshieldFee'];
      const name = names.find((key) => abi.getFunction(key).selector === selector);
      const keyRequest = selector === verifierAbi.getFunction('getVerificationKey').selector;
      if (!name && !keyRequest) return deployment.request(call);
      assert.equal(params[0].to, pins.proxy);
      assert.deepEqual(params[1], block);
      if (keyRequest) {
        assert.equal(params[0].data, verifierAbi.encodeFunctionData('getVerificationKey', [1, 2]));
        return encodedKey;
      }
      const args =
        name === 'rootHistory'
          ? [selected.tree, selected.merkleRoot]
          : name === 'nullifiers'
            ? [selected.tree, selected.nullifier]
            : [];
      assert.equal(params[0].data, abi.encodeFunctionData(name, args));
      return abi
        .encodeFunctionResult(name, [
          name === 'rootHistory' ? true : name === 'nullifiers' ? false : 25n,
        ])
        .toLowerCase();
    },
  };
}
function installCustody() {
  assert.equal(!!require.cache[require.resolve(wallet + 'railgun-relay-operation')], false);
  const data = require(wallet + 'railgun-relay-recovery-data'),
    original = data.matchRailgunRelayLocalReservation;
  const rows = [];
  let issuance = 0,
    jobs,
    quoteCreatedAt,
    credentialQuoteRemainingMs;
  const observed = function (...args) {
    const result = Reflect.apply(original, this, args);
    try {
      const row = {
        operationId: result.record.id,
        state: result.record.state,
        recordDigest: result.recordDigest,
        reservationState: result.reservationState,
        interruptedStep: result.interruptedStep,
      };
      if (rows.length) assert.equal(row.operationId, rows[0].operationId);
      assert.equal(row.interruptedStep, null);
      if (row.state === 'signed')
        assert.equal(jobs.rows.find((v) => v.role === 'signature-C')?.closedObserved, true);
      if (row.state === 'ready-local') {
        assert.equal(jobs.rows.find((v) => v.role === 'proof-A')?.closedObserved, true);
        assert.equal(jobs.rows.find((v) => v.role === 'dual-proof-C')?.closedObserved, true);
      }
      rows.push(row);
    } catch (error) {
      native.record(error, 'relay-positive.custody');
    }
    return result;
  };
  data.matchRailgunRelayLocalReservation = observed;
  return {
    rows,
    jobs(value) {
      assert.equal(jobs, undefined);
      jobs = value;
    },
    quote(createdAt) {
      assert.equal(quoteCreatedAt, undefined);
      assert.ok(Number.isSafeInteger(createdAt));
      quoteCreatedAt = createdAt;
    },
    credentialMargin() {
      assert.ok(Number.isSafeInteger(credentialQuoteRemainingMs));
      return credentialQuoteRemainingMs;
    },
    issued() {
      assert.equal(++issuance, 1);
      assert.ok(Date.now() >= quoteCreatedAt);
      credentialQuoteRemainingMs = quoteCreatedAt + 240000 - Date.now();
      assert.ok(credentialQuoteRemainingMs >= 90000);
      assert.ok(rows.length > 0);
      assert.equal(rows.at(-1).state, 'signing-local');
      assert.equal(rows.at(-1).reservationState, 'signing-local');
      assert.equal(rows.at(-1).interruptedStep, null);
    },
    finish() {
      assert.equal(issuance, 1);
      assert.deepEqual(
        [...new Set(rows.map((v) => v.state))],
        ['held', 'signing-local', 'signed', 'ready-local']
      );
      native.assertEmpty();
    },
    restore() {
      assert.equal(data.matchRailgunRelayLocalReservation, observed);
      data.matchRailgunRelayLocalReservation = original;
    },
  };
}
async function runFixtureJob(kind, input, validate, sender, timeoutMs) {
  assert.ok(kind === 'membership-fixture' || AUDIT_CASES.some((name) => kind === 'audit-' + name));
  const controller = new AbortController();
  const scope = require(network + 'privacy-context').createPrivacyScope({
    profileId: 'public-synthetic-relay-fixture',
    signal: controller.signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-fixture',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'prover',
    operation: 'poi-verify',
  });
  const started = performance.now(),
    pending = new Set();
  let task,
    value,
    failed,
    sequence = 0,
    chunks = 0;
  const close = () => {
    controller.abort();
    try {
      task?.close();
    } catch (error) {
      failed ??= error;
    }
  };
  const timer = setTimeout(close, timeoutMs);
  const active = () => {
    assert.equal(controller.signal.aborted, false);
    assert.ok(performance.now() >= started && performance.now() - started < timeoutMs);
  };
  const broker = {
    signal: controller.signal,
    dispatch(wire) {
      const work = (async () => {
        try {
          active();
          assert.equal(pending.size, 0);
          assert.equal(value, undefined);
          assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) < 65536);
          const message = JSON.parse(wire);
          assert.equal(message.id, ++sequence);
          let result;
          if (message.method === 'relay-verify-record') {
            assert.ok(sender);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'index', 'method']);
            result = sender.read({ method: message.method, index: message.index });
            chunks++;
          } else {
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            assert.equal(message.method, 'result');
            assert.equal(chunks, sender?.manifest.chunks ?? 0);
            validate(message.value);
            value = structuredClone(message.value);
            result = null;
          }
          return JSON.stringify({ id: message.id, value: result });
        } catch (error) {
          failed ??= error;
          close();
          throw error;
        }
      })();
      pending.add(work);
      work.then(
        () => pending.delete(work),
        () => pending.delete(work)
      );
      return work;
    },
  };
  let originalReady, originalClosed, outcome;
  try {
    const inputText = JSON.stringify(input);
    assert.ok(Buffer.byteLength(inputText) <= 65536);
    task = require(wallet + 'railgun-process').startRailgunProcess({
      handle,
      filename: require.resolve(
        kind === 'membership-fixture'
          ? './railgun-relay-positive-membership-job'
          : './railgun-relay-positive-audit-job'
      ),
      input: inputText,
      binaryKey: false,
      startupMs: timeoutMs,
      lifetimeMs: timeoutMs,
      heapMb: 256,
      rssMb: 768,
      broker,
    });
    originalReady = task.ready;
    originalClosed = Promise.prototype.then.call(
      task.closed,
      (v) => ({ value: v }),
      (error) => ({ error })
    );
    await originalReady;
    active();
  } catch (error) {
    failed ??= error;
  } finally {
    try {
      task?.close();
    } catch (error) {
      failed ??= error;
    }
    if (originalReady)
      try {
        await originalReady;
      } catch (error) {
        failed ??= error;
      }
    if (originalClosed) {
      const settled = await originalClosed;
      failed ??= settled.error;
      outcome = settled.value;
    }
    await Promise.allSettled([...pending]);
    clearTimeout(timer);
    try {
      sender?.close();
    } catch (error) {
      failed ??= error;
    }
    try {
      scope.close();
    } catch (error) {
      failed ??= error;
    }
  }
  if (failed) throw failed;
  assert.ok(value);
  assert.equal(outcome.code, 'RAILGUN_PROCESS_CLOSED');
  assert.equal(outcome.exitCode, 15);
  assert.equal(outcome.escalated, false);
  assert.equal(outcome.peerDisconnected, false);
  assert.ok(performance.now() - started < timeoutMs);
  return value;
}
function assertOperationRpc(requests) {
  const headers = {},
    protocol = {};
  for (const row of requests) {
    if (['shield-preflight', 'relay-preflight'].includes(row.operation))
      protocol[row.method] = (protocol[row.method] ?? 0) + 1;
    else {
      assert.equal(row.method, 'eth_getBlockByNumber');
      assert.equal(row.params.length, 2);
      assert.equal(row.params[1], false);
      headers[row.params[0]] = (headers[row.params[0]] ?? 0) + 1;
    }
  }
  assert.deepEqual(
    headers,
    Object.fromEntries(
      ['finalized', ...[ANCHOR, 5900000, THROUGH, 5899999].map((v) => '0x' + v.toString(16))].map(
        (key) => [key, 4]
      )
    )
  );
  assert.deepEqual(protocol, {
    eth_chainId: 2,
    eth_getBlockByNumber: 3,
    eth_getCode: 4,
    eth_getStorageAt: 2,
    eth_call: 8,
  });
  assert.equal(requests.length, 39);
  return { headers, protocol };
}
function assertAudit(value, auditCase, recordText, pair) {
  require(wallet + 'railgun-relay-quote-data').shape(value, [
    'auditCase',
    'recordDigest',
    'originalRecordSha256',
    'checkedRecordSha256',
    'codecAccepted',
    'transactionMatcherAccepted',
    'pairMatcherAccepted',
    'primitiveResults',
    'productionOutcome',
    'productionCode',
    'guards',
    'inventory',
  ]);
  assert.equal(value.auditCase, auditCase);
  assert.equal(value.recordDigest, pair.recordDigest);
  assert.equal(value.originalRecordSha256, sha(recordText));
  assert.match(value.checkedRecordSha256, /^[0-9a-f]{64}$/);
  for (const key of ['codecAccepted', 'transactionMatcherAccepted', 'pairMatcherAccepted'])
    assert.equal(value[key], true);
  const results = [{ domain: 'signature', verified: auditCase !== 'signature' }];
  if (auditCase !== 'signature')
    results.push({ domain: '01x02', verified: auditCase !== 'transaction-proof' });
  if (!['signature', 'transaction-proof'].includes(auditCase))
    results.push({ domain: 'POI_3x3', verified: auditCase !== 'pre-poi-proof' });
  assert.deepEqual(value.primitiveResults, results);
  assert.equal(value.productionOutcome, auditCase === 'unmodified' ? 'verified' : 'refused');
  assert.equal(
    value.productionCode,
    auditCase === 'unmodified' ? null : 'RAILGUN_RELAY_PROOF_VERIFICATION_REFUSED'
  );
  if (auditCase === 'unmodified') assert.equal(value.checkedRecordSha256, sha(recordText));
  else assert.notEqual(value.checkedRecordSha256, sha(recordText));
  assert.deepEqual(value.guards, require(wallet + 'railgun-relay-quote-data').EXPECTED_GUARDS);
  assert.deepEqual(value.inventory, {
    engineSha256: require(wallet + 'railgun-engine-manifest.json').sha256,
    proverSha256: require(wallet + 'railgun-prover-manifest.json').sha256,
    artifactVkeys: Object.fromEntries(
      ['01x02', 'POI_3x3'].map((variant) => [
        variant,
        require(wallet + 'railgun-artifacts').manifest[variant].find((v) => v.kind === 'vkey')
          .sha256,
      ])
    ),
  });
}
// Failure-only public diagnostics from observations already held by this fixture.
// These projections grant nothing and never reopen/read an account or store.
function assertReadyLocal(result, jobs, custody) {
  if (result.status === 'ready-local') return;
  const stages = new Set([
    'admission',
    'root-disclosure',
    'disclosure',
    'membership',
    'binding',
    'preflight',
    'root-acquisition',
    'reserve',
    'signing-marker',
    'signer',
    'signature-verification',
    'signature-storage',
    'proof',
  ]);
  const states = new Set([
    'held',
    'signing-local',
    'signed',
    'ready-local',
    'cancelled-unsigned',
    'discarded-signed',
  ]);
  const roles = new Set(expectedRoles());
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
  const diagnostic = {
    schema: 'railgun-relay-positive-refusal-diagnostic-v1',
    result: {
      status: ['refused', 'recovery-required'].includes(result.status)
        ? result.status
        : 'unrecognized',
      stage: stages.has(result.stage) ? result.stage : 'unrecognized',
      signingAttempted:
        typeof result.signingAttempted === 'boolean' ? result.signingAttempted : null,
      signatureSaved: typeof result.signatureSaved === 'boolean' ? result.signatureSaved : null,
    },
    jobs: jobs.rows.slice(0, expectedRoles().length).map((row) => ({
      role: roles.has(row.role) ? row.role : 'unrecognized',
      results: count(row.results),
      keyRequests: count(row.keyRequests),
      keyReplies: count(row.keyReplies),
      closedObserved: row.closedObserved === true,
      exitCode:
        Number.isSafeInteger(row.closed?.exitCode) && Math.abs(row.closed.exitCode) <= 255
          ? row.closed.exitCode
          : null,
      escalated: typeof row.closed?.escalated === 'boolean' ? row.closed.escalated : null,
      peerDisconnected:
        typeof row.closed?.peerDisconnected === 'boolean' ? row.closed.peerDisconnected : null,
    })),
    jobRowsTruncated: jobs.rows.length > expectedRoles().length,
    custodyStates: [],
    custodyRowsTruncated: custody.rows.length > 128,
  };
  for (const row of custody.rows.slice(-128)) {
    const state = {
      state: states.has(row.state) ? row.state : 'unrecognized',
      reservationState: states.has(row.reservationState) ? row.reservationState : 'unrecognized',
    };
    const last = diagnostic.custodyStates.at(-1);
    if (!last || last.state !== state.state || last.reservationState !== state.reservationState) {
      if (diagnostic.custodyStates.length === 16) break;
      diagnostic.custodyStates.push(state);
    }
  }
  // Keep the original success predicate. No report/qualified output follows this.
  assert.equal(diagnostic.result.status, 'ready-local', JSON.stringify(diagnostic));
}

async function qualify({
  account,
  owners,
  archive,
  proverArchive,
  artifactDirectory,
  scenario,
  services,
  jobs,
  custody,
}) {
  assert.equal(scenario, 'synthetic-list');
  const api = require(wallet + 'railgun-account-wallet');
  const baseline = api.readRailgunAccountOwnedNotes(account, owners);
  const candidates = baseline.read.received.filter(
    (v) => v.spentTxid === false && v.amount === 2000n
  );
  assert.equal(candidates.length, 1);
  const selected = candidates[0],
    owned = baseline.ownedPoi.find((v) => v.id === selected.id);
  assert.ok(owned && owned.type === 'Shield' && owned.blockNumber === OFFSET + 10);
  const reservations = await owners.enrollment.openReservations(),
    recovery = await owners.enrollment.openRelayRecoveryStore();
  const before = {
    private: await reservations.inspect(),
    relay: await reservations.listRelay(recovery),
    recovery: await recovery.inspect(),
  };
  assert.deepEqual(before.relay, []);
  assert.equal(before.recovery.records, 0);
  const createdAt = Date.now();
  const publicSelected = {
    hash: owned.hash,
    npk: owned.npk,
    tree: Number(selected.id.split(':')[0]),
    position: Number(selected.id.split(':')[1]),
    blindedCommitment: owned.blindedCommitment,
    type: 'Shield',
    amount: '2000',
  };
  const helperInput = { archive, createdAt, selected: publicSelected };
  const helper = await runFixtureJob(
    'membership-fixture',
    helperInput,
    (value) => {
      require(wallet + 'railgun-relay-quote-data').shape(value, [
        'inputSha256',
        'selectedSha256',
        'note',
        'proof',
        'event',
        'quote',
        'gas',
        'createdAt',
        'controls',
        'syntheticList',
        'productionServiceAuthority',
        'engineSha256',
        'guards',
      ]);
      assert.equal(value.inputSha256, sha(JSON.stringify(helperInput)));
      assert.equal(value.selectedSha256, sha(JSON.stringify(publicSelected)));
      assert.deepEqual(value.note, { blindedCommitment: owned.blindedCommitment, type: 'Shield' });
      assert.equal(value.proof.leaf, owned.blindedCommitment.slice(2));
      assert.equal(value.createdAt, createdAt);
      assert.equal(value.syntheticList, TEST_LIST);
      assert.equal(value.productionServiceAuthority, false);
      assert.equal(value.engineSha256, require(wallet + 'railgun-engine-manifest.json').sha256);
      assert.deepEqual(value.controls, {
        badEventRefused: true,
        productionKeyRefused: true,
        badPathRefused: true,
        otherEventAndPathVerified: true,
        otherNoteUnequal: true,
        otherEventSelectedJoinRefused: true,
      });
      assert.deepEqual(value.guards, require(wallet + 'railgun-relay-quote-data').EXPECTED_GUARDS);
      // Main's real Ed25519 check does not import an engine module.
      require(wallet + 'railgun-poi-records').verifyPoiEvent(
        [value.event],
        value.note,
        value.proof
      );
    },
    null,
    15000
  );
  const quote = require(wallet + 'railgun-relay-quote-data').normalizeRailgunRelayQuote(
    helper.quote,
    helper.gas
  );
  assert.deepEqual(quote.fields.requiredPOIListKeys, [TEST_LIST]);
  assert.equal(quote.fields.feeExpiration, createdAt + 240000);
  services.fixture(helper);
  custody.quote(createdAt);
  const margins = [],
    operationStart = performance.now();
  const margin = (stage, minimum) => {
    assert.ok(Date.now() >= createdAt);
    const remainingMs = createdAt + 240000 - Date.now();
    assert.ok(remainingMs >= minimum);
    margins.push({ stage, remainingMs });
  };
  margin('admission', 120000);
  const rpcBefore = services.requests.length;
  let reviewed = 0,
    disclosed = 0;
  const result = await require(
    wallet + 'railgun-relay-operation'
  ).proveRailgunAccountRelayOperation({
    account,
    owners,
    archive,
    proverArchive,
    artifactDirectory,
    request: {
      noteId: selected.id,
      quote: helper.quote,
      gas: helper.gas,
      maxFee: '100',
      signal: new AbortController().signal,
    },
    review(summary) {
      reviewed++;
      assert.equal(summary.selection.noteId, selected.id);
      assert.deepEqual(summary.amounts, { input: '2000', fee: '100', self: '1900', cap: '100' });
      assert.deepEqual(summary.quote.requiredPOIListKeys, [TEST_LIST]);
      assert.equal(summary.quote.quoteSha256, quote.quoteSha256);
      assert.equal(summary.quote.signedBytesSha256, quote.signedBytesSha256);
      assert.equal(summary.quote.expiresAt, createdAt + 240000);
      margin('review', 90000);
      return true;
    },
    reviewDisclosure(summary) {
      disclosed++;
      assert.equal(summary.listKey, TEST_LIST);
      assert.equal(summary.input.id, selected.id);
      assert.equal(summary.input.type, 'Shield');
      assert.equal(summary.input.blindedCommitment, owned.blindedCommitment);
      services.selected({ blindedCommitment: owned.blindedCommitment, type: 'Shield' });
      margin('disclosure', 90000);
      return true;
    },
  });
  assert.equal(reviewed, 1);
  assert.equal(disclosed, 1);
  assertReadyLocal(result, jobs, custody);
  assert.match(result.operationId, /^[0-9a-f]{64}$/);
  assert.ok(performance.now() - operationStart < 180000);
  services.assertClosed();
  const rpc = assertOperationRpc(services.requests.slice(rpcBefore));
  const ready = await reservations.readRelay(recovery, result.operationId);
  assert.equal(ready.record.state, 'ready-local');
  assert.equal(ready.entry.state, 'signing-local');
  assert.equal(ready.interruptedStep, null);
  assert.deepEqual(ready.record.history.note, helper.note);
  assert.deepEqual(ready.record.history.proof, helper.proof);
  assert.deepEqual(ready.record.history.event, helper.event);
  const after = {
    private: await reservations.inspect(),
    relay: await reservations.listRelay(recovery),
    recovery: await recovery.inspect(),
  };
  assert.deepEqual(after.private, before.private);
  assert.deepEqual(after.relay, [{ id: result.operationId, state: 'signing-local' }]);
  assert.equal(after.recovery.records, 1);
  assert.equal(after.recovery.sequence - before.recovery.sequence, 4);
  assert.deepEqual(after.recovery.states, [{ id: result.operationId, state: 'ready-local' }]);
  custody.finish();
  const recordText = JSON.stringify(ready.record),
    identityText = JSON.stringify({
      walletId: owners.identity.descriptor.walletId,
      spendingPublicKey: owners.identity.descriptor.spendingPublicKey,
    });
  const audits = [];
  for (const auditCase of AUDIT_CASES) {
    const control = new AbortController();
    const sender = require(
      wallet + 'railgun-relay-record-stream'
    ).createRailgunRelayVerifyRecordSender(recordText, control.signal);
    audits.push(
      await runFixtureJob(
        'audit-' + auditCase,
        {
          archive,
          proverArchive,
          artifactDirectory,
          identityText,
          entryText: JSON.stringify(ready.entry),
          recordStream: sender.manifest,
          auditCase,
        },
        (value) => assertAudit(value, auditCase, recordText, ready),
        sender,
        60000
      )
    );
    control.abort();
  }
  const unchanged = await reservations.readRelay(recovery, result.operationId);
  assert.equal(JSON.stringify(unchanged.record), recordText);
  assert.deepEqual(unchanged.entry, ready.entry);
  assert.deepEqual(await recovery.inspect(), after.recovery);
  assert.equal(services.requests.length - rpcBefore, 39);
  assert.equal(jobs.rows.length, 79);
  assert.equal(
    jobs.rows.reduce((sum, row) => sum + row.keyReplies, 0),
    9
  );
  await account.close();
  return {
    schema: 'railgun-relay-positive-native-v1',
    scenario,
    result,
    selectedInputType: 'Shield',
    inputAmount: '2000',
    feeAmount: '100',
    selfAmount: '1900',
    syntheticList: TEST_LIST,
    productionServiceAuthority: false,
    liveServiceContact: false,
    relaySendPermitted: false,
    quoteListEqualityIsFixturePolicy: true,
    exactReviewCallbacks: reviewed,
    disclosureCallbacks: disclosed,
    quoteMargins: [
      ...margins,
      { stage: 'credential-reply-observed', remainingMs: custody.credentialMargin() },
    ],
    membershipControls: helper.controls,
    selectedServiceMethods: [...services.poiMethods],
    syntheticOperationRpc: rpc,
    recoverySequenceDelta: 4,
    ledgerSequenceDeltaSourceDerived: 2,
    authenticatedReadyReadback: true,
    auditCustodyUnchanged: true,
    custodyOrdering: custody.rows,
    audits,
    recordDigest: ready.recordDigest,
    publicFixtureRecordSha256: sha(recordText),
    publicFixtureEntrySha256: sha(JSON.stringify(ready.entry)),
    proofProduced: true,
    signatureIndependentlyVerified: true,
    proofsIndependentlyVerified: true,
    transportAttempted: false,
    coldRestartQualified: false,
    actualProductionListQualified: false,
  };
}

// Publication-time main cache observation only. It cannot recover modules
// removed earlier or observe imports inside utility processes.
function collectMainModuleCache({ root, cache, electron }) {
  assert.ok(path.isAbsolute(root) && path.normalize(root) === root);
  assert.equal(fs.realpathSync(root), root);
  assert.ok(fs.lstatSync(root).isDirectory());
  const mount = path.join(root, 'node_modules');
  assert.ok(fs.lstatSync(mount).isSymbolicLink());
  const dependencyRoot = fs.realpathSync(mount);
  assert.equal(fs.readlinkSync(mount), dependencyRoot);
  assert.ok(fs.lstatSync(dependencyRoot).isDirectory());
  const within = (base, name) => {
    const relative = path.relative(base, name);
    return (
      relative !== '' &&
      !relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative)
    );
  };
  assert.ok(
    !within(root, dependencyRoot) && !within(dependencyRoot, root) && root !== dependencyRoot
  );
  const extraApplication = new Set([
    'package.json', // src/main/index.js's literal require.
    'docs/qualification/railgun-poi-read-2026-10-03.json', // relay-core-data.js.
  ]);
  const virtual = new Set(['electron', 'electron/common', 'electron/main']);
  const bootstrapContainer = path.join(
    dependencyRoot,
    'electron/dist/Electron.app/Contents/Resources/default_app.asar'
  );
  const bootstrapEntry = bootstrapContainer + '/package.json';
  let bootstrapObserved = false;
  const modules = [],
    virtualModules = [],
    keys = Object.keys(cache).sort();
  assert.ok(keys.length > 0 && keys.length <= 10000);
  for (const filename of keys) {
    const entry = cache[filename];
    assert.ok(entry && typeof entry === 'object');
    assert.equal(entry.filename, filename);
    assert.equal(entry.loaded, true);
    if (!path.isAbsolute(filename)) {
      // Exact representation previously checked by the cold-credit qualifier;
      // ordinary builtins (including original-fs) are not assumed cache entries.
      assert.ok(virtual.has(filename));
      assert.equal(fs.existsSync(path.resolve(root, filename)), false);
      assert.equal(entry.id, 'electron');
      assert.equal(entry.exports, electron);
      virtualModules.push(filename);
      continue;
    }
    assert.equal(path.normalize(filename), filename);
    if (filename === bootstrapEntry) {
      // Qualification-only exception observed with this pinned Electron 44.5.1
      // CLI. original-fs observes the real container, never an ASAR member.
      const originalFs = require('original-fs');
      assert.equal(originalFs.realpathSync(bootstrapContainer), bootstrapContainer);
      const before = originalFs.lstatSync(bootstrapContainer);
      assert.ok(before.isFile() && !before.isSymbolicLink());
      assert.equal(before.size, 110862);
      const container = originalFs.readFileSync(bootstrapContainer);
      assert.equal(container.length, 110862);
      assert.equal(
        sha(container),
        '0eb2491b0a9ac94790389d39c09dd5005c6c1f0665842943829bbd0193f6cc4f'
      );
      // Electron's patched fs reads only the exact observed package member.
      const bytes = fs.readFileSync(bootstrapEntry);
      assert.equal(bytes.length, 95);
      assert.equal(sha(bytes), '3688987acbbeeea464615eee547ab4feca1c33e71ff85607e84e5167ebc595fc');
      const after = originalFs.lstatSync(bootstrapContainer);
      assert.equal(originalFs.realpathSync(bootstrapContainer), bootstrapContainer);
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(after.ctimeMs, before.ctimeMs);
      modules.push({
        class: 'runtime-bootstrap',
        relativePath: 'default_app.asar/package.json',
        sha256: sha(bytes),
        bytes: bytes.length,
      });
      bootstrapObserved = true;
      continue;
    }
    assert.ok(!filename.split(path.sep).some((part) => part.endsWith('.asar')));
    let classification, relativePath;
    if (within(root, filename)) {
      relativePath = path.relative(root, filename);
      assert.ok(
        relativePath.startsWith('src' + path.sep) ||
          relativePath.startsWith('scripts' + path.sep) ||
          extraApplication.has(relativePath)
      );
      classification = 'application';
    } else {
      assert.ok(within(dependencyRoot, filename), 'Main module outside declared roots');
      relativePath = path.relative(dependencyRoot, filename);
      classification = 'dependency';
    }
    // No module alias may turn copied source into an original-root fallback.
    assert.equal(fs.realpathSync(filename), filename);
    const before = fs.lstatSync(filename);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 256 * 1024 * 1024);
    const bytes = fs.readFileSync(filename);
    const after = fs.lstatSync(filename);
    assert.equal(bytes.length, before.size);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    modules.push({ class: classification, relativePath, sha256: sha(bytes), bytes: bytes.length });
  }
  assert.deepEqual(Object.keys(cache).sort(), keys);
  assert.equal(bootstrapObserved, true);
  assert.deepEqual(virtualModules, [...virtual].sort());
  modules.sort((a, b) => {
    const left = a.class + '\0' + a.relativePath,
      right = b.class + '\0' + b.relativePath;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  assert.equal(new Set(modules.map((v) => v.class + ':' + v.relativePath)).size, modules.length);
  return {
    scope: 'main-require-cache-at-publication',
    historicalExecutionCoverage: false,
    utilityImportCoverage: false,
    modules,
    virtualModules,
  };
}
function inspectMainModuleCache() {
  const electron = require('electron');
  return collectMainModuleCache({
    root: path.resolve(__dirname, '../..'),
    cache: require.cache,
    electron,
  });
}

async function execute(config) {
  const { app } = require('electron');
  const retained = require('./railgun-relay-retained-run');
  const bytes = retained.readBounded(config.sourceFilename, 8466, {
    bytes: 8466,
    sha256: SOURCE_SHA,
  });
  const derived = translate(bytes);
  const archive = require(wallet + 'railgun-engine-runtime').verifyRailgunEngineRuntime(
    config.archive
  );
  const proverArchive = require(wallet + 'railgun-prover-runtime').verifyRailgunProverRuntime(
    config.proverArchive
  );
  const sourceHashes = () => ({
    ...retained.sourceHashes(),
    ...Object.fromEntries(
      fs
        .readdirSync(path.join(__dirname, '..'))
        .filter((name) => /^qualify-railgun-relay-(positive|cold-ready)(\.test)?\.js$/.test(name))
        .map((name) => ['scripts/' + name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    ),
    'scripts/qualify-railgun-relay-positive.js': sha(
      fs.readFileSync(path.join(__dirname, '../qualify-railgun-relay-positive.js'))
    ),
    'scripts/fixtures/railgun-poi-signed-event.json': sha(
      fs.readFileSync(path.join(__dirname, 'railgun-poi-signed-event.json'))
    ),
    'scripts/fixtures/railgun-shield-offline-deployment.js': sha(
      fs.readFileSync(path.join(__dirname, 'railgun-shield-offline-deployment.js'))
    ),
    'docs/qualification/railgun-public-contract-bytecodes-2026-10-04.json': sha(
      fs.readFileSync(
        path.join(
          __dirname,
          '../../docs/qualification/railgun-public-contract-bytecodes-2026-10-04.json'
        )
      )
    ),
    'docs/qualification/railgun-poi-read-2026-10-03.json': sha(
      fs.readFileSync(
        path.join(__dirname, '../../docs/qualification/railgun-poi-read-2026-10-03.json')
      )
    ),
  });
  const before = sourceHashes();
  for (const entry of [
    'scripts/fixtures/railgun-relay-positive-native.js',
    'scripts/fixtures/railgun-relay-positive-native.test.js',
    'scripts/fixtures/railgun-relay-positive-membership-job.js',
    'scripts/fixtures/railgun-relay-positive-audit-job.js',
    'src/main/wallet/railgun-relay-operation.js',
    'src/main/wallet/railgun-account-wallet.js',
    'src/main/wallet/railgun-account-poi.js',
    'src/main/wallet/railgun-private-reservations.js',
    'src/main/wallet/railgun-relay-recovery-store.js',
  ])
    assert.match(before[entry], /^[0-9a-f]{64}$/);
  assert.equal(
    path.join(fs.realpathSync(path.dirname(config.directory)), path.basename(config.directory)),
    config.directory
  );
  retained.freshDirectory(config.directory, {
    sourceFilename: config.sourceFilename,
    archive: config.archive,
    proverArchive: config.proverArchive,
    artifactDirectory: config.artifactDirectory,
  });
  const profile = require('../../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(config.directory, 'profile') },
  });
  const lockApi = require('../../src/main/profile-lock');
  const lock = lockApi.acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  let selected, identity, enrollment, publicAccount, account, report, failure;
  const protocol = createProtocol(config.artifactDirectory);
  const services = installServices(derived.logs, () => selected, config.scenario, protocol.request);
  services.selected = (v) => {
    assert.equal(selected, undefined);
    selected = Object.freeze({ ...v });
  };
  const custody = installCustody();
  const jobs = installJobs(protocol.draft, () => custody.issued());
  custody.jobs(jobs);
  const vault = require('../../src/main/identity/vault');
  const started = performance.now();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    identity?.close();
    enrollment?.close();
  }, 900000);
  const current = () => {
    assert.equal(expired, false);
    assert.ok(performance.now() >= started && performance.now() - started < 900000);
  };
  try {
    const vaultDirectory = path.join(profile.userDataDir, 'identity');
    await vault.importVault(
      vaultDirectory,
      'public-fixture-password-not-a-user-credential',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    identity = await require(wallet + 'railgun-identity').openRailgunIdentity({ archive });
    current();
    enrollment = await require(
      wallet + 'railgun-account-enrollment'
    ).openRailgunCooperativeAccountEnrollment({ identity, create: true });
    publicAccount = await require(wallet + 'railgun-account-public').openRailgunAccountPublic({
      enrollment,
      archive,
      create: true,
    });
    for (const range of ranges()) {
      current();
      await publicAccount.advance({
        to: range.to,
        anchor: { number: ANCHOR, hash: hex(ANCHOR + 1) },
      });
    }
    const api = require(wallet + 'railgun-account-wallet'),
      coordinator = publicAccount.coordinator;
    const policy = api.getRailgunAccountWalletPolicy({ archive, enrollment, coordinator });
    await enrollment.catalog.begin(policy);
    account = await api.openRailgunAccountWallet({
      identity,
      enrollment,
      archive,
      coordinator,
      policy,
      mode: 'pending',
    });
    await account.close();
    account = await api.openRailgunAccountWallet({
      identity,
      enrollment,
      archive,
      coordinator,
      policy,
      mode: 'active',
    });
    current();
    // Source-derived bootstrap: 60 ranges (3 canonical passes each), 59 prior
    // refreshes, 60 log reads, 3 event headers, first publication (8 headers),
    // two wallet snapshots (20 headers), and one genuine chain handshake.
    assert.equal(services.requests.length, 1283);
    report = await qualify({
      account,
      owners: { identity, enrollment, coordinator },
      archive,
      proverArchive: config.proverArchive,
      artifactDirectory: config.artifactDirectory,
      scenario: config.scenario,
      services,
      jobs,
      custody,
    });
    await jobs.finish();
    assert.equal(services.requests.length, 1322);
    assert.equal(services.requests.filter((v) => v.method === 'eth_chainId').length, 3);
    current();
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    for (const use of [
      () => account?.close(),
      () => publicAccount?.close(),
      () => enrollment?.close(),
      () => identity?.close(),
      () => vault.lockVault(),
      () => services.close(),
    ])
      try {
        await use();
      } catch (error) {
        failure ??= error;
      }
    for (const use of [
      () => services.restore(),
      () => jobs.restore(),
      () => custody.restore(),
      () => lockApi.releaseProfileLock(lock),
    ])
      try {
        use();
      } catch (error) {
        failure ??= error;
      }
  }
  if (failure) throw failure;
  current();
  native.assertEmpty();
  assert.deepEqual(sourceHashes(), before);
  assert.equal(
    require(wallet + 'railgun-engine-runtime').verifyRailgunEngineRuntime(config.archive),
    archive
  );
  assert.equal(
    sha(retained.readBounded(config.sourceFilename, 8466, { bytes: 8466, sha256: SOURCE_SHA })),
    derived.originalSha256
  );
  assert.equal(
    require(wallet + 'railgun-prover-runtime').verifyRailgunProverRuntime(config.proverArchive),
    proverArchive
  );
  current();
  fs.writeFileSync(
    path.join(config.directory, 'report.json'),
    JSON.stringify(
      {
        ...report,
        fixturePins: {
          engineSha256: require(wallet + 'railgun-engine-manifest.json').sha256,
          proverSha256: require(wallet + 'railgun-prover-manifest.json').sha256,
          artifactManifestSha256: sha(
            JSON.stringify(require(wallet + 'railgun-artifacts').manifest)
          ),
        },
        originalSourceSha256: derived.originalSha256,
        translatedLogsSha256: derived.translatedSha256,
        blockOffset: OFFSET,
        setupRanges: ranges(),
        originalJobs: jobs.rows,
        sourceSha256: before,
        syntheticRpcRequests: services.requests.length,
        rpcOwner: 'genuine-private-rpc',
        syntheticProviderHost: 'synthetic.invalid',
        syntheticChainIdChecks: 3,
        originalControllerDeadlineMs: 180000,
        overallFixtureDeadlineMs: 900000,
        sourceInventoryIsExecutionCoverage: false,
        mainModuleCache: inspectMainModuleCache(),
      },
      null,
      2
    ) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
}
module.exports = {
  assertReadyLocal,
  collectMainModuleCache,
  inspectMainModuleCache,
  select,
  translate,
  ranges,
  expectedRoles,
  assertOperationRpc,
  createProtocol,
  installCustody,
  runFixtureJob,
  assertAudit,
  installServices,
  installJobs,
  qualify,
  execute,
};
