/** Transport/signing observers only; never issues completion or submission authority. */
const fixtureChecks = require('./railgun-native-assertions');
const assert = fixtureChecks.assert;
const { Transaction, toBeHex } = require('ethers');
// Opt-in synthetic EOA history: earlier ordinary sends, resolved at these
// blocks, which the journal's history refresh re-reads before each send.
const HEAD = 11834600;
const historyBlockHash = (n) => toBeHex(BigInt(n) * 7919n + 1n, 32);
const syntheticHistory = (resolved) =>
  Array.from({ length: resolved }, (_, n) => ({
    hash: '0x' + (n + 1).toString(16).padStart(64, 'a'),
    nonce: n,
    blockNumber: HEAD - 40 + n,
    blockHash: historyBlockHash(HEAD - 40 + n),
    confirmations: 41 - n,
  }));
exports.install = function install({ testCase, endpoint, resolved = 0 }) {
  assert.ok(['acknowledged', 'lost-response'].includes(testCase));
  assert.equal(endpoint, 'https://synthetic.invalid/railgun-partial-controller');
  assert.ok(Number.isSafeInteger(resolved) && resolved >= 0 && resolved <= 8);
  const history = syntheticHistory(resolved);
  const transport = require('../../src/main/networks/wallet-tor-transport');
  const signers = require('../../src/main/wallet/signers');
  const { getPrivacyContext } = require('../../src/main/networks/privacy-context');
  const originalTransport = transport.createWalletTorTransport,
    originalSigner = signers.getSigner;
  const clients = new Set();
  const counts = {
    creates: 0,
    closes: 0,
    entries: 0,
    pending: 0,
    transactionEntries: 0,
    unexpectedFailures: 0,
    controlledLostReplies: 0,
    addressAttempts: 0,
    signatureAttempts: 0,
    signatures: 0,
    sends: 0,
    journalBeforeSend: 0,
  };
  const methods = {},
    events = [];
  let active = true,
    expected,
    transactionHash;
  const current = () => assert.equal(active, true);
  signers.getSigner = (index) => {
    const genuine = originalSigner(index);
    return Object.freeze({
      async getAddress() {
        counts.addressAttempts++;
        current();
        return genuine.getAddress();
      },
      async signTransaction(tx) {
        counts.signatureAttempts++;
        current();
        assert.ok(expected);
        assert.equal(counts.signatureAttempts, 1);
        assert.equal(tx.to.toLowerCase(), expected.transaction.to.toLowerCase());
        assert.equal(tx.data, expected.transaction.data);
        assert.equal(BigInt(tx.value), 0n);
        const raw = await genuine.signTransaction(tx);
        current();
        counts.signatures++;
        return raw;
      },
    });
  };
  transport.createWalletTorTransport = (...args) => {
    current();
    const delegate = originalTransport(...args);
    counts.creates++;
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
      ...delegate,
      closed: drained,
      close() {
        if (!closed) counts.closes++;
        closed = true;
        try {
          delegate.close();
        } finally {
          finish();
        }
      },
      async request(handle, url, options) {
        counts.entries++;
        counts.pending++;
        pending++;
        let controlled = false;
        const currency = () => {
          current();
          assert.equal(closed, false);
          assert.equal(options.signal.aborted, false);
          return getPrivacyContext(handle);
        };
        try {
          const { subject } = currency();
          if (subject.role !== 'transaction-rpc') {
            const response = await delegate.request(handle, url, options);
            currency();
            return response;
          }
          counts.transactionEntries++;
          assert.ok(expected);
          assert.equal(subject.kind, 'public-address');
          assert.equal(subject.chainId, 11155111);
          assert.equal(subject.principal, expected.owner);
          assert.equal(subject.operation, null);
          assert.equal(url, endpoint);
          assert.equal(options.method, 'POST');
          const wire = JSON.parse(options.body);
          assert.deepEqual(Object.keys(wire).sort(), ['id', 'jsonrpc', 'method', 'params']);
          assert.equal(wire.jsonrpc, '2.0');
          assert.equal(typeof wire.id, 'string');
          assert.equal(typeof wire.method, 'string');
          assert.ok(Array.isArray(wire.params));
          methods[wire.method] = (methods[wire.method] || 0) + 1;
          events.push({ method: wire.method, at: performance.now() });
          if (['eth_chainId', 'eth_getCode', 'eth_getBalance'].includes(wire.method)) {
            const response = await delegate.request(handle, url, options);
            currency();
            return response;
          }
          let result;
          if (wire.method === 'eth_getTransactionCount') {
            assert.equal(wire.params.length, 2);
            assert.equal(wire.params[0].toLowerCase(), expected.owner);
            assert.ok(['pending', 'latest'].includes(wire.params[1]));
            result = '0x' + resolved.toString(16);
          } else if (resolved && wire.method === 'eth_blockNumber') {
            assert.deepEqual(wire.params, []);
            result = '0x' + HEAD.toString(16);
          } else if (resolved && wire.method === 'eth_getBlockByNumber') {
            assert.equal(wire.params.length, 2);
            assert.equal(wire.params[1], false);
            const number = Number(BigInt(wire.params[0]));
            assert.ok(history.some((entry) => entry.blockNumber === number));
            result = {
              number: wire.params[0],
              hash: historyBlockHash(number),
              parentHash: historyBlockHash(number - 1),
              timestamp: '0x6500',
            };
          } else if (wire.method === 'eth_gasPrice') {
            assert.deepEqual(wire.params, []);
            result = '0x64';
          } else if (['eth_estimateGas', 'eth_call'].includes(wire.method)) {
            assert.equal(wire.params.length, wire.method === 'eth_call' ? 2 : 1);
            if (wire.method === 'eth_call') assert.equal(wire.params[1], 'latest');
            const tx = wire.params[0];
            assert.equal(tx.from.toLowerCase(), expected.owner);
            assert.equal(tx.to.toLowerCase(), expected.transaction.to.toLowerCase());
            assert.equal(tx.data, expected.transaction.data);
            assert.equal(BigInt(tx.value), 0n);
            result = wire.method === 'eth_call' ? '0x' : '0x100000';
          } else if (wire.method === 'eth_sendRawTransaction') {
            counts.sends++;
            assert.equal(counts.sends, 1);
            assert.equal(counts.signatures, 1);
            assert.equal(wire.params.length, 1);
            const signed = Transaction.from(wire.params[0]);
            assert.equal(signed.from.toLowerCase(), expected.owner);
            assert.equal(signed.chainId, 11155111n);
            assert.equal(signed.to.toLowerCase(), expected.transaction.to.toLowerCase());
            assert.equal(signed.data, expected.transaction.data);
            assert.equal(signed.value, 0n);
            const journal =
              require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
                handle
              );
            const records = await journal.list();
            currency();
            assert.equal(records.length, resolved + 1);
            for (const [index, prior] of records.slice(0, -1).entries()) {
              assert.equal(prior.hash, history[index].hash);
              assert.equal(prior.intent, undefined);
              assert.equal(prior.resolution.blockHash, history[index].blockHash);
            }
            const record = records.at(-1);
            assert.equal(record.state, 'attempted');
            assert.equal(record.hash, signed.hash.toLowerCase());
            assert.deepEqual(
              record.intent,
              require('../../src/main/wallet/railgun-transact-intent').railgunTransactJournalIntent(
                signed
              )
            );
            counts.journalBeforeSend++;
            transactionHash = record.hash;
            if (testCase === 'lost-response') {
              controlled = true;
              counts.controlledLostReplies++;
              throw Error('Synthetic lost broadcast reply');
            }
            result = record.hash;
          } else throw Error('Unexpected cold-submission EOA method');
          currency();
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
          };
        } catch (error) {
          if (!controlled) {
            counts.unexpectedFailures++;
            fixtureChecks.record(error, 'eoa-transport');
          }
          throw error;
        } finally {
          pending--;
          counts.pending--;
          finish();
        }
      },
    };
    clients.add(client);
    return client;
  };
  return Object.freeze({
    configure({ owner, transaction }) {
      current();
      assert.equal(expected, undefined);
      assert.match(owner, /^0x[0-9a-f]{40}$/);
      assert.equal(BigInt(transaction.chainId), 11155111n);
      expected = JSON.parse(JSON.stringify({ owner, transaction }));
    },
    // The synthetic resolved sends a qualifier seeds through the real journal.
    history: () => history.map((entry) => ({ ...entry })),
    report() {
      return {
        ...counts,
        methods: { ...methods },
        events: events.map((event) => ({ ...event })),
        transactionHash,
      };
    },
    async close() {
      active = false;
      for (const client of clients) client.close();
      await Promise.all([...clients].map((client) => client.closed));
      assert.equal(counts.pending, 0);
      assert.equal(counts.creates, counts.closes);
      transport.createWalletTorTransport = originalTransport;
      signers.getSigner = originalSigner;
    },
  });
};
