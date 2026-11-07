/**
 * A failed remote proof is a failure, never a local proof (#1059).
 *
 * Colibri 3.0.3 proves a read itself when the configured prover's request
 * fails, asking the package's built-in public beacon API and RPC hosts for
 * the inputs. `colibri-runtime.js` stops that at the one transition into the
 * fallback (see the comment above `refuseLocalProving` there). The first block
 * pins the stop's rules against a scripted runtime; the second runs the real
 * WASM client through the worker's own service and client config, with a
 * scripted `fetch` that answers every request itself, so nothing leaves the
 * machine.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { refuseLocalProving, NO_LOCAL_PROVING_ERROR } = require('./colibri-runtime');

const REMOTE = 1;
const PROXY = 3;
const PROOFABLE = 1;
const UNPROOFABLE = 2;
const LOCAL = 4;
const CTX = 0x5000;
const REMOTE_REQUEST = { req_ptr: 0x6000, type: 'prover', method: 'post', encoding: 'ssz' };

function scriptedRuntime({ methodType = PROOFABLE, ctx = CTX } = {}) {
  return {
    kind: 'wasm',
    getMethodType: jest.fn(() => methodType),
    createRpcCtx: jest.fn(() => ctx),
    executeRpcCtx: jest.fn(() => ({ status: 'pending', requests: [REMOTE_REQUEST] })),
    reqSetResponse: jest.fn(),
    reqSetError: jest.fn(),
    freeRpcCtx: jest.fn(),
    decodeProof: jest.fn(),
  };
}

const BALANCE = ['eth_getBalance', '["0xabc","latest"]', 1n, 0, 2];

describe('refuseLocalProving', () => {
  test.each([
    ['remote', REMOTE],
    ['proxy', PROXY],
  ])('ends a %s proof whose request failed with that error, before the C core can prove it locally', (_label, mode) => {
    const raw = scriptedRuntime();
    const runtime = refuseLocalProving(raw);

    const ctx = runtime.createRpcCtx(...BALANCE, mode);
    // The same question the C core asks when it starts the context.
    expect(raw.getMethodType).toHaveBeenCalledWith(1n, 'eth_getBalance', '["0xabc","latest"]', 2);
    const pending = runtime.executeRpcCtx(ctx);
    expect(pending).toEqual({ status: 'pending', requests: [REMOTE_REQUEST] });

    runtime.reqSetError(pending.requests[0], 'HTTP error! Status: 503, Details: down', 0);
    expect(raw.reqSetError).toHaveBeenCalledWith(REMOTE_REQUEST, 'HTTP error! Status: 503, Details: down', 0);

    expect(runtime.executeRpcCtx(ctx)).toEqual({
      status: 'error',
      error: `${NO_LOCAL_PROVING_ERROR}: HTTP error! Status: 503, Details: down`,
    });
    // The execute that would have created the local prover never ran.
    expect(raw.executeRpcCtx).toHaveBeenCalledTimes(1);

    runtime.freeRpcCtx(ctx);
    expect(raw.freeRpcCtx).toHaveBeenCalledWith(CTX);
  });

  test('hands an answered remote proof to the verifier, and its later requests too', () => {
    const raw = scriptedRuntime();
    const runtime = refuseLocalProving(raw);
    const ctx = runtime.createRpcCtx(...BALANCE, REMOTE);
    runtime.executeRpcCtx(ctx);
    const proof = new Uint8Array([1, 2, 3]);
    runtime.reqSetResponse(REMOTE_REQUEST, proof, 0);
    expect(raw.reqSetResponse).toHaveBeenCalledWith(REMOTE_REQUEST, proof, 0);

    // Verifying needs a light-client update; the sync server is down.
    const sync = { req_ptr: 0x6100, type: 'beacon_api', method: 'get' };
    raw.executeRpcCtx.mockReturnValueOnce({ status: 'pending', requests: [sync] });
    expect(runtime.executeRpcCtx(ctx)).toEqual({ status: 'pending', requests: [sync] });
    runtime.reqSetError(sync, 'All nodes failed', 0);
    // Even the remote request's own late error changes nothing now.
    runtime.reqSetError(REMOTE_REQUEST, 'late', 0);
    raw.executeRpcCtx.mockReturnValueOnce({ status: 'error', error: 'sync failed' });
    expect(runtime.executeRpcCtx(ctx)).toEqual({ status: 'error', error: 'sync failed' });
    expect(raw.executeRpcCtx).toHaveBeenCalledTimes(3);
  });

  // A contract call or transaction lookup (LOCAL under PAP) starts in the
  // verifier, whose own prover requests have fallbacks of their own; an
  // unproofable read never proves; local and hybrid modes prove locally by
  // design and are not Freedom's.
  test.each([
    ['a verifier-run read', LOCAL, REMOTE],
    ['an unproofable read', UNPROOFABLE, REMOTE],
    ['local mode', PROOFABLE, 0],
    ['hybrid mode', PROOFABLE, 2],
  ])('leaves %s to the C core', (_label, methodType, mode) => {
    const raw = scriptedRuntime({ methodType });
    const runtime = refuseLocalProving(raw);
    const ctx = runtime.createRpcCtx(...BALANCE, mode);
    runtime.executeRpcCtx(ctx);
    runtime.reqSetError(REMOTE_REQUEST, 'HTTP error! Status: 503', 0);
    raw.executeRpcCtx.mockReturnValueOnce({ status: 'error', error: 'the core\'s own' });
    expect(runtime.executeRpcCtx(ctx)).toEqual({ status: 'error', error: 'the core\'s own' });
    expect(raw.executeRpcCtx).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['two requests', { status: 'pending', requests: [REMOTE_REQUEST, { req_ptr: 0x6200, type: 'beacon_api' }] }],
    ['a request of another type', { status: 'pending', requests: [{ ...REMOTE_REQUEST, type: 'eth_rpc' }] }],
    ['an answer', { status: 'success', result: '0x1' }],
  ])('tracks nothing when the first execute returns %s', (_label, first) => {
    const raw = scriptedRuntime();
    const runtime = refuseLocalProving(raw);
    const ctx = runtime.createRpcCtx(...BALANCE, REMOTE);
    raw.executeRpcCtx.mockReturnValueOnce(first);
    expect(runtime.executeRpcCtx(ctx)).toBe(first);
    runtime.reqSetError(REMOTE_REQUEST, 'down', 0);
    runtime.executeRpcCtx(ctx);
    expect(raw.executeRpcCtx).toHaveBeenCalledTimes(2);
  });

  test('keeps each context to its own request, and forgets a freed one', () => {
    const raw = scriptedRuntime();
    const runtime = refuseLocalProving(raw);
    const other = { ...REMOTE_REQUEST, req_ptr: 0x7000 };
    raw.createRpcCtx.mockReturnValueOnce(CTX).mockReturnValueOnce(CTX + 1);
    const first = runtime.createRpcCtx(...BALANCE, REMOTE);
    const second = runtime.createRpcCtx(...BALANCE, REMOTE);
    raw.executeRpcCtx
      .mockReturnValueOnce({ status: 'pending', requests: [REMOTE_REQUEST] })
      .mockReturnValueOnce({ status: 'pending', requests: [other] });
    runtime.executeRpcCtx(first);
    runtime.executeRpcCtx(second);

    runtime.reqSetError(other, 'down', 0);
    raw.executeRpcCtx.mockReturnValueOnce({ status: 'pending', requests: [] });
    runtime.executeRpcCtx(first);
    expect(raw.executeRpcCtx).toHaveBeenCalledTimes(3);
    expect(runtime.executeRpcCtx(second).status).toBe('error');

    // A freed context's pointer can come back for an unrelated read.
    runtime.reqSetError(REMOTE_REQUEST, 'down', 0);
    runtime.freeRpcCtx(first);
    raw.getMethodType.mockReturnValueOnce(LOCAL);
    raw.createRpcCtx.mockReturnValueOnce(CTX);
    const reused = runtime.createRpcCtx('eth_call', '[]', 1n, 0, 2, REMOTE);
    expect(reused).toBe(first);
    raw.executeRpcCtx.mockReturnValueOnce({ status: 'success', result: '0x' });
    expect(runtime.executeRpcCtx(reused)).toEqual({ status: 'success', result: '0x' });
  });

  test('passes every other runtime call through', () => {
    const raw = scriptedRuntime();
    const runtime = refuseLocalProving(raw);
    expect(runtime.kind).toBe('wasm');
    expect(runtime.decodeProof).toBe(raw.decodeProof);
    expect(runtime.getMethodType).toBe(raw.getMethodType);
  });
});

describe('the real Colibri client with a prover that fails (#1059)', () => {
  const RUNTIME = require.resolve('./colibri-runtime');
  const WORKER = require.resolve('./colibri-worker');
  const PKG_CJS = path.dirname(require.resolve('@corpus-core/colibri-stateless'));
  const PROVER = 'https://prover.invalid';
  // Hosts the package uses for chain 1 when the client isn't given its own,
  // as the worker doesn't: these are the ones the fallback reached.
  const { default_config: defaults } = require(path.join(PKG_CJS, 'chains.js'));
  const BUILT_IN = [...defaults['1'].rpcs, ...defaults['1'].beacon_apis, ...defaults['1'].checkpointz];

  // Answers every request itself: the prover as `proverAnswers` says (a 503,
  // or eight bytes), anything else with a 503. `unguarded` swaps
  // colibri-runtime's provider for upstream's own WASM runtime, without the
  // stop.
  function probe({ reads, proverAnswers = 'down', unguarded = false }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colibri-no-local-'));
    const source = `
      const runtime = require(${JSON.stringify(RUNTIME)});
      if (${unguarded}) {
        require(${JSON.stringify(path.join(PKG_CJS, 'runtime.js'))}).setRuntimeProvider(() =>
          require(${JSON.stringify(path.join(PKG_CJS, 'runtime_wasm.js'))}).getWasmRuntime());
      }
      const { createColibriService } = require(${JSON.stringify(WORKER)});
      const prover = ${JSON.stringify(PROVER)};
      const reads = [];
      let current = null;
      globalThis.fetch = async (url, init = {}) => {
        current.fetched.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
        if (String(url) !== prover) return new Response('down', { status: 503 });
        return ${JSON.stringify(proverAnswers)} === 'down'
          ? new Response('prover down', { status: 503 })
          : new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200 });
      };
      const posted = [];
      const service = createColibriService({
        runtime, storageDir: ${JSON.stringify(dir)}, post: (message) => posted.push(message),
      });
      const config = { chainId: 1, proverUrl: prover, zkProof: false };
      (async () => {
        await service.init();
        for (const [id, [method, params]] of ${JSON.stringify(reads)}.entries()) {
          current = { method, fetched: [] };
          await service.handle({ type: 'request', id, clientId: 1, config, method, params });
          reads.push({ ...current, posted: posted.find((message) => message.id === id) });
        }
      })().then(
        () => { console.log(JSON.stringify({ probe: true, reads })); process.exit(0); },
        (err) => { console.log(JSON.stringify({ probe: true, error: String(err && err.stack || err) })); process.exit(0); },
      );
    `;
    try {
      const stdout = execFileSync(process.execPath, ['-e', source], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const line = stdout.split('\n').find((l) => l.startsWith('{"probe"'));
      const result = JSON.parse(line);
      expect(result.error).toBeUndefined();
      return result.reads;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const ACCOUNT = '0x00000000000000000000000000000000000000aa';
  const PROOFABLE_READS = [
    ['eth_getBalance', [ACCOUNT, 'latest']],
    ['eth_getTransactionCount', [ACCOUNT, 'latest']],
    ['eth_getStorageAt', [ACCOUNT, '0x0', 'latest']],
    ['eth_getCode', [ACCOUNT, 'latest']],
    ['eth_blockNumber', []],
    ['eth_getBlockByNumber', ['latest', false]],
  ];
  const builtIn = (fetched) => fetched.filter(({ url }) => BUILT_IN.some((host) => url.startsWith(host)));

  test('asks only the configured prover, once, and fails the read with its error', () => {
    expect(BUILT_IN.length).toBeGreaterThan(0);
    const reads = probe({ reads: PROOFABLE_READS });
    expect(reads).toHaveLength(PROOFABLE_READS.length);
    for (const { method, fetched, posted } of reads) {
      expect({ method, fetched: fetched.map(({ url, method: verb }) => `${verb} ${url}`) })
        .toEqual({ method, fetched: [`POST ${PROVER}`] });
      expect(builtIn(fetched)).toEqual([]);
      // A plain failure: no `retry`, so the host doesn't resend it to a
      // fresh worker, and the router or ENS moves on to its next source.
      expect(posted).toEqual({
        type: 'result',
        id: expect.any(Number),
        ok: false,
        error: {
          name: 'ProviderRpcError',
          code: 4900,
          message: expect.stringContaining(
            `: ${NO_LOCAL_PROVING_ERROR}: HTTP error! Status: 503, Details: prover down`
          ),
        },
      });
    }
  }, 60_000);

  // Pins the upstream behavior the stop exists for. If this fails after a
  // bump, re-read `rpc_handle_remote_proof`: the fallback may be gone (drop
  // the stop) or moved (move it).
  test('without the stop, the same outage reaches the built-in hosts', () => {
    const reads = probe({ reads: PROOFABLE_READS.slice(0, 1), unguarded: true });
    expect(builtIn(reads[0].fetched).length).toBeGreaterThan(0);
    expect(reads[0].posted.error.message).not.toContain(NO_LOCAL_PROVING_ERROR);
  }, 60_000);

  test('hands a proof the prover sends to the verifier', () => {
    const [{ fetched, posted }] = probe({ reads: PROOFABLE_READS.slice(0, 1), proverAnswers: 'bytes' });
    expect(fetched.map(({ url }) => url)).toEqual([PROVER]);
    // Eight bytes aren't a proof: the verifier's own verdict.
    expect(posted.ok).toBe(false);
    expect(posted.error.message).not.toContain(NO_LOCAL_PROVING_ERROR);
    expect(posted.error.message).toMatch(/Invalid offset|invalid|proof/i);
  }, 60_000);

  // A contract call runs in the verifier (PAP), which reads code from the
  // `eth_rpc` hosts itself: refusing that server type would break it.
  test('leaves the verifier\'s own requests alone', () => {
    const [{ fetched, posted }] = probe({
      reads: [['eth_call', [{ to: '0xce01f8eee7e479c928f8919abd53e553a36cef67', data: '0x01ffc9a7' }, 'latest']]],
    });
    expect(fetched.some(({ body }) => body?.method === 'eth_getCode')).toBe(true);
    expect(posted.ok).toBe(false);
    expect(posted.error.message).not.toContain(NO_LOCAL_PROVING_ERROR);
  }, 60_000);
});
