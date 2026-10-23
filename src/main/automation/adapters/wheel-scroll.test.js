'use strict';

const { EventEmitter } = require('events');
const {
  WebContentsPageAdapter,
  wheelScroll,
  settleScroll,
} = require('./web-contents-page-adapter');
const { ERROR_CODES } = require('../contract/errors');

// Drives a fake page: `apply(at)` is what the page does with one wheel.
function harness({ apply, before = { x: 0, y: 0 } }) {
  let position = { ...before };
  let received = 0;
  const calls = [];
  const options = {
    before,
    point: { x: 10, y: 10 },
    send: jest.fn(async (at) => {
      calls.push(['send', at]);
      const effect = apply(calls.filter(([kind]) => kind === 'send').length);
      if (effect.received) received += 1;
      if (effect.moveTo) setTimeout(() => (position = effect.moveTo), effect.delay ?? 0);
    }),
    readScroll: jest.fn(async () => ({ ...position })),
    probe: jest.fn(async (action) => {
      calls.push(['probe', action]);
      if (action === 'arm') received = 0;
      return { ok: true, count: received };
    }),
    recheck: jest.fn(async () => {
      calls.push(['recheck']);
      return { x: 20, y: 20 };
    }),
  };
  return { options, calls };
}

async function run(promise) {
  let settled = false;
  promise.finally(() => (settled = true)).catch(() => {});
  while (!settled) await jest.advanceTimersByTimeAsync(50);
  return promise;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('settleScroll', () => {
  test('a quiet period before any movement is not settled; late movement is waited for', async () => {
    let y = 0;
    setTimeout(() => (y = 300), 1_000);
    const started = Date.now();
    const result = await run(settleScroll(async () => ({ x: 0, y }), { x: 0, y: 0 }));
    expect(result).toEqual({ after: { x: 0, y: 300 }, settled: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_100);
    expect(Date.now() - started).toBeLessThan(1_300);
  });

  test('a target that never moves waits out the limit and is not settled', async () => {
    const started = Date.now();
    const result = await run(settleScroll(async () => ({ x: 0, y: 0 }), { x: 0, y: 0 }));
    expect(result).toEqual({ after: { x: 0, y: 0 }, settled: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
  });
});

describe('wheelScroll', () => {
  test('a wheel that moves the target is sent once', async () => {
    const { options } = harness({ apply: () => ({ received: true, moveTo: { x: 0, y: 400 } }) });
    await expect(run(wheelScroll(options))).resolves.toMatchObject({
      after: { x: 0, y: 400 },
      settled: true,
      attempts: 1,
      delivered: true,
    });
    expect(options.send).toHaveBeenCalledTimes(1);
    expect(options.recheck).not.toHaveBeenCalled();
    expect(options.probe).toHaveBeenLastCalledWith('disarm');
  });

  test('a wheel the page received and consumed without scrolling is never resent', async () => {
    // A carousel/map whose wheel handler calls preventDefault() and acts.
    const { options } = harness({ apply: () => ({ received: true }) });
    await expect(run(wheelScroll(options))).resolves.toMatchObject({
      after: { x: 0, y: 0 },
      settled: false,
      attempts: 1,
      delivered: true,
    });
    expect(options.send).toHaveBeenCalledTimes(1);
    expect(options.recheck).not.toHaveBeenCalled();
  });

  test('a wheel lost outright is sent once more, at the rechecked point, with a fresh probe', async () => {
    const { options, calls } = harness({
      apply: (n) => (n === 1 ? {} : { received: true, moveTo: { x: 0, y: 400 } }),
    });
    await expect(run(wheelScroll(options))).resolves.toMatchObject({
      after: { x: 0, y: 400 },
      attempts: 2,
      delivered: true,
    });
    expect(calls).toEqual([
      ['probe', 'arm'],
      ['send', { x: 10, y: 10 }],
      ['probe', 'read'],
      ['recheck'],
      ['probe', 'arm'],
      ['send', { x: 20, y: 20 }],
      ['probe', 'disarm'],
    ]);
  });

  test('a lost wheel is not resent when the recheck finds a boundary', async () => {
    const { options } = harness({ apply: () => ({}) });
    options.recheck.mockResolvedValueOnce(null);
    await expect(run(wheelScroll(options))).resolves.toMatchObject({
      attempts: 1,
      delivered: false,
    });
    expect(options.send).toHaveBeenCalledTimes(1);
  });

  test('a deadline too close for a resend skips it instead of overrunning the frame budget', async () => {
    const { options } = harness({ apply: () => ({}) });
    options.deadline = Date.now() + 3_000;
    const started = Date.now();
    await expect(run(wheelScroll(options))).resolves.toMatchObject({
      attempts: 1,
      delivered: false,
    });
    expect(options.recheck).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThanOrEqual(3_000);
  });

  test('a resend under a deadline settles only for what remains of it', async () => {
    const { options } = harness({ apply: () => ({}) });
    options.deadline = Date.now() + 4_000;
    const started = Date.now();
    await expect(run(wheelScroll(options))).resolves.toMatchObject({ attempts: 2, settled: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_500);
    expect(Date.now() - started).toBeLessThanOrEqual(4_050);
  });

  test('an unobservable wheel over a child frame is never resent and reports delivery unknown', async () => {
    // The embed's own document received (and consumed) it; the probe cannot see that.
    const { options } = harness({ apply: () => ({}) });
    options.observable = false;
    await expect(run(wheelScroll(options))).resolves.toMatchObject({
      attempts: 1,
      delivered: null,
    });
    expect(options.send).toHaveBeenCalledTimes(1);
    expect(options.recheck).not.toHaveBeenCalled();
    expect(options.probe).toHaveBeenLastCalledWith('disarm');
  });

  test('an unobservable wheel that moved the target is still delivered', async () => {
    const { options } = harness({ apply: () => ({ moveTo: { x: 0, y: 400 } }) });
    options.observable = false;
    await expect(run(wheelScroll(options))).resolves.toMatchObject({
      attempts: 1,
      delivered: true,
    });
  });

  test('a failed recheck sends nothing more and still disarms the probe', async () => {
    const { options } = harness({ apply: () => ({}) });
    options.recheck.mockRejectedValueOnce(new Error('stale'));
    await expect(run(wheelScroll(options))).rejects.toThrow('stale');
    expect(options.send).toHaveBeenCalledTimes(1);
    expect(options.probe).toHaveBeenLastCalledWith('disarm');
  });
});

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.zoom = 1;
    this.executeJavaScriptInIsolatedWorld = jest.fn();
    this.sendInputEvent = jest.fn();
    this.focus = jest.fn();
    this.debugger = {
      attach: jest.fn(),
      detach: jest.fn(),
      isAttached: jest.fn(() => false),
      sendCommand: jest.fn(),
    };
  }
  async loadURL() {}
  getURL() {
    return 'https://example.test/';
  }
  getTitle() {
    return 'Fixture';
  }
  isLoading() {
    return false;
  }
  isDestroyed() {
    return false;
  }
  getZoomFactor() {
    return this.zoom;
  }
}

// Routes isolated-world calls by the function they invoke.
function pageAdapter({ wheelReceived, childFrame = false }) {
  const webContents = new FakeWebContents();
  let probeCount = 0;
  webContents.sendInputEvent.mockImplementation(() => {
    if (wheelReceived) probeCount += 1;
  });
  webContents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world, [{ code }]) => {
    if (code.includes('(function wheelProbe(')) {
      if (code.includes('"arm"')) probeCount = 0;
      return { ok: true, count: probeCount };
    }
    if (code.includes('(function inspectScrollReference(')) {
      return {
        ok: true,
        point: { x: 5, y: 5 },
        ...(childFrame ? { childFrame: true } : {}),
        scroll: {
          x: 0,
          y: 0,
          maxX: 0,
          maxY: 1000,
          minX: 0,
          width: 400,
          height: 300,
          vertical: true,
        },
      };
    }
    return {
      url: 'https://example.test/',
      title: 'Fixture',
      text: '',
      truncated: false,
      frames: [{ ref: 'frame_0', viewport: { ref: 'ref_viewport' } }],
      elements: [],
    };
  });
  return { webContents, adapter: new WebContentsPageAdapter(webContents) };
}

describe('WebContentsPageAdapter.scroll wheel resend', () => {
  test('a wheel the page consumed is not sent twice', async () => {
    const { webContents, adapter } = pageAdapter({ wheelReceived: true });
    await adapter.snapshot();
    await expect(run(adapter.scroll('ref_viewport', { direction: 'down' }))).resolves.toMatchObject(
      {
        outcome: 'no_movement',
        attempts: 1,
        delivered: true,
      }
    );
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(1);
  });

  test('a wheel that never reached the page is sent once more', async () => {
    const { webContents, adapter } = pageAdapter({ wheelReceived: false });
    await adapter.snapshot();
    await expect(run(adapter.scroll('ref_viewport', { direction: 'down' }))).resolves.toMatchObject(
      {
        outcome: 'no_movement',
        attempts: 2,
        delivered: false,
      }
    );
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(2);
  });

  test('a wheel sent over a child frame is not sent twice', async () => {
    const { webContents, adapter } = pageAdapter({ wheelReceived: false, childFrame: true });
    await adapter.snapshot();
    await expect(run(adapter.scroll('ref_viewport', { direction: 'down' }))).resolves.toMatchObject(
      { outcome: 'no_movement', attempts: 1, delivered: null }
    );
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(1);
    expect(webContents.sendInputEvent.mock.calls[0][0]).not.toHaveProperty('childFrame');
  });

  test('a zoom change before the resend makes the reference stale instead of sending again', async () => {
    const { webContents, adapter } = pageAdapter({ wheelReceived: false });
    await adapter.snapshot();
    webContents.sendInputEvent.mockImplementationOnce(() => (webContents.zoom = 1.25));
    await expect(run(adapter.scroll('ref_viewport', { direction: 'down' }))).rejects.toMatchObject({
      code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
    });
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(1);
  });

  test('a navigation before the resend makes the reference stale instead of sending again', async () => {
    const { webContents, adapter } = pageAdapter({ wheelReceived: false });
    await adapter.snapshot();
    webContents.sendInputEvent.mockImplementationOnce(() =>
      webContents.emit('did-start-navigation', {}, 'https://example.test/next', false, true)
    );
    await expect(run(adapter.scroll('ref_viewport', { direction: 'down' }))).rejects.toMatchObject({
      code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
    });
    expect(webContents.sendInputEvent).toHaveBeenCalledTimes(1);
  });
});

// Drives frameAction's browser_scroll through a fake frame session.
// `childFrameAt(reads)` decides whether the scroll read with a point (the
// first read is 1) only found a point over a nested child frame.
function frameAdapter({ wheelReceived = false, childFrameAt = () => false } = {}) {
  const webContents = new FakeWebContents();
  const adapter = new WebContentsPageAdapter(webContents);
  let probeCount = 0;
  let pointReads = 0;
  const session = {
    frame: { ref: 'frame_1', origin: 'https://embed.test' },
    reference: { scrollOnly: true },
    assertCurrent: jest.fn(async () => {}),
    checkedInputPoint: jest.fn(async (local) => ({ x: local.x + 100, y: local.y + 100 })),
    mouse: jest.fn(async () => {
      if (wheelReceived) probeCount += 1;
    }),
    evaluate: jest.fn(async (name, args = []) => {
      if (name === 'viewport') return { ok: true };
      if (name === 'wheelProbe') {
        if (args[0] === 'arm') probeCount = 0;
        return { ok: true, count: probeCount };
      }
      if (name === 'scroll') {
        const childFrame = args[1] ? childFrameAt(++pointReads) : false;
        return {
          ok: true,
          point: { x: 5, y: 5 },
          ...(childFrame ? { childFrame: true } : {}),
          scroll: { x: 0, y: 0, maxX: 0, maxY: 1000, minX: 0, width: 400, height: 300 },
        };
      }
      throw new Error(`unexpected frame evaluate ${name}`);
    }),
  };
  adapter.frameObserver = { withReference: async (_ref, _authorize, fn) => fn(session) };
  const execution = {
    authorizeFrame: () => true,
    expectedFrameAction: {
      label: 'Scroll down by 1 viewport(s) in the observed page or container',
      frameRef: 'frame_1',
      origin: 'https://embed.test',
    },
  };
  const scroll = () =>
    run(
      adapter.frameAction(
        'ref_frame_scroll',
        { operation: 'browser_scroll', direction: 'down' },
        execution
      )
    );
  const wheels = () => session.mouse.mock.calls.filter(([event]) => event.type === 'mouseWheel');
  return { scroll, wheels };
}

describe('WebContentsPageAdapter.frameAction browser_scroll wheel resend', () => {
  test('a wheel that never reached the frame document is sent once more', async () => {
    const { scroll, wheels } = frameAdapter();
    await expect(scroll()).resolves.toMatchObject({ attempts: 2, delivered: false });
    expect(wheels()).toHaveLength(2);
  });

  test('a wheel the frame document consumed is not sent twice', async () => {
    const { scroll, wheels } = frameAdapter({ wheelReceived: true });
    await expect(scroll()).resolves.toMatchObject({ attempts: 1, delivered: true });
    expect(wheels()).toHaveLength(1);
  });

  test('a wheel sent over a nested child frame is not sent twice', async () => {
    // Every point of the target is over a nested iframe, whose document gets
    // the wheel where the frame's own probe cannot see it.
    const { scroll, wheels } = frameAdapter({ childFrameAt: () => true });
    await expect(scroll()).resolves.toMatchObject({
      outcome: 'no_movement',
      attempts: 1,
      delivered: null,
    });
    expect(wheels()).toHaveLength(1);
  });

  test('a lost wheel is not resent when the recheck only finds a point over a child frame', async () => {
    // The first two point reads (before and after preparing) are clear; the
    // recheck after the lost wheel only finds a point over a nested iframe.
    const { scroll, wheels } = frameAdapter({ childFrameAt: (n) => n > 2 });
    await expect(scroll()).resolves.toMatchObject({ attempts: 1, delivered: false });
    expect(wheels()).toHaveLength(1);
  });
});
