const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalNavigator = global.navigator;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createStep = (step) =>
  createElement('div', {
    classes: ['ghb-step'],
    dataset: { step },
  });

const loadGithubBridgeModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    enableRadicleIntegration: options.enableRadicleIntegration ?? true,
    currentRadicleStatus: options.currentRadicleStatus || 'running',
  };
  const bridgeBtn = createElement('button', {
    classes: ['hidden'],
  });
  const panel = createElement('div', {
    classes: ['hidden'],
  });
  const closeBtn = createElement('button');
  const importBtn = createElement('button');
  const browseBtn = createElement('button');
  const retryBtn = createElement('button');
  const copyBtn = createElement('button');
  const repoNameEl = createElement('div');
  const ridEl = createElement('div');
  const errorDetailEl = createElement('div');
  const prereqTextEl = createElement('div');
  const prereqErrorState = createElement('section', { classes: ['hidden'] });
  const readyState = createElement('section', { classes: ['hidden'] });
  const importingState = createElement('section', { classes: ['hidden'] });
  const successState = createElement('section', { classes: ['hidden'] });
  const errorState = createElement('section', { classes: ['hidden'] });
  const cloningStep = createStep('cloning');
  const initializingStep = createStep('initializing');
  const pushingStep = createStep('pushing');
  const addressInput = createElement('input', {
    value: options.addressValue || 'https://github.com/openai/project',
  });
  const body = createElement('body');

  importingState.appendChild(cloningStep);
  importingState.appendChild(initializingStep);
  importingState.appendChild(pushingStep);
  panel.appendChild(closeBtn);
  panel.appendChild(importBtn);
  panel.appendChild(browseBtn);
  panel.appendChild(retryBtn);
  panel.appendChild(copyBtn);
  panel.appendChild(repoNameEl);
  panel.appendChild(ridEl);
  panel.appendChild(errorDetailEl);
  panel.appendChild(prereqTextEl);
  panel.appendChild(prereqErrorState);
  panel.appendChild(readyState);
  panel.appendChild(importingState);
  panel.appendChild(successState);
  panel.appendChild(errorState);
  body.appendChild(panel);

  const document = createDocument({
    body,
    elementsById: {
      'github-bridge-btn': bridgeBtn,
      'github-bridge-panel': panel,
      'ghb-close': closeBtn,
      'ghb-import-btn': importBtn,
      'ghb-browse-btn': browseBtn,
      'ghb-retry-btn': retryBtn,
      'ghb-copy-rid': copyBtn,
      'ghb-repo-name': repoNameEl,
      'ghb-rid': ridEl,
      'ghb-error-detail': errorDetailEl,
      'ghb-prereq-text': prereqTextEl,
      'ghb-prereq-error': prereqErrorState,
      'ghb-ready': readyState,
      'ghb-importing': importingState,
      'ghb-success': successState,
      'ghb-error': errorState,
      'address-input': addressInput,
    },
  });
  let progressHandler = null;
  const progressCleanup = jest.fn();
  const githubBridge = {
    checkExisting:
      options.checkExisting ||
      jest.fn().mockResolvedValue({ success: true, bridged: false, rid: '' }),
    checkPrerequisites:
      options.checkPrerequisites || jest.fn().mockResolvedValue({ success: true }),
    onProgress:
      options.onProgress ||
      jest.fn((handler) => {
        progressHandler = handler;
        return progressCleanup;
      }),
    import:
      options.importFn ||
      jest.fn().mockResolvedValue({ success: true, rid: 'z123' }),
  };
  const windowHandlers = {};
  const clipboard = {
    writeText: jest.fn().mockResolvedValue(undefined),
  };
  const electronAPI = {
    copyText: jest.fn(),
  };
  const setTimeoutMock = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
    fn();
    return 1;
  });

  global.window = {
    githubBridge,
    electronAPI,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };
  global.document = document;
  global.navigator = {
    clipboard,
  };

  jest.doMock('./state.js', () => ({ state }));

  const mod = await import('./github-bridge-ui.js');

  return {
    mod,
    state,
    githubBridge,
    progressCleanup,
    getProgressHandler: () => progressHandler,
    clipboard,
    electronAPI,
    windowHandlers,
    setTimeoutMock,
    documentHandlers: document.handlers,
    elements: {
      bridgeBtn,
      panel,
      closeBtn,
      importBtn,
      browseBtn,
      retryBtn,
      copyBtn,
      repoNameEl,
      ridEl,
      errorDetailEl,
      prereqTextEl,
      prereqErrorState,
      readyState,
      importingState,
      successState,
      errorState,
      cloningStep,
      initializingStep,
      pushingStep,
      addressInput,
    },
  };
};

describe('github-bridge-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.navigator = originalNavigator;
    jest.restoreAllMocks();
  });

  test('updates icon visibility for GitHub URLs and bridged repositories', async () => {
    const ctx = await loadGithubBridgeModule();

    ctx.mod.initGithubBridgeUi();
    await ctx.mod.updateGithubBridgeIcon();

    expect(ctx.githubBridge.checkExisting).toHaveBeenCalledWith('https://github.com/openai/project');
    expect(ctx.elements.bridgeBtn.classList.contains('hidden')).toBe(false);

    ctx.githubBridge.checkExisting.mockResolvedValueOnce({
      success: true,
      bridged: true,
      rid: 'zknown',
    });
    await ctx.mod.updateGithubBridgeIcon();
    expect(ctx.elements.bridgeBtn.classList.contains('hidden')).toBe(true);

    ctx.elements.addressInput.value = 'https://example.com/not-github';
    await ctx.mod.updateGithubBridgeIcon();
    expect(ctx.elements.bridgeBtn.classList.contains('hidden')).toBe(true);

    ctx.state.enableRadicleIntegration = false;
    ctx.windowHandlers['settings:updated']();
    await flushMicrotasks();
    expect(ctx.elements.bridgeBtn.classList.contains('hidden')).toBe(true);
  });

  test('opens the panel, imports successfully, and supports browse and copy actions', async () => {
    const ctx = await loadGithubBridgeModule();
    const onOpenRadicleUrl = jest.fn();

    ctx.mod.initGithubBridgeUi();
    ctx.mod.setOnOpenRadicleUrl(onOpenRadicleUrl);
    await ctx.mod.updateGithubBridgeIcon();
    ctx.githubBridge.import.mockImplementation(async () => {
      const progressHandler = ctx.getProgressHandler();
      progressHandler({ step: 'cloning' });
      progressHandler({ step: 'pushing' });
      progressHandler({ step: 'success' });
      return { success: true, rid: 'zsuccess' };
    });
    ctx.elements.bridgeBtn.dispatch('click', {
      stopPropagation: jest.fn(),
    });
    await flushMicrotasks();

    expect(ctx.elements.panel.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.repoNameEl.textContent).toBe('openai/project');
    expect(ctx.elements.readyState.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.prereqErrorState.classList.contains('hidden')).toBe(true);

    ctx.elements.importBtn.dispatch('click');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.githubBridge.checkPrerequisites).toHaveBeenCalled();
    expect(ctx.githubBridge.import).toHaveBeenCalledWith('https://github.com/openai/project');
    expect(ctx.progressCleanup).toHaveBeenCalled();
    expect(ctx.elements.cloningStep.classList.contains('done')).toBe(true);
    expect(ctx.elements.pushingStep.classList.contains('done')).toBe(true);
    expect(ctx.elements.successState.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.ridEl.textContent).toBe('rad:zsuccess');

    ctx.elements.browseBtn.dispatch('click');
    expect(onOpenRadicleUrl).toHaveBeenCalledWith('rad://zsuccess');
    expect(ctx.elements.panel.classList.contains('hidden')).toBe(true);

    ctx.elements.copyBtn.dispatch('click');
    expect(ctx.clipboard.writeText).toHaveBeenCalledWith('rad:zsuccess');
    expect(ctx.setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  test('shows prereq and import errors and supports retry', async () => {
    const ctx = await loadGithubBridgeModule({
      enableRadicleIntegration: false,
    });

    ctx.mod.initGithubBridgeUi();
    ctx.elements.bridgeBtn.dispatch('click', {
      stopPropagation: jest.fn(),
    });

    expect(ctx.elements.prereqErrorState.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.prereqTextEl.textContent).toBe(
      'Radicle integration is disabled. Enable it in Settings > Experimental'
    );

    ctx.state.enableRadicleIntegration = true;
    ctx.state.currentRadicleStatus = 'running';
    ctx.githubBridge.import.mockResolvedValueOnce({
      success: false,
      error: 'remote rejected',
      step: 'pushing',
    });

    await ctx.mod.updateGithubBridgeIcon();
    ctx.elements.bridgeBtn.dispatch('click', {
      stopPropagation: jest.fn(),
    });
    await flushMicrotasks();

    ctx.elements.importBtn.dispatch('click');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.elements.errorState.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.errorDetailEl.textContent).toBe('remote rejected');
    expect(ctx.elements.pushingStep.classList.contains('error')).toBe(true);

    ctx.elements.retryBtn.dispatch('click');
    expect(ctx.elements.readyState.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.pushingStep.classList.contains('error')).toBe(false);
  });

  test('handles already-bridged imports, copy fallback, and panel close shortcuts', async () => {
    const ctx = await loadGithubBridgeModule({
      importFn: jest.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'ALREADY_BRIDGED',
          details: {
            rid: 'zexisting',
          },
        },
      }),
    });

    ctx.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));

    ctx.mod.initGithubBridgeUi();
    await ctx.mod.updateGithubBridgeIcon();

    ctx.elements.bridgeBtn.dispatch('click', {
      stopPropagation: jest.fn(),
    });
    await flushMicrotasks();

    ctx.elements.importBtn.dispatch('click');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.elements.successState.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.ridEl.textContent).toBe('rad:zexisting');
    expect(ctx.elements.bridgeBtn.classList.contains('hidden')).toBe(true);

    ctx.elements.copyBtn.dispatch('click');
    await flushMicrotasks();
    expect(ctx.electronAPI.copyText).toHaveBeenCalledWith('rad:zexisting');

    ctx.documentHandlers.keydown({
      key: 'Escape',
    });
    expect(ctx.elements.panel.classList.contains('hidden')).toBe(true);

    ctx.elements.bridgeBtn.classList.remove('hidden');
    ctx.elements.bridgeBtn.dispatch('click', {
      stopPropagation: jest.fn(),
    });
    await flushMicrotasks();
    ctx.documentHandlers.click({
      target: createElement('div'),
    });
    expect(ctx.elements.panel.classList.contains('hidden')).toBe(true);
  });
});
