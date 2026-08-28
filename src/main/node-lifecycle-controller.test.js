'use strict';

const { EFFECTS } = require('./agent/effect-classifier');
const { NodeLifecycleController } = require('./node-lifecycle-controller');

function classification(effect = EFFECTS.REVERSIBLE_ADMIN) {
  return {
    effect,
    confidence: 0.99,
    summary: `${effect} lifecycle action`,
    resources: ['Freedom node'],
    uncertainties: [],
  };
}

function statusController(service, states) {
  const queue = [...states];
  let last = queue.at(-1);
  return {
    status: jest.fn(async () => {
      last = queue.length ? queue.shift() : last;
      return { nodes: [{ id: service, state: last }] };
    }),
  };
}

describe('NodeLifecycleController', () => {
  test('requires exact approval, applies a start, and verifies the resulting state', async () => {
    const nodeStatusController = statusController('ant', ['stopped', 'running']);
    const startAnt = jest.fn(async () => {});
    const classifyEffect = jest.fn(async () => classification());
    const requestApproval = jest.fn(async () => 'approved');
    const controller = new NodeLifecycleController({
      nodeStatusController,
      dependencies: { startAnt, stopAnt: jest.fn() },
      verifyTimeoutMs: 0,
    });

    await expect(
      controller.lifecycle(
        { service: 'ant', action: 'start' },
        { classifyEffect, requestApproval }
      )
    ).resolves.toEqual({
      service: 'ant',
      action: 'start',
      effect: EFFECTS.REVERSIBLE_ADMIN,
      beforeState: 'stopped',
      afterState: 'running',
      verified: true,
      summary: {
        service: 'ant',
        action: 'start',
        effect: EFFECTS.REVERSIBLE_ADMIN,
        beforeState: 'stopped',
        afterState: 'running',
        verified: true,
      },
    });
    expect(classifyEffect).toHaveBeenCalledWith({
      domain: 'node',
      action: { service: 'ant', transport: 'freedom_lifecycle', action: 'start' },
      trustedContext: {
        authority: 'Freedom node manager',
        semantics: 'Start, stop, or restart one integrated node service',
      },
    });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'node_lifecycle',
      operation: 'node_lifecycle',
      label: 'start ant',
      nodeLifecycle: {
        service: 'ant',
        action: 'start',
        effect: EFFECTS.REVERSIBLE_ADMIN,
        beforeState: 'stopped',
        classification: classification(),
      },
    });
    expect(startAnt).toHaveBeenCalledTimes(1);
  });

  test('restarts the selected Myotis chain through its stable manager API', async () => {
    const stopMyotis = jest.fn();
    const startMyotis = jest.fn();
    const controller = new NodeLifecycleController({
      nodeStatusController: statusController('myotis-gnosis', ['ready', 'syncing']),
      dependencies: { stopMyotis, startMyotis },
      verifyTimeoutMs: 0,
    });

    await expect(
      controller.lifecycle(
        { service: 'myotis-gnosis', action: 'restart' },
        {
          classifyEffect: async () => classification(),
          requestApproval: async () => 'approved',
        }
      )
    ).resolves.toMatchObject({ afterState: 'syncing', verified: true });
    expect(stopMyotis).toHaveBeenCalledWith(100);
    expect(startMyotis).toHaveBeenCalledWith(100);
  });

  test('never lets a classifier downgrade lifecycle approval', async () => {
    const startIpfs = jest.fn();
    const requestApproval = jest.fn(async () => 'declined');
    const controller = new NodeLifecycleController({
      nodeStatusController: statusController('ipfs', ['stopped']),
      dependencies: { startIpfs, stopIpfs: jest.fn() },
    });

    await expect(
      controller.lifecycle(
        { service: 'ipfs', action: 'start' },
        {
          classifyEffect: async () => classification(EFFECTS.READ),
          requestApproval,
        }
      )
    ).rejects.toMatchObject({ code: 'USER_CANCELLED' });
    expect(requestApproval.mock.calls[0][0].nodeLifecycle.effect).toBe(
      EFFECTS.REVERSIBLE_ADMIN
    );
    expect(startIpfs).not.toHaveBeenCalled();
  });

  test('fails rather than claiming success when the expected state is not observed', async () => {
    const controller = new NodeLifecycleController({
      nodeStatusController: statusController('tor', ['stopped', 'error']),
      dependencies: { startTor: jest.fn(), stopTor: jest.fn() },
      verifyTimeoutMs: 0,
    });

    await expect(
      controller.lifecycle(
        { service: 'tor', action: 'start' },
        {
          classifyEffect: async () => classification(),
          requestApproval: async () => 'approved',
        }
      )
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });
});
