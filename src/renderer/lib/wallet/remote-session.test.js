/**
 * Broker unit tests with a scripted openlv stack: what matters here is
 * the job protocol against main (respond exactly once, cancel/abort
 * semantics) and the event stream the QR dialog will consume. Real
 * protocol round-trips live in the openlv integration test.
 */

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeSession() {
  const link = deferred();
  const response = deferred();
  return {
    link,
    response,
    connect: jest.fn(async () => {}),
    waitForLink: jest.fn(() => link.promise),
    send: jest.fn(() => response.promise),
    close: jest.fn(async () => {}),
    getHandshakeParameters: () => ({
      version: 1,
      sessionId: 'abcdef1234567890',
      h: '00ff00ff00ff00ff',
      k: '11'.repeat(16),
      p: 'mqtt',
      s: 'wss://relay.test/mqtt',
    }),
    emitter: { on: jest.fn(), off: jest.fn() },
  };
}

function createHarness() {
  const session = createFakeSession();
  const openlv = {
    createSession: jest.fn(async () => session),
    mqtt: 'MQTT_LAYER',
    webrtc: jest.fn(() => 'WEBRTC_LAYER'),
    encodeConnectionURL: jest.fn(
      (p) => `openlv://${p.sessionId}@1?h=${p.h}&k=${p.k}&p=${p.p}&s=${encodeURIComponent(p.s)}`,
    ),
  };
  const handlers = {};
  const remoteSigner = {
    onRequest: jest.fn((cb) => {
      handlers.request = cb;
      return () => delete handlers.request;
    }),
    onAbort: jest.fn((cb) => {
      handlers.abort = cb;
      return () => delete handlers.abort;
    }),
    respond: jest.fn(),
  };
  return { session, openlv, remoteSigner, handlers };
}

async function startBroker(harness) {
  const { createRemoteSessionBroker } = await import('./remote-session.js');
  const broker = createRemoteSessionBroker({
    openlv: harness.openlv,
    remoteSigner: harness.remoteSigner,
    // Explicit relay: without it the broker PROBES the public brokers
    // with a real WebSocket — a unit test must never touch the network.
    signaling: { p: 'mqtt', s: 'wss://relay.test/mqtt' },
    bridgeOrigin: 'https://bridge.test',
  });
  broker.start();
  return broker;
}

const JOB = { jobId: 'job-1', walletIndex: 4, address: '0xabc', method: 'personal_sign', params: ['0x6869', '0xabc'] };

// Let the runJob microtasks settle.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('remote-session broker', () => {
  test('runs a job end to end: session, QR event, request, response to main', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);
    const events = [];
    broker.onJobEvent((e) => events.push(e));

    harness.handlers.request(JOB);
    await tick();

    // Host session created over the injected signaling/transport layers.
    expect(harness.openlv.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ p: 'mqtt' }),
      'MQTT_LAYER',
      ['WEBRTC_LAYER'],
      expect.any(Function),
    );

    // QR event exposes the raw URI and the fragment-carrying bridge URL.
    const qrEvent = events.find((e) => e.phase === 'qr');
    expect(qrEvent.uri).toMatch(/^openlv:\/\/abcdef1234567890@1\?/);
    expect(qrEvent.bridgeUrl).toBe(`https://bridge.test/#${qrEvent.uri}`);
    expect(qrEvent.method).toBe('personal_sign');

    harness.session.link.resolve();
    await tick();
    expect(harness.session.send).toHaveBeenCalledWith({
      method: 'personal_sign',
      params: ['0x6869', '0xabc'],
    });
    expect(events.some((e) => e.phase === 'awaiting-approval')).toBe(true);

    harness.session.response.resolve({ result: '0xsignature' });
    await tick();
    expect(harness.remoteSigner.respond).toHaveBeenCalledWith({ jobId: 'job-1', result: '0xsignature' });
    expect(harness.session.close).toHaveBeenCalled();
  });

  test('treats a bare (non-envelope) payload as the result', async () => {
    const harness = createHarness();
    await startBroker(harness);

    harness.handlers.request(JOB);
    await tick();
    harness.session.link.resolve();
    await tick();
    harness.session.response.resolve('0xbaresig');
    await tick();

    expect(harness.remoteSigner.respond).toHaveBeenCalledWith({ jobId: 'job-1', result: '0xbaresig' });
  });

  test('forwards phone JSON-RPC errors to main as rpcCode', async () => {
    const harness = createHarness();
    await startBroker(harness);

    harness.handlers.request(JOB);
    await tick();
    harness.session.link.resolve();
    await tick();
    harness.session.response.resolve({ error: { code: 4001, message: 'User denied.' } });
    await tick();

    expect(harness.remoteSigner.respond).toHaveBeenCalledWith({
      jobId: 'job-1',
      error: { rpcCode: 4001, message: 'User denied.' },
    });
  });

  test('reports session failures as REMOTE_UNKNOWN with the underlying message', async () => {
    const harness = createHarness();
    await startBroker(harness);

    harness.handlers.request(JOB);
    await tick();
    harness.session.link.reject(new Error('Session failed to connect'));
    await tick();

    expect(harness.remoteSigner.respond).toHaveBeenCalledWith({
      jobId: 'job-1',
      error: { code: 'REMOTE_UNKNOWN', message: 'Session failed to connect' },
    });
    expect(harness.session.close).toHaveBeenCalled();
  });

  test('cancelJob responds USER_CANCELLED once and ignores a late phone answer', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);

    harness.handlers.request(JOB);
    await tick();
    broker.cancelJob('job-1');

    expect(harness.remoteSigner.respond).toHaveBeenCalledWith({
      jobId: 'job-1',
      error: { code: 'REMOTE_USER_CANCELLED' },
    });
    expect(harness.session.close).toHaveBeenCalled();

    // Phone answers after the user already cancelled — must not respond again.
    harness.session.link.resolve();
    harness.session.response.resolve({ result: '0xlate' });
    await tick();
    expect(harness.remoteSigner.respond).toHaveBeenCalledTimes(1);
  });

  test('abort from main tears the session down without responding', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);
    const events = [];
    broker.onJobEvent((e) => events.push(e));

    harness.handlers.request(JOB);
    await tick();
    harness.handlers.abort({ jobId: 'job-1' });

    expect(harness.session.close).toHaveBeenCalled();
    expect(harness.remoteSigner.respond).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'aborted')).toBe(true);

    // A phone answer for the aborted job must not reach main either.
    harness.session.link.resolve();
    harness.session.response.resolve({ result: '0xlate' });
    await tick();
    expect(harness.remoteSigner.respond).not.toHaveBeenCalled();
  });

  test('answers unexpected phone-initiated requests with method-not-found', async () => {
    const harness = createHarness();
    await startBroker(harness);

    harness.handlers.request(JOB);
    await tick();
    const onIncoming = harness.openlv.createSession.mock.calls[0][3];
    await expect(onIncoming({ method: 'eth_accounts' })).resolves.toEqual({
      error: { code: -32601, message: 'Method not found' },
    });
  });

  test('connectPhone discovers accounts over eth_requestAccounts', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);
    const events = [];
    broker.onJobEvent((e) => events.push(e));

    const { jobId, accounts } = broker.connectPhone();
    expect(jobId).toMatch(/^connect-/);
    await tick();

    const qrEvent = events.find((e) => e.phase === 'qr');
    expect(qrEvent.jobId).toBe(jobId);
    expect(qrEvent.bridgeUrl).toMatch(/^https:\/\/bridge\.test\/#openlv:\/\//);

    harness.session.link.resolve();
    await tick();
    expect(harness.session.send).toHaveBeenCalledWith({ method: 'eth_requestAccounts', params: [] });

    harness.session.response.resolve({ result: ['0xAbC0000000000000000000000000000000000001'] });
    await expect(accounts).resolves.toEqual(['0xAbC0000000000000000000000000000000000001']);
    // Local flow: nothing goes to main.
    expect(harness.remoteSigner.respond).not.toHaveBeenCalled();
    expect(harness.session.close).toHaveBeenCalled();
  });

  test('connectPhone rejects when the phone shares no accounts', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);

    const { accounts } = broker.connectPhone();
    await tick();
    harness.session.link.resolve();
    await tick();
    harness.session.response.resolve({ result: [] });

    await expect(accounts).rejects.toMatchObject({ code: 'REMOTE_BAD_RESPONSE' });
  });

  test('cancelJob aborts a connectPhone discovery', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);

    const { jobId, accounts } = broker.connectPhone();
    await tick();
    broker.cancelJob(jobId);

    await expect(accounts).rejects.toMatchObject({ code: 'REMOTE_USER_CANCELLED' });
    expect(harness.session.close).toHaveBeenCalled();
    expect(harness.remoteSigner.respond).not.toHaveBeenCalled();
  });

  describe('chain switching (jobs carrying a chain descriptor)', () => {
    const CHAIN = {
      chainId: '0x64',
      chainName: 'Gnosis Chain',
      nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
      rpcUrls: ['https://rpc.gnosischain.com'],
    };
    const TX_JOB = {
      jobId: 'job-tx',
      walletIndex: 4,
      address: '0xabc',
      method: 'eth_sendTransaction',
      params: [{ from: '0xabc', to: '0xdef', value: '0x1', chainId: '0x64' }],
      chain: CHAIN,
    };

    /** Run TX_JOB against a scripted per-method send handler. */
    async function runTxJob(harness, sendImpl) {
      const calls = [];
      harness.session.send.mockImplementation(async (message) => {
        calls.push(message.method);
        return sendImpl(message);
      });
      harness.handlers.request(TX_JOB);
      await tick();
      harness.session.link.resolve();
      await tick();
      return calls;
    }

    test('switches the wallet to the tx chain before sending', async () => {
      const harness = createHarness();
      await startBroker(harness);

      const calls = await runTxJob(harness, ({ method }) => {
        if (method === 'wallet_switchEthereumChain') return { result: null };
        return { result: '0x' + 'ab'.repeat(32) };
      });

      expect(calls).toEqual(['wallet_switchEthereumChain', 'eth_sendTransaction']);
      expect(harness.session.send).toHaveBeenCalledWith({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x64' }],
      });
      expect(harness.remoteSigner.respond).toHaveBeenCalledWith({
        jobId: 'job-tx',
        result: '0x' + 'ab'.repeat(32),
      });
    });

    test('unknown chain (4902): adds it via EIP-3085, switches again, then sends', async () => {
      const harness = createHarness();
      await startBroker(harness);

      let switchCalls = 0;
      const calls = await runTxJob(harness, ({ method, params }) => {
        if (method === 'wallet_switchEthereumChain') {
          switchCalls += 1;
          return switchCalls === 1
            ? { error: { code: 4902, message: 'Unrecognized chain ID' } }
            : { result: null };
        }
        if (method === 'wallet_addEthereumChain') {
          expect(params).toEqual([CHAIN]);
          return { result: null };
        }
        return { result: '0x' + 'ab'.repeat(32) };
      });

      expect(calls).toEqual([
        'wallet_switchEthereumChain',
        'wallet_addEthereumChain',
        'wallet_switchEthereumChain',
        'eth_sendTransaction',
      ]);
      expect(harness.remoteSigner.respond).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-tx', result: expect.any(String) }),
      );
    });

    test('declined network switch fails the job without sending the tx', async () => {
      const harness = createHarness();
      await startBroker(harness);

      const calls = await runTxJob(harness, ({ method }) => {
        if (method === 'wallet_switchEthereumChain') {
          return { error: { code: 4001, message: 'User rejected the request.' } };
        }
        throw new Error('must not reach the tx');
      });

      expect(calls).toEqual(['wallet_switchEthereumChain']);
      expect(harness.remoteSigner.respond).toHaveBeenCalledWith({
        jobId: 'job-tx',
        error: { rpcCode: 4001, message: 'User rejected the request.' },
      });
      expect(harness.session.close).toHaveBeenCalled();
    });

    test('4902 without RPC endpoints to offer surfaces the wallet error', async () => {
      const harness = createHarness();
      await startBroker(harness);

      harness.session.send.mockImplementation(async () => ({
        error: { code: 4902, message: 'Unrecognized chain ID' },
      }));
      harness.handlers.request({ ...TX_JOB, chain: { chainId: '0x64' } });
      await tick();
      harness.session.link.resolve();
      await tick();

      expect(harness.remoteSigner.respond).toHaveBeenCalledWith({
        jobId: 'job-tx',
        error: { rpcCode: 4902, message: 'Unrecognized chain ID' },
      });
    });
  });

  test('retryJob abandons the session and mints a fresh QR for the same job', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);
    const events = [];
    broker.onJobEvent((e) => events.push(e));

    harness.handlers.request(JOB);
    await tick();
    const firstSession = harness.session;

    // Swap in a second scripted session for the retry attempt.
    const secondSession = createFakeSession();
    harness.openlv.createSession.mockImplementation(async () => secondSession);

    broker.retryJob('job-1');
    await tick();

    expect(firstSession.close).toHaveBeenCalled();
    expect(events.filter((e) => e.phase === 'qr')).toHaveLength(2);

    // The first attempt's late outcome must not settle the job…
    firstSession.link.resolve();
    firstSession.response.resolve({ result: '0xstale' });
    await tick();
    expect(harness.remoteSigner.respond).not.toHaveBeenCalled();

    // …the second attempt's does.
    secondSession.link.resolve();
    await tick();
    secondSession.response.resolve({ result: '0xfresh' });
    await tick();
    expect(harness.remoteSigner.respond).toHaveBeenCalledWith({ jobId: 'job-1', result: '0xfresh' });
  });

  test('retryJob is a no-op for settled or unknown jobs', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);

    harness.handlers.request(JOB);
    await tick();
    broker.cancelJob('job-1');
    harness.openlv.createSession.mockClear();

    broker.retryJob('job-1');
    broker.retryJob('nope');
    await tick();
    expect(harness.openlv.createSession).not.toHaveBeenCalled();
  });

  test('stop() unsubscribes and closes live sessions', async () => {
    const harness = createHarness();
    const broker = await startBroker(harness);

    harness.handlers.request(JOB);
    await tick();
    broker.stop();

    expect(harness.handlers.request).toBeUndefined();
    expect(harness.handlers.abort).toBeUndefined();
    expect(harness.session.close).toHaveBeenCalled();
  });
});
