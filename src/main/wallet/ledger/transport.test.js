const mockGetAddress = jest.fn();
const mockClose = jest.fn(async () => {});
const mockOpen = jest.fn();
const mockList = jest.fn();
const mockEthConstructed = jest.fn();
// The signing APDUs, for the backend's tests through this real transport.
const mockSign = {
  signTransaction: jest.fn(),
  signPersonalMessage: jest.fn(),
  signEIP712Message: jest.fn(),
  signEIP712HashedMessage: jest.fn(),
};

jest.mock('@ledgerhq/hw-transport-node-hid', () => ({
  default: {
    open: (...args) => mockOpen(...args),
    list: (...args) => mockList(...args),
  },
}));
jest.mock('@ledgerhq/hw-app-eth', () => ({
  default: class MockEth {
    constructor(transport, scrambleKey, loadConfig) {
      this.transport = transport;
      mockEthConstructed({ scrambleKey, loadConfig });
    }
    getAddress(...args) {
      return mockGetAddress(...args);
    }
    signTransaction(...args) {
      return mockSign.signTransaction(...args);
    }
    signPersonalMessage(...args) {
      return mockSign.signPersonalMessage(...args);
    }
    signEIP712Message(...args) {
      return mockSign.signEIP712Message(...args);
    }
    signEIP712HashedMessage(...args) {
      return mockSign.signEIP712HashedMessage(...args);
    }
  },
}));

const { listAccounts, withEthApp, OFFLINE_LOAD_CONFIG } = require('./transport');
const { LEDGER_ERROR_CODES } = require('./errors');

beforeEach(() => {
  mockOpen.mockReset().mockResolvedValue({ close: mockClose });
  mockList.mockReset();
  mockGetAddress.mockReset();
  mockClose.mockClear();
  mockEthConstructed.mockClear();
});

describe('listAccounts', () => {
  test('walks the Ledger Live path scheme without on-device display', async () => {
    mockGetAddress.mockImplementation(async (path) => ({ address: `0xaddr:${path}` }));

    const accounts = await listAccounts({ scheme: 'live', start: 0, count: 3 });

    expect(accounts).toEqual([
      { path: "44'/60'/0'/0/0", address: "0xaddr:44'/60'/0'/0/0" },
      { path: "44'/60'/1'/0/0", address: "0xaddr:44'/60'/1'/0/0" },
      { path: "44'/60'/2'/0/0", address: "0xaddr:44'/60'/2'/0/0" },
    ]);
    expect(mockGetAddress).toHaveBeenCalledWith("44'/60'/0'/0/0", false);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test('supports the legacy path scheme and paging', async () => {
    mockGetAddress.mockImplementation(async (path) => ({ address: `0xaddr:${path}` }));

    const accounts = await listAccounts({ scheme: 'legacy', start: 5, count: 2 });

    expect(accounts.map((a) => a.path)).toEqual(["44'/60'/0'/5", "44'/60'/0'/6"]);
  });

  test('rejects unknown schemes before touching the device', async () => {
    await expect(listAccounts({ scheme: 'nope' })).rejects.toThrow('Unknown derivation scheme');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test('maps app-not-open APDU errors and still closes the transport', async () => {
    const apduError = new Error('0x6511');
    apduError.statusCode = 0x6511;
    mockGetAddress.mockRejectedValue(apduError);

    await expect(listAccounts()).rejects.toMatchObject({
      code: LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN,
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test('maps transport-open failures to DEVICE_NOT_FOUND', async () => {
    mockOpen.mockRejectedValue(new Error('cannot open device with path'));
    await expect(listAccounts()).rejects.toMatchObject({
      code: LEDGER_ERROR_CODES.DEVICE_NOT_FOUND,
    });
  });
});

describe('hosted clear-signing services', () => {
  test('every Eth app is built with the offline load config', async () => {
    mockGetAddress.mockResolvedValue({ address: '0xok' });

    await withEthApp((eth) => eth.getAddress('x', false));

    expect(mockEthConstructed).toHaveBeenCalledTimes(1);
    expect(mockEthConstructed.mock.calls[0][0].loadConfig).toBe(OFFLINE_LOAD_CONFIG);
    // scrambleKey stays at hw-app-eth's own default.
    expect(mockEthConstructed.mock.calls[0][0].scrambleKey).toBeUndefined();
  });

  test('the offline config nulls every service URL the installed hw-app-eth would call', () => {
    // Resolved against the library's own defaults: a URL we forget to
    // null (or one a future version adds) falls back to Ledger's hosted
    // endpoint and would leak signing metadata off the machine.
    const { getLoadConfig } = require('@ledgerhq/hw-app-eth/lib/services/ledger/loadConfig');
    const resolved = getLoadConfig(OFFLINE_LOAD_CONFIG);

    const urlKeys = Object.keys(resolved).filter((key) => /URL$/.test(key));
    expect(urlKeys.length).toBeGreaterThan(0);
    for (const key of urlKeys) {
      expect(resolved[key]).toBeNull();
    }
  });
});

describe('withEthApp serialization', () => {
  test('device operations run one at a time, in order', async () => {
    const events = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = withEthApp(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 1;
    });
    const second = withEthApp(async () => {
      events.push('second:start');
      return 2;
    });

    // Give the second task a chance to (incorrectly) start early.
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('a failed operation does not wedge the queue', async () => {
    mockGetAddress.mockRejectedValueOnce(Object.assign(new Error('rejected'), { statusCode: 0x6985 }));
    await expect(withEthApp((eth) => eth.getAddress('x', false))).rejects.toMatchObject({
      code: LEDGER_ERROR_CODES.USER_REJECTED,
    });

    mockGetAddress.mockResolvedValueOnce({ address: '0xok' });
    await expect(withEthApp((eth) => eth.getAddress('x', false))).resolves.toEqual({ address: '0xok' });
  });
});

// Codex round 2 on #1246: the Ledger backend (`signer.js`) through this
// real transport, its device queue, its open and its address check held.
// The caller's last check (`beforeSign`) runs in the device session after
// all of them, right before the signing APDU; a refusal there sends none,
// closes the transport, frees the queue, and reaches the caller as it is.
describe('the Ledger backend: the caller\'s last check right before each signing APDU', () => {
  const { Wallet, Signature, Transaction } = require('ethers');
  const { createLedgerBackend } = require('./signer');
  const key = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const RECORD = { index: 1000000, type: 'ledger', address: key.address, path: "44'/60'/0'/0/0" };
  const TYPED = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      Permit: [{ name: 'value', type: 'uint256' }],
    },
    domain: { name: 'Permit', chainId: 100 },
    primaryType: 'Permit',
    message: { value: '1' },
  };
  const STRIPPED = { Permit: TYPED.types.Permit };
  const TX = { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', gasPrice: '7', nonce: 1, chainId: 100, type: 0 };
  const deviceSig = (serialized) => {
    const sig = Signature.from(serialized);
    return { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.v };
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const tick = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const REQUESTS = {
    message: ['signPersonalMessage', (backend) => backend.signMessage('hello')],
    'typed data': ['signEIP712Message', (backend) => backend.signTypedData(TYPED)],
    transaction: ['signTransaction', (backend) => backend.signTransaction(TX)],
  };
  // What a held step looks like: started (`reached`), then let go.
  const HOLDS = {
    'the device queue': () => {
      const gate = deferred();
      const blocker = withEthApp(() => gate.promise);
      return { reached: tick(), release: gate.resolve, done: blocker };
    },
    "the transport's open": () => {
      const gate = deferred();
      const reached = deferred();
      mockOpen.mockImplementationOnce(async () => {
        reached.resolve();
        await gate.promise;
        return { close: mockClose };
      });
      return { reached: reached.promise, release: gate.resolve, done: Promise.resolve() };
    },
    "the device's address check": () => {
      const gate = deferred();
      const reached = deferred();
      mockGetAddress.mockImplementationOnce(async () => {
        reached.resolve();
        await gate.promise;
        return { address: key.address };
      });
      return { reached: reached.promise, release: gate.resolve, done: Promise.resolve() };
    },
  };

  beforeEach(() => {
    mockGetAddress.mockResolvedValue({ address: key.address });
    mockSign.signPersonalMessage.mockReset().mockImplementation(async (_path, hex) => deviceSig(await key.signMessage(Buffer.from(hex, 'hex'))));
    mockSign.signEIP712Message.mockReset().mockImplementation(async () =>
      deviceSig(await key.signTypedData(TYPED.domain, STRIPPED, TYPED.message))
    );
    mockSign.signEIP712HashedMessage.mockReset().mockImplementation(async () =>
      deviceSig(await key.signTypedData(TYPED.domain, STRIPPED, TYPED.message))
    );
    mockSign.signTransaction.mockReset().mockImplementation(async () => {
      const signed = Transaction.from(await key.signTransaction(TX));
      return deviceSig(signed.signature.serialized);
    });
  });

  const apdus = () => Object.values(mockSign).reduce((count, fn) => count + fn.mock.calls.length, 0);

  describe.each(Object.keys(HOLDS))('%s held', (held) => {
    test.each(Object.keys(REQUESTS))('%s: the check after it; refused there, no signing APDU and the device freed; else one', async (request) => {
      const [apdu, sign] = REQUESTS[request];
      for (const refuses of [true, false]) {
        const order = [];
        const refusal = Object.assign(new Error('Signing was not confirmed: the Agent no longer holds this tab'), { code: 'SIGNING_NOT_CONFIRMED' });
        let changed = false;
        const beforeSign = jest.fn(async () => {
          order.push('check');
          if (changed) throw refusal;
        });
        const closes = mockClose.mock.calls.length;
        const hold = HOLDS[held]();
        const signing = sign(createLedgerBackend(RECORD, { beforeSign }));
        await hold.reached;
        await tick();
        // Held: not yet checked, nothing signed.
        expect(beforeSign).not.toHaveBeenCalled();
        expect(apdus()).toBe(0);
        changed = refuses;
        hold.release();
        await hold.done;
        if (refuses) {
          await expect(signing).rejects.toBe(refusal);
          expect(apdus()).toBe(0);
        } else {
          await expect(signing).resolves.toMatch(/^0x/);
          expect(mockSign[apdu]).toHaveBeenCalledTimes(1);
        }
        expect(beforeSign).toHaveBeenCalledTimes(1);
        // Every session closed: the device is free for the next.
        expect(mockClose.mock.calls.length).toBe(closes + (held === 'the device queue' ? 2 : 1));
        await expect(withEthApp(async () => 'free')).resolves.toBe('free');
        for (const fn of Object.values(mockSign)) fn.mockClear();
      }
    });
  });

  test('the check is the last step: after the address check, right before the APDU', async () => {
    const order = [];
    mockGetAddress.mockImplementationOnce(async () => {
      order.push('address');
      return { address: key.address };
    });
    const real = mockSign.signPersonalMessage.getMockImplementation();
    mockSign.signPersonalMessage.mockImplementationOnce(async (...args) => {
      order.push('apdu');
      return real(...args);
    });
    await createLedgerBackend(RECORD, { beforeSign: async () => order.push('check') }).signMessage('hello');
    expect(order).toEqual(['address', 'check', 'apdu']);
  });

  test("typed data on an app without full EIP-712: the check again before the hashed fallback's APDU, after the device's refusal", async () => {
    const unsupported = Object.assign(new Error('INS not supported'), { statusCode: 0x6d00 });
    let checks = 0;
    let refuseSecond = false;
    const refusal = new Error('Signing was not confirmed: this request is not covered by the site\'s auto-approve rules');
    const beforeSign = async () => {
      checks += 1;
      if (refuseSecond && checks === 2) throw refusal;
    };
    mockSign.signEIP712Message.mockRejectedValueOnce(unsupported);
    const signature = await createLedgerBackend(RECORD, { beforeSign }).signTypedData(TYPED);
    expect(signature).toBe(await key.signTypedData(TYPED.domain, STRIPPED, TYPED.message));
    expect(checks).toBe(2);
    expect(mockSign.signEIP712HashedMessage).toHaveBeenCalledTimes(1);
    // Refused at the second check: the hashed APDU is never sent.
    checks = 0;
    refuseSecond = true;
    mockSign.signEIP712HashedMessage.mockClear();
    mockSign.signEIP712Message.mockRejectedValueOnce(unsupported);
    await expect(createLedgerBackend(RECORD, { beforeSign }).signTypedData(TYPED)).rejects.toBe(refusal);
    expect(checks).toBe(2);
    expect(mockSign.signEIP712HashedMessage).not.toHaveBeenCalled();
  });

  test('without a check, the backend signs as before', async () => {
    await expect(createLedgerBackend(RECORD).signMessage('hello')).resolves.toBe(await key.signMessage('hello'));
    expect(mockSign.signPersonalMessage).toHaveBeenCalledTimes(1);
  });
});
