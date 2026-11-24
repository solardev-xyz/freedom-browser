/**
 * The checkpoint check's evidence policy, on both verifier paths where it
 * applies (checkpoint-verifier.js's `acquireCheckpoint`): the WASM worker
 * (`verifyCheckpoint`, a scripted runtime) and freedom-colibrid's one-shot
 * process (`checkpoint-colibrid.js`, a scripted check through
 * test/helpers/fake-colibrid.js), meeting the same authorities, prover and
 * verifier model (test/helpers/checkpoint-fixture.js). The runtime's own
 * cases (its client version, its decoder, its storage, an intercepted URL on
 * another origin) are the worker's alone. Then the bounded bodies, and the
 * captured proofs through the real WASM; the captures through the real
 * binary are in checkpoint-colibrid.test.js.
 */
const os = require('node:os');
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
const { MAX_AGE_MS } = require('./checkpoint-verifier');
const { acquireColibridCheckpoint } = require('./checkpoint-colibrid');
const { checkpointFixture: fixture, NOW } = require('../../../test/helpers/checkpoint-fixture');

/** The verifier paths: the WASM worker, and freedom-colibrid's process. */
const PATHS = ['wasm', 'colibrid'];

/** One check of `f` on `verifier`: the worker's `verifyCheckpoint` with the
 * fixture's runtime, or the native path through a fresh fake process. */
function run(verifier, f, chainId = f.chainId) {
  if (verifier === 'wasm') return verifyCheckpoint(chainId, f.dependencies);
  const { dependencies } = f.colibrid();
  return acquireColibridCheckpoint(
    chainId,
    { onDiagnostic: f.dependencies.onDiagnostic },
    dependencies
  );
}

describe.each(PATHS)('checkpoint proof/finality policy on the %s path', (verifier) => {
  const check = (f, chainId) => run(verifier, f, chainId);
  // The runtime's own cases: the WASM worker's alone.
  const wasmTest = verifier === 'wasm' ? test : () => {};
  beforeEach(() => {
    // The fake processes' PIDs are no processes of ours.
    jest.spyOn(os, 'setPriority').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  wasmTest('a runtime without an encoded client version fails before requesting evidence', async () => {
    const f = fixture();
    f.runtime.clientVersion = undefined;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_INCOMPATIBLE',
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  test.each([1, 100])(
    'requires exact checkpoint and explicit finality for chain %i',
    async (chainId) => {
      const f = fixture(chainId);
      const result = await check(f, chainId);
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
        // The runtime's version (3.0.0 here; requesting v2 proofs breaks the
        // v3 verifier), or the service's pinned one (3.0.3).
        version: verifier === 'wasm' ? 196608 : 196611,
        zk_proof: true,
      });
      if (verifier === 'wasm') {
        expect(f.clientConfig).toMatchObject({
          checkpointz: [f.config.source],
          beacon_apis: [],
          prover: [],
        });
      }
      expect(f.fetch).toHaveBeenCalledTimes(1 + 2 * f.config.participants);
      // The quorum's GETs refuse redirects; the service's proof POST is the
      // executor's, which follows none (`manual`, refused there).
      for (const [url, options] of f.fetch.mock.calls) {
        const proof = verifier === 'colibrid' && url === f.config.prover;
        expect(options.redirect).toBe(proof ? 'manual' : 'error');
      }
    }
  );

  test('a decoded proof with an invalid signature is a mismatch', async () => {
    const f = fixture();
    f.failVerification(new Error('invalid zk_proof!'));
    await expect(check(f, 1)).rejects.toMatchObject({
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
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test.each(['{"error":"busy"}', '<html>Maintenance</html>', 'malformed proof'])(
    'an undecodable HTTP-200 prover body is unavailable: %s',
    async (body) => {
      const f = fixture();
      f.fetch.mockResolvedValue(new Response(body));
      f.runtime.decode_proof.mockRejectedValue(new Error('Unknown proof format'));
      await expect(check(f, 1)).rejects.toMatchObject({
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
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('successful verification without a trust lookup is an incompatible runtime', async () => {
    const f = fixture();
    f.verifier.run = async () => ({ number: '0x1' });
    await expect(check(f, 1)).rejects.toMatchObject({
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
    f.verifier.run = async (lookup) => {
      try {
        await lookup(`eth/v1/beacon/blocks/${f.slot}/root`);
      } catch {
        /* swallowed by the runtime */
      }
      return { number: '0x1' };
    };
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  wasmTest('a runtime without the required decoder is incompatible before any request', async () => {
    const f = fixture();
    f.runtime.decode_proof = undefined;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_INCOMPATIBLE',
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  wasmTest('unapproved fallback host is never contacted', async () => {
    const f = fixture();
    f.trustUrl(f.config.prover + '/eth/v1/beacon/blocks/' + f.slot + '/root');
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('a lookup other than the root is never sent, and is a mismatch', async () => {
    const f = fixture();
    // The interception admits the root path alone; the service's contract,
    // the `checkpoint_root` variant alone.
    f.verifier.rootPath = 'eth/v1/beacon/states/head/finality_checkpoints';
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('a later finalized root is retryable, not reported as a proof conflict', async () => {
    const f = fixture();
    f.finality.data.finalized.epoch = String(Number(f.finality.data.finalized.epoch) + 1);
    f.finality.data.finalized.root = '0x' + '99'.repeat(32);
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('conflicting root at the same finalized epoch fails as mismatch', async () => {
    const f = fixture();
    f.finality.data.finalized.root = '0x' + '99'.repeat(32);
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test.each([[true, 'CHECKPOINT_QUORUM_CONFLICT'], ['false', 'CHECKPOINT_QUORUM_UNAVAILABLE']])(
    'optimistic or mistyped metadata %p is not accepted',
    async (value, code) => {
      const f = fixture();
      f.finality.execution_optimistic = value;
      await expect(check(f, 1)).rejects.toMatchObject({ code });
    }
  );

  test('missing modern committee-binding variant is rejected', async () => {
    const f = fixture();
    delete f.decoded.sync_data.checkpoint.aggregate_pubkey;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
  });

  test('a root fetched at a different slot cannot authorize the header', async () => {
    const f = fixture();
    f.verifier.rootPath = 'eth/v1/beacon/blocks/' + (f.slot - 1) + '/root';
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_MISMATCH',
    });
  });

  test('one-hour age is enforced even if proof verification succeeds', async () => {
    const f = fixture();
    f.dependencies.now = () => NOW + MAX_AGE_MS;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_STALE',
    });
  });

  test('a future checkpoint fails as clock mismatch', async () => {
    const f = fixture();
    f.dependencies.now = () => (f.config.genesis + f.slot * f.config.secondsPerSlot) * 1000 - 1;
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_CLOCK',
    });
  });

  test('a finalized epoch in the future is rejected', async () => {
    const f = fixture();
    f.finality.data.finalized.epoch = String(Number(f.finality.data.finalized.epoch) + 100);
    await expect(check(f, 1)).rejects.toMatchObject({
      code: 'CHECKPOINT_CLOCK',
    });
  });


  test.each([0, 1, 2])('Ethereum recovers with authority %i offline', async (index) => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url.startsWith(f.config.sources[index])
      ? Promise.reject(new Error('offline')) : original(url));
    const result = await check(f, 1);
    expect(result.sources).toEqual(f.config.sources.slice(0, 3).filter((_, i) => i !== index));
  });

  test.each([0, 1, 2])('Gnosis verifies with authority %i offline, including historical Beacon votes', async (index) => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    const diagnostics = [];
    f.dependencies.onDiagnostic = value => diagnostics.push(value);
    f.fetch.mockImplementation(url => {
      if (url.startsWith(f.config.sources[index])) return Promise.resolve(new Response('down', { status: 503 }));
      if (url.startsWith(f.config.sources[2]) && url.endsWith('finality_checkpoints')) {
        return Promise.resolve(new Response(JSON.stringify({ finalized: false, execution_optimistic: false,
          data: { finalized: { epoch: String(f.slot / 16 + 1), root: '0x' + '99'.repeat(32) } },
        })));
      }
      return original(url);
    });
    const result = await check(f, 100);
    expect(result.sources).toEqual(f.config.sources.filter((_, i) => i !== index));
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/slots'))).toBe(false);
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: f.config.sources[index],
      outcome: 'CHECKPOINT_UNAVAILABLE', stage: 'block-root', failure: 'http', httpStatus: 503 }));
    expect(diagnostics.filter(value => value.outcome === 'vote')).toHaveLength(2);
  });

  test.each([
    [{}, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: true }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: false, execution_optimistic: false }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: 'true', execution_optimistic: false }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
    [{ finalized: true, execution_optimistic: true }, 'CHECKPOINT_QUORUM_CONFLICT'],
    [{ finalized: true, execution_optimistic: 'false' }, 'CHECKPOINT_QUORUM_UNAVAILABLE'],
  ])('Beacon root flags %j cannot vote without explicit finality and execution verification', async (flags, code) => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(url => {
      if (url.startsWith(f.config.sources[1])) return Promise.reject(new Error('offline'));
      if (url.startsWith(f.config.sources[2]) && url.endsWith('/root')) {
        return Promise.resolve(new Response(JSON.stringify({ ...flags, data: { root: headerRoot(f.header) } })));
      }
      return original(url);
    });
    await expect(check(f, 100)).rejects.toMatchObject({ code });
  });

  test.each(['same-epoch-conflict', 'behind', 'future'])('Beacon finalized flag cannot bypass %s', async variant => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(url => {
      if (url.startsWith(f.config.sources[1])) return Promise.reject(new Error('offline'));
      if (url.startsWith(f.config.sources[2]) && url.endsWith('finality_checkpoints')) {
        return Promise.resolve(new Response(JSON.stringify({ data: { finalized: {
          epoch: String(f.slot / 16 + (variant === 'behind' ? -1 : variant === 'future' ? 100 : 0)),
          root: '0x' + '99'.repeat(32),
        } } })));
      }
      return original(url);
    });
    await expect(check(f, 100)).rejects.toMatchObject({
      code: variant === 'same-epoch-conflict' ? 'CHECKPOINT_QUORUM_CONFLICT' : 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
  });

  test('a Gnosis quorum containing PublicNode cannot bypass an invalid Colibri proof', async () => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(url => url.startsWith(f.config.sources[0])
      ? Promise.reject(new Error('offline')) : original(url));
    f.failVerification(new Error('invalid proof'));
    await expect(check(f, 100)).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
  });

  test('malformed source JSON has bounded diagnostics; diagnostic failure cannot veto other votes', async () => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    const diagnostics = [];
    f.dependencies.onDiagnostic = value => { diagnostics.push(value); throw new Error('logging failed'); };
    f.fetch.mockImplementation(url => url.startsWith(f.config.sources[0])
      ? Promise.resolve(new Response('<html>secret upstream response</html>')) : original(url));
    await expect(check(f, 100)).resolves.toMatchObject({ sources: f.config.sources.slice(1) });
    expect(diagnostics).toContainEqual(expect.objectContaining({ failure: 'invalid-json', stage: 'block-root' }));
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
  });

  test.each([1, 100])('chain %i never accepts one vote', async (chainId) => {
    const f = fixture(chainId);
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url === f.config.prover || url.startsWith(f.config.sources[0])
      ? original(url) : Promise.reject(new Error('offline')));
    await expect(check(f, chainId)).rejects.toMatchObject({
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
    await expect(check(f, chainId)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
  });

  test('two unavailable original candidates are replaced from the wider pool', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => f.config.sources.slice(0, 2).some((source) => url.startsWith(source))
      ? Promise.reject(new Error('offline')) : original(url));
    const result = await check(f, 1);
    expect(result.sources).toEqual(f.config.sources.slice(2, 5));
    const contacted = new Set(f.fetch.mock.calls.filter(([url]) => url !== f.config.prover).map(([url]) => new URL(url).origin));
    expect([...contacted]).toEqual(f.config.sources.slice(0, 5));
  });

  test('exhausts all seven candidates without accepting a lone vote', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url === f.config.prover || url.startsWith(f.config.sources[6])
      ? original(url) : Promise.reject(new Error('offline')));
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_UNAVAILABLE' });
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
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
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
    expect((await check(f, 1)).sources).toEqual(f.config.sources.slice(2, 4));
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
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_QUORUM_CONFLICT' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  test('two matching Ethereum votes tolerate one dissenting authority', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation((url) => url.startsWith(f.config.sources[0])
      ? Promise.resolve(new Response(JSON.stringify(url.endsWith('finality_checkpoints')
        ? { data: { finalized: { epoch: f.finality.data.finalized.epoch, root: '0x' + '99'.repeat(32) } } }
        : { data: { root: '0x' + '99'.repeat(32) } }))) : original(url));
    const result = await check(f, 1);
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
    await expect(check(f, 100)).resolves.toMatchObject({ sources: f.config.sources.slice(0, f.config.participants) });
  });

  test.each(['missing', 'conflicting', 'duplicate'])('finalized history %s never supplies a vote', async (variant) => {
    const f = fixture(100);
    const original = f.fetch.getMockImplementation();
    const entry = { slot: f.slot, block_root: headerRoot(f.header) };
    f.fetch.mockImplementation((url) => {
      if (url.startsWith(f.config.sources[2])) return Promise.reject(new Error('offline'));
      if (!url.startsWith(f.config.sources[1])) return original(url);
      if (url.endsWith('finality_checkpoints')) return Promise.resolve(new Response(JSON.stringify({
        data: { finalized: { epoch: String(f.slot / 16 + 1), root: '0x' + '99'.repeat(32) } },
      })));
      if (url.endsWith('/slots')) return Promise.resolve(new Response(JSON.stringify({ data: { slots:
        variant === 'missing' ? [] : variant === 'duplicate' ? [entry, entry] : [{ ...entry, block_root: '0x' + '99'.repeat(32) }],
      } })));
      return original(url);
    });
    await expect(check(f, 100)).rejects.toMatchObject({
      code: variant === 'missing' ? 'CHECKPOINT_QUORUM_UNAVAILABLE' : 'CHECKPOINT_QUORUM_CONFLICT',
    });
  });

  test('repeated Colibri lookups reuse votes, not extra voter identities', async () => {
    const f = fixture(100);
    const once = f.verifier.run;
    f.verifier.run = async (lookup) => {
      await once(lookup);
      return once(lookup);
    };
    await check(f, 100);
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  test('all authorities agreeing cannot override invalid Colibri proof', async () => {
    const f = fixture();
    f.failVerification(new Error('invalid zk proof'));
    await expect(check(f, 1)).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  wasmTest('storage is cleared after an attempt', async () => {
    const f = fixture();
    await check(f, 1);
    expect(f.storage.get('unused')).toBeNull();
  });

  test.each(['1', 11155111])(
    'wrong chain configuration %p is rejected before loading runtime',
    async (chainId) => {
      const f = fixture();
      await expect(check(f, chainId)).rejects.toMatchObject({
        code: 'CHECKPOINT_MISMATCH',
      });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.runtime.decode_proof).not.toHaveBeenCalled();
    }
  );
});

describe('the quorum', () => {
  test('all authority requests retain HTTPS origins and reject redirects', async () => {
    const f = fixture();
    await checkpointQuorum(f.slot, f.config, f.fetch, () => NOW);
    for (const [url, options] of f.fetch.mock.calls) {
      expect(f.config.sources).toContain(new URL(url).origin);
      expect(options.redirect).toBe('error');
      expect(options.method).toBe('GET');
    }
  });
});

describe('bounded HTTP bodies', () => {
  test('a silent source times out with a bounded diagnostic', async () => {
    jest.useFakeTimers();
    try {
      const fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      const result = fetchBytes(fetch, 'https://test.invalid', {}, MAX_METADATA_BYTES);
      const assertion = expect(result).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE', failure: 'timeout' });
      await jest.advanceTimersByTimeAsync(20000);
      await assertion;
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
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
    expect(require('@corpus-core/colibri-stateless/package.json').version).toBe('3.0.3');
  });
  test('real Gnosis proof requires PublicNode historical finality when Gnosis Checkpointz is offline', () => {
    const dir = path.resolve(__dirname, '../../../docs/audits/evidence/gnosis-recovery-2026-09/capture');
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { verifyCheckpoint } = require(${JSON.stringify(path.join(__dirname, 'checkpoint-verifier-worker.js'))});
      const dir = ${JSON.stringify(dir)};
      const original = JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json')));
      const responses = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json')));
      const proof = fs.readFileSync(path.join(dir, 'proof.ssz'));
      Date.now = () => original.verifiedAt;
      const fetch = (stripFinality, corrupt) => async (url, options) => {
        if (options.method === 'POST') {
          const bytes = Buffer.from(proof);
          if (corrupt) bytes[bytes.length - 1] ^= 1;
          return new Response(bytes);
        }
        if (!responses[url]) throw new Error('Provider offline in capture');
        const response = responses[url];
        const body = JSON.parse(response.body);
        if (stripFinality && url.startsWith('https://gnosis-beacon-api.publicnode.com/') && url.endsWith('/root'))
          delete body.finalized;
        return new Response(JSON.stringify(body), { status: response.status });
      };
      (async () => {
        const good = await verifyCheckpoint(100, { fetch: fetch(false, false) });
        let missingFinality, corrupt;
        try { await verifyCheckpoint(100, { fetch: fetch(true, false) }); } catch (e) { missingFinality = e.code; }
        try { await verifyCheckpoint(100, { fetch: fetch(false, true) }); } catch (e) { corrupt = e.code; }
        console.log(JSON.stringify({ good, missingFinality, corrupt }));
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 })
      .trim().split('\n').at(-1));
    expect(result.good).toEqual(JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json'))));
    expect(result.good.sources).toContain('https://gnosis-beacon-api.publicnode.com');
    expect(result.missingFinality).toBe('CHECKPOINT_QUORUM_UNAVAILABLE');
    expect(result.corrupt).toBe('CHECKPOINT_MISMATCH');
  }, 40000);
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
