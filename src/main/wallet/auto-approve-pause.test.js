// D12: "Always allow" pauses for a site while one of its payments is in
// Payments waiting. The predicate, against the list main serves.

const mockWaiting = jest.fn();
jest.mock('./intent-ipc', () => ({ waitingIntents: () => mockWaiting() }));
jest.mock('../logger', () => ({ warn: jest.fn() }));

const { transactionAutoApprovePaused } = require('./auto-approve-pause');

const waiting = (origin, overrides = {}) => ({
  intentId: `intent-${origin}`,
  kind: origin ? 'dapp-send' : 'wallet-send',
  origin,
  receipt: null,
  ...overrides,
});

beforeEach(() => {
  mockWaiting.mockReset().mockResolvedValue([]);
});

describe('transactionAutoApprovePaused', () => {
  test("a site's payment in Payments waiting pauses that site only", async () => {
    mockWaiting.mockResolvedValue([waiting('https://swap.example')]);
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(true);
    await expect(transactionAutoApprovePaused('https://other.example')).resolves.toBe(false);
  });

  test('nothing waiting, or only payments no site requested: nothing paused', async () => {
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(false);
    mockWaiting.mockResolvedValue([waiting(null), waiting(undefined)]);
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(false);
  });

  test("sites compare as permission keys: the page's path and the name's case don't matter", async () => {
    mockWaiting.mockResolvedValue([waiting('https://swap.example'), waiting('vitalik.eth')]);
    await expect(transactionAutoApprovePaused('https://swap.example/trade')).resolves.toBe(true);
    await expect(transactionAutoApprovePaused('ens://VITALIK.ETH/#/app')).resolves.toBe(true);
    await expect(transactionAutoApprovePaused('https://swap.example.evil')).resolves.toBe(false);
  });

  test("records that can't be read pause it: asking is the safe reading", async () => {
    mockWaiting.mockRejectedValue(
      Object.assign(new Error("The wallet's payment records are not loaded."), {
        code: 'INTENT_STORE_UNAVAILABLE',
      })
    );
    await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(true);
  });

  test('no site, nothing to pause, and the records are not read', async () => {
    for (const origin of [undefined, null, '', 42]) {
      await expect(transactionAutoApprovePaused(origin)).resolves.toBe(false);
    }
    expect(mockWaiting).not.toHaveBeenCalled();
  });
});
