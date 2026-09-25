const { EventEmitter } = require('events');
const http = require('http');
const {
  DEFAULT_EXTERNAL_NODE_CANDIDATES,
  EXTERNAL_CANDIDATE_PROMPT_KEY,
  detectDefaultExternalCandidates,
  applyExternalCandidateDecisions,
  presentExternalCandidatesInWindow,
  probeEndpoint,
  promptForDefaultExternalCandidateProtocol,
  promptForDefaultExternalCandidates,
  shouldPromptForProtocol,
} = require('./profile-external-candidates');
const IPC = require('../shared/ipc-channels');

function createProfile(nodes = {}) {
  return {
    id: 'default',
    displayName: 'Default',
    source: 'catalog',
    metadata: {
      nodes: {
        bee: { mode: 'managed' },
        ipfs: { mode: 'managed' },
        radicle: { mode: 'managed' },
        ...nodes,
      },
    },
  };
}

describe('profile external candidates', () => {
  test('detects compatible default-port nodes only for unprompted managed protocols', async () => {
    const profile = createProfile({
      radicle: {
        mode: 'managed',
        [EXTERNAL_CANDIDATE_PROMPT_KEY]: { choice: 'managed' },
      },
    });
    const probeEndpoint = jest.fn().mockResolvedValue(true);

    const candidates = await detectDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: true,
        ipfs: false,
        radicle: true,
      },
      probeEndpoint,
    });

    expect(candidates.map((candidate) => candidate.protocol)).toEqual(['bee']);
    expect(probeEndpoint).toHaveBeenCalledWith(
      DEFAULT_EXTERNAL_NODE_CANDIDATES.bee.probes[0],
      expect.any(Object)
    );
  });

  test('skips disabled startup protocols during default-port detection', async () => {
    const profile = createProfile();
    const probeEndpoint = jest.fn().mockResolvedValue(true);

    const candidates = await detectDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: false,
        ipfs: false,
        radicle: false,
      },
      probeEndpoint,
    });

    expect(candidates).toEqual([]);
    expect(probeEndpoint).not.toHaveBeenCalled();
  });

  test('persists external mode when the user chooses an existing default-port node', async () => {
    const profile = createProfile();
    const dialog = {
      showMessageBox: jest.fn().mockResolvedValue({ response: 0 }),
    };
    const updateNodeConfig = jest.fn();

    const decisions = await promptForDefaultExternalCandidates(profile, {
      dialog,
      enabledProtocols: {
        bee: true,
        ipfs: false,
        radicle: false,
      },
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      probeEndpoint: jest.fn().mockResolvedValue(true),
      updateNodeConfig,
    });

    expect(decisions).toEqual([
      {
        protocol: 'bee',
        choice: 'external',
        endpoints: ['http://127.0.0.1:1633'],
      },
    ]);
    expect(updateNodeConfig).toHaveBeenCalledWith('bee', {
      mode: 'external',
      externalApi: 'http://127.0.0.1:1633',
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'external',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['http://127.0.0.1:1633'],
      },
    });
  });

  test('ignores Radicle when probing default-port external nodes', async () => {
    const profile = createProfile();
    const updateNodeConfig = jest.fn();
    const decisions = await promptForDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: true,
        ipfs: false,
        radicle: true,
      },
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      presentCandidates: jest.fn().mockResolvedValue({ bee: 'external' }),
      probeEndpoint: jest.fn().mockResolvedValue(true),
      updateNodeConfig,
    });

    expect(decisions).toEqual([
      {
        protocol: 'bee',
        choice: 'external',
        endpoints: ['http://127.0.0.1:1633'],
      },
    ]);
    expect(updateNodeConfig).toHaveBeenCalledWith('bee', {
      mode: 'external',
      externalApi: 'http://127.0.0.1:1633',
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'external',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['http://127.0.0.1:1633'],
      },
    });
    expect(updateNodeConfig).toHaveBeenCalledTimes(1);
  });

  test('persists external Tor when a default SOCKS endpoint is chosen', async () => {
    const profile = createProfile({
      tor: { mode: 'managed' },
    });
    const updateNodeConfig = jest.fn();

    const decisions = await promptForDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: false,
        ipfs: false,
        radicle: false,
        tor: true,
      },
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      presentCandidates: jest.fn().mockResolvedValue({
        tor: 'external',
      }),
      probeEndpoint: jest.fn().mockResolvedValue(true),
      updateNodeConfig,
    });

    expect(decisions).toEqual([
      {
        protocol: 'tor',
        choice: 'external',
        endpoints: ['SOCKS5 127.0.0.1:9150'],
      },
    ]);
    expect(updateNodeConfig).toHaveBeenCalledWith('tor', {
      mode: 'external',
      externalSocks: '127.0.0.1:9150',
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'external',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['SOCKS5 127.0.0.1:9150'],
      },
    });
  });

  test('single-protocol prompt only probes the requested default endpoint', async () => {
    const profile = createProfile({
      tor: { mode: 'managed' },
    });
    const updateNodeConfig = jest.fn();
    const probeEndpoint = jest.fn().mockResolvedValue(true);

    await promptForDefaultExternalCandidateProtocol(profile, 'tor', {
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      presentCandidates: jest.fn().mockResolvedValue({
        tor: 'managed',
      }),
      probeEndpoint,
      updateNodeConfig,
    });

    expect(probeEndpoint).toHaveBeenCalledTimes(1);
    expect(probeEndpoint).toHaveBeenCalledWith(
      DEFAULT_EXTERNAL_NODE_CANDIDATES.tor.probes[0],
      expect.any(Object)
    );
    expect(updateNodeConfig).toHaveBeenCalledWith('tor', {
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'managed',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['SOCKS5 127.0.0.1:9150'],
      },
    });
  });

  test('persists managed choice without changing node mode', async () => {
    const profile = createProfile();
    const dialog = {
      showMessageBox: jest.fn().mockResolvedValue({ response: 1 }),
    };
    const updateNodeConfig = jest.fn();

    await promptForDefaultExternalCandidates(profile, {
      dialog,
      enabledProtocols: {
        bee: true,
        ipfs: false,
        radicle: false,
      },
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      probeEndpoint: jest.fn().mockResolvedValue(true),
      updateNodeConfig,
    });

    expect(updateNodeConfig).toHaveBeenCalledWith('bee', {
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'managed',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['http://127.0.0.1:1633'],
      },
    });
  });

  test('does not prompt outside catalog-managed profiles', () => {
    expect(shouldPromptForProtocol({ source: 'profile-dir' }, 'bee')).toBe(false);
    expect(shouldPromptForProtocol(createProfile({ bee: { mode: 'disabled' } }), 'bee')).toBe(
      false
    );
  });

  test('defaults invalid combined choices to managed', () => {
    const updateNodeConfig = jest.fn();
    const decisions = applyExternalCandidateDecisions(
      [
        {
          protocol: 'bee',
          endpoints: ['http://127.0.0.1:1633'],
          externalConfig: {
            mode: 'external',
            externalApi: 'http://127.0.0.1:1633',
          },
        },
      ],
      { bee: 'surprise' },
      {
        logger: { info: jest.fn() },
        now: '2026-05-26T00:00:00.000Z',
        updateNodeConfig,
      }
    );

    expect(decisions[0]).toMatchObject({ protocol: 'bee', choice: 'managed' });
    expect(updateNodeConfig).toHaveBeenCalledWith('bee', {
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'managed',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['http://127.0.0.1:1633'],
      },
    });
  });

  test('presents all candidates to the renderer as one request', async () => {
    const profile = createProfile();
    const ipcMain = new EventEmitter();
    const webContents = new EventEmitter();
    const window = new EventEmitter();
    webContents.isLoading = () => false;
    webContents.send = jest.fn((channel, payload) => {
      setImmediate(() => {
        ipcMain.emit(IPC.PROFILE_EXTERNAL_CANDIDATES_DECISION, { sender: webContents }, {
          requestId: payload.requestId,
          choices: {
            bee: 'external',
            tor: 'managed',
          },
        });
      });
    });
    window.webContents = webContents;
    window.isDestroyed = () => false;

    const choices = await presentExternalCandidatesInWindow(
      profile,
      [
        { protocol: 'bee', label: 'Swarm', endpoints: ['http://127.0.0.1:1633'] },
        { protocol: 'tor', label: 'Tor', endpoints: ['127.0.0.1:9150'] },
      ],
      {
        ipcMain,
        requestId: 'req-1',
        window,
      }
    );

    expect(webContents.send).toHaveBeenCalledWith(IPC.PROFILE_EXTERNAL_CANDIDATES, {
      requestId: 'req-1',
      profile: {
        id: 'default',
        displayName: 'Default',
      },
      candidates: [
        {
          protocol: 'bee',
          label: 'Swarm',
          endpoints: ['http://127.0.0.1:1633'],
          trustNote: null,
        },
        { protocol: 'tor', label: 'Tor', endpoints: ['127.0.0.1:9150'], trustNote: null },
      ],
    });
    expect(choices).toEqual({
      bee: 'external',
      tor: 'managed',
    });
  });

  test('ignores external-candidate decisions from a different window sender', async () => {
    const profile = createProfile();
    const ipcMain = new EventEmitter();
    const webContents = new EventEmitter();
    const otherWebContents = new EventEmitter();
    const window = new EventEmitter();
    webContents.isLoading = () => false;
    webContents.send = jest.fn((channel, payload) => {
      setImmediate(() => {
        ipcMain.emit(IPC.PROFILE_EXTERNAL_CANDIDATES_DECISION, { sender: otherWebContents }, {
          requestId: payload.requestId,
          choices: { bee: 'external' },
        });
        ipcMain.emit(IPC.PROFILE_EXTERNAL_CANDIDATES_DECISION, { sender: webContents }, {
          requestId: payload.requestId,
          choices: { bee: 'managed' },
        });
      });
    });
    window.webContents = webContents;
    window.isDestroyed = () => false;

    const choices = await presentExternalCandidatesInWindow(
      profile,
      [{ protocol: 'bee', label: 'Swarm', endpoints: ['http://127.0.0.1:1633'] }],
      {
        ipcMain,
        requestId: 'req-bound',
        window,
      }
    );

    expect(choices).toEqual({ bee: 'managed' });
  });

  // The IPFS candidate probes 127.0.0.1:8080, by far the most common local
  // dev-server port. Detection has to prove it is talking to an IPFS gateway
  // before offering to route every ipfs:// load through it.
  describe('IPFS gateway probe', () => {
    const servers = [];

    const startServer = (handler) =>
      new Promise((resolve) => {
        const server = http.createServer(handler);
        servers.push(server);
        server.listen(0, '127.0.0.1', () => resolve(server));
      });

    const probeUrlFor = (server, path = '/ipfs/bafkqaaa') =>
      `http://127.0.0.1:${server.address().port}${path}`;

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise((resolve) => {
              server.closeAllConnections?.();
              server.close(() => resolve());
            })
        )
      );
    });

    test('rejects a dev server answering 200 + index.html for every path', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body>vite dev server</body></html>');
      });

      await expect(
        probeEndpoint({ url: probeUrlFor(server), method: 'GET', expectIpfsGateway: true })
      ).resolves.toBe(false);
    });

    test('accepts a gateway that answers the probe CID with an empty 200', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end();
      });

      await expect(
        probeEndpoint({ url: probeUrlFor(server), method: 'GET', expectIpfsGateway: true })
      ).resolves.toBe(true);
    });

    test('accepts a gateway that identifies itself with an X-Ipfs-Path header', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'X-Ipfs-Path': '/ipfs/bafkqaaa' });
        res.end('served by a gateway that adds a body');
      });

      await expect(
        probeEndpoint({ url: probeUrlFor(server), method: 'GET', expectIpfsGateway: true })
      ).resolves.toBe(true);
    });

    test('does not follow a redirect into another local service', async () => {
      const redirected = [];
      const target = await startServer((req, res) => {
        redirected.push(req.url);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end();
      });
      const server = await startServer((_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` });
        res.end();
      });

      await expect(
        probeEndpoint({ url: probeUrlFor(server), method: 'GET', expectIpfsGateway: true })
      ).resolves.toBe(false);
      expect(redirected).toEqual([]);
    });

    test('the shipped IPFS candidate carries the gateway check and the trust disclosure', () => {
      const definition = DEFAULT_EXTERNAL_NODE_CANDIDATES.ipfs;
      expect(definition.probes).toEqual([
        {
          url: 'http://127.0.0.1:8080/ipfs/bafkqaaa',
          method: 'GET',
          expectJson: false,
          expectIpfsGateway: true,
        },
      ]);
      expect(definition.trustNote).toMatch(/does not verify content integrity/i);
    });
  });
});
