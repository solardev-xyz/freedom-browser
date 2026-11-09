const { validateLedgerEip712, hasHwAppEthChunkLoss } = require('./eip712-bounds');
const { LEDGER_ERROR_CODES } = require('./errors');

describe('hasHwAppEthChunkLoss', () => {
  test('boundary values for 1st chunk boundary (dataLength ~256)', () => {
    // dataLength = 2 + byteLength
    // byteLength 253 -> dataLength 255: ceil(255/256)=1, 1*255=255 >= 255 (no loss)
    expect(hasHwAppEthChunkLoss(253)).toBe(false);
    // byteLength 254 -> dataLength 256: ceil(256/256)=1, 1*255=255 < 256 (LOSES 1 BYTE)
    expect(hasHwAppEthChunkLoss(254)).toBe(true);
    // byteLength 255 -> dataLength 257: ceil(257/256)=2, 2*255=510 >= 257 (no loss)
    expect(hasHwAppEthChunkLoss(255)).toBe(false);
  });

  test('boundary values for 2nd chunk boundary (dataLength ~512)', () => {
    // byteLength 508 -> dataLength 510: ceil(510/256)=2, 2*255=510 >= 510 (no loss)
    expect(hasHwAppEthChunkLoss(508)).toBe(false);
    // byteLength 509 -> dataLength 511: ceil(511/256)=2, 2*255=510 < 511 (LOSES 1 BYTE)
    expect(hasHwAppEthChunkLoss(509)).toBe(true);
    // byteLength 510 -> dataLength 512: ceil(512/256)=2, 2*255=510 < 512 (LOSES 2 BYTES)
    expect(hasHwAppEthChunkLoss(510)).toBe(true);
    // byteLength 511 -> dataLength 513: ceil(513/256)=3, 3*255=765 >= 513 (no loss)
    expect(hasHwAppEthChunkLoss(511)).toBe(false);
  });
});

describe('validateLedgerEip712', () => {
  const validPayload = {
    primaryType: 'Mail',
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }],
      Mail: [
        { name: 'from', type: 'string' },
        { name: 'to', type: 'string' },
        { name: 'contents', type: 'string' },
      ],
    },
    domain: { name: 'Ether Mail' },
    message: { from: 'Alice', to: 'Bob', contents: 'Hello World' },
  };

  test('accepts valid ASCII typed data payload', () => {
    expect(() => validateLedgerEip712(validPayload)).not.toThrow();
  });

  describe('name boundaries (ASCII and multi-byte)', () => {
    test.each([
      ['non-ASCII primaryType', { ...validPayload, primaryType: 'Máil' }],
      ['non-ASCII type name', {
        ...validPayload,
        types: { ...validPayload.types, 'ÜberType': [{ name: 'x', type: 'string' }] },
      }],
      ['non-ASCII field name', {
        ...validPayload,
        types: {
          ...validPayload.types,
          Mail: [{ name: 'crédit', type: 'string' }],
        },
      }],
      ['non-ASCII field type', {
        ...validPayload,
        types: {
          ...validPayload.types,
          Mail: [{ name: 'amount', type: 'uint256é' }],
        },
      }],
    ])('refuses %s', (_label, payload) => {
      expect(() => validateLedgerEip712(payload)).toThrow(
        expect.objectContaining({ code: LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA })
      );
    });

    test('accepts exact 255-byte ASCII name', () => {
      const name255 = 'a'.repeat(255);
      const payload = {
        ...validPayload,
        types: {
          ...validPayload.types,
          Mail: [{ name: name255, type: 'string' }],
        },
      };
      expect(() => validateLedgerEip712(payload)).not.toThrow();
    });

    test('refuses 256-byte ASCII name', () => {
      const name256 = 'a'.repeat(256);
      const payload = {
        ...validPayload,
        types: {
          ...validPayload.types,
          Mail: [{ name: name256, type: 'string' }],
        },
      };
      expect(() => validateLedgerEip712(payload)).toThrow(
        expect.objectContaining({ code: LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA })
      );
    });
  });

  describe('array boundaries', () => {
    test('accepts array with 255 items', () => {
      const payload = {
        ...validPayload,
        message: {
          ...validPayload.message,
          items: new Array(255).fill('item'),
        },
      };
      expect(() => validateLedgerEip712(payload)).not.toThrow();
    });

    test('refuses array with 256 items', () => {
      const payload = {
        ...validPayload,
        message: {
          ...validPayload.message,
          items: new Array(256).fill('item'),
        },
      };
      expect(() => validateLedgerEip712(payload)).toThrow(
        expect.objectContaining({ code: LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA })
      );
    });
  });

  describe('value encoding chunk-boundary loss', () => {
    test('accepts string value with encoded dataLength = 255 (byteLength = 253)', () => {
      const str253 = 'x'.repeat(253);
      const payload = {
        ...validPayload,
        message: { ...validPayload.message, contents: str253 },
      };
      expect(() => validateLedgerEip712(payload)).not.toThrow();
    });

    test('refuses string value with encoded dataLength = 256 (byteLength = 254)', () => {
      const str254 = 'x'.repeat(254);
      const payload = {
        ...validPayload,
        message: { ...validPayload.message, contents: str254 },
      };
      expect(() => validateLedgerEip712(payload)).toThrow(
        expect.objectContaining({ code: LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA })
      );
    });

    test('accepts string value with encoded dataLength = 257 (byteLength = 255)', () => {
      const str255 = 'x'.repeat(255);
      const payload = {
        ...validPayload,
        message: { ...validPayload.message, contents: str255 },
      };
      expect(() => validateLedgerEip712(payload)).not.toThrow();
    });

    test('refuses string value at 2nd chunk boundary (byteLength = 509, 510)', () => {
      for (const len of [509, 510]) {
        const str = 'x'.repeat(len);
        const payload = {
          ...validPayload,
          message: { ...validPayload.message, contents: str },
        };
        expect(() => validateLedgerEip712(payload)).toThrow(
          expect.objectContaining({ code: LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA })
        );
      }
    });

    test('refuses bytes value that causes chunk boundary loss', () => {
      // 254 bytes = 508 hex characters + '0x'
      const hex254 = '0x' + 'ab'.repeat(254);
      const payload = {
        ...validPayload,
        message: { ...validPayload.message, data: hex254 },
      };
      expect(() => validateLedgerEip712(payload)).toThrow(
        expect.objectContaining({ code: LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA })
      );
    });
  });
});
