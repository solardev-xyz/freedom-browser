const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

describe('downloads-ui', () => {
  const originalDocument = global.document;
  const originalWindow = global.window;

  let shelfEl;
  let electronAPI;
  let updateHandler;

  const loadModule = async ({ withShelf = true } = {}) => {
    jest.resetModules();
    jest.useFakeTimers();

    updateHandler = null;
    electronAPI = {
      onDownloadUpdated: jest.fn((callback) => {
        updateHandler = callback;
        return () => {};
      }),
      cancelDownload: jest.fn(),
      resumeDownload: jest.fn(),
      openDownloadedFile: jest.fn(),
      showDownloadInFolder: jest.fn(),
    };

    shelfEl = createElement('div');
    global.document = createDocument({
      elementsById: withShelf ? { 'download-shelf': shelfEl } : {},
    });
    global.window = { electronAPI };

    const mod = await import('./downloads-ui.js');
    mod._resetForTest();
    mod.initDownloadsUi();
    return mod;
  };

  afterEach(() => {
    jest.useRealTimers();
    global.document = originalDocument;
    global.window = originalWindow;
  });

  describe('formatBytes', () => {
    test('formats across unit boundaries', async () => {
      const mod = await loadModule();
      expect(mod.formatBytes(0)).toBe('0 B');
      expect(mod.formatBytes(999)).toBe('999 B');
      expect(mod.formatBytes(1024)).toBe('1.0 KB');
      expect(mod.formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
      expect(mod.formatBytes(1024 ** 3)).toBe('1.0 GB');
      expect(mod.formatBytes(-5)).toBe('0 B');
      expect(mod.formatBytes(undefined)).toBe('0 B');
    });
  });

  describe('progressPercent', () => {
    test('is null for unknown totals and clamped otherwise', async () => {
      const mod = await loadModule();
      expect(mod.progressPercent({ total_bytes: 0, received_bytes: 10 })).toBeNull();
      expect(mod.progressPercent({ total_bytes: 200, received_bytes: 50 })).toBe(25);
      expect(mod.progressPercent({ total_bytes: 100, received_bytes: 150 })).toBe(100);
      expect(mod.progressPercent({ total_bytes: 100, received_bytes: 0 })).toBe(0);
    });
  });

  describe('downloadStatusText', () => {
    test('covers all states', async () => {
      const mod = await loadModule();
      expect(
        mod.downloadStatusText({ state: 'in_progress', received_bytes: 512, total_bytes: 2048 })
      ).toBe('512 B of 2.0 KB');
      expect(
        mod.downloadStatusText({ state: 'in_progress', received_bytes: 512, total_bytes: 0 })
      ).toBe('512 B');
      expect(
        mod.downloadStatusText({
          state: 'in_progress',
          is_paused: true,
          received_bytes: 512,
          total_bytes: 2048,
        })
      ).toBe('Paused — 512 B of 2.0 KB');
      expect(
        mod.downloadStatusText({ state: 'completed', received_bytes: 2048, total_bytes: 2048 })
      ).toBe('Done — 2.0 KB');
      expect(mod.downloadStatusText({ state: 'cancelled' })).toBe('Cancelled');
      expect(mod.downloadStatusText({ state: 'interrupted' })).toBe(
        'Failed — download interrupted'
      );
      // Live-but-stalled is not a terminal failure and must not read as an
      // in-flight transfer either.
      expect(
        mod.downloadStatusText({
          state: 'in_progress',
          is_interrupted: true,
          received_bytes: 512,
          total_bytes: 2048,
        })
      ).toBe('Interrupted — 512 B of 2.0 KB');
    });
  });

  describe('isSettledState', () => {
    test('only terminal states settle', async () => {
      const mod = await loadModule();
      expect(mod.isSettledState('completed')).toBe(true);
      expect(mod.isSettledState('cancelled')).toBe(true);
      expect(mod.isSettledState('interrupted')).toBe(true);
      expect(mod.isSettledState('in_progress')).toBe(false);
    });
  });

  describe('shelf cards', () => {
    test('subscribes to download updates on init', async () => {
      await loadModule();
      expect(electronAPI.onDownloadUpdated).toHaveBeenCalledTimes(1);
      expect(typeof updateHandler).toBe('function');
    });

    test('creates one card per download and updates it in place', async () => {
      await loadModule();

      updateHandler({
        id: 1,
        filename: 'file.zip',
        state: 'in_progress',
        received_bytes: 100,
        total_bytes: 1000,
      });
      expect(shelfEl.children).toHaveLength(1);

      updateHandler({
        id: 1,
        filename: 'file.zip',
        state: 'in_progress',
        received_bytes: 500,
        total_bytes: 1000,
      });
      expect(shelfEl.children).toHaveLength(1);

      const card = shelfEl.children[0];
      const fill = card.querySelector('.download-card-progress-fill');
      expect(fill.style.width).toBe('50%');
      const status = card.querySelector('.download-card-status');
      expect(status.textContent).toBe('500 B of 1000 B');
    });

    test('in-progress cards offer Cancel which routes to electronAPI', async () => {
      await loadModule();

      updateHandler({
        id: 2,
        filename: 'big.iso',
        state: 'in_progress',
        received_bytes: 0,
        total_bytes: 0,
      });
      const cancelBtn = shelfEl.children[0].querySelector('[data-test="download-cancel"]');
      expect(cancelBtn).toBeTruthy();

      cancelBtn.dispatch('click');
      expect(electronAPI.cancelDownload).toHaveBeenCalledWith(2);
    });

    test('completion swaps controls to Open / Show in folder and auto-dismisses', async () => {
      await loadModule();

      updateHandler({
        id: 3,
        filename: 'done.pdf',
        state: 'in_progress',
        received_bytes: 10,
        total_bytes: 10,
      });
      updateHandler({
        id: 3,
        filename: 'done.pdf',
        state: 'completed',
        received_bytes: 10,
        total_bytes: 10,
      });

      const card = shelfEl.children[0];
      expect(card.querySelector('[data-test="download-cancel"]')).toBeNull();
      const showBtn = card.querySelector('[data-test="download-show-in-folder"]');
      const openBtn = card.querySelector('[data-test="download-open"]');
      expect(showBtn).toBeTruthy();
      expect(openBtn).toBeTruthy();

      openBtn.dispatch('click');
      expect(electronAPI.openDownloadedFile).toHaveBeenCalledWith(3);
      // Dismissal now awaits main's result — settle the microtask queue.
      await Promise.resolve();
      await Promise.resolve();

      // The open click dismissed the card; a fresh completed update spawns a
      // new card which auto-dismisses after the timeout.
      expect(shelfEl.children).toHaveLength(0);
      updateHandler({
        id: 3,
        filename: 'done.pdf',
        state: 'completed',
        received_bytes: 10,
        total_bytes: 10,
      });
      expect(shelfEl.children).toHaveLength(1);
      jest.advanceTimersByTime(5000);
      expect(shelfEl.children).toHaveLength(0);
    });

    test('a failed Open keeps the card and surfaces the error', async () => {
      await loadModule();
      electronAPI.openDownloadedFile.mockResolvedValue({
        success: false,
        error: 'File no longer exists',
      });

      updateHandler({
        id: 7,
        filename: 'gone.iso',
        state: 'completed',
        received_bytes: 5,
        total_bytes: 5,
      });
      const card = shelfEl.children[0];
      card.querySelector('[data-test="download-open"]').dispatch('click');
      await Promise.resolve();
      await Promise.resolve();

      expect(shelfEl.children).toHaveLength(1);
      expect(card.querySelector('.download-card-status').textContent).toBe(
        'File no longer exists'
      );
    });

    test('failed downloads show their state and auto-dismiss', async () => {
      await loadModule();

      updateHandler({
        id: 4,
        filename: 'lost.bin',
        state: 'interrupted',
        received_bytes: 5,
        total_bytes: 100,
      });
      const card = shelfEl.children[0];
      expect(card.classList.contains('failed')).toBe(true);
      expect(card.querySelector('.download-card-status').textContent).toBe(
        'Failed — download interrupted'
      );
      jest.advanceTimersByTime(5000);
      expect(shelfEl.children).toHaveLength(0);
    });

    test('a live interrupted download swaps Cancel-only for Resume + Cancel', async () => {
      await loadModule();

      updateHandler({
        id: 5,
        filename: 'big.iso',
        state: 'in_progress',
        received_bytes: 400,
        total_bytes: 1000,
      });
      let card = shelfEl.children[0];
      expect(card.querySelector('[data-test="download-resume"]')).toBeNull();

      // Connection drops mid-transfer: still live, still resumable.
      updateHandler({
        id: 5,
        filename: 'big.iso',
        state: 'in_progress',
        is_interrupted: true,
        can_resume: true,
        received_bytes: 400,
        total_bytes: 1000,
      });
      card = shelfEl.children[0];
      expect(card.classList.contains('stalled')).toBe(true);
      expect(card.querySelector('.download-card-status').textContent).toBe(
        'Interrupted — 400 B of 1000 B'
      );
      const resumeBtn = card.querySelector('[data-test="download-resume"]');
      expect(resumeBtn).toBeTruthy();
      resumeBtn.dispatch('click');
      expect(electronAPI.resumeDownload).toHaveBeenCalledWith(5);

      // Still live, so the card must not auto-dismiss.
      jest.advanceTimersByTime(5000);
      expect(shelfEl.children).toHaveLength(1);

      // Back to progressing → Resume goes away again.
      updateHandler({
        id: 5,
        filename: 'big.iso',
        state: 'in_progress',
        received_bytes: 600,
        total_bytes: 1000,
      });
      card = shelfEl.children[0];
      expect(card.classList.contains('stalled')).toBe(false);
      expect(card.querySelector('[data-test="download-resume"]')).toBeNull();
      expect(card.querySelector('[data-test="download-cancel"]')).toBeTruthy();
    });

    test('missing shelf container disables the module without throwing', async () => {
      await loadModule({ withShelf: false });
      expect(electronAPI.onDownloadUpdated).not.toHaveBeenCalled();
    });
  });
});
