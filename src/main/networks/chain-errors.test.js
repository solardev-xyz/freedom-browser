const { safeErrorMessage, isCapacityFailure } = require('./chain-errors');

const NBSP = String.fromCharCode(0xa0);
const hex = (digits) => `0x${'a'.repeat(digits)}`;

describe('safeErrorMessage', () => {
  test('elides hex runs of 128 digits or more, and only those', () => {
    expect(safeErrorMessage(new Error(`data ${hex(128)} end`))).toBe(
      'data 0xaaaaaaaa…(64 bytes) end'
    );
    expect(safeErrorMessage(new Error(hex(127)))).toBe(hex(127));
  });

  test('collapses whitespace runs, Unicode spaces included, and cuts at 500 units', () => {
    expect(safeErrorMessage(new Error(`a \n\t${NBSP} b`))).toBe('a b');
    expect(safeErrorMessage(new Error('x'.repeat(600)))).toHaveLength(500);
  });

  test('reads a message, or the value itself', () => {
    expect(safeErrorMessage({ message: 'plain object' })).toBe('plain object');
    expect(safeErrorMessage('a string')).toBe('a string');
    expect(safeErrorMessage(new Error(''))).toBe('Error');
  });
});

describe('isCapacityFailure', () => {
  test.each([
    'out of gas',
    'Execution reverted: OUT OF GAS',
    'execution gas limit reached',
    'execution resource limit',
    'exceeds gas limit',
    'request exceed the execution limit',
  ])('%s is a capacity failure', (message) => {
    expect(isCapacityFailure(new Error(message))).toBe(true);
  });

  test.each(['outofgas', 'gas limit too low', 'execution limit', 'exceeds the block gas limit'])(
    '%s is not',
    (message) => {
      expect(isCapacityFailure(new Error(message))).toBe(false);
    }
  );

  test('is matched on the safe text: whitespace collapsed, not the raw message', () => {
    expect(isCapacityFailure(new Error(`out  of\n${NBSP}gas`))).toBe(true);
  });

  test('a phrase is matched only within the first 500 units', () => {
    const at = (offset) => new Error(`${'x'.repeat(offset)}out of gas`);
    expect(isCapacityFailure(at(490))).toBe(true);
    expect(isCapacityFailure(at(491))).toBe(false);
  });

  test('an elided hex run brings a later phrase within reach', () => {
    const message = `${hex(1000)} out of gas`;
    expect(message.length).toBeGreaterThan(500);
    expect(isCapacityFailure(new Error(message))).toBe(true);
  });

  test("an error's own failureKind is enough", () => {
    expect(isCapacityFailure(Object.assign(new Error('opaque'), { failureKind: 'capacity' }))).toBe(
      true
    );
    expect(isCapacityFailure(Object.assign(new Error('opaque'), { failureKind: 'timeout' }))).toBe(
      false
    );
  });
});
