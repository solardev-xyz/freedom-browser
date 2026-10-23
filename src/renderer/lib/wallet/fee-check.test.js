/**
 * The approval screens' fee check at confirmation (freedom-core design
 * 0005, A): what it shows of main's verdict, and how a fee above the
 * threshold is confirmed twice.
 */

const { createElement } = require('../../../../test/helpers/fake-dom');

const VERDICT = {
  maxCost: '1050000000000001',
  comparable: true,
  ratio: '1.2',
  above: false,
  oneEndpoint: false,
  basis: 'header',
  autoApprove: true,
};

let feeCheck;

beforeEach(async () => {
  global.window = {
    wallet: { feeCheck: jest.fn(async () => ({ success: true, feeCheck: VERDICT })) },
  };
  feeCheck = await import('./fee-check.js');
});

afterEach(() => {
  delete global.window;
});

function screen() {
  const elements = {
    maxEl: createElement('span'),
    noteEl: createElement('span'),
    warningEl: createElement('div'),
    warningTextEl: createElement('span'),
  };
  for (const element of Object.values(elements)) element.classList.add('hidden');
  return { elements, confirmation: new feeCheck.FeeConfirmation(elements) };
}

const shown = (element) => !element.classList.contains('hidden');

test('the most a payment can cost is rounded up at a gwei, never understated', () => {
  expect(feeCheck.formatMaxCost('1050000000000001')).toBe('0.001050001');
  expect(feeCheck.formatMaxCost('2000000000000000000')).toBe('2');
  expect(feeCheck.formatMaxCost('1')).toBe('0.000000001');
});

test('main is asked for the fields as they will be signed', async () => {
  const { confirmation } = screen();
  await confirmation.load(
    {
      chainId: 1,
      gasLimit: '21000',
      maxFeePerGas: '30',
      maxPriorityFeePerGas: '2',
      gasPrice: '9',
      to: '0x1',
    },
    'ETH'
  );
  expect(window.wallet.feeCheck).toHaveBeenLastCalledWith({
    chainId: 1,
    gasLimit: '21000',
    maxFeePerGas: '30',
    maxPriorityFeePerGas: '2',
  });
  await confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '9' }, 'ETH');
  expect(window.wallet.feeCheck).toHaveBeenLastCalledWith({
    chainId: 1,
    gasLimit: '21000',
    gasPrice: '9',
  });
});

test('a fee like today’s: the most it can cost, and how it compares', async () => {
  const { elements, confirmation } = screen();
  await confirmation.load({ chainId: 100, gasLimit: '21000', gasPrice: '50000000000' }, 'xDAI');
  expect(elements.maxEl.textContent).toBe('Up to 0.001050001 xDAI');
  expect(elements.noteEl.textContent).toBe("About 1.2× today's network fee");
  expect(shown(elements.maxEl) && shown(elements.noteEl)).toBe(true);
  expect(shown(elements.warningEl)).toBe(false);
  expect(confirmation.proceed()).toBe(true);
  expect(confirmation.options()).toBeUndefined();
  expect(confirmation.confirmLabel('Confirm')).toBe('Confirm');
});

test("one endpoint's reference says so", async () => {
  window.wallet.feeCheck.mockResolvedValue({
    success: true,
    feeCheck: { ...VERDICT, ratio: '1', oneEndpoint: true, autoApprove: false },
  });
  const { elements, confirmation } = screen();
  await confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '1' });
  expect(elements.noteEl.textContent).toBe(
    "About 1× today's network fee, as one network source reports it"
  );
});

test("no reference: the most it can cost, and that it couldn't be compared", async () => {
  window.wallet.feeCheck.mockResolvedValue({
    success: true,
    feeCheck: { ...VERDICT, comparable: false, ratio: null, autoApprove: false },
  });
  const { elements, confirmation } = screen();
  await confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '1' });
  expect(elements.maxEl.textContent).toBe('Up to 0.001050001 ETH');
  expect(elements.noteEl.textContent).toBe("Couldn't compare this fee with today's network fee");
  expect(confirmation.proceed()).toBe(true);
});

test('no verdict at all (main unreachable): nothing shown, main still judges at the press', async () => {
  window.wallet.feeCheck.mockRejectedValue(new Error('gone'));
  const { elements, confirmation } = screen();
  await expect(
    confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '1' })
  ).resolves.toBeNull();
  expect(Object.values(elements).filter(shown)).toEqual([]);
  expect(confirmation.proceed()).toBe(true);
});

test('above the threshold: warned, and asked again before anything is signed', async () => {
  window.wallet.feeCheck.mockResolvedValue({
    success: true,
    feeCheck: { ...VERDICT, ratio: '20', above: true, autoApprove: false },
  });
  const { elements, confirmation } = screen();
  await confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '1' });
  expect(shown(elements.warningEl)).toBe(true);
  expect(elements.warningTextEl.textContent).toBe("This network fee is 20× today's network fee.");
  expect(shown(elements.noteEl)).toBe(false);
  // The first press asks again.
  expect(confirmation.proceed()).toBe(false);
  expect(confirmation.confirmLabel('Confirm')).toBe('Send anyway');
  expect(elements.warningTextEl.textContent).toBe(
    "This network fee is 20× today's network fee. Check the fee, then press Send anyway to pay it."
  );
  // The second confirms it.
  expect(confirmation.proceed()).toBe(true);
  expect(confirmation.options()).toEqual({ feeAcknowledged: true });
  expect(confirmation.confirmLabel('Confirm')).toBe('Confirm');
});

test("main's ask-again at the press shows its verdict and asks", async () => {
  const { elements, confirmation } = screen();
  await confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '1' });
  expect(confirmation.proceed()).toBe(true);
  expect(confirmation.askAgain(new Error('other'))).toBe(false);
  const asked = Object.assign(new Error('again'), {
    code: feeCheck.FEE_CHECK_ASK_AGAIN,
    feeCheck: { ...VERDICT, ratio: '4', above: true, autoApprove: false },
  });
  expect(confirmation.askAgain(asked)).toBe(true);
  expect(elements.warningTextEl.textContent).toBe(
    "This network fee is 4× today's network fee. Check the fee, then press Send anyway to pay it."
  );
  expect(confirmation.confirmLabel('Confirm')).toBe('Send anyway');
  expect(confirmation.proceed()).toBe(true);
  expect(confirmation.options()).toEqual({ feeAcknowledged: true });
});

test('an answer for an earlier transaction is dropped, and reset clears everything', async () => {
  let answer;
  window.wallet.feeCheck.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  const { elements, confirmation } = screen();
  const first = confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '1' });
  await confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '2' });
  answer({ success: true, feeCheck: { ...VERDICT, ratio: '20', above: true } });
  await first;
  expect(shown(elements.warningEl)).toBe(false);
  confirmation.reset();
  expect(Object.values(elements).filter(shown)).toEqual([]);
});
