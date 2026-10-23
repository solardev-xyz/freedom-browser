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

test("no verdict at all (main unreachable): the most it can cost, and couldn't compare", async () => {
  window.wallet.feeCheck.mockRejectedValue(new Error('gone'));
  const { elements, confirmation } = screen();
  const verdict = await confirmation.load({
    chainId: 1,
    gasLimit: '21000',
    gasPrice: '1000000000',
  });
  expect(verdict).toMatchObject({ maxCost: '21000000000000', comparable: false, above: false });
  expect(elements.maxEl.textContent).toBe('Up to 0.000021 ETH');
  expect(elements.noteEl.textContent).toBe("Couldn't compare this fee with today's network fee");
  expect(shown(elements.warningEl)).toBe(false);
  // Main still judges the fee at the press.
  expect(confirmation.proceed()).toBe(true);
  // Fields it can't price show only that the fee couldn't be compared.
  window.wallet.feeCheck.mockResolvedValue({ success: false, error: 'no' });
  await confirmation.load({ chainId: 1 });
  expect(shown(elements.maxEl)).toBe(false);
  expect(elements.noteEl.textContent).toBe("Couldn't compare this fee with today's network fee");
});

// Review of #794, round 1: nothing is confirmed before the verdict is shown.
test('a pending or missing verdict never lets Confirm go on', async () => {
  let answer;
  window.wallet.feeCheck.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  const { elements, confirmation } = screen();
  // No check asked for yet.
  expect(confirmation.pending()).toBe(false);
  expect(confirmation.proceed()).toBe(false);
  const loading = confirmation.load({ chainId: 1, gasLimit: '21000', gasPrice: '1' });
  expect(confirmation.pending()).toBe(true);
  expect(confirmation.proceed()).toBe(false);
  expect(Object.values(elements).filter(shown)).toEqual([]);
  answer({ success: true, feeCheck: VERDICT });
  await loading;
  expect(confirmation.pending()).toBe(false);
  expect(confirmation.proceed()).toBe(true);
  confirmation.reset();
  expect(confirmation.proceed()).toBe(false);
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

test('a verdict in lines: the most it can cost, then how it compares', () => {
  expect(feeCheck.describeFeeCheck(VERDICT, 'xDAI')).toEqual([
    'Up to 0.001050001 xDAI',
    "About 1.2× today's network fee",
  ]);
  expect(feeCheck.describeFeeCheck({ ...VERDICT, comparable: false, ratio: null }, 'xDAI')).toEqual(
    ['Up to 0.001050001 xDAI', "Couldn't compare this fee with today's network fee"]
  );
  expect(feeCheck.describeFeeCheck({ ...VERDICT, ratio: '20', above: true }, 'xDAI')).toEqual([
    'Up to 0.001050001 xDAI',
    "This network fee is 20× today's network fee",
  ]);
  expect(feeCheck.describeFeeCheck(null)).toEqual([]);
});

// A Safe's execution or activation that main stopped for its fee: the user
// confirms exactly the transaction main offered, and main takes back that
// fee with the confirmation.
describe('confirming a fee main stopped its own transaction for', () => {
  const OFFER = {
    executorIndex: 0,
    chainId: 100,
    to: '0x41aD4887971f90BB3fE4d83eCa65177281283261',
    value: '0',
    data: '0x6a761202',
    gasLimit: '150000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
  };

  beforeEach(() => {
    window.wallet.confirmSigning = jest.fn(async () => ({ success: true, token: 'token-1' }));
  });

  test('the offered transaction is confirmed, and its fee goes back with the token', async () => {
    await expect(feeCheck.confirmOfferedFee(OFFER, VERDICT)).resolves.toEqual({
      confirmation: 'token-1',
      gasLimit: '150000',
      fees: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' },
    });
    const { executorIndex: _executor, ...payload } = OFFER;
    expect(window.wallet.confirmSigning).toHaveBeenCalledWith('executor-send', 0, payload);
  });

  test('a legacy fee, and a fee shown above the threshold', async () => {
    const { maxFeePerGas: _max, maxPriorityFeePerGas: _tip, ...rest } = OFFER;
    const legacy = { ...rest, gasPrice: '5000000000' };
    const confirmed = await feeCheck.confirmOfferedFee(legacy, { ...VERDICT, above: true });
    expect(confirmed.fees).toEqual({ gasPrice: '5000000000' });
    expect(window.wallet.confirmSigning).toHaveBeenCalledWith(
      'executor-send',
      0,
      expect.objectContaining({ gasPrice: '5000000000' }),
      { feeAcknowledged: true }
    );
  });

  test("main's ask-again reaches the screen with its verdict", async () => {
    window.wallet.confirmSigning.mockResolvedValueOnce({
      success: false,
      code: feeCheck.FEE_CHECK_ASK_AGAIN,
      error: 'again',
      feeCheck: { ...VERDICT, above: true },
    });
    await expect(feeCheck.confirmOfferedFee(OFFER, VERDICT)).rejects.toMatchObject({
      code: feeCheck.FEE_CHECK_ASK_AGAIN,
      feeCheck: { ...VERDICT, above: true },
    });
  });
});
