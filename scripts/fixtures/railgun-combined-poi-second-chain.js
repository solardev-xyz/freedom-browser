/** Disposable second transaction only. Bind the scanned change before serving
 * any preflight, and the real stored proved calldata before EOA simulation.
 * No first-input fallback, new list answer, or TXID history replacement. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Interface, Transaction } = require('ethers');
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const { PRIVATE_EVENTS } = require('../../src/main/wallet/railgun-transact-receipt');
const abi = new Interface([
  TRANSACT_ABI,
  ...PRIVATE_EVENTS,
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function unshieldFee() view returns (uint120)',
  'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
]);
const quantity = (n) => '0x' + BigInt(n).toString(16);
const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
const URL = 'https://synthetic.invalid/railgun-partial-controller';
function verifier(directory) {
  const entry = require('../../src/main/wallet/railgun-artifacts').manifest['01x01'].find(
    (v) => v.kind === 'vkey'
  );
  const bytes = fs.readFileSync(path.join(directory, entry.name));
  assert.equal(bytes.length, entry.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  const v = JSON.parse(bytes);
  const g1 = (p) => ({ x: BigInt(p[0]), y: BigInt(p[1]) });
  const g2 = (p) => ({
    x: [BigInt(p[0][1]), BigInt(p[0][0])],
    y: [BigInt(p[1][1]), BigInt(p[1][0])],
  });
  return abi
    .encodeFunctionResult('getVerificationKey', [
      {
        artifactsIPFSHash: 'offline-pinned-01x01',
        alpha1: g1(v.vk_alpha_1),
        beta2: g2(v.vk_beta_2),
        gamma2: g2(v.vk_gamma_2),
        delta2: g2(v.vk_delta_2),
        ic: v.IC.map(g1),
      },
    ])
    .toLowerCase();
}
function create(
  {
    bytecodes,
    artifactDirectory,
    accountIndex,
    selected,
    tree,
    merkleRoot,
    amount,
    recipient,
    firstRecord,
    firstNullifier,
    firstRoot,
    firstReceipt,
  },
  cold = false,
  lost = false
) {
  const lostReplies = new WeakSet();
  selected = copy(selected);
  firstRecord = copy(firstRecord);
  firstReceipt = copy(firstReceipt);
  assert.equal(selected.type, 'Transact');
  assert.equal(Number(selected.id.split(':')[0]), tree);
  assert.equal(selected.txid.length, 66);
  assert.notEqual(selected.nullifier, firstNullifier);
  assert.notEqual(merkleRoot, firstRoot);
  assert.equal(typeof amount, 'bigint');
  assert.ok(amount > 0n);
  assert.match(recipient, /^0x[0-9a-f]{40}$/);
  assert.equal(firstRecord.state, 'submitted');
  assert.ok(firstRecord.resolution);
  const firstNumber = Number(BigInt(firstReceipt.blockNumber));
  assert.ok(Number.isSafeInteger(firstNumber) && firstNumber >= 0);
  assert.ok(Number.isSafeInteger(firstRecord.revision) && firstRecord.revision >= 0);
  assert.equal(firstRecord.observation.status, 'included');
  assert.equal(firstRecord.observation.blockNumber, firstNumber);
  assert.equal(firstRecord.observation.blockHash, firstReceipt.blockHash);
  assert.equal(firstRecord.resolution.blockHash, firstReceipt.blockHash);
  assert.equal(firstReceipt.transactionHash, firstRecord.hash);
  assert.equal(firstReceipt.status, '0x1');
  assert.equal(firstReceipt.from.toLowerCase(), recipient);
  assert.match(firstReceipt.blockHash, /^0x[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(firstRecord.observation.observedAt));
  assert.ok(firstRecord.observation.observedAt >= 0);
  const inclusion = firstNumber + 20,
    finalized = inclusion + 10;
  const deployment = require('./railgun-shield-offline-deployment').createOfflineShieldDeployment(
    bytecodes
  );
  const vkey = verifier(artifactDirectory);
  const counts = {
    attempted: {},
    validated: {},
    privateCalls: {},
    sends: 0,
    signatures: 0,
    journalBeforeSend: 0,
    firstCanonicalRefreshReads: 0,
  };
  let active = true,
    latest,
    internalAnchor,
    expected,
    signed,
    receipt,
    transaction;
  const header = (n) => ({
    number: quantity(n),
    hash: hash(n + 1000),
    parentHash: hash(n + 999),
    timestamp: quantity(n),
    transactions: signed ? [signed.hash] : [],
  });
  const inc = (kind, key) => {
    counts[kind][key] = (counts[kind][key] || 0) + 1;
  };
  const current = () => assert.ok(active);
  let lastFirstObservedAt = firstRecord.observation.observedAt;
  // Production refreshResolved deliberately updates the prior record before
  // admitting another send. Only these observed refresh fields may change.
  const assertFirstRecord = (record) => {
    current();
    assert.ok(record && record.observation);
    const { revision, observation, ...immutable } = record;
    const {
      revision: baselineRevision,
      observation: baselineObservation,
      ...baseline
    } = firstRecord;
    assert.deepEqual(immutable, baseline);
    const { confirmations, observedAt, ...anchor } = observation;
    const {
      confirmations: priorConfirmations,
      observedAt: _priorTime,
      ...priorAnchor
    } = baselineObservation;
    assert.deepEqual(anchor, priorAnchor);
    assert.equal(revision, baselineRevision + counts.firstCanonicalRefreshReads);
    assert.ok(Number.isSafeInteger(revision));
    assert.equal(
      confirmations,
      counts.firstCanonicalRefreshReads ? finalized + 2 - firstNumber + 1 : priorConfirmations
    );
    assert.ok(Number.isSafeInteger(observedAt) && observedAt >= lastFirstObservedAt);
    lastFirstObservedAt = observedAt;
  };
  const exactTransaction = (value) => {
    current();
    assert.ok(expected);
    assert.equal(value.to.toLowerCase(), pins.proxy);
    assert.equal(value.data, expected.data);
    assert.equal(BigInt(value.value), 0n);
  };
  const build = () => {
    const [[inner]] = abi.decodeFunctionData('transact', signed.data);
    const gross = inner.unshieldPreimage.value,
      fee = (gross * 25n) / 10000n,
      net = gross - fee;
    assert.equal(gross, amount);
    const treasury = require('../../src/main/wallet/railgun-transact-receipt-policy').treasury;
    const events = [
      [pins.proxy, 'Nullified', [tree, [selected.nullifier]]],
      [pins.wrappedNative, 'Transfer', [pins.proxy, recipient, net]],
      [pins.wrappedNative, 'Transfer', [pins.proxy, treasury, fee]],
      [pins.proxy, 'Unshield', [recipient, [0, pins.wrappedNative, 0], net, fee]],
    ];
    transaction = {
      hash: signed.hash.toLowerCase(),
      from: signed.from.toLowerCase(),
      to: pins.proxy,
      chainId: quantity(signed.chainId),
      nonce: quantity(signed.nonce),
      value: '0x0',
      input: signed.data,
      blockNumber: quantity(inclusion),
      blockHash: hash(inclusion + 1000),
      transactionIndex: '0x0',
    };
    receipt = {
      status: '0x1',
      gasUsed: '0x100000',
      effectiveGasPrice: '0x64',
      transactionHash: transaction.hash,
      from: transaction.from,
      to: pins.proxy,
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
      transactionIndex: '0x0',
      logs: events.map(([address, name, values], i) => ({
        ...abi.encodeEventLog(name, values),
        address,
        transactionHash: transaction.hash,
        blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash,
        transactionIndex: '0x0',
        logIndex: quantity(i),
        removed: false,
      })),
    };
  };
  return Object.freeze({
    assertFirstRecord,
    bindProved(stored) {
      current();
      assert.equal(expected, undefined);
      assert.equal(stored.capsule.version, 1);
      assert.equal(stored.capsule.selection.kind, 'railgun-token-unshield');
      assert.equal(stored.capsule.noteHash, selected.hash);
      assert.equal(stored.capsule.selection.tree, tree);
      assert.equal(stored.capsule.selection.position, Number(selected.id.split(':')[1]));
      assert.equal(stored.capsule.preparation.expected.nullifier, selected.nullifier);
      assert.equal(stored.capsule.preparation.expected.merkleRoot, merkleRoot);
      assert.equal(stored.capsule.preparation.expected.amount, amount.toString());
      assert.equal(stored.capsule.preparation.expected.recipient, recipient);
      expected = copy(stored.provedTransaction);
      const [[inner]] = abi.decodeFunctionData('transact', expected.data);
      assert.deepEqual([...inner.nullifiers], [selected.nullifier]);
      assert.equal(inner.commitments.length, 1);
      assert.equal(inner.boundParams.commitmentCiphertext.length, 0);
      assert.equal(inner.boundParams.unshield, 1n);
      assert.equal(inner.unshieldPreimage.value, amount);
      assert.equal('0x' + inner.unshieldPreimage.npk.slice(-40), recipient);
    },
    assertKeyAdmission() {
      current();
      assert.equal(cold, false);
      assert.deepEqual(counts.privateCalls, {
        rootHistory: 1,
        unshieldFee: 1,
        getVerificationKey: 1,
        nullifiers: 1,
      });
    },
    assertSigning(value) {
      exactTransaction(value);
      assert.equal(counts.signatures, 0);
      if (cold)
        assert.deepEqual(counts.privateCalls, {
          rootHistory: 1,
          unshieldFee: 1,
          getVerificationKey: 1,
          nullifiers: 1,
        });
      assert.equal(BigInt(value.nonce), BigInt(firstRecord.nonce) + 1n);
      counts.signatures++;
    },
    isLostReply: (error) => lostReplies.has(error),
    report: () => copy(counts),
    evidence() {
      current();
      assert.ok(receipt && transaction);
      return copy({ receipt, transaction });
    },
    close() {
      active = false;
    },
    async route(subject, url, options, handle) {
      const protocol =
        subject.role === 'protocol-rpc' &&
        ['shield-preflight', 'private-preflight'].includes(subject.operation);
      const eoa = subject.role === 'transaction-rpc';
      if (!protocol && !eoa) return undefined;
      try {
        current();
        assert.equal(options.signal.aborted, false);
        assert.equal(options.method, 'POST');
        assert.equal(url, URL);
        assert.equal(subject.chainId, pins.chainId);
        const wire = JSON.parse(options.body);
        assert.deepEqual(Object.keys(wire).sort(), ['id', 'jsonrpc', 'method', 'params']);
        assert.equal(wire.jsonrpc, '2.0');
        assert.equal(typeof wire.id, 'string');
        assert.ok(Array.isArray(wire.params));
        const key = subject.role + ':' + (subject.operation ?? 'public') + ':' + wire.method;
        inc('attempted', key);
        let result;
        if (protocol) {
          assert.equal(subject.kind, 'private-account');
          assert.equal(subject.principal, 'railgun:' + accountIndex);
          assert.equal(subject.protocol, 'railgun');
          assert.equal(subject.deployment, 'sepolia');
          if (wire.method === 'eth_chainId') {
            assert.deepEqual(wire.params, []);
            result = '0xaa36a7';
          } else if (subject.operation === 'shield-preflight') {
            if (wire.method === 'eth_getBlockByNumber') {
              assert.equal(wire.params[1], false);
              if (wire.params[0] === 'latest') {
                internalAnchor = deployment.request(wire);
                latest = {
                  ...header(firstNumber + 11),
                  timestamp: quantity(Math.floor(Date.now() / 1000)),
                };
              } else assert.equal(wire.params[0], latest?.number);
              result = latest;
            } else {
              assert.ok(latest && internalAnchor);
              assert.deepEqual(wire.params.at(-1), {
                blockHash: latest.hash,
                requireCanonical: true,
              });
              const translated = copy(wire);
              translated.params[translated.params.length - 1] = {
                blockHash: internalAnchor.hash,
                requireCanonical: true,
              };
              result = deployment.request(translated);
            }
          } else {
            assert.ok(latest);
            if (wire.method === 'eth_getBlockByNumber') {
              assert.deepEqual(wire.params, [latest.number, false]);
              result = latest;
            } else {
              assert.equal(wire.method, 'eth_call');
              assert.equal(wire.params.length, 2);
              assert.deepEqual(wire.params[1], { blockHash: latest.hash, requireCanonical: true });
              assert.deepEqual(Object.keys(wire.params[0]).sort(), ['data', 'to']);
              assert.equal(wire.params[0].to, pins.proxy);
              const call = abi.parseTransaction(wire.params[0]);
              assert.ok(
                ['rootHistory', 'nullifiers', 'unshieldFee', 'getVerificationKey'].includes(
                  call.name
                )
              );
              inc('privateCalls', call.name);
              if (call.name === 'getVerificationKey') {
                assert.deepEqual([...call.args], [1n, 1n]);
                result = vkey;
              } else if (call.name === 'unshieldFee') {
                assert.equal(call.args.length, 0);
                result = abi.encodeFunctionResult(call.name, [25n]);
              } else {
                assert.deepEqual(
                  [...call.args],
                  [BigInt(tree), call.name === 'rootHistory' ? merkleRoot : selected.nullifier]
                );
                result = abi.encodeFunctionResult(call.name, [call.name === 'rootHistory']);
              }
            }
          }
        } else {
          assert.equal(subject.kind, 'public-address');
          assert.equal(subject.principal, recipient);
          assert.equal(subject.operation, null);
          if (wire.method === 'eth_chainId') {
            assert.deepEqual(wire.params, []);
            result = '0xaa36a7';
          } else if (
            ['eth_getCode', 'eth_getBalance', 'eth_getTransactionCount'].includes(wire.method)
          ) {
            assert.equal(wire.params.length, 2);
            assert.equal(wire.params[0].toLowerCase(), recipient);
            assert.ok(['latest', 'pending'].includes(wire.params[1]));
            result =
              wire.method === 'eth_getCode'
                ? '0x'
                : wire.method === 'eth_getBalance'
                  ? '0xde0b6b3a7640000'
                  : quantity(BigInt(firstRecord.nonce) + 1n + BigInt(counts.sends));
          } else if (wire.method === 'eth_gasPrice') {
            assert.deepEqual(wire.params, []);
            result = '0x64';
          } else if (['eth_estimateGas', 'eth_call'].includes(wire.method)) {
            exactTransaction(wire.params[0]);
            assert.equal(wire.params[0].from.toLowerCase(), recipient);
            assert.equal(wire.params.length, wire.method === 'eth_call' ? 2 : 1);
            if (wire.method === 'eth_call') assert.equal(wire.params[1], 'latest');
            result = wire.method === 'eth_estimateGas' ? '0x100000' : '0x';
          } else if (wire.method === 'eth_sendRawTransaction') {
            assert.equal(wire.params.length, 1);
            assert.equal(counts.sends, 0);
            assert.equal(counts.signatures, 1);
            signed = Transaction.from(wire.params[0]);
            exactTransaction(signed);
            assert.equal(signed.from.toLowerCase(), recipient);
            assert.equal(signed.chainId, BigInt(pins.chainId));
            assert.equal(BigInt(signed.nonce), BigInt(firstRecord.nonce) + 1n);
            const journal =
              require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
                handle
              );
            const records = await journal.list();
            current();
            assert.equal(options.signal.aborted, false);
            assert.equal(records.length, 2);
            assertFirstRecord(records.find((v) => v.hash === firstRecord.hash));
            const record = records.find((v) => v.hash === signed.hash.toLowerCase());
            assert.ok(record);
            assert.equal(record.state, 'attempted');
            assert.equal(record.nonce, signed.nonce);
            assert.deepEqual(
              record.intent,
              require('../../src/main/wallet/railgun-transact-intent').railgunTransactJournalIntent(
                signed
              )
            );
            counts.journalBeforeSend++;
            counts.sends++;
            build();
            if (lost) {
              counts.controlledLostReplies = (counts.controlledLostReplies || 0) + 1;
              inc('validated', key);
              const error = Error('Disposable second submission reply lost');
              lostReplies.add(error);
              throw error;
            }
            result = signed.hash;
          } else if (
            ['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(wire.method)
          ) {
            assert.ok(signed);
            assert.deepEqual(wire.params, [signed.hash.toLowerCase()]);
            result = wire.method === 'eth_getTransactionReceipt' ? receipt : transaction;
          } else if (wire.method === 'eth_blockNumber') {
            assert.deepEqual(wire.params, []);
            result = quantity(finalized + 2);
          } else if (wire.method === 'eth_getBlockByNumber') {
            assert.equal(wire.params[1], false);
            const n = wire.params[0] === 'finalized' ? finalized : Number(BigInt(wire.params[0]));
            assert.equal(wire.params.length, 2);
            if (n === firstNumber) {
              assert.equal(wire.params[0], quantity(firstNumber));
              counts.firstCanonicalRefreshReads++;
              result = {
                ...header(firstNumber),
                hash: firstReceipt.blockHash,
                transactions: [firstRecord.hash],
              };
            } else {
              assert.ok([inclusion, finalized, finalized + 1].includes(n));
              result = header(n);
            }
          } else assert.fail('Unexpected second transaction request');
        }
        current();
        assert.equal(options.signal.aborted, false);
        inc('validated', key);
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
        };
      } catch (error) {
        if (!lostReplies.has(error)) sticky.record(error, 'second-chain.request');
        throw error;
      }
    },
  });
}
exports.create = (options) => create(options);
exports.createCold = (options) => create(options, true);

exports.createColdLost = (options) => create(options, true, true);
