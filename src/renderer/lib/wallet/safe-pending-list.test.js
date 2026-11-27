jest.mock('./wallet-state.js', () => ({ walletState: {}, registerScreenHider: () => {} }));
jest.mock('./wallet-utils.js', () => ({
  escapeHtml: (s) => s,
  walletRecord: () => null,
  timeAgo: () => '',
}));
jest.mock('./safe-signing.js', () => ({ openSafeSigningBoard: () => {}, summaryLine: () => '' }));

describe('storeNoticeMessage (#1068: the user is told about the pending store)', () => {
  let storeNoticeMessage;
  beforeEach(async () => {
    ({ storeNoticeMessage } = await import('./safe-pending-list.js'));
  });

  test('an unreadable store shows its message instead of hiding the row silently', () => {
    expect(
      storeNoticeMessage({
        success: false,
        code: 'SAFE_PENDING_UNREADABLE',
        error: 'could not be read',
      })
    ).toBe('could not be read');
  });

  test('a damaged store set aside shows where the copy went', () => {
    expect(
      storeNoticeMessage({ success: true, states: [], storeNotice: { message: 'set aside as X' } })
    ).toBe('set aside as X');
  });

  test('nothing to say otherwise', () => {
    expect(storeNoticeMessage({ success: true, states: [], storeNotice: null })).toBeNull();
    expect(storeNoticeMessage({ success: false, error: 'other' })).toBeNull();
    expect(storeNoticeMessage(undefined)).toBeNull();
  });
});
