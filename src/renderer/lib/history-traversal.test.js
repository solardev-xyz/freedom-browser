// The request total the gateway offer (#70) reads: it only goes up, so a
// commit spending a mark or a shell navigation clearing them cannot make a
// Back already asked for look like it never happened.
import {
  goBackInHistory,
  goForwardInHistory,
  consumeHistoryTraversal,
  clearHistoryTraversal,
  historyTraversalRequestCount,
} from './history-traversal.js';

const fakeWebview = () => ({
  canGoBack: () => true,
  canGoForward: () => true,
  goBack: jest.fn(),
  goForward: jest.fn(),
});

describe('historyTraversalRequestCount', () => {
  test('counts every request and is not lowered by consume or clear', () => {
    const wv = fakeWebview();
    expect(historyTraversalRequestCount(wv)).toBe(0);
    goBackInHistory(wv);
    goForwardInHistory(wv);
    expect(historyTraversalRequestCount(wv)).toBe(2);
    expect(consumeHistoryTraversal(wv)).toBe(true);
    clearHistoryTraversal(wv);
    expect(consumeHistoryTraversal(wv)).toBe(false);
    expect(historyTraversalRequestCount(wv)).toBe(2);
    goBackInHistory(wv);
    expect(historyTraversalRequestCount(wv)).toBe(3);
  });

  test('a refused traversal is not counted, and webviews are separate', () => {
    const wv = { ...fakeWebview(), canGoBack: () => false };
    expect(goBackInHistory(wv)).toBe(false);
    expect(historyTraversalRequestCount(wv)).toBe(0);
    expect(historyTraversalRequestCount(null)).toBe(0);
    goForwardInHistory(wv);
    expect(historyTraversalRequestCount(fakeWebview())).toBe(0);
  });
});
