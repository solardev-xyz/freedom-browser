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
    });

    await expect(
      controller.request(requestInput(), { classifyEffect, requestApproval })
    ).resolves.toEqual({
      service: 'ant',
      transport: 'http',
      effect: 'read',
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
