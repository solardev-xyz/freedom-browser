let mockSerial, mockArtifacts;
jest.mock('./railgun-prover-runtime', () => ({ loadRailgunProverRuntime: () => mockSerial }));
jest.mock('./railgun-artifacts', () => ({
  loadRailgunArtifacts: jest.fn(async () => mockArtifacts),
}));
const { run } = require('./railgun-poi-verify-job');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { createHash } = require('crypto');
const hex = (n) => n.toString(16).padStart(64, '0');
let input, request, controller;
beforeEach(() => {
  globalThis.curve_bn128 = null;
  mockSerial = { verify: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
  mockArtifacts = { vkey: {}, wasm: Buffer.from('wasm'), zkey: Buffer.from('zkey') };
  request = jest.fn(async () => JSON.stringify({ id: 1, value: null }));
  controller = new AbortController();
  input = {
    proverArchive: '/test/prover.asar',
    artifactDirectory: '/test/artifacts',
    payload: {
      listKey: REQUIRED_LIST,
      proof: {
        pi_a: ['1', '2'],
        pi_b: [
          ['3', '4'],
          ['5', '6'],
        ],
        pi_c: ['7', '8'],
      },
      poiMerkleroots: [hex(3n)],
      txidMerkleroot: hex(4n),
      txidMerklerootIndex: 6,
      blindedCommitmentsOut: ['0x' + hex(5n)],
      railgunTxidIfHasUnshield: '0x00',
    },
  };
});
afterEach(() => {
  delete globalThis.curve_bn128;
});
const execute = () =>
  run(JSON.stringify(input), {
    request,
    signal: controller.signal,
    guardReport: () => ({ attempts: 0, canaries: 1, hooks: ['test.guard'] }),
  });
test.each([false, true])(
  'derives all eight signals for unshield=%s and emits digest-only evidence',
  async (unshield) => {
    if (unshield) {
      input.payload.blindedCommitmentsOut = [];
      input.payload.railgunTxidIfHasUnshield = '0x' + hex(6n);
    }
    await execute();
    const zero = BigInt('0x' + require('./railgun-public-records').ZERO_NODES[0]);
    const expected = [unshield ? 0n : 5n, 0n, 0n, 4n, unshield ? 6n : 0n, 3n, zero, zero];
    expect(mockSerial.verify.mock.calls[0]).toEqual([
      mockArtifacts.vkey,
      expected,
      input.payload.proof,
    ]);
    expected[3] = 5n;
    expect(mockSerial.verify.mock.calls[1][1]).toEqual(expected);
    const result = JSON.parse(request.mock.calls[0][0]);
    expect(result.value).toMatchObject({
      proofVerified: true,
      rootAccepted: false,
      disclosureEnabled: false,
      payloadSha256: createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'),
    });
    expect(result.value).not.toHaveProperty('payload');
    expect(mockArtifacts.wasm.every((v) => v === 0)).toBe(true);
    expect(mockArtifacts.zkey.every((v) => v === 0)).toBe(true);
  }
);
test.each(['missing', 'true', 'false', 'throw', 'worker', 'abort'])(
  'refuses %s verifier without a result',
  async (mode) => {
    if (mode === 'missing') delete mockSerial.verify;
    if (mode === 'true') mockSerial.verify = jest.fn(async () => true);
    if (mode === 'false') mockSerial.verify = jest.fn(async () => false);
    if (mode === 'throw')
      mockSerial.verify = jest.fn(async () => {
        throw Error('sensitive');
      });
    if (mode === 'worker') globalThis.curve_bn128 = {};
    if (mode === 'abort')
      mockSerial.verify = jest.fn(async () => {
        controller.abort();
        return true;
      });
    await expect(execute()).rejects.toMatchObject({
      message: 'Railgun POI verification unavailable',
      code: 'RAILGUN_POI_VERIFICATION_REFUSED',
    });
    expect(request).not.toHaveBeenCalled();
  }
);
test('checkpoint metadata changes payload digest but not cryptographic signals', async () => {
  await execute();
  const first = JSON.parse(request.mock.calls[0][0]).value;
  const signals = mockSerial.verify.mock.calls[0][1];
  input.payload.txidMerklerootIndex++;
  mockSerial.verify = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await execute();
  const second = JSON.parse(request.mock.calls[1][0]).value;
  expect(first.payloadSha256).not.toBe(second.payloadSha256);
  expect(mockSerial.verify.mock.calls[0][1]).toEqual(signals);
});
test('cancellation waits for verification before wiping artifacts and refusing', async () => {
  let release;
  mockSerial.verify = jest.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  let settled = false;
  const outcome = execute().catch((e) => {
    settled = true;
    return e;
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  controller.abort();
  expect(settled).toBe(false);
  expect(mockArtifacts.wasm.toString()).toBe('wasm');
  release(true);
  expect(await outcome).toMatchObject({ code: 'RAILGUN_POI_VERIFICATION_REFUSED' });
  expect(mockSerial.verify).toHaveBeenCalledTimes(1);
  expect(mockArtifacts.wasm.every((v) => v === 0)).toBe(true);
  expect(mockArtifacts.zkey.every((v) => v === 0)).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
