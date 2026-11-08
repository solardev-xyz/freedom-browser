// What the account list screens say (#1037). The screens themselves are
// covered end to end in test-e2e/wallet-account-list.spec.js.

jest.mock('./wallet-state.js', () => ({ walletState: {}, registerScreenHider: jest.fn() }));
jest.mock('./signature-flight.js', () => ({ refuseSubscreenWhileInFlight: jest.fn(() => false) }));
jest.mock('./wallet-selector.js', () => ({ loadDerivedWallets: jest.fn() }));

import { joinNames, typeLabel, rowNote, importSummary, importResult } from './account-list.js';

const PHONE = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';

test('joinNames', () => {
  expect(joinNames(['A'])).toBe('A');
  expect(joinNames(['A', 'B'])).toBe('A and B');
  expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
});

test('typeLabel', () => {
  expect(typeLabel({ type: 'mnemonic' })).toBe('Software wallet');
  expect(typeLabel({ type: 'ledger' })).toBe('Ledger');
  expect(typeLabel({ type: 'remote' })).toBe('Phone');
  expect(typeLabel({ type: 'safe', threshold: 2, ownerCount: 3 })).toBe('Safe · 2 of 3');
  expect(typeLabel({ type: 'safe' })).toBe('Safe');
});

describe('rowNote', () => {
  test('tells how to bring back an account that needs a device or owners', () => {
    expect(rowNote({ kind: 'skip', reason: 'ledger' })).toBe(
      'Connect this Ledger and add its account, then import again to restore the name.'
    );
    expect(rowNote({ kind: 'skip', reason: 'remote' })).toBe(
      'Pair this phone and add its account, then import again to restore the name.'
    );
    expect(
      rowNote({
        kind: 'skip',
        reason: 'owners',
        missingOwners: [
          { name: 'Nano X', address: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720' },
          { name: null, address: PHONE },
        ],
      })
    ).toBe('Needs owners Nano X and 0xBcd4…4096. Add them, then import again.');
    expect(
      rowNote({
        kind: 'skip',
        reason: 'owners-locked',
        missingOwners: [{ name: 'Trading', address: PHONE }],
      })
    ).toBe('Needs owner Trading, which can be added once you unlock.');
  });

  test('says why a Safe was checked or refused', () => {
    expect(
      rowNote({ kind: 'add', type: 'safe', ownerNames: ['Main Wallet', 'Cold storage'] })
    ).toBe('Owners Main Wallet and Cold storage are here, and the Safe address checks out.');
    expect(rowNote({ kind: 'skip', reason: 'safe-mismatch' })).toMatch("doesn't match its owners");
    expect(rowNote({ kind: 'skip', reason: 'safe-unchecked' })).toMatch('Check your connection');
  });

  test('nothing to say about a plain rename or addition', () => {
    expect(rowNote({ kind: 'rename' })).toBe('');
    expect(rowNote({ kind: 'add', type: 'mnemonic' })).toBe('');
  });
});

test('importSummary counts what changes and promises nothing is deleted', () => {
  const rows = [
    { kind: 'rename' },
    { kind: 'rename' },
    { kind: 'add' },
    { kind: 'skip', reason: 'ledger' },
    { kind: 'same' },
  ];
  expect(importSummary(rows)).toBe('2 renamed, 1 added. Nothing is deleted.');
  expect(importSummary([{ kind: 'add' }])).toBe('1 added. Nothing is deleted.');
  expect(importSummary([{ kind: 'same' }])).toBe('Nothing to change.');
});

describe('importResult', () => {
  test('reports what was done and how to get the rest', () => {
    expect(
      importResult([
        { kind: 'rename' },
        { kind: 'rename' },
        { kind: 'add' },
        { kind: 'add' },
        { kind: 'skip', reason: 'ledger' },
        { kind: 'skip', reason: 'not-from-seed' },
      ])
    ).toEqual({
      done: 'Renamed 2 and added 2 accounts.',
      left: "2 weren't added. Add the missing Ledger, phone or owners, then import the same file again to restore their names.",
    });
  });

  test("doesn't suggest adding devices when none would help", () => {
    expect(importResult([{ kind: 'add' }, { kind: 'skip', reason: 'not-from-seed' }])).toEqual({
      done: 'Added 1 account.',
      left: "1 wasn't added.",
    });
  });

  test('a rename alone, and nothing at all', () => {
    expect(importResult([{ kind: 'rename' }]).done).toBe('Renamed 1 account.');
    expect(importResult([{ kind: 'same' }])).toEqual({ done: 'Nothing was changed.', left: '' });
  });
});

describe('the account list screens', () => {
  const {
    FakeElement,
    createDocument,
    createElement,
  } = require('../../../../test/helpers/fake-dom.js');
  const originalWindow = global.window;
  const originalDocument = global.document;

  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  const IDS = [
    'sidebar-export-accounts',
    'export-accounts-list',
    'export-accounts-save',
    'export-accounts-done',
    'export-accounts-finish',
    'export-accounts-error',
    'export-accounts-rows',
    'export-accounts-intro',
    'sidebar-export-accounts-btn',
    'export-accounts-back',
    'sidebar-import-accounts',
    'sidebar-import-accounts-btn',
    'import-accounts-back',
    'import-accounts-loading',
    'import-accounts-invalid',
    'import-accounts-invalid-text',
    'import-accounts-preview',
    'import-accounts-file',
    'import-accounts-unlock',
    'import-accounts-unlock-text',
    'import-accounts-touchid-btn',
    'import-accounts-password-section',
    'import-accounts-password',
    'import-accounts-password-submit',
    'import-accounts-unlock-error',
    'import-accounts-groups',
    'import-accounts-error',
    'import-accounts-done',
    'import-accounts-done-text',
    'import-accounts-done-left',
    'import-accounts-footer',
    'import-accounts-summary',
    'import-accounts-cancel',
    'import-accounts-submit',
    'import-accounts-choose',
    'import-accounts-finish',
  ];

  // A file with one rename and one account waiting for the vault.
  const ROWS = [
    { kind: 'rename', name: 'Savings', from: 'Wallet 2', address: PHONE, type: 'mnemonic' },
    { kind: 'skip', reason: 'locked', name: 'Trading', address: PHONE, type: 'mnemonic' },
  ];

  async function load({ unlock = jest.fn(), wallet = {} } = {}) {
    jest.resetModules();
    // The rows are built with append and text nodes, which the shared fake
    // DOM doesn't have.
    FakeElement.prototype.append = function append(...nodes) {
      nodes.forEach((node) => this.appendChild(node));
    };
    const elements = Object.fromEntries(
      IDS.map((id) => [
        id,
        createElement(id.endsWith('btn') || id.includes('-submit') ? 'button' : 'div', {
          classes: ['hidden'],
        }),
      ])
    );
    const document = createDocument({ elementsById: elements });
    document.createTextNode = (text) => createElement('#text', { textContent: text });
    global.document = document;
    global.window = {
      wallet: {
        openAccountList: jest.fn(async () => ({
          success: true,
          token: 'T',
          fileName: 'list.json',
          count: 2,
        })),
        previewAccountListImport: jest.fn(async () => ({ success: true, rows: ROWS })),
        importAccountList: jest.fn(async () => ({ success: true, rows: [ROWS[0], ROWS[1]] })),
        getDerivedWallets: jest.fn(async () => ({
          success: true,
          wallets: [{ index: 0, name: 'Main Wallet', address: PHONE, type: 'mnemonic' }],
        })),
        ...wallet,
      },
      identity: { unlock, getVaultMeta: jest.fn(async () => ({ userKnowsPassword: true })) },
      quickUnlock: {
        canUseTouchId: jest.fn(async () => false),
        isEnabled: jest.fn(async () => false),
      },
    };

    const { registerScreenHider } = await import('./wallet-state.js');
    const screens = await import('./account-list.js');
    screens.initAccountList(jest.fn());
    const hidden = (id) => elements[id].classList.contains('hidden');
    const [hider] = registerScreenHider.mock.calls.at(-1);
    return { elements, hidden, hider, screens };
  }

  async function openPreview(options) {
    const loaded = await load(options);
    loaded.elements['sidebar-import-accounts-btn'].dispatch('click');
    await flush();
    return loaded;
  }

  afterEach(() => {
    delete FakeElement.prototype.append;
    global.window = originalWindow;
    global.document = originalDocument;
  });

  test('a screen taking over the sidebar clears the typed password', async () => {
    const { elements, hidden, hider } = await openPreview({ unlock: jest.fn() });
    expect(hidden('import-accounts-preview')).toBe(false);
    elements['import-accounts-password'].value = 'vault password';

    hider();

    expect(hidden('sidebar-import-accounts')).toBe(true);
    expect(elements['import-accounts-password'].value).toBe('');
    expect(elements['import-accounts-groups'].children).toHaveLength(0);
  });

  test('an unlock that finishes after Import does not replace the result', async () => {
    const unlocking = deferred();
    const { elements, hidden } = await openPreview({ unlock: jest.fn(() => unlocking.promise) });

    elements['import-accounts-password'].value = 'vault password';
    elements['import-accounts-password-submit'].dispatch('click');
    elements['import-accounts-submit'].dispatch('click');
    await flush();
    expect(hidden('import-accounts-done')).toBe(false);

    unlocking.resolve({ success: true });
    await flush();

    expect(hidden('import-accounts-done')).toBe(false);
    expect(hidden('import-accounts-invalid')).toBe(true);
    expect(global.window.wallet.previewAccountListImport).toHaveBeenCalledTimes(1);
  });

  test('a file still being read when the tab changes does not open over it', async () => {
    const reading = deferred();
    const { elements, hidden, screens } = await load({
      wallet: { openAccountList: jest.fn(() => reading.promise) },
    });
    elements['sidebar-import-accounts-btn'].dispatch('click');
    // What switching tabs does, while the screen isn't shown yet.
    screens.closeImportAccounts();

    reading.resolve({ success: true, token: 'T', fileName: 'list.json', count: 2 });
    await flush();

    expect(hidden('sidebar-import-accounts')).toBe(true);
    expect(global.window.wallet.previewAccountListImport).not.toHaveBeenCalled();
  });

  test('a slow save does not land on the export screen opened again since', async () => {
    const saving = deferred();
    const { elements, hidden } = await load({
      wallet: { exportAccountList: jest.fn(() => saving.promise) },
    });
    elements['sidebar-export-accounts-btn'].dispatch('click');
    await flush();
    elements['export-accounts-save'].dispatch('click');
    elements['export-accounts-back'].dispatch('click');
    elements['sidebar-export-accounts-btn'].dispatch('click');
    await flush();

    saving.resolve({ success: true, count: 1, fileName: 'previous.json' });
    await flush();

    expect(hidden('export-accounts-list')).toBe(false);
    expect(hidden('export-accounts-done')).toBe(true);
    expect(elements['export-accounts-save'].disabled).toBe(false);
  });
});
