/**
 * A page's device steps on the core's Ledger backend (freedom-core design
 * 0016, "Deadlines, cancel and unplugging", deviation `cancel`; LDG-3's PR
 * 10): a Ledger's signature (page-devices.js) and send (page-core-sends.js)
 * say they can be cancelled as they start (`context.deviceWait()`) and sign
 * with the request's `signal`, which main's Reject aborts by answering the
 * request (page-requests.js `cancelIn`). The signer's LEDGER_CANCELLED is
 * the page's 4001. On the JS backend, and for a phone, neither happens: the
 * step is as before.
 */

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { createDeviceSigning } = require('./page-devices');
const { createCoreSends } = require('./page-core-sends');

const LEDGER = 1000000;
const PHONE = 1000001;
const KEY = 'https://dapp.example';
const PAGE = { origin: KEY, top_origin: KEY, frame: 0, navigation: 4 };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const cancelled = () =>
  Object.assign(new Error('Cancelled. If your Ledger still shows the request, reject it there.'), {
    code: 'LEDGER_CANCELLED',
  });
const WALLETS = [
  { index: LEDGER, type: 'ledger' },
  { index: PHONE, type: 'remote' },
];

/** A request's context as page-requests.js gives the steps one. */
function requestContext() {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    requester: { key: KEY, guest: 3 },
    params: [],
    deviceWait: jest.fn(() => true),
    nameHolds: async () => true,
    holdsKey: () => true,
    pageContext: () => ({ agent: false }),
    traceCoreToken: () => {},
  };
}

describe('a Ledger signature (page-devices.js)', () => {
  const device = (account = LEDGER, type = 'ledger') => ({
    type,
    kind: 'sign-message',
    account,
    payload: { message: '0x68' },
    handle: 'h'.repeat(64),
    token: 'T'.repeat(43),
  });

  function signing(ledgerCancels) {
    const getSigner = jest.fn(() => ({
      signMessage: async () => {
        throw cancelled();
      },
    }));
    const steps = createDeviceSigning({
      walletList: async () => WALLETS,
      getSigner,
      discardToken: () => {},
      ledgerCancels: () => ledgerCancels,
    });
    return { steps, getSigner };
  }

  test("on the core's backend: it says so, signs with the request's signal, and the Cancel is the page's 4001", async () => {
    const { steps, getSigner } = signing(true);
    const context = requestContext();
    expect(await steps.sign(context, device(), PAGE)).toEqual(REJECTED);
    expect(context.deviceWait).toHaveBeenCalledTimes(1);
    expect(getSigner.mock.calls).toEqual([
      [LEDGER, { confirmation: expect.objectContaining({ token: 'T'.repeat(43), page: PAGE }), signal: context.signal }],
    ]);
  });

  test('on the JS backend, and for a phone: nothing said, no signal', async () => {
    for (const [ledgerCancels, account, type] of [
      [false, LEDGER, 'ledger'],
      [true, PHONE, 'remote'],
    ]) {
      const { steps, getSigner } = signing(ledgerCancels);
      const context = requestContext();
      await steps.sign(context, device(account, type), PAGE);
      expect(context.deviceWait).not.toHaveBeenCalled();
      expect(getSigner.mock.calls[0][1]).not.toHaveProperty('signal');
    }
  });
});

describe('a Ledger send (page-core-sends.js)', () => {
  const checked = (account = LEDGER, type = 'ledger') => ({
    type,
    kind: 'dapp-send',
    account,
    payload: { tx: { to: '0x' + '22'.repeat(20), value: '0', data: '0x', chain_id: '100', gas_limit: '21000', type: 0, gas_price: '1' } },
    handle: 'h'.repeat(64),
    token: 'T'.repeat(43),
    remember: false,
  });

  function sends(ledgerCancels) {
    const authorizations = [];
    const signAndRecord = jest.fn(async () => {
      throw cancelled();
    });
    const steps = createCoreSends(
      { getPermission: () => ({ walletIndex: LEDGER }), updateLastUsed: () => {}, walletList: async () => WALLETS },
      {
        takeSiteTurn: async () => () => {},
        sitePaymentWaiting: async () => false,
        getSigner: (index, authorized) => {
          authorizations.push([index, authorized]);
          return {};
        },
        signAndRecord,
        discardToken: () => {},
        ledgerCancels: () => ledgerCancels,
      }
    );
    return { steps, authorizations, signAndRecord };
  }

  test("on the core's backend: it says so, signs with the request's signal, and the Cancel is the page's 4001", async () => {
    const { steps, authorizations } = sends(true);
    const context = requestContext();
    expect(await steps.device(context, checked(), PAGE)).toEqual(REJECTED);
    expect(context.deviceWait).toHaveBeenCalledTimes(1);
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0][1]).toMatchObject({ signal: context.signal });
  });

  test('on the JS backend: nothing said, no signal', async () => {
    const { steps, authorizations } = sends(false);
    const context = requestContext();
    expect(await steps.device(context, checked(), PAGE)).toEqual(REJECTED);
    expect(context.deviceWait).not.toHaveBeenCalled();
    expect(authorizations[0][1]).not.toHaveProperty('signal');
  });
});
