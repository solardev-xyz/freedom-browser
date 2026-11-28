/**
 * The unfinished Safe transactions' overview: on the core's Safe backend
 * (SAFE-3's PR 9) an entry started in an older version of Freedom, or whose
 * account changed outside Freedom, says so in its row; a state on js says
 * neither, and its row is as before.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const state = (safeIndex, overrides = {}) => ({
  safeIndex,
  safeTxHash: '0x' + String(safeIndex).repeat(64).slice(0, 64),
  collected: 1,
  threshold: 2,
  createdAt: '2026-07-12T00:00:00.000Z',
  display: { toAddress: '0xabc', amount: '1000', symbol: 'xDAI' },
  ...overrides,
});

async function loadList(states) {
  jest.resetModules();
  const listEl = createElement('div');
  const elementsById = {
    'safe-pending-row': createElement('div'),
    'safe-pending-count': createElement('span'),
    'sidebar-safe-pending': createElement('div', { classes: ['hidden'] }),
    'safe-pending-back': createElement('button'),
    'safe-pending-list': listEl,
  };
  global.document = createDocument({ elementsById });
  global.window = {
    wallet: { safePendingList: jest.fn(async () => ({ success: true, states })) },
    addEventListener: jest.fn(),
  };
  jest.doMock('./wallet-state.js', () => ({ walletState: { identityView: createElement('div') }, registerScreenHider: jest.fn() }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: (text) => String(text ?? ''),
    walletRecord: (index) => ({ name: `Account ${index}` }),
    timeAgo: () => 'Just now',
  }));
  const openSafeSigningBoard = jest.fn();
  jest.doMock('./safe-signing.js', () => ({ openSafeSigningBoard, summaryLine: () => 'sending 1000 xDAI to 0xabc' }));
  const mod = await import('./safe-pending-list.js');
  mod.initSafePendingList();
  return { mod, listEl, openSafeSigningBoard };
}

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

test("each row says when its board offers less: an older version's, or an account changed outside Freedom", async () => {
  const { mod, listEl } = await loadList([
    state(5, { older: true }),
    state(6, { older: true, setupChanged: ['owners'] }),
    state(7),
  ]);
  await mod.openSafePendingList();
  const rows = listEl.children.map((item) => item.innerHTML);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain('1 of 2 signatures');
  expect(rows[0]).toContain('started just now · from an older version of Freedom');
  expect(rows[1]).toContain('started just now · account changed outside Freedom');
  expect(rows[1]).not.toContain('older version');
  // A state on js: as before.
  expect(rows[2]).not.toContain('older version');
  expect(rows[2]).not.toContain('changed outside');
});

test('the note alone', async () => {
  const { mod } = await loadList([]);
  expect(mod.standingNote(state(5, { older: true }))).toBe(' · from an older version of Freedom');
  expect(mod.standingNote(state(5, { setupChanged: [] }))).toBe(' · account changed outside Freedom');
  expect(mod.standingNote(state(5))).toBe('');
  expect(mod.standingNote(state(5, { older: false }))).toBe('');
});
