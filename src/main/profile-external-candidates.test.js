const { EventEmitter } = require('events');
const {
  DEFAULT_EXTERNAL_NODE_CANDIDATES,
  EXTERNAL_CANDIDATE_PROMPT_KEY,
  detectDefaultExternalCandidates,
  applyExternalCandidateDecisions,
  presentExternalCandidatesInWindow,
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

  test('persists combined renderer choices for all detected default-port nodes', async () => {
    const profile = createProfile();
    const updateNodeConfig = jest.fn();
    const decisions = await promptForDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: true,
        radicle: true,
      },
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      presentCandidates: jest.fn().mockResolvedValue({
        bee: 'external',
        radicle: 'managed',
      }),
      probeEndpoint: jest.fn().mockResolvedValue(true),
      updateNodeConfig,
    });

    expect(decisions).toEqual([
      {
        protocol: 'bee',
        choice: 'external',
        endpoints: ['http://127.0.0.1:1633'],
      },
      {
        protocol: 'radicle',
        choice: 'managed',
        endpoints: ['http://127.0.0.1:8780'],
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
    expect(updateNodeConfig).toHaveBeenCalledWith('radicle', {
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'managed',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['http://127.0.0.1:8780'],
      },
    });
  });

  test('persists external Tor when a default SOCKS endpoint is chosen', async () => {
    const profile = createProfile({
      tor: { mode: 'managed' },
    });
    const updateNodeConfig = jest.fn();

    const decisions = await promptForDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: false,
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
            radicle: 'managed',
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
        {
          protocol: 'radicle',
          label: 'Radicle',
          endpoints: ['http://127.0.0.1:8780'],
        },
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
        { protocol: 'bee', label: 'Swarm', endpoints: ['http://127.0.0.1:1633'] },
        {
          protocol: 'radicle',
          label: 'Radicle',
          endpoints: ['http://127.0.0.1:8780'],
        },
      ],
    });
    expect(choices).toEqual({
      bee: 'external',
      radicle: 'managed',
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
});
