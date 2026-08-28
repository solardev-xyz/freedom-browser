'use strict';

const { EFFECTS } = require('./agent/effect-classifier');
const { NodeRequestController, fixedEndpoint, minimumEffectForMethod } = require('./node-request-controller');

function classification(effect, confidence = 0.99, uncertainties = []) {
  return {
    effect,
    confidence,
    summary: `${effect} request`,
    resources: ['Ant node'],
    uncertainties,
  };
}

function requestInput(overrides = {}) {
  return {
    service: 'ant',
    transport: 'http',
    request: { method: 'GET', path: '/health', ...overrides },
  };
}

describe('NodeRequestController', () => {
  test('executes a confidently classified read against only the registry endpoint', async () => {
    const fetch = jest.fn(async () =>
      new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-private': 'hidden' },
      })
    );
    const classifyEffect = jest.fn(async () => classification(EFFECTS.READ));
    const requestApproval = jest.fn();
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch,
      operationIdFactory: () => 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
      now: () => 1_000,
    });

    await expect(
      controller.request(requestInput(), { classifyEffect, requestApproval })
    ).resolves.toEqual({
      service: 'ant',
      transport: 'http',
      effect: 'read',
      operation: {
        operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
        state: 'responded',
        retrySafety: 'safe',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      request: { method: 'GET', path: '/health' },
      response: {
        status: 200,
        statusText: '',
        headers: { 'content-type': 'application/json' },
        body: '{"status":"ok"}',
        bytes: 15,
      },
      summary: {
        service: 'ant',
        effect: 'read',
        method: 'GET',
        path: '/health',
        operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
        state: 'responded',
        retrySafety: 'safe',
        status: 200,
        bytes: 15,
      },
    });
    expect(classifyEffect).toHaveBeenCalledWith({
      domain: 'node',
      action: {
        service: 'ant',
        transport: 'http',
        request: { method: 'GET', path: '/health' },
      },
      trustedContext: {
        endpointAuthority: 'Freedom service registry',
        wireProtocol: 'Bee HTTP API',
      },
    });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:1633/health'),
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
  });

  test('asks approval for a state-changing request and shows its exact request', async () => {
    const fetch = jest.fn(async () => new Response('{}', { status: 201 }));
    const classifyEffect = jest.fn(async () => classification(EFFECTS.PERSISTENT_CHANGE));
    const requestApproval = jest.fn(async () => 'approved');
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch,
    });
    const input = requestInput({
      method: 'POST',
      path: '/stamps/100/20',
      headers: { 'content-type': 'application/json' },
      body: '{"immutable":false}',
    });

    await expect(controller.request(input, { classifyEffect, requestApproval })).resolves.toMatchObject({
      effect: EFFECTS.PERSISTENT_CHANGE,
      response: { status: 201 },
    });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'node_request',
      operation: 'node_request',
      label: 'POST /stamps/100/20',
      nodeRequest: {
        service: 'ant',
        transport: 'http',
        request: input.request,
        effect: EFFECTS.PERSISTENT_CHANGE,
        classification: classification(EFFECTS.PERSISTENT_CHANGE),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('dispatches Radicle HTTP to its registry-selected endpoint', async () => {
    const fetch = jest.fn(async () => new Response('[]', { status: 200 }));
    const controller = new NodeRequestController({
      getRadicleApiUrl: () => 'http://127.0.0.1:8780',
      fetch,
    });
    const input = {
      service: 'radicle',
      transport: 'http',
      request: { method: 'GET', path: '/api/v1/repos' },
    };

    await expect(
      controller.request(input, { classifyEffect: async () => classification(EFFECTS.READ) })
    ).resolves.toMatchObject({
      service: 'radicle',
      transport: 'http',
      response: { body: '[]' },
      summary: { service: 'radicle', status: 200 },
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8780/api/v1/repos'),
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
  });

  test('dispatches IPFS reads through the active native gateway instance', async () => {
    const serveIpfsRequest = jest.fn(async () =>
      new Response('ipfs-body', { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    const controller = new NodeRequestController({ serveIpfsRequest });
    const input = {
      service: 'ipfs',
      transport: 'gateway',
      request: { method: 'GET', path: '/ipfs/bafy-test' },
    };

    await expect(
      controller.request(input, { classifyEffect: async () => classification(EFFECTS.READ) })
    ).resolves.toMatchObject({
      service: 'ipfs',
      transport: 'gateway',
      response: { body: 'ipfs-body' },
      summary: { service: 'ipfs', status: 200 },
    });
    expect(serveIpfsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/ipfs/bafy-test',
        headers: expect.any(Headers),
        signal: expect.any(AbortSignal),
      })
    );
  });

  test('fails closed to approval when classification is unavailable or uncertain', async () => {
    const fetch = jest.fn(async () => new Response('{}'));
    const requestApproval = jest.fn(async () => 'declined');
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch,
    });

    await expect(controller.request(requestInput(), { requestApproval })).rejects.toMatchObject({
      code: 'USER_CANCELLED',
    });
    await expect(
      controller.request(requestInput(), {
        classifyEffect: async () => classification(EFFECTS.READ, 0.99, ['Unknown route semantics']),
        requestApproval,
      })
    ).rejects.toMatchObject({ code: 'USER_CANCELLED' });
    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('never allows the classifier to downgrade structural method risk', async () => {
    const fetch = jest.fn(async () => new Response('{}'));
    const requestApproval = jest.fn(async () => 'declined');
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch,
    });

    await expect(
      controller.request(requestInput({ method: 'DELETE', path: '/data' }), {
        classifyEffect: async () => classification(EFFECTS.READ),
        requestApproval,
      })
    ).rejects.toMatchObject({ code: 'USER_CANCELLED' });
    expect(requestApproval.mock.calls[0][0].nodeRequest.effect).toBe(EFFECTS.DESTRUCTIVE);
  });

  test('rejects unavailable endpoints, redirects, and oversized responses', async () => {
    const unavailable = new NodeRequestController({ getAntApiUrl: () => null, fetch: jest.fn() });
    await expect(unavailable.request(requestInput())).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });

    const oversized = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      maxResponseBytes: 4,
      fetch: async () => new Response('12345'),
    });
    await expect(
      oversized.request(requestInput(), {
        classifyEffect: async () => classification(EFFECTS.READ),
      })
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });

  test('keeps a slow state-changing request alive and exposes its eventual response by operation ID', async () => {
    let release;
    const responseReady = new Promise((resolve) => {
      release = resolve;
    });
    const fetch = jest.fn(() => responseReady);
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch,
      interactiveTimeoutMs: 5,
      mutationTimeoutMs: 1_000,
      operationIdFactory: () => 'node_op_bbbbbbbbbbbbbbbbbbbbbbbb',
    });
    const context = {
      conversationId: 'conversation_one',
      classifyEffect: async () => classification(EFFECTS.FINANCIAL),
      requestApproval: async () => 'approved',
    };

    const pending = await controller.request(
      requestInput({ method: 'POST', path: '/stamps/100/20' }),
      context
    );
    expect(pending).toMatchObject({
      operation: {
        operationId: 'node_op_bbbbbbbbbbbbbbbbbbbbbbbb',
        state: 'in_flight',
        retrySafety: 'unsafe',
      },
      summary: { state: 'in_flight' },
    });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);

    release(new Response('{"batchID":"batch-1"}', { status: 201 }));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      controller.status(
        { operationId: 'node_op_bbbbbbbbbbbbbbbbbbbbbbbb' },
        { conversationId: 'conversation_one' }
      )
    ).resolves.toMatchObject({
      operation: { state: 'responded', retrySafety: 'unsafe' },
      response: { status: 201, body: '{"batchID":"batch-1"}' },
    });
  });

  test('stopping the Agent after dispatch stops waiting without aborting an unsafe request', async () => {
    let release;
    let dispatched;
    const dispatchedPromise = new Promise((resolve) => {
      dispatched = resolve;
    });
    const fetch = jest.fn((_url, options) => {
      dispatched(options.signal);
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch,
      interactiveTimeoutMs: 1_000,
      mutationTimeoutMs: 2_000,
      operationIdFactory: () => 'node_op_cccccccccccccccccccccccc',
    });
    const abortController = new AbortController();
    const request = controller.request(requestInput({ method: 'PATCH', path: '/configuration' }), {
      conversationId: 'conversation_one',
      classifyEffect: async () => classification(EFFECTS.PERSISTENT_CHANGE),
      requestApproval: async () => 'approved',
      signal: abortController.signal,
    });

    const nodeSignal = await dispatchedPromise;
    abortController.abort();
    await expect(request).resolves.toMatchObject({ operation: { state: 'in_flight' } });
    expect(nodeSignal.aborted).toBe(false);
    release(new Response('{}', { status: 200 }));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      controller.status(
        { operationId: 'node_op_cccccccccccccccccccccccc' },
        { conversationId: 'conversation_one' }
      )
    ).resolves.toMatchObject({ operation: { state: 'responded' } });
  });

  test('records an in-flight unsafe request as uncertain when Freedom shuts down', async () => {
    let dispatched;
    const dispatchedPromise = new Promise((resolve) => {
      dispatched = resolve;
    });
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch: (_url, options) =>
        new Promise((_resolve, reject) => {
          dispatched();
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        }),
      interactiveTimeoutMs: 1_000,
      mutationTimeoutMs: 2_000,
      operationIdFactory: () => 'node_op_ffffffffffffffffffffffff',
    });
    const request = controller.request(requestInput({ method: 'POST', path: '/admin' }), {
      conversationId: 'conversation_one',
      classifyEffect: async () => classification(EFFECTS.REVERSIBLE_ADMIN),
      requestApproval: async () => 'approved',
    });
    await dispatchedPromise;

    await controller.dispose();

    await expect(request).resolves.toMatchObject({
      operation: {
        state: 'delivery_uncertain',
        retrySafety: 'unsafe',
        error: {
          code: 'NODE_DELIVERY_UNCERTAIN',
          message: 'Freedom shut down before the node response was received',
        },
      },
    });
  });

  test('reports transport loss after unsafe dispatch as delivery uncertain and never as not applied', async () => {
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch: async () => {
        throw new TypeError('socket closed');
      },
      operationIdFactory: () => 'node_op_dddddddddddddddddddddddd',
    });

    await expect(
      controller.request(requestInput({ method: 'POST', path: '/admin' }), {
        conversationId: 'conversation_one',
        classifyEffect: async () => classification(EFFECTS.REVERSIBLE_ADMIN),
        requestApproval: async () => 'approved',
      })
    ).resolves.toMatchObject({
      operation: {
        state: 'delivery_uncertain',
        retrySafety: 'unsafe',
        error: { code: 'NODE_DELIVERY_UNCERTAIN' },
      },
    });
  });

  test('records a failed read response as safely retryable instead of leaving it in flight', async () => {
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch: async () => {
        throw new TypeError('socket closed');
      },
      operationIdFactory: () => 'node_op_111111111111111111111111',
    });

    await expect(
      controller.request(requestInput(), {
        conversationId: 'conversation_one',
        classifyEffect: async () => classification(EFFECTS.READ),
      })
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    await expect(
      controller.status(
        { operationId: 'node_op_111111111111111111111111' },
        { conversationId: 'conversation_one' }
      )
    ).resolves.toMatchObject({
      operation: {
        state: 'delivery_uncertain',
        retrySafety: 'safe',
        error: { code: 'NODE_RESPONSE_UNAVAILABLE' },
      },
    });
  });

  test('keeps operation receipts conversation-scoped', async () => {
    const controller = new NodeRequestController({
      getAntApiUrl: () => 'http://127.0.0.1:1633',
      fetch: async () => new Response('{}'),
      operationIdFactory: () => 'node_op_eeeeeeeeeeeeeeeeeeeeeeee',
    });
    await controller.request(requestInput(), {
      conversationId: 'conversation_one',
      classifyEffect: async () => classification(EFFECTS.READ),
    });

    await expect(
      controller.status(
        { operationId: 'node_op_eeeeeeeeeeeeeeeeeeeeeeee' },
        { conversationId: 'conversation_two' }
      )
    ).rejects.toThrow('unavailable in the current conversation');
    await expect(controller.status({}, { conversationId: 'conversation_one' })).resolves.toEqual({
      operations: [
        expect.objectContaining({
          operationId: 'node_op_eeeeeeeeeeeeeeeeeeeeeeee',
          state: 'responded',
          retrySafety: 'safe',
          status: 200,
        }),
      ],
      summary: { count: 1, inFlight: 0, uncertain: 0 },
    });
  });
});

describe('node request hard boundaries', () => {
  test('targets the exact manager-selected origin', () => {
    expect(fixedEndpoint('http://127.0.0.1:1633', '/health').href).toBe(
      'http://127.0.0.1:1633/health'
    );
    expect(() => fixedEndpoint('file:///tmp/node', '/health')).toThrow('endpoint is unavailable');
  });

  test('uses structural risk floors independent of model output', () => {
    expect(minimumEffectForMethod('GET')).toBe(EFFECTS.READ);
    expect(minimumEffectForMethod('POST')).toBe(EFFECTS.REVERSIBLE_ADMIN);
    expect(minimumEffectForMethod('DELETE')).toBe(EFFECTS.DESTRUCTIVE);
  });
});
