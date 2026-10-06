/** Mock API plumbing only. No engine/crypto/native/profile operation. */
const {
  assertReceiver,
  recoverOutput,
  expectRefusal,
} = require('./railgun-relay-sender-recovery-data');
function fixture() {
  const senderKey = Buffer.alloc(32, 8),
    symmetric = Buffer.alloc(32, 9);
  const sender = { viewingPublicKey: Buffer.alloc(32, 1), masterPublicKey: 1n };
  const expected = {
    viewingPublicKey: Buffer.alloc(32, 2),
    masterPublicKey: 2n,
    amount: 100n,
    token: '0x' + '11'.repeat(20),
    tokenHash: '22'.repeat(32),
    random: '02'.repeat(16),
    senderRandom: '04'.repeat(15),
    outputType: 1,
  };
  const output = {
    receiverAddressData: {
      viewingPublicKey: Buffer.from(expected.viewingPublicKey),
      masterPublicKey: 2n,
    },
    value: 100n,
    tokenData: { tokenType: 0, tokenAddress: expected.token, tokenSubID: '0' },
    tokenHash: expected.tokenHash,
    random: expected.random,
    senderRandom: expected.senderRandom,
    outputType: 1,
    walletSource: 'freedom',
    memoText: undefined,
    notePublicKey: 123n,
    hash: 456n,
  };
  const bundle = {
    ciphertext: ['0x' + '00'.repeat(32), ...Array(3).fill('0x' + '33'.repeat(32))],
    blindedSenderViewingKey: '0x' + '44'.repeat(32),
    blindedReceiverViewingKey: '0x' + '55'.repeat(32),
    memo: '0x',
    annotationData: '0x' + '66'.repeat(62),
  };
  const controller = new AbortController(),
    observed = {};
  const api = {
    getSharedSymmetricKey: jest.fn(async () => symmetric),
    TransactNote: { decrypt: jest.fn(async () => output), getHash: jest.fn(() => 456n) },
    getNotePublicKey: jest.fn(() => 123n),
    getNoteBlindingKeys: jest.fn(() => ({
      blindedSenderViewingKey: Buffer.alloc(32, 0x44),
      blindedReceiverViewingKey: Buffer.alloc(32, 0x55),
    })),
  };
  const input = {
    api,
    bundle,
    sender,
    senderKey,
    tokenDataGetter: {},
    expected,
    commitment: 456n,
    active() {
      if (controller.signal.aborted) throw Error('aborted');
    },
    observed,
  };
  return { input, api, output, expected, symmetric, controller, observed };
}
test('sender key direction and sent-note flag reach actual helper call sites; key buffer is wiped', async () => {
  const f = fixture();
  await recoverOutput(f.input);
  expect(f.api.getSharedSymmetricKey).toHaveBeenCalledWith(
    f.input.senderKey,
    Buffer.alloc(32, 0x55)
  );
  const args = f.api.TransactNote.decrypt.mock.calls[0];
  expect(args[7]).toBe(f.input.senderKey);
  expect(args[8]).toEqual(Buffer.alloc(32, 0x55));
  expect(args[9]).toEqual(Buffer.alloc(32, 0x44));
  expect(args[10]).toBe(true);
  expect(args[11]).toBe(false);
  expect(f.observed.decrypted).toBe(true);
  expect(f.symmetric).toEqual(Buffer.alloc(32));
});
test.each([
  [
    'empty viewing fallback',
    (f) => {
      f.output.receiverAddressData.viewingPublicKey = new Uint8Array();
    },
  ],
  [
    'substitute receiver',
    (f) => {
      f.output.receiverAddressData.viewingPublicKey = Buffer.alloc(32, 3);
    },
  ],
  [
    'wrong receiver master',
    (f) => {
      f.output.receiverAddressData.masterPublicKey = 3n;
    },
  ],
  [
    'wrong amount',
    (f) => {
      f.output.value = 99n;
    },
  ],
  [
    'changed recovered randomness',
    (f) => {
      f.output.random = '03'.repeat(16);
    },
  ],
  [
    'changed sender random',
    (f) => {
      f.output.senderRandom = '05'.repeat(15);
    },
  ],
  [
    'wrong output type',
    (f) => {
      f.output.outputType = 0;
    },
  ],
  [
    'wrong commitment',
    (f) => {
      f.input.commitment = 457n;
    },
  ],
  [
    'mismatched receiver blinding',
    (f) => {
      f.api.getNoteBlindingKeys.mockReturnValue({
        blindedSenderViewingKey: Buffer.alloc(32, 0x44),
        blindedReceiverViewingKey: Buffer.alloc(32, 0x56),
      });
    },
  ],
  [
    'ciphertext decrypt fails',
    (f) => {
      f.api.TransactNote.decrypt.mockRejectedValue(Error('authentication refused'));
    },
  ],
])('%s refuses and wipes the derived shared key', async (name, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(recoverOutput(f.input)).rejects.toBeDefined();
  expect(f.symmetric).toEqual(Buffer.alloc(32));
});
test('empty unblind fallback cannot pass standalone identity guard', () => {
  const f = fixture();
  expect(() =>
    assertReceiver(
      { receiverAddressData: { masterPublicKey: 2n, viewingPublicKey: new Uint8Array() } },
      f.expected
    )
  ).toThrow();
});

// Synthetic source-origin error only: these controls do not import or execute AES.
const aesFilename =
  '/fixture/engine.asar/node_modules/@railgun-community/engine/dist/utils/encryption/aes.js';
function aesError() {
  const error = Error('Unable to decrypt ciphertext.');
  error.stack =
    'Error: Unable to decrypt ciphertext.\n    at AES.decryptGCM (' + aesFilename + ':88:19)';
  return error;
}
function checkRefusal(f, mustDecrypt) {
  return expectRefusal(
    (observed) => recoverOutput({ ...f.input, observed }),
    mustDecrypt,
    aesFilename,
    f.input.active
  );
}
test('semantic negative admits only actual receiver-viewing-key assertion after decrypt', async () => {
  const f = fixture();
  f.output.receiverAddressData.viewingPublicKey = Buffer.alloc(32, 3);
  const observed = await checkRefusal(f, true);
  expect(observed.decrypted).toBe(true);
  expect(observed.decryptError).toBeUndefined();
});
test('ciphertext negative admits source-bound original decrypt error; no backend claim', async () => {
  const f = fixture(),
    error = aesError();
  f.api.TransactNote.decrypt.mockRejectedValue(error);
  const observed = await checkRefusal(f, false);
  expect(observed.decryptError).toBe(error);
  expect(observed.decrypted).toBeUndefined();
});
test.each([
  [
    'key derivation failure',
    false,
    (f) => f.api.getSharedSymmetricKey.mockRejectedValue(Error('unrelated key setup')),
  ],
  [
    'predecrypt active failure',
    false,
    (f) => {
      let calls = 0;
      f.input.active = () => {
        if (++calls === 2) throw Error('unrelated predecrypt');
      };
    },
  ],
  [
    'decrypt unrelated failure',
    false,
    (f) => f.api.TransactNote.decrypt.mockRejectedValue(Error('unrelated decrypt implementation')),
  ],
  [
    'decrypt same message wrong source',
    false,
    (f) => f.api.TransactNote.decrypt.mockRejectedValue(Error('Unable to decrypt ciphertext.')),
  ],
  [
    'decrypt wrong pinned line',
    false,
    (f) => {
      const error = aesError();
      error.stack = error.stack.replace(':88:19)', ':87:19)');
      f.api.TransactNote.decrypt.mockRejectedValue(error);
    },
  ],
  [
    'decrypt wrong runtime path',
    false,
    (f) => {
      const error = aesError();
      error.stack = error.stack.replace('engine.asar', 'different-engine.asar');
      f.api.TransactNote.decrypt.mockRejectedValue(error);
    },
  ],
  [
    'semantic postdecrypt unrelated failure',
    true,
    (f) => {
      let calls = 0;
      f.input.active = () => {
        if (++calls === 3) throw Error('unrelated postdecrypt');
      };
    },
  ],
  [
    'semantic different actual assertion',
    true,
    (f) => {
      f.output.value = 99n;
    },
  ],
  [
    'semantic wrong receiver master assertion',
    true,
    (f) => {
      f.output.receiverAddressData.masterPublicKey = 3n;
    },
  ],
  [
    'semantic empty receiver key assertion',
    true,
    (f) => {
      f.output.receiverAddressData.viewingPublicKey = new Uint8Array();
    },
  ],
  ['no refusal', true, () => {}],
])('%s fails qualification rather than counting a negative', async (_name, mustDecrypt, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(checkRefusal(f, mustDecrypt)).rejects.toThrow();
});
test('source-shaped AES error before decrypt does not qualify', async () => {
  const f = fixture();
  f.api.getSharedSymmetricKey.mockRejectedValue(aesError());
  await expect(checkRefusal(f, false)).rejects.toThrow('Expected original decrypt-stage error');
});
test('decrypt-stage error cannot qualify as semantic refusal', async () => {
  const f = fixture();
  f.api.TransactNote.decrypt.mockRejectedValue(aesError());
  await expect(checkRefusal(f, true)).rejects.toThrow();
});
test('receiver assertion cannot qualify as ciphertext refusal', async () => {
  const f = fixture();
  f.output.receiverAddressData.viewingPublicKey = Buffer.alloc(32, 3);
  await expect(checkRefusal(f, false)).rejects.toThrow();
});
test('unrelated error carrying ERR_ASSERTION code cannot qualify', async () => {
  const f = fixture();
  let calls = 0;
  f.input.active = () => {
    if (++calls === 3) {
      const error = Error('unrelated assertion');
      error.code = 'ERR_ASSERTION';
      throw error;
    }
  };
  await expect(checkRefusal(f, true)).rejects.toThrow(
    'Expected exact receiver viewing-key assertion'
  );
});
test('final liveness error escapes instead of counting an otherwise valid negative', async () => {
  const f = fixture();
  f.output.receiverAddressData.viewingPublicKey = Buffer.alloc(32, 3);
  const unrelated = Error('unrelated final check');
  await expect(
    expectRefusal(
      (observed) => recoverOutput({ ...f.input, observed }),
      true,
      aesFilename,
      () => {
        throw unrelated;
      }
    )
  ).rejects.toBe(unrelated);
});
