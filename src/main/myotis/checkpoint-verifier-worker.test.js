const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const {
  verifyCheckpoint,
  checkpointQuorum,
  headerRoot,
  fetchBytes,
  MAX_PROOF_BYTES,
  MAX_METADATA_BYTES,
} = require('./checkpoint-verifier-worker');
const { CHECKPOINT_NETWORKS, MAX_AGE_MS } = require('./checkpoint-verifier');

const NOW = Date.UTC(2026, 8, 14, 21);
function fixture(chainId = 1) {
  const config = CHECKPOINT_NETWORKS[chainId];
  const slot =
    Math.floor((NOW / 1000 - config.genesis) / config.secondsPerSlot / config.slotsPerEpoch) *
      config.slotsPerEpoch -
    config.slotsPerEpoch;
  const header = {
    slot: '0x' + slot.toString(16),
    proposerIndex: '0x123',
    parentRoot: '0x' + '11'.repeat(32),
    stateRoot: '0x' + '22'.repeat(32),
    bodyRoot: '0x' + '33'.repeat(32),
  };
  const decoded = {
    sync_data: {
      pubkeys: Array(512).fill('0x' + '44'.repeat(48)),
      checkpoint: {
        header,
        aggregate_pubkey: '0x' + '44'.repeat(48),
        proof: ['0x' + '55'.repeat(32)],
      },
    },
  };
  const finality = {
    data: { finalized: { epoch: String(slot / config.slotsPerEpoch), root: headerRoot(header) } },
  };
  let verify;
  let verifyFailure;
  let requestUrl;
  let storage;
  let clientConfig;
  const runtime = {
    clientVersion: 196608,
    Strategy: { VerifiedOnly: 0 },
    Colibri: class {
      static async register_storage(value) {
        storage = value;
      }
      constructor(value) {
        clientConfig = value;
      }
      async verifyProof(_method, _params, proof) {
        verify = proof;
        await clientConfig.fetch(
          requestUrl || config.source + '/eth/v1/beacon/blocks/' + slot + '/root'
        );
        if (verifyFailure) throw verifyFailure;
        return { number: '0x1' };
      }
      destroy() {}
    },
    decode_proof: jest.fn(async () => decoded),
  };
  const fetch = jest.fn(async (url) => {
    if (url === config.prover) return new Response(Buffer.from('bounded test proof'));
    if (url.endsWith('finality_checkpoints')) return new Response(JSON.stringify(finality));
    return new Response(JSON.stringify({ data: { root: headerRoot(header) } }));
  });
  return {
    config,
    decoded,
    finality,
    header,
    slot,
    runtime,
    fetch,
    dependencies: { runtime, fetch, now: () => NOW },
    failVerification: (error) => {
      verifyFailure = error;
    },
    trustUrl: (value) => {
      requestUrl = value;
    },
    get verifyBytes() {
      return verify;
    },
    get storage() {
      return storage;
    },
    get clientConfig() {
      return clientConfig;
    },
  };
}

describe('checkpoint proof/finality policy', () => {
  test('a runtime without an encoded client version fails before requesting evidence', async () => {
    const f = fixture();
    f.runtime.clientVersion = undefined;
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_INCOMPATIBLE',
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  test.each([1, 100])(
    'requires exact checkpoint and explicit finality for chain %i',
    async (chainId) => {
      const f = fixture(chainId);
      const result = await verifyCheckpoint(chainId, f.dependencies);
      expect(result).toEqual({
        schemaVersion: 2,
        chainId,
        network: f.config.network,
        root: headerRoot(f.header),
        slot: f.slot,
        sources: f.config.sources.slice(0, f.config.participants),
        verifiedAt: NOW,
        finalizedEpoch: f.slot / f.config.slotsPerEpoch,
      });
      expect(f.runtime.decode_proof).toHaveBeenCalledWith(f.verifyBytes);
      const proofRequest = f.fetch.mock.calls.find(([url]) => url === f.config.prover);
      expect(JSON.parse(proofRequest[1].body)).toEqual({
        method: 'eth_getBlockByNumber',
        params: ['latest', false],
        version: 196608, // 3.0.0; requesting v2 proofs breaks the v3 verifier.
        zk_proof: true,
      });
      expect(f.clientConfig).toMatchObject({
        checkpointz: [f.config.source],
        beacon_apis: [],
        prover: [],
      });
      expect(f.fetch).toHaveBeenCalledTimes(1 + 2 * f.config.participants);
      for (const [, options] of f.fetch.mock.calls) expect(options.redirect).toBe('error');
    }
  );

  test('a decoded proof with an invalid signature is a mismatch', async () => {
    const f = fixture();
    f.failVerification(new Error('invalid zk_proof!'));
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
    expect(f.runtime.decode_proof).toHaveBeenCalledTimes(1);
  });

  test('service outage remains unavailable even when Colibri wraps the fetch error', async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (url) => {
      if (url === f.config.prover) return new Response('proof');
      throw new Error('offline');
    });
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test.each(['{"error":"busy"}', '<html>Maintenance</html>', 'malformed proof'])(
    'an undecodable HTTP-200 prover body is unavailable: %s',
    async (body) => {
      const f = fixture();
      f.fetch.mockResolvedValue(new Response(body));
      f.runtime.decode_proof.mockRejectedValue(new Error('Unknown proof format'));
      await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
        code: 'CHECKPOINT_UNAVAILABLE',
      });
      expect(f.verifyBytes).toBeUndefined();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    ['root', '<html>Maintenance</html>'],
    ['root', '{"error":"busy"}'],
    ['root', '{"data":{"root":"truncated"}}'],
    ['finality', '<html>Maintenance</html>'],
    ['finality', 'null'],
    ['finality', '{"data":{"finalized":{"epoch":"bad","root":"bad"}}}'],
  ])('malformed authority %s response is unavailable: %s', async (endpoint, body) => {
    const f = fixture();
    const originalFetch = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(async (url) => {
      if (url !== f.config.prover && (url.endsWith('finality_checkpoints') === (endpoint === 'finality'))) {
        return new Response(body);
      }
      return originalFetch(url);
    });
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('successful verification without a trust lookup is an incompatible runtime', async () => {
    const f = fixture();
    f.runtime.Colibri.prototype.verifyProof = async () => ({ number: '0x1' });
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_INCOMPATIBLE',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('quorum evidence refused during interception is never verified as success', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(async (url) => {
      if (url !== f.config.prover && !url.endsWith('finality_checkpoints')) {
        return new Response(JSON.stringify({ execution_optimistic: true, data: { root: headerRoot(f.header) } }));
      }
      return original(url);
    });
    // A future runtime could swallow the interception failure and still report
    // a verified proof; the recorded transport error must still decide.
    f.runtime.Colibri.prototype.verifyProof = async function verifyProof() {
      try {
        await f.clientConfig.fetch(`${f.config.source}/eth/v1/beacon/blocks/${f.slot}/root`);
      } catch {
        /* swallowed by the runtime */
      }
      return { number: '0x1' };
    };
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test('a runtime without the required decoder is incompatible before any request', async () => {
    const f = fixture();
    f.runtime.decode_proof = undefined;
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_INCOMPATIBLE',
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  test('unapproved fallback host is never contacted', async () => {
    const f = fixture();
    f.trustUrl(f.config.prover + '/eth/v1/beacon/blocks/' + f.slot + '/root');
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('a later finalized root is retryable, not reported as a proof conflict', async () => {
    const f = fixture();
    f.finality.data.finalized.epoch = String(Number(f.finality.data.finalized.epoch) + 1);
    f.finality.data.finalized.root = '0x' + '99'.repeat(32);
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('conflicting root at the same finalized epoch fails as mismatch', async () => {
    const f = fixture();
    f.finality.data.finalized.root = '0x' + '99'.repeat(32);
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test.each([[true, 'CHECKPOINT_QUORUM_CONFLICT'], ['false', 'CHECKPOINT_QUORUM_UNAVAILABLE']])(
    'optimistic or mistyped metadata %p is not accepted',
    async (value, code) => {
      const f = fixture();
      f.finality.execution_optimistic = value;
      await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({ code });
    }
  );

  test('missing modern committee-binding variant is rejected', async () => {
    const f = fixture();
    delete f.decoded.sync_data.checkpoint.aggregate_pubkey;
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
  });

  test('a root fetched at a different slot cannot authorize the header', async () => {
    const f = fixture();
    f.trustUrl(f.config.source + '/eth/v1/beacon/blocks/' + (f.slot - 1) + '/root');
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
  });

  test('one-hour age is enforced even if proof verification succeeds', async () => {
    const f = fixture();
    f.dependencies.now = () => NOW + MAX_AGE_MS;
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_STALE',
    });
  });

  test('a future checkpoint fails as clock mismatch', async () => {
    const f = fixture();
    f.dependencies.now = () => (f.config.genesis + f.slot * f.config.secondsPerSlot) * 1000 - 1;
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_CLOCK',
    });
  });

  test('a finalized epoch in the future is rejected', async () => {
    const f = fixture();
    f.finality.data.finalized.epoch = String(Number(f.finality.data.finalized.epoch) + 100);
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_CLOCK',
    });
  });


  test.each([0, 1, 2])('Ethereum recovers with authority %i offline', async (index) => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url.startsWith(f.config.sources[index])
      ? Promise.reject(new Error('offline')) : original(url));
    const result = await verifyCheckpoint(1, f.dependencies);
    expect(result.sources).toEqual(f.config.sources.slice(0, 3).filter((_, i) => i !== index));
  });

  test.each([1, 100])('chain %i never accepts one vote', async (chainId) => {
    const f = fixture(chainId);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url === f.config.prover || url.startsWith(f.config.sources[0])
      ? original(url) : Promise.reject(new Error('offline')));
    await expect(verifyCheckpoint(chainId, f.dependencies)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test.each([1, 100])('chain %i distinguishes an actual split from missing votes', async (chainId) => {
    const f = fixture(chainId);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (url.startsWith(f.config.sources[1])) {
        return Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
          ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32) } } }
          : { data: { root: '0x' + '99'.repeat(32) } })));
      }
      if (f.config.sources.slice(2).some((source) => url.startsWith(source))) return Promise.reject(new Error('offline'));
      return original(url);
    });
    await expect(verifyCheckpoint(chainId, f.dependencies)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
  });

  test('two unavailable original candidates are replaced from the wider pool', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => f.config.sources.slice(0, 2).some((source) => url.startsWith(source))
      ? Promise.reject(new Error('offline')) : original(url));
    const result = await verifyCheckpoint(1, f.dependencies);
    expect(result.sources).toEqual(f.config.sources.slice(2, 5));
    const contacted = new Set(f.fetch.mock.calls.filter(([url]) => url !== f.config.prover).map(([url]) => new URL(url).origin));
    expect([...contacted]).toEqual(f.config.sources.slice(0, 5));
  });

  test('exhausts all seven candidates without accepting a lone vote', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url === f.config.prover || url.startsWith(f.config.sources[6])
      ? original(url) : Promise.reject(new Error('offline')));
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_UNAVAILABLE' });
    expect(new Set(f.fetch.mock.calls.filter(([url]) => url !== f.config.prover).map(([url]) => new URL(url).origin)).size).toBe(7);
  });

  test('three disagreeing participants are never replaced by agreeable reserves', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      const index = f.config.sources.findIndex((source) => url.startsWith(source));
      if (index < 0 || index > 2) return original(url);
      const root = '0x' + String(index + 1).repeat(64);
      return Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
        ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root } } }
        : { data: { root } })));
    });
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect(f.fetch.mock.calls.some(([url]) => f.config.sources.slice(3).some((source) => url.startsWith(source)))).toBe(false);
  });

  test('retains a dissenting vote while replacing an unavailable participant', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (url.startsWith(f.config.sources[0])) return Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
        ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32) } } }
        : { data: { root: '0x' + '99'.repeat(32) } })));
      if (url.startsWith(f.config.sources[1])) return Promise.reject(new Error('offline'));
      return original(url);
    });
    expect((await verifyCheckpoint(1, f.dependencies)).sources).toEqual(f.config.sources.slice(2, 4));
    expect(f.fetch).toHaveBeenCalledTimes(9);
  });

  test('contradictory evidence occupies a seat and is not discarded for a reserve', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (f.config.sources.slice(0, 2).some((source) => url.startsWith(source)) && url.endsWith('finality_checkpoints')) {
        return Promise.resolve(new Response(JSON.stringify({ data: { finalized: {
          epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32),
        } } })));
      }
      return original(url);
    });
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  test('two matching Ethereum votes tolerate one dissenting authority', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url.startsWith(f.config.sources[0])
      ? Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
        ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32) } } }
        : { data: { root: '0x' + '99'.repeat(32) } }))) : original(url));
    const result = await verifyCheckpoint(1, f.dependencies);
    expect(result.sources).toEqual(f.config.sources.slice(1, 3));
  });

  test('aligned finalized history permits different latest epochs without comparing unrelated roots', async () => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => {
      if (!url.startsWith(f.config.sources[1])) return original(url);
      if (url.endsWith('finality_checkpoints')) return Promise.resolve(new Response(JSON.stringify({
        data: { finalized: { epoch: String(f.slot / 16 + 1), root: '0x' + '99'.repeat(32) } },
      })));
      if (url.endsWith('/slots')) return Promise.resolve(new Response(JSON.stringify({ data: { slots: [
        { slot: String(f.slot), block_root: headerRoot(f.header) },
      ] } })));
      return original(url);
    });
    await expect(verifyCheckpoint(100, f.dependencies)).resolves.toMatchObject({ sources: f.config.sources.slice(0, f.config.participants) });
  });

  test.each(['missing', 'conflicting', 'duplicate'])('finalized history %s never supplies a vote', async (variant) => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    const entry = { slot: f.slot, block_root: headerRoot(f.header) };
    f.fetch.mockImplementation((url) => {
      if (!url.startsWith(f.config.sources[1])) return original(url);
      if (url.endsWith('finality_checkpoints')) return Promise.resolve(new Response(JSON.stringify({
        data: { finalized: { epoch: String(f.slot / 16 + 1), root: '0x' + '99'.repeat(32) } },
      })));
      if (url.endsWith('/slots')) return Promise.resolve(new Response(JSON.stringify({ data: { slots:
        variant === 'missing' ? [] : variant === 'duplicate' ? [entry, entry] : [{ ...entry, block_root: '0x' + '99'.repeat(32) }],
      } })));
      return original(url);
    });
    await expect(verifyCheckpoint(100, f.dependencies)).rejects.toMatchObject({
      code: variant === 'missing' ? 'CHECKPOINT_QUORUM_UNAVAILABLE' : 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test('repeated Colibri lookups reuse votes, not extra voter identities', async () => {
    const f = fixture(100);
    const originalVerify = f.runtime.Colibri.prototype.verifyProof;
    f.runtime.Colibri.prototype.verifyProof = async function (...args) {
      await originalVerify.apply(this, args);
      return originalVerify.apply(this, args);
    };
    await verifyCheckpoint(100, f.dependencies);
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });

  test('all authorities agreeing cannot override invalid Colibri proof', async () => {
    const f = fixture();
    f.failVerification(new Error('invalid zk proof'));
    await expect(verifyCheckpoint(1, f.dependencies)).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  test('all authority requests retain HTTPS origins and reject redirects', async () => {
    const f = fixture();
    await checkpointQuorum(f.slot, f.config, f.fetch, () => NOW);
    for (const [url, options] of f.fetch.mock.calls) {
      expect(f.config.sources).toContain(new URL(url).origin);
      expect(options.redirect).toBe('error');
      expect(options.method).toBe('GET');
    }
  });

  test('storage is cleared after an attempt', async () => {
    const f = fixture();
    await verifyCheckpoint(1, f.dependencies);
    expect(f.storage.get('unused')).toBeNull();
  });

  test.each(['1', 11155111])(
    'wrong chain configuration %p is rejected before loading runtime',
    async (chainId) => {
      await expect(verifyCheckpoint(chainId, {})).rejects.toMatchObject({
        code: 'CHECKPOINT_MISMATCH',
      });
    }
  );
});

describe('bounded HTTP bodies', () => {
  test('rejects oversized Content-Length before reading it', async () => {
    const response = new Response('x', {
      headers: { 'content-length': String(MAX_PROOF_BYTES + 1) },
    });
    await expect(
      fetchBytes(async () => response, 'https://test.invalid', {}, MAX_PROOF_BYTES)
    ).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
  });

  test.each([MAX_METADATA_BYTES, MAX_PROOF_BYTES])(
    'enforces streaming limit %i without Content-Length',
    async (limit) => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(limit));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        })
      );
      await expect(
        fetchBytes(async () => response, 'https://test.invalid', {}, limit)
      ).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
    }
  );

  test('metadata at the limit is read exactly', async () => {
    const bytes = Buffer.alloc(MAX_METADATA_BYTES, 65);
    await expect(
      fetchBytes(async () => new Response(bytes), 'https://test.invalid', {}, MAX_METADATA_BYTES)
    ).resolves.toEqual(bytes);
  });

  test('HTTP failure is availability failure, without verifier evidence', async () => {
    await expect(
      fetchBytes(
        async () => new Response('unavailable', { status: 503 }),
        'https://test.invalid',
        {},
        MAX_METADATA_BYTES
      )
    ).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' });
  });
});

// Use the actual pinned WASM in a fresh process; do not confuse mocked policy
// checks above with cryptographic verification. Responses are public captures,
// and the clock is restored to capture time so this test is deterministic/offline.
// Each authority's actual response is replayed separately. These tests make no
// network requests; the capture script records the live quorum observations.
describe('captured proofs with the real Colibri WASM', () => {
  beforeAll(() => {
    // These captures qualify this exact verifier/API, not a semver-compatible build.
    expect(require('@corpus-core/colibri-stateless/package.json').version).toBe('3.0.0');
  });
  test.each(['mainnet', 'gnosis'])(
    '%s proof verifies; corruption, wrong chain, stale and legacy proofs reject',
    (network) => {
      const dir = path.resolve(
        __dirname,
        '../../../docs/audits/evidence/colibri-v3-2026-09/captures/' + network
      );
      const legacyProofPath = path.resolve(
        __dirname,
        '../../../docs/audits/evidence/myotis-recovery-spike-2026-09/captures/' +
          network + '-finalized/proof.ssz'
      );
      const workerPath = path.join(__dirname, 'checkpoint-verifier-worker.js');
      expect(fs.existsSync(path.join(dir, 'proof.ssz'))).toBe(true);
      const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const {verifyCheckpoint} = require(${JSON.stringify(workerPath)});
      const dir = ${JSON.stringify(dir)};
      const original = JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json')));
      Date.now = () => original.verifiedAt;
      const proof = fs.readFileSync(path.join(dir, 'proof.ssz'));
      const responses = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json')));
      const prover = require('./src/main/myotis/checkpoint-verifier').CHECKPOINT_NETWORKS[original.chainId].prover;
      const fetch = async (url) => {
        if (url === prover) return new Response(proof);
        const response = responses[url];
        if (!response) throw new Error('Uncaptured request: ' + url);
        return new Response(response.body, {status: response.status});
      };
      (async () => {
        const good = await verifyCheckpoint(original.chainId, {fetch});
        let corrupt, wrongChain, stale, legacy;
        const malformed = [];
        for (const body of ['{"error":"busy"}', '<html>Maintenance</html>', 'malformed proof']) {
          try { await verifyCheckpoint(original.chainId, {fetch: async () => new Response(body)}); }
          catch(e) { malformed.push(e.code); }
        }
        const badProof = Buffer.from(proof); badProof[badProof.length - 1] ^= 1;
        const badFetch = async (url) => url === prover ? new Response(badProof) : fetch(url);
        try { await verifyCheckpoint(original.chainId, {fetch: badFetch}); } catch(e) { corrupt=e.code; }
        // Supply the same wrong-network proof AND metadata to the other chain's
        // endpoints: rejection must not be caused merely by a missing fixture.
        const proofForAnyProver = async (url, options) => {
          if (options.method === 'POST') return new Response(proof);
          const entry = Object.entries(responses).find(([recorded]) => new URL(recorded).pathname === new URL(url).pathname);
          if (!entry) throw new Error('Uncaptured wrong-chain request: ' + url);
          return new Response(entry[1].body, {status: entry[1].status});
        };
        try { await verifyCheckpoint(original.chainId === 1 ? 100 : 1, {fetch: proofForAnyProver}); } catch(e) { wrongChain=e.code; }
        const legacyProof = fs.readFileSync(${JSON.stringify(legacyProofPath)});
        try { await verifyCheckpoint(original.chainId, {fetch: async () => new Response(legacyProof)}); } catch(e) { legacy=e.code; }
        Date.now = () => original.verifiedAt + 120000;
        try { await verifyCheckpoint(original.chainId, {fetch}); } catch(e) { stale=e.code; }
        console.log(JSON.stringify({good, corrupt, wrongChain, stale, legacy, malformed}));
      })().catch(e => { console.error(e); process.exitCode=1; });
    `;
      const result = JSON.parse(
        execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 })
          .trim()
          .split('\n')
          .at(-1)
      );
      expect(result.good.network).toBe(network);
      const original = JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json')));
      expect(result.good).toMatchObject({ root: original.root, slot: original.slot, sources: original.sources });
      expect(result.corrupt).toBe('CHECKPOINT_MISMATCH');
      expect(result.stale).toBe('CHECKPOINT_STALE');
      expect(result.legacy).toBe('CHECKPOINT_UNAVAILABLE');
      expect(result.malformed).toEqual(Array(3).fill('CHECKPOINT_UNAVAILABLE'));
      // Wrong-network metadata may fail the quorum clock check before the proof check.
      expect(['CHECKPOINT_MISMATCH', 'CHECKPOINT_CLOCK']).toContain(result.wrongChain);
    },
    40_000
  );
});
