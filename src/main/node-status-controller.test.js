'use strict';

const { NodeStatusController } = require('./node-status-controller');

function createController(overrides = {}) {
  return new NodeStatusController({
    getRegistry: async () => ({
      ant: { mode: 'bundled', api: 'http://127.0.0.1:11633' },
      ipfs: { mode: 'bundled', gateway: '/private/profile/ipfs' },
      radicle: { mode: 'external', api: 'http://127.0.0.1:18780' },
      tor: { mode: 'bundled', socks: '127.0.0.1:19150' },
      myotis: { mode: 'bundled' },
    }),
    getSettings: async () => ({
      enableRadicleIntegration: true,
      enableTorIntegration: false,
    }),
    getAntStatus: async () => ({ status: 'running', error: null }),
    getIpfsStatus: async () => ({ status: 'starting', error: null }),
    getRadicleStatus: async () => ({ status: 'error', error: 'token=private' }),
    getTorStatus: async () => ({ status: 'running', error: null }),
    getMyotisStatus: async (chainId) =>
      chainId === 1
        ? {
            state: 'ready',
            peerCount: 4,
            finalizedBlockNumber: 123,
            error: '/private/profile/myotis',
          }
        : { state: 'off', peerCount: 0 },
    ...overrides,
  });
}

describe('NodeStatusController', () => {
  test('normalizes every integrated service without exposing endpoints or raw diagnostics', async () => {
    const result = await createController().status();

    expect(result).toEqual({
      nodes: [
        {
          id: 'ant',
          name: 'Swarm',
          implementation: 'Ant',
          protocols: ['bzz'],
          state: 'running',
          mode: 'bundled',
          running: true,
          ready: true,
        },
        {
          id: 'ipfs',
          name: 'IPFS',
          implementation: 'Freedom IPFS',
          protocols: ['ipfs', 'ipns'],
          state: 'starting',
          mode: 'bundled',
          running: false,
          ready: false,
        },
        {
          id: 'radicle',
          name: 'Radicle',
          implementation: 'Radicle Node',
          protocols: ['rad'],
          state: 'error',
          mode: 'external',
          running: false,
          ready: false,
          recovery: 'Open Freedom’s Nodes panel for recovery details.',
        },
        {
          id: 'tor',
          name: 'Tor',
          implementation: 'Arti',
          protocols: ['onion'],
          state: 'disabled',
          mode: 'disabled',
          running: false,
          ready: false,
          recovery: 'Enable this service in Freedom settings if the task needs it.',
        },
        {
          id: 'myotis-ethereum',
          name: 'Ethereum light client',
          implementation: 'Myotis',
          protocols: ['ethereum'],
          chainId: 1,
          state: 'ready',
          mode: 'bundled',
          running: true,
          ready: true,
          peerCount: 4,
        },
        {
          id: 'myotis-gnosis',
          name: 'Gnosis light client',
          implementation: 'Myotis',
          protocols: ['gnosis'],
          chainId: 100,
          state: 'stopped',
          mode: 'bundled',
          running: false,
          ready: false,
          peerCount: 0,
        },
      ],
      summary: { total: 6, ready: 2, active: 3, disabled: 1, attention: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /127\.0\.0\.1|private\/profile|token|finalizedBlockNumber/
    );
  });

  test('fails individual status probes closed without failing the complete snapshot', async () => {
    const result = await createController({
      getAntStatus: async () => {
        throw new Error('secret Ant failure');
      },
      getMyotisStatus: async () => ({ state: 'unexpected', peerCount: Number.MAX_SAFE_INTEGER }),
    }).status();

    expect(result.nodes.find((node) => node.id === 'ant')).toMatchObject({
      state: 'error',
      ready: false,
      recovery: 'Open Freedom’s Nodes panel for recovery details.',
    });
    expect(result.nodes.find((node) => node.id === 'myotis-ethereum')).toMatchObject({
      state: 'error',
      ready: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret Ant failure');
    expect(JSON.stringify(result)).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });
});
