/**
 * Tests for what the recovery phrase screen shows, and that it doesn't stay in
 * the page once the screen is gone.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const WORDS = 'abandon about';
const PASSPHRASE = '<b>25th</b> ';

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const loadScreen = async (exported, { touchId = false, beforeOpen } = {}) => {
  jest.resetModules();

  const hidden = () => createElement('div', { classes: ['hidden'] });
  const elements = {
    'sidebar-export-mnemonic': hidden(),
    'export-unlock-required': hidden(),
    'export-mnemonic-display': hidden(),
    'export-touchid-btn': createElement('button'),
    'export-password-section': hidden(),
    'sidebar-export-mnemonic-btn': createElement('button'),
    'export-mnemonic-back': createElement('button'),
    'export-password-submit': createElement('button'),
    'export-password-input': createElement('input'),
    'export-unlock-error': hidden(),
    'copy-mnemonic-btn': createElement('button'),
    'mnemonic-words': createElement('div'),
    'export-passphrase': hidden(),
    'export-passphrase-value': createElement('code'),
    'export-passphrase-note': createElement('p'),
  };

  global.window = {
    identity: {
      unlock: jest.fn(async () => ({ success: true })),
      lock: jest.fn(async () => ({ success: true })),
      exportMnemonic: jest.fn(() => exported),
      getVaultMeta: jest.fn(async () => ({ userKnowsPassword: true })),
    },
    quickUnlock: {
      canUseTouchId: jest.fn(async () => touchId),
      isEnabled: jest.fn(async () => touchId),
      exportMnemonic: jest.fn(() => exported),
    },
    electronAPI: { copyText: jest.fn(async () => {}) },
  };
  global.document = createDocument({ elementsById: elements });

  const { hideAllSubscreens } = await import('./wallet-state.js');
  const { initExportMnemonic } = await import('./export-mnemonic.js');
  initExportMnemonic(jest.fn());
  beforeOpen?.();

  elements['sidebar-export-mnemonic-btn'].dispatch('click');
  await flushMicrotasks();

  const revealWithPassword = async () => {
    elements['export-password-input'].value = 'vault password';
    elements['export-password-submit'].dispatch('click');
    await flushMicrotasks();
  };

  return { elements, hideAllSubscreens, revealWithPassword };
};

const expectNothingShown = async (elements) => {
  expect(elements['mnemonic-words'].innerHTML).toBe('');
  expect(elements['export-passphrase-value'].textContent).toBe('');
  expect(elements['export-passphrase-note'].textContent).toBe('');
  expect(elements['export-passphrase'].classList.contains('hidden')).toBe(true);

  elements['copy-mnemonic-btn'].dispatch('click');
  await flushMicrotasks();
  expect(global.window.electronAPI.copyText).not.toHaveBeenCalled();
};

describe('recovery phrase screen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.window = originalWindow;
    global.document = originalDocument;
  });

  test('shows the passphrase next to the words, as text', async () => {
    const { elements, revealWithPassword } = await loadScreen({
      success: true,
      mnemonic: WORDS,
      passphrase: PASSPHRASE,
    });

    await revealWithPassword();

    expect(elements['mnemonic-words'].children).toHaveLength(2);
    expect(elements['export-passphrase'].classList.contains('hidden')).toBe(false);
    expect(elements['export-passphrase-value'].textContent).toBe(PASSPHRASE);
    expect(elements['export-passphrase-value'].innerHTML).toBe('');
    expect(elements['export-passphrase-note'].textContent).toContain('different, empty wallet');
    expect(elements['export-passphrase-note'].textContent).toContain('starts or ends with a space');
  });

  test('Touch ID shows the passphrase too', async () => {
    const { elements } = await loadScreen({
      success: true,
      mnemonic: WORDS,
      passphrase: PASSPHRASE,
    });

    elements['export-touchid-btn'].dispatch('click');
    await flushMicrotasks();

    expect(elements['export-passphrase-value'].textContent).toBe(PASSPHRASE);
  });

  test('shows no passphrase for a seed without one', async () => {
    const { elements, revealWithPassword } = await loadScreen({
      success: true,
      mnemonic: WORDS,
      passphrase: '',
    });

    await revealWithPassword();

    expect(elements['mnemonic-words'].children).toHaveLength(2);
    expect(elements['export-passphrase'].classList.contains('hidden')).toBe(true);
  });

  test('Copy copies the words only', async () => {
    const { elements, revealWithPassword } = await loadScreen({
      success: true,
      mnemonic: WORDS,
      passphrase: PASSPHRASE,
    });

    await revealWithPassword();
    elements['copy-mnemonic-btn'].dispatch('click');
    await flushMicrotasks();

    expect(global.window.electronAPI.copyText).toHaveBeenCalledWith(WORDS);
  });

  test('Back clears the words and passphrase', async () => {
    const { elements, revealWithPassword } = await loadScreen({
      success: true,
      mnemonic: WORDS,
      passphrase: PASSPHRASE,
    });

    await revealWithPassword();
    elements['export-mnemonic-back'].dispatch('click');
    await flushMicrotasks();

    await expectNothingShown(elements);
  });

  test('another screen taking over the sidebar clears them too', async () => {
    const { elements, hideAllSubscreens, revealWithPassword } = await loadScreen({
      success: true,
      mnemonic: WORDS,
      passphrase: PASSPHRASE,
    });

    await revealWithPassword();
    hideAllSubscreens();

    expect(elements['sidebar-export-mnemonic'].classList.contains('hidden')).toBe(true);
    await expectNothingShown(elements);
  });

  describe('the automatic Touch ID prompt', () => {
    const REVEALED = { success: true, mnemonic: WORDS, passphrase: PASSPHRASE };

    test('reveals the words and passphrase when the screen is still open', async () => {
      const { elements } = await loadScreen(REVEALED, { touchId: true });

      jest.advanceTimersByTime(200);
      await flushMicrotasks();

      expect(elements['export-passphrase-value'].textContent).toBe(PASSPHRASE);
    });

    test('never starts if another screen takes over first', async () => {
      const { elements, hideAllSubscreens } = await loadScreen(REVEALED, { touchId: true });

      hideAllSubscreens();
      jest.advanceTimersByTime(200);
      await flushMicrotasks();

      expect(global.window.quickUnlock.exportMnemonic).not.toHaveBeenCalled();
      await expectNothingShown(elements);
    });

    test('never starts if the takeover comes while the screen is still setting up', async () => {
      const setup = deferred();
      const { elements, hideAllSubscreens } = await loadScreen(REVEALED, {
        touchId: true,
        beforeOpen: () => {
          global.window.quickUnlock.canUseTouchId = jest.fn(() => setup.promise);
        },
      });

      hideAllSubscreens();
      setup.resolve(true);
      await flushMicrotasks();
      jest.advanceTimersByTime(200);
      await flushMicrotasks();

      expect(global.window.quickUnlock.exportMnemonic).not.toHaveBeenCalled();
      await expectNothingShown(elements);
    });
  });

  describe('a reveal still on its way when the screen goes', () => {
    const REVEALED = { success: true, mnemonic: WORDS, passphrase: PASSPHRASE };

    test('does not fill it back in after a takeover', async () => {
      const pending = deferred();
      const { elements, hideAllSubscreens, revealWithPassword } = await loadScreen(pending.promise);

      await revealWithPassword();
      hideAllSubscreens();
      pending.resolve(REVEALED);
      await flushMicrotasks();

      await expectNothingShown(elements);
    });

    test('does not fill it back in after Back', async () => {
      const pending = deferred();
      const { elements, revealWithPassword } = await loadScreen(pending.promise);

      await revealWithPassword();
      elements['export-mnemonic-back'].dispatch('click');
      await flushMicrotasks();
      pending.resolve(REVEALED);
      await flushMicrotasks();

      await expectNothingShown(elements);
    });

    test('does not appear on the unlock view after reopening', async () => {
      const pending = deferred();
      const { elements, hideAllSubscreens } = await loadScreen(pending.promise);

      elements['export-touchid-btn'].dispatch('click');
      await flushMicrotasks();
      hideAllSubscreens();
      elements['sidebar-export-mnemonic-btn'].dispatch('click');
      await flushMicrotasks();
      pending.resolve(REVEALED);
      await flushMicrotasks();

      await expectNothingShown(elements);
    });
  });
});
