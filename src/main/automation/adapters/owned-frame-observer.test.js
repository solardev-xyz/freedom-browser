'use strict';

const { EventEmitter } = require('events');
const { OwnedFrameObserver } = require('./owned-frame-observer');
const { ERROR_CODES } = require('../contract/errors');

function fixture() {
  const api = new EventEmitter();
  let attached = false;
  const root = {
    id: 'root',
    loaderId: 'root-document',
    securityOrigin: 'https://owner.test',
    url: 'https://owner.test/',
  };
  const child = {
    id: 'child',
    parentId: 'root',
    loaderId: 'child-document',
    securityOrigin: 'https://child.test',
    url: 'https://child.test/',
  };
  const snapshot = {
    text: 'Child text',
    elements: [{ ref: 'ref_child', name: 'Name', scrollOnly: true }],
    frames: [{ viewport: { ref: 'ref_viewport', scrollY: 0 } }],
  };
  api.isAttached = () => attached;
  api.attach = jest.fn(() => {
    attached = true;
  });
  api.detach = jest.fn(() => {
    attached = false;
    api.emit('detach');
  });
  api.sendCommand = jest.fn(async (method, params, sessionId) => {
    if (method === 'Target.setAutoAttach' && !sessionId) {
      api.emit('message', {}, 'Target.attachedToTarget', {
        sessionId: 'child-session',
        targetInfo: { type: 'iframe' },
      });
      // A popup page is deliberately not part of the owned iframe tree.
      api.emit('message', {}, 'Target.attachedToTarget', {
        sessionId: 'foreign-page',
        targetInfo: { type: 'page' },
      });
    }
    if (method === 'Runtime.enable') {
      const frame = sessionId ? child : root;
      api.emit(
        'message',
        {},
        'Runtime.executionContextCreated',
        {
          context: {
            id: 1,
            uniqueId: `default-${frame.loaderId}`,
            origin: frame.securityOrigin,
            auxData: { frameId: frame.id, isDefault: true },
          },
        },
        sessionId
      );
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: sessionId ? child : root } };
    if (method === 'Page.createIsolatedWorld') {
      api.emit(
        'message',
        {},
        'Runtime.executionContextCreated',
        { context: { id: 8, uniqueId: 'unique-child-context', origin: child.securityOrigin } },
        sessionId
      );
      return { executionContextId: 8 };
    }
    if (method === 'Runtime.evaluate') return { result: { value: snapshot } };
    return {};
  });
  const source = jest.fn(() => 'fixed host collector');
  const observer = new OwnedFrameObserver({ debugger: api, isDestroyed: () => false }, source);
  return { observer, api, root, child, source };
}

async function childRef(observer) {
  const { frames } = await observer.list();
  return frames.find((frame) => frame.origin === 'https://child.test').ref;
}

test('routes only owned iframe sessions, exposes opaque document handles and strips action refs', async () => {
  const { observer, api, source } = fixture();
  const first = await observer.list();
  const second = await observer.list();
  expect(second).toEqual(first);
  expect(first.frames[1].parentRef).toBe(first.frames[0].ref);
  expect(JSON.stringify(first)).not.toMatch(/loaderId|sessionId|child-document|root-document/);
  expect(api.sendCommand.mock.calls.some((call) => call[2] === 'foreign-page')).toBe(false);
  const result = await observer.read(first.frames[1].ref, { textQuery: 'Child' }, () => true);
  expect(result).toMatchObject({
    readOnly: true,
    text: 'Child text',
    elements: [{ name: 'Name' }],
    frames: [{ viewport: { scrollY: 0 } }],
  });
  expect(result.elements[0]).not.toHaveProperty('ref');
  expect(result.frames[0].viewport).not.toHaveProperty('ref');
  expect(source).toHaveBeenCalledWith({ textQuery: 'Child' });
  expect(api.sendCommand).toHaveBeenCalledWith(
    'Runtime.evaluate',
    expect.objectContaining({
      uniqueContextId: 'unique-child-context',
      expression: 'fixed host collector',
    }),
    'child-session'
  );
  expect(api.sendCommand).toHaveBeenCalledWith(
    'Page.createIsolatedWorld',
    expect.objectContaining({ grantUniveralAccess: false }),
    'child-session'
  );
  expect(api.isAttached()).toBe(false);
  expect(api.listenerCount('message')).toBe(0);
});

test('requires explicit trusted origin authorization before evaluating page content', async () => {
  const { observer, api } = fixture();
  const ref = await childRef(observer);
  for (const authorize of [undefined, () => false, () => 'true']) {
    await expect(observer.read(ref, {}, authorize)).rejects.toMatchObject({
      code: ERROR_CODES.POLICY_DENIED,
    });
  }
  expect(api.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
});

test.each(['authorization', 'world creation', 'after read'])(
  'rejects document changes during %s',
  async (phase) => {
    const { observer, api, child } = fixture();
    const ref = await childRef(observer);
    const original = api.sendCommand.getMockImplementation();
    api.sendCommand.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (
        (phase === 'world creation' && args[0] === 'Page.createIsolatedWorld') ||
        (phase === 'after read' && args[0] === 'Runtime.evaluate')
      )
        child.loaderId = 'replacement';
      return result;
    });
    await expect(
      observer.read(ref, {}, () => {
        if (phase === 'authorization') child.loaderId = 'replacement';
        return true;
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_ELEMENT_REFERENCE });
    expect(
      api.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.evaluate')
    ).toHaveLength(phase === 'after read' ? 1 : 0);
    expect(api.isAttached()).toBe(false);
  }
);

test('rejects foreign handles and loader/origin changes even at the same URL', async () => {
  const { observer, child, api } = fixture();
  const foreign = fixture();
  const ref = await childRef(observer);
  await expect(foreign.observer.read(ref, {}, () => true)).rejects.toMatchObject({
    code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
  });
  child.securityOrigin = 'null';
  await expect(observer.read(ref, {}, () => true)).rejects.toMatchObject({
    code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
  });
  expect(api.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
});

test('does not borrow or detach another debugger and disposes its own connection', async () => {
  const { observer, api } = fixture();
  api.attach();
  await expect(observer.list()).rejects.toMatchObject({ code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
  expect(api.detach).not.toHaveBeenCalled();
  api.detach();
  const ref = await childRef(observer);
  await expect(
    observer.read(ref, {}, () => {
      observer.dispose();
      return true;
    })
  ).rejects.toMatchObject({ code: ERROR_CODES.USER_CANCELLED });
  expect(api.isAttached()).toBe(false);
  await expect(observer.list()).rejects.toMatchObject({ code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
});

test('serializes requests and cleans up rejected protocol commands', async () => {
  const { observer, api } = fixture();
  api.sendCommand.mockRejectedValueOnce(new Error('sensitive raw protocol detail'));
  const results = await Promise.allSettled([observer.list(), observer.list()]);
  expect(results[0].reason).toMatchObject({ code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
  expect(results[0].reason.message).not.toContain('sensitive');
  expect(results[1].status).toBe('fulfilled');
  expect(api.attach).toHaveBeenCalledTimes(2);
  expect(api.detach).toHaveBeenCalledTimes(2);
  expect(api.listenerCount('message')).toBe(0);
});

test('a hung protocol command times out and releases the debugger', async () => {
  jest.useFakeTimers();
  try {
    const { observer, api } = fixture();
    api.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
    const checked = expect(observer.list()).rejects.toMatchObject({
      code: ERROR_CODES.CAPABILITY_UNAVAILABLE,
      message: 'Frame observation timed out',
    });
    await jest.advanceTimersByTimeAsync(5000);
    await checked;
    expect(api.isAttached()).toBe(false);
    expect(api.listenerCount('message')).toBe(0);
    await expect(observer.list()).resolves.toHaveProperty('frames');
  } finally {
    jest.useRealTimers();
  }
});

test('cancellation rejects active and queued reads without poisoning later observations', async () => {
  const { observer, api } = fixture();
  api.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
  const active = observer.list();
  const queued = observer.list();
  await new Promise((resolve) => setImmediate(resolve));
  observer.cancel();
  const results = await Promise.allSettled([active, queued]);
  for (const result of results)
    expect(result.reason).toMatchObject({ code: ERROR_CODES.USER_CANCELLED });
  expect(api.isAttached()).toBe(false);
  await expect(observer.list()).resolves.toHaveProperty('frames');
});
