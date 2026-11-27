/**
 * The hash-only warning over a tab (ledger-hash-only-notice.js; freedom-core
 * design 0016, Q23; LDG-3's PR 11): what it shows, the hashes as the
 * Ethereum app shows them, its report after two animation frames in a
 * visible window with the notice laid out, its Cancel (the LDG-3 plan's
 * point 19), and its copy, which is the approvals document's.
 */

const kinds = require('../../approvals/approvals-kinds.js');

const ID = 'ab'.repeat(16);
const DOMAIN = '0x' + '1a'.repeat(31) + 'ef';
const STRUCT = '0x' + '2b'.repeat(31) + 'cd';
const NOTICE = { id: ID, site: 'https://dapp.example', domainSeparator: DOMAIN, structHash: STRUCT };

const IDS = [
  'ledger-hash-only-notice',
  'ledger-hash-only-title',
  'ledger-hash-only-site',
  'ledger-hash-only-body',
  'ledger-hash-only-domain-label',
  'ledger-hash-only-domain',
  'ledger-hash-only-message-label',
  'ledger-hash-only-message',
  'ledger-hash-only-cancel',
];

function element() {
  const listeners = {};
  return {
    hidden: true,
    disabled: false,
    textContent: '',
    laidOut: true,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    click() {
      listeners.click?.();
    },
    checkVisibility() {
      return !this.hidden && this.laidOut;
    },
  };
}

async function load() {
  jest.resetModules();
  const els = Object.fromEntries(IDS.map((id) => [id, element()]));
  const frames = [];
  let listener = null;
  const api = {
    onHashOnlyNotice: jest.fn((fn) => {
      listener = fn;
    }),
    hashOnlyNoticeShown: jest.fn(),
    cancelHashOnlyNotice: jest.fn(),
  };
  global.document = { getElementById: (id) => els[id] ?? null, visibilityState: 'visible' };
  global.window = {
    ledger: api,
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: (handle) => {
      frames[handle - 1] = null;
    },
  };
  const mod = await import('./ledger-hash-only-notice.js');
  expect(mod.initLedgerHashOnlyNotice()).toBe(true);
  // Runs the frames requested so far, one turn of painting.
  const paint = () => {
    const due = frames.splice(0, frames.length);
    for (const fn of due) fn?.();
  };
  return { mod, els, api, paint, send: (message) => listener(message) };
}

afterEach(() => {
  delete global.window;
  delete global.document;
});

describe('the notice over a tab', () => {
  test('shows the copy, the site and the two hashes as the device shows them; reported after two frames', async () => {
    const { els, api, paint, send } = await load();
    expect(els['ledger-hash-only-title'].textContent).toBe("This Ledger can't show the request's details");
    expect(els['ledger-hash-only-body'].textContent).toBe(
      'It will show only two hashes, not what you are signing. Check that they match the ones below, ' +
        'and approve on the Ledger only if you trust this request.'
    );
    expect(els['ledger-hash-only-domain-label'].textContent).toBe('Domain hash');
    expect(els['ledger-hash-only-message-label'].textContent).toBe('Message hash');
    send(NOTICE);
    expect(els['ledger-hash-only-notice'].hidden).toBe(false);
    expect(els['ledger-hash-only-site'].textContent).toBe('From https://dapp.example');
    expect(els['ledger-hash-only-site'].hidden).toBe(false);
    expect(els['ledger-hash-only-domain'].textContent).toBe('0x' + '1A'.repeat(31) + 'EF');
    expect(els['ledger-hash-only-message'].textContent).toBe('0x' + '2B'.repeat(31) + 'CD');
    paint();
    expect(api.hashOnlyNoticeShown).not.toHaveBeenCalled();
    paint();
    expect(api.hashOnlyNoticeShown).toHaveBeenCalledWith(ID);
  });

  test('a hidden window, or a notice with no box, is not reported', async () => {
    const hidden = await load();
    global.document.visibilityState = 'hidden';
    hidden.send(NOTICE);
    hidden.paint();
    hidden.paint();
    expect(hidden.api.hashOnlyNoticeShown).not.toHaveBeenCalled();
    const boxless = await load();
    boxless.els['ledger-hash-only-notice'].laidOut = false;
    boxless.send(NOTICE);
    boxless.paint();
    boxless.paint();
    expect(boxless.api.hashOnlyNoticeShown).not.toHaveBeenCalled();
  });

  test('taken down when main says the operation ended, before it painted: no report', async () => {
    const { els, api, paint, send } = await load();
    send(NOTICE);
    paint();
    send({ id: 'cd'.repeat(16), closed: true });
    expect(els['ledger-hash-only-notice'].hidden).toBe(false);
    send({ id: ID, closed: true });
    expect(els['ledger-hash-only-notice'].hidden).toBe(true);
    expect(els['ledger-hash-only-domain'].textContent).toBe('');
    paint();
    expect(api.hashOnlyNoticeShown).not.toHaveBeenCalled();
  });

  test("its Cancel (point 19) cancels the request it shows, once", async () => {
    const { els, api, send } = await load();
    els['ledger-hash-only-cancel'].click();
    expect(api.cancelHashOnlyNotice).not.toHaveBeenCalled();
    send(NOTICE);
    els['ledger-hash-only-cancel'].click();
    expect(api.cancelHashOnlyNotice).toHaveBeenCalledWith(ID);
    expect(els['ledger-hash-only-cancel'].disabled).toBe(true);
  });

  test('a message off its shape shows nothing', async () => {
    const { mod, els, send } = await load();
    for (const bad of [
      null,
      [],
      { ...NOTICE, id: 'AB'.repeat(16) },
      { ...NOTICE, id: 'ab' },
      { ...NOTICE, domainSeparator: DOMAIN.toUpperCase() },
      { ...NOTICE, structHash: '0x12' },
      { ...NOTICE, domainSeparator: 7 },
    ]) {
      expect(mod.checkNotice(bad)).toBeNull();
      send(bad);
    }
    expect(els['ledger-hash-only-notice'].hidden).toBe(true);
    expect(mod.checkNotice({ ...NOTICE, site: null })).toMatchObject({ site: null, closed: false });
  });

  test("its copy and hash format are the approvals document's", async () => {
    const { mod } = await load();
    expect(mod.HASH_ONLY_COPY).toEqual(kinds.HASH_ONLY_COPY);
    expect(mod.deviceHash(DOMAIN)).toBe(kinds.deviceHash(DOMAIN));
  });
});

describe("the approvals document's hash-only message", () => {
  const HANDLE = 'f'.repeat(64);
  test('checked: a warning to show, or one to take down; anything else is nothing', () => {
    const shown = { handle: HANDLE, warning: 3, domainSeparator: DOMAIN, structHash: STRUCT };
    expect(kinds.checkHashOnly(shown)).toEqual(shown);
    expect(kinds.checkHashOnly({ handle: HANDLE, warning: null })).toEqual({ handle: HANDLE, warning: null });
    for (const bad of [
      null,
      { ...shown, handle: 'F'.repeat(64) },
      { ...shown, warning: 0 },
      { ...shown, warning: '3' },
      { ...shown, domainSeparator: DOMAIN.toUpperCase() },
      { ...shown, structHash: undefined },
      { ...shown, extra: 1 },
      { handle: HANDLE, warning: null, extra: 1 },
    ]) {
      expect(kinds.checkHashOnly(bad)).toBeNull();
    }
    expect(kinds.deviceHash(DOMAIN)).toBe('0x' + '1A'.repeat(31) + 'EF');
  });
});
