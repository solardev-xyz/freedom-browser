describe('swarm-readiness', () => {
  test('treats ultra-light nodes as browsing only and suggests upgrade for bundled Bee', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.classifySwarmPublishState({
        beeStatus: 'running',
        desiredMode: 'ultraLight',
        actualMode: 'ultraLight',
        registryMode: 'bundled',
      })
    ).toEqual({
      key: 'browsing-only',
      label: 'Browsing only',
      detail: 'Uploads require light mode, node funding, and usable stamps.',
      action: {
        key: 'upgrade',
        label: 'Upgrade to Light Node',
        hint: 'Enable uploads and publishing',
      },
    });
  });

  test('normalizes Bee API ultra-light mode strings', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(mod.normalizeSwarmMode('ultra-light')).toBe('ultraLight');
    expect(mod.normalizeSwarmMode('UltraLight')).toBe('ultraLight');
    expect(mod.normalizeSwarmMode('full-node')).toBe('full');
  });

  test('treats Bee API ultra-light mode strings as browsing only', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.classifySwarmPublishState({
        beeStatus: 'running',
        desiredMode: 'light',
        actualMode: 'ultra-light',
        registryMode: 'bundled',
      })
    ).toEqual({
      key: 'browsing-only',
      label: 'Browsing only',
      detail: 'Uploads require light mode, node funding, and usable stamps.',
      action: {
        key: 'upgrade',
        label: 'Upgrade to Light Node',
        hint: 'Enable uploads and publishing',
      },
    });
  });

  test('treats light nodes with readiness not OK as initializing', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.classifySwarmPublishState({
        beeStatus: 'running',
        desiredMode: 'light',
        actualMode: 'light',
        registryMode: 'bundled',
        readiness: { ok: false },
        stampsKnown: false,
      })
    ).toEqual({
      key: 'initializing',
      label: 'Initializing',
      detail: 'Bee is finishing light-node setup.',
      action: null,
    });
  });

  test('treats readiness-ok light nodes with no usable stamps as not publish-ready', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.classifySwarmPublishState({
        beeStatus: 'running',
        desiredMode: 'light',
        actualMode: 'light',
        registryMode: 'bundled',
        readiness: { ok: true },
        stampsKnown: true,
        stamps: [{ batchID: 'a', usable: false }],
      })
    ).toEqual({
      key: 'no-usable-stamps',
      label: 'No usable stamps',
      detail: 'Publishing needs at least one usable postage batch.',
      action: null,
    });
  });

  test('treats readiness-ok light nodes with a usable stamp as ready to publish', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.classifySwarmPublishState({
        beeStatus: 'running',
        desiredMode: 'light',
        actualMode: 'light',
        registryMode: 'bundled',
        readiness: { ok: true },
        stampsKnown: true,
        stamps: [
          { batchID: 'a', usable: true },
          { batchID: 'b', usable: false },
        ],
      })
    ).toEqual({
      key: 'ready',
      label: 'Ready to publish',
      detail: '1 usable batch available.',
      action: null,
    });
  });

  test('marks external Bee nodes as inspect-only by appending note and removing actions', async () => {
    const mod = await import('./swarm-readiness.js');

    const result = mod.classifySwarmPublishState({
      beeStatus: 'running',
      desiredMode: 'light',
      actualMode: 'ultra-light',
      registryMode: 'reused',
    });

    expect(result.key).toBe('browsing-only');
    expect(result.detail).toContain('Managed outside Freedom.');
    expect(result.action).toBeNull();
  });

  test('shows initializing for light node with readiness OK but stamps not yet known', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.classifySwarmPublishState({
        beeStatus: 'running',
        desiredMode: 'light',
        actualMode: 'light',
        registryMode: 'bundled',
        readiness: { ok: true },
        stampsKnown: false,
      })
    ).toEqual({
      key: 'initializing',
      label: 'Initializing',
      detail: 'Checking postage-batch availability.',
      action: null,
    });
  });

  test('shows error state when bee status is error', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.classifySwarmPublishState({
        beeStatus: 'error',
        desiredMode: 'light',
        actualMode: 'light',
        registryMode: 'bundled',
      })
    ).toEqual({
      key: 'error',
      label: 'Error',
      detail: 'Swarm reported a startup or health-check error.',
      action: null,
    });
  });

  test('summarizes usable and total stamp counts conservatively', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(mod.summarizeSwarmStamps([], false)).toEqual({
      count: '--',
      summary: 'Checking stamp availability\u2026',
    });

    expect(
      mod.summarizeSwarmStamps([
        { batchID: 'a', usable: true },
        { batchID: 'b', usable: false },
        { batchID: 'c', usable: true },
      ])
    ).toEqual({
      count: '2',
      summary: '2 usable of 3 total batches',
    });
  });

  test('checkLightModePrerequisites returns funded when chequebook is deployed', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.checkLightModePrerequisites({
        chequebookAddress: '0xabc123def456abc123def456abc123def456abc1',
        xdaiBalance: '0.0',
      })
    ).toEqual({ funded: true });
  });

  test('checkLightModePrerequisites returns funded when chequebook is deployed even with zero xDAI', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.checkLightModePrerequisites({
        chequebookAddress: '0xabc123def456abc123def456abc123def456abc1',
        xdaiBalance: '0',
      })
    ).toEqual({ funded: true });
  });

  test('checkLightModePrerequisites returns funded when no chequebook but wallet has xDAI', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.checkLightModePrerequisites({
        chequebookAddress: '0x0000000000000000000000000000000000000000',
        xdaiBalance: '0.01',
      })
    ).toEqual({ funded: true });
  });

  test('checkLightModePrerequisites returns not funded when no chequebook and zero balance', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.checkLightModePrerequisites({
        chequebookAddress: '0x0000000000000000000000000000000000000000',
        xdaiBalance: '0',
      })
    ).toEqual({ funded: false });
  });

  test('checkLightModePrerequisites returns not funded when data is missing', async () => {
    const mod = await import('./swarm-readiness.js');

    expect(
      mod.checkLightModePrerequisites({
        chequebookAddress: null,
        xdaiBalance: null,
      })
    ).toEqual({ funded: false });
  });
});
