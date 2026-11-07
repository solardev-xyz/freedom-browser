import {
  hasEdgeSpace,
  passphraseBackupNote,
  passphraseNote,
  passphraseStatus,
} from './passphrase-fields.js';

describe('passphraseStatus', () => {
  test('off when the switch is off, whatever is in the fields', () => {
    expect(passphraseStatus(false, 'secret', 'secret')).toBe('off');
  });

  test('switched on with nothing typed counts as off', () => {
    expect(passphraseStatus(true, '', '')).toBe('off');
  });

  test('on when both entries match', () => {
    expect(passphraseStatus(true, 'secret', 'secret')).toBe('on');
  });

  test('a passphrase with no confirmation yet does not count', () => {
    expect(passphraseStatus(true, 'secret', '')).toBe('mismatch');
    expect(passphraseStatus(true, '', 'secret')).toBe('mismatch');
  });

  test('case and spaces count when comparing', () => {
    expect(passphraseStatus(true, 'secret', 'Secret')).toBe('mismatch');
    expect(passphraseStatus(true, 'secret ', 'secret')).toBe('mismatch');
  });

  test('whitespace alone is a real passphrase', () => {
    expect(passphraseStatus(true, ' ', ' ')).toBe('on');
  });
});

describe('passphraseNote', () => {
  test('stays neutral until the confirmation disagrees', () => {
    expect(passphraseNote('secret', '')).toEqual({
      text: 'Capitals and spaces count, exactly as typed.',
      bad: false,
    });
  });

  test('says when the entries differ', () => {
    expect(passphraseNote('secret', 'secre')).toEqual({
      text: "Passphrases don't match.",
      bad: true,
    });
  });

  test('flags a space at either end, which is still allowed', () => {
    expect(passphraseNote('secret ', 'secret ')).toEqual({
      text: 'Spaces at the start or end count as part of the passphrase.',
      bad: false,
    });
  });
});

describe('hasEdgeSpace', () => {
  test.each([
    ['secret', false],
    ['two words', false],
    [' secret', true],
    ['secret ', true],
    [' ', true],
  ])('%j -> %s', (passphrase, expected) => {
    expect(hasEdgeSpace(passphrase)).toBe(expected);
  });
});

describe('passphraseBackupNote', () => {
  test('says the words alone are not enough', () => {
    expect(passphraseBackupNote('secret')).toContain('different, empty wallet');
    expect(passphraseBackupNote('secret')).not.toContain('space');
  });

  test('points out a space at either end', () => {
    expect(passphraseBackupNote('secret ')).toContain('starts or ends with a space');
  });
});
