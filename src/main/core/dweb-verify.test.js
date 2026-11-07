/**
 * Main's side of `dweb.verify` and `dweb.forget` (freedom-core design
 * 0009): the request goes to the process that made the plan, its pieces'
 * context opens under the ID `onSent` reports, and a private partition's
 * close sends `dweb.forget`.
 */
const { DwebVerifier, attachDwebVerify, detachDwebVerify, dwebVerifier } = require('./dweb-verify');
const { createFetchAdmission } = require('../dweb/fetch-admission');
const { CoreError } = require('./core-client');

const quietLog = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });

/** A client whose process `serving` serves; its requests
 * answer `reply(method, params)`, and `requestStreamTo` reports `onSent`
 * as the real client does, once the frame is written. */
function fakeClient({ serving = true, reply = async () => ({}) } = {}) {
  const gen = { number: 3 };
  let nextId = 41;
  return {
    current: gen,
    serves: jest.fn((g) => serving && g === gen),
    requestTo: jest.fn(async (_gen, method, params) => reply(method, params)),
    requestStreamTo: jest.fn((g, method, params, context, options) => {
      const id = nextId++;
      options.onSent?.(id, g.number);
      return Promise.resolve({ result: { id }, body: null });
    }),
  };
}

function fakeShell() {
  const opened = [];
  return {
    opened,
    open: jest.fn((key, capture) => {
      const handle = { key, capture, closed: 0, close: () => (handle.closed += 1) };
      opened.push(handle);
      return handle;
    }),
  };
}

afterEach(() => detachDwebVerify());

describe('send', () => {
  test("writes dweb.verify to the plan's process, opening its pieces' context under its ID", async () => {
    const client = fakeClient();
    const shell = fakeShell();
    const verifier = new DwebVerifier({ client, shell, log: quietLog() });
    const capture = { backend: {}, plan: {}, signal: null, stop: null };
    const life = new AbortController().signal;
    const params = {
      plan: {},
      method: 'GET',
      partition: null,
      private: false,
      deadline_ms: 360_000,
    };
    const sent = verifier.send(client.current, params, capture, life);

    const [gen, method, sentParams, context, options] = client.requestStreamTo.mock.calls[0];
    expect([gen, method, sentParams, context]).toEqual([
      client.current,
      'dweb.verify',
      params,
      { caller: 'shell' },
    ]);
    expect(options.signal).toBe(life);
    // The head deadline and 0001's margin.
    expect(options.watchdogMs).toBe(375_000);
    expect(shell.opened.map((h) => [h.key, h.capture])).toEqual([
      [{ id: 41, generation: 3 }, capture],
    ]);
    await expect(sent.head).resolves.toEqual({ result: { id: 41 }, body: null });
    sent.close();
    sent.close();
    expect(shell.opened[0].closed).toBe(1);
  });

  test('a context the shell refuses is logged; the request still goes', async () => {
    const client = fakeClient();
    const log = quietLog();
    const shell = {
      open: jest.fn(() => {
        throw new TypeError('no backend');
      }),
    };
    const verifier = new DwebVerifier({ client, shell, log });
    const sent = verifier.send(client.current, { deadline_ms: 1 }, {}, null);
    await expect(sent.head).resolves.toBeTruthy();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('no backend'));
    sent.close();
  });
});

describe('forget', () => {
  test('sends dweb.forget { partition } to the serving process', async () => {
    const client = fakeClient();
    const verifier = new DwebVerifier({ client, shell: fakeShell(), log: quietLog() });
    await expect(verifier.forget('private-1')).resolves.toBe(true);
    expect(client.requestTo).toHaveBeenCalledWith(
      client.current,
      'dweb.forget',
      { partition: 'private-1' },
      { caller: 'shell' },
      { watchdogMs: 15_000 }
    );
  });

  test('a core that is not serving gets nothing: it holds nothing of the partition', async () => {
    const client = fakeClient({ serving: false });
    const verifier = new DwebVerifier({ client, shell: fakeShell(), log: quietLog() });
    await expect(verifier.forget('private-1')).resolves.toBe(false);
    expect(client.requestTo).not.toHaveBeenCalled();
  });

  test('a failure is logged by its code, never the partition; the core ending is quiet', async () => {
    const log = quietLog();
    let error = new CoreError('invalid_argument', 'Invalid dweb.forget parameters');
    const client = fakeClient({
      reply: async () => {
        throw error;
      },
    });
    const verifier = new DwebVerifier({ client, shell: fakeShell(), log });
    await expect(verifier.forget('private-9')).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith('[Core] dweb.forget failed (invalid_argument)');
    error = new CoreError('core_unavailable', 'The core is not running');
    await expect(verifier.forget('private-9')).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('attachDwebVerify', () => {
  test('only with the dweb shell', () => {
    const admission = createFetchAdmission();
    const deps = { log: quietLog(), onSessionClosed: admission.onSessionClosed };
    expect(attachDwebVerify(fakeClient(), null, deps)).toBeNull();
    expect(dwebVerifier()).toBeNull();
    const verifier = attachDwebVerify(fakeClient(), fakeShell(), deps);
    expect(verifier).toBeInstanceOf(DwebVerifier);
    expect(dwebVerifier()).toBe(verifier);
  });

  test("a private partition's close sends dweb.forget; the profile's sends nothing", async () => {
    const admission = createFetchAdmission();
    const client = fakeClient();
    attachDwebVerify(client, fakeShell(), {
      log: quietLog(),
      onSessionClosed: admission.onSessionClosed,
    });
    admission.closeSession('private-4');
    admission.closeSession(null);
    await null;
    expect(client.requestTo.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['dweb.forget', { partition: 'private-4' }],
    ]);
  });

  test('after its requests are stopped: a fenced request is aborted before the forget', () => {
    const admission = createFetchAdmission();
    const order = [];
    const client = fakeClient({
      reply: async (method) => {
        order.push(method);
        return {};
      },
    });
    attachDwebVerify(client, fakeShell(), {
      log: quietLog(),
      onSessionClosed: admission.onSessionClosed,
    });
    const fence = admission.fence('private-5');
    fence.signal.addEventListener('abort', () => order.push('request stopped'));
    admission.closeSession('private-5');
    expect(client.requestTo).toHaveBeenCalledTimes(1);
    return Promise.resolve().then(() => expect(order).toEqual(['request stopped', 'dweb.forget']));
  });

  test('detach (or a new attach) stops forgetting for the old client', async () => {
    const admission = createFetchAdmission();
    const old = fakeClient();
    const deps = { log: quietLog(), onSessionClosed: admission.onSessionClosed };
    attachDwebVerify(old, fakeShell(), deps);
    const current = fakeClient();
    attachDwebVerify(current, fakeShell(), deps);
    admission.closeSession('private-6');
    detachDwebVerify();
    admission.closeSession('private-7');
    await null;
    expect(old.requestTo).not.toHaveBeenCalled();
    expect(current.requestTo.mock.calls.map((call) => call[2])).toEqual([
      { partition: 'private-6' },
    ]);
    expect(dwebVerifier()).toBeNull();
  });
});
