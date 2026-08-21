'use strict';

const { createRuntimeIdleController } = require('./runtime-idle-controller');

function createFixture(options = {}) {
  let nowMs = 0;
  let scheduled = null;
  const onIdle = jest.fn();
  const controller = createRuntimeIdleController({
    timeoutMs: 100,
    busyPollIntervalMs: 10,
    now: () => nowMs,
    schedule: (callback, delayMs) => {
      scheduled = { callback, delayMs };
      return scheduled;
    },
    cancel: () => {
      scheduled = null;
    },
    onIdle,
    logger: { warn: jest.fn(), error: jest.fn() },
    ...options,
  });
  return {
    controller,
    onIdle,
    scheduled: () => scheduled,
    advanceTo: (nextNowMs) => {
      nowMs = nextNowMs;
      const pending = scheduled;
      scheduled = null;
      pending.callback();
    },
  };
}

describe('runtime idle controller', () => {
  test('starts a countdown and triggers idle shutdown after inactivity', () => {
    const fixture = createFixture();
    fixture.controller.start();
    expect(fixture.scheduled().delayMs).toBe(100);
    expect(fixture.controller.status()).toMatchObject({
      state: 'countdown',
      timeoutMs: 100,
      idleDeadlineAt: '1970-01-01T00:00:00.100Z',
    });

    fixture.advanceTo(100);
    expect(fixture.onIdle).toHaveBeenCalledTimes(1);
    expect(fixture.controller.status().state).toBe('idle');
  });

  test('blocks while clients or requests are active and restarts from release', () => {
    const fixture = createFixture();
    fixture.controller.start();
    const releaseClient = fixture.controller.acquire('client');
    const releaseRequest = fixture.controller.acquire('request');
    expect(fixture.scheduled()).toBeNull();
    expect(fixture.controller.status()).toMatchObject({
      state: 'blocked',
      blockers: [
        { source: 'client', count: 1 },
        { source: 'request', count: 1 },
      ],
    });

    expect(releaseClient()).toBe(true);
    expect(fixture.scheduled()).toBeNull();
    expect(releaseRequest()).toBe(true);
    expect(releaseRequest()).toBe(false);
    expect(fixture.scheduled().delayMs).toBe(100);
  });

  test('waits for probed work to finish before starting a fresh countdown', () => {
    let downloadActive = true;
    const fixture = createFixture();
    fixture.controller.registerProbe('downloads', () => downloadActive);
    fixture.controller.start();

    fixture.advanceTo(100);
    expect(fixture.onIdle).not.toHaveBeenCalled();
    expect(fixture.controller.status()).toMatchObject({
      state: 'busy',
      busyProbes: ['downloads'],
    });
    expect(fixture.scheduled().delayMs).toBe(10);

    downloadActive = false;
    fixture.advanceTo(110);
    expect(fixture.onIdle).not.toHaveBeenCalled();
    expect(fixture.controller.status().state).toBe('countdown');
    expect(fixture.scheduled().delayMs).toBe(100);
    fixture.advanceTo(210);
    expect(fixture.onIdle).toHaveBeenCalledTimes(1);
  });

  test('can disable automatic shutdown for persistent runtimes', () => {
    const fixture = createFixture({ timeoutMs: 0 });
    fixture.controller.start();
    expect(fixture.scheduled()).toBeNull();
    expect(fixture.controller.status()).toMatchObject({ enabled: false, state: 'disabled' });
  });
});
