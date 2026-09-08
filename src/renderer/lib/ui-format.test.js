import {
  EMPTY_COUNT,
  UNKNOWN,
  countText,
  formatCount,
  pluralize,
  versionText,
} from './ui-format.js';

describe('countText', () => {
  test('renders a reported number', () => {
    expect(countText(0)).toBe('0');
    expect(countText(42)).toBe('42');
    expect(countText(25684159)).toBe('25684159');
  });

  test('renders the shared empty counter for anything missing (#252)', () => {
    // Regression guard for the Nodes menu's Finalized Block rows, which used
    // to fall back to '--' where every sibling counter fell back to '0'.
    for (const missing of [undefined, null, '', '   ', NaN, Infinity, false]) {
      expect(countText(missing)).toBe('0');
    }
    expect(EMPTY_COUNT).toBe('0');
    expect(countText(undefined)).not.toBe('--');
  });

  test('passes through a pre-formatted string count', () => {
    expect(countText('1,024')).toBe('1,024');
    expect(countText(' 7 ')).toBe('7');
  });
});

describe('versionText', () => {
  test('renders a reported version', () => {
    expect(versionText('Myotis v0.1.7')).toBe('Myotis v0.1.7');
    expect(versionText('libradicle v0.7.1')).toBe('libradicle v0.7.1');
  });

  test('renders one placeholder for every "not known yet" shape (#253)', () => {
    // The Nodes menu used to show four conventions at once: blank, a bare
    // product name, '--', and a populated string.
    for (const missing of [undefined, null, '', '   ', 0, false]) {
      expect(versionText(missing)).toBe('Unknown');
    }
    expect(UNKNOWN).toBe('Unknown');
    expect(versionText('')).not.toBe('--');
    expect(versionText('')).not.toBe('');
  });

  test('trims, so a padded value never renders as blank', () => {
    expect(versionText('  Ant v0.5.8  ')).toBe('Ant v0.5.8');
  });
});

describe('pluralize', () => {
  test('uses the singular for exactly one', () => {
    expect(pluralize(1, 'payment')).toBe('payment');
  });

  test('uses the plural for everything else', () => {
    expect(pluralize(0, 'payment')).toBe('payments');
    expect(pluralize(2, 'payment')).toBe('payments');
    expect(pluralize(12, 'download')).toBe('downloads');
  });

  test('accepts an explicit irregular plural', () => {
    expect(pluralize(1, 'entry', 'entries')).toBe('entry');
    expect(pluralize(3, 'entry', 'entries')).toBe('entries');
  });
});

describe('formatCount', () => {
  test('pluralises the unfiltered count (#254)', () => {
    expect(formatCount(0, 0, 'page')).toBe('0 pages');
    expect(formatCount(1, 1, 'page')).toBe('1 page');
    expect(formatCount(2, 2, 'page')).toBe('2 pages');
    expect(formatCount(1, 1, 'download')).toBe('1 download');
    expect(formatCount(1, 1, 'payment')).toBe('1 payment');
  });

  test('names how much of the list is showing while a filter is active', () => {
    expect(formatCount(3, 12, 'payment')).toBe('3 of 12 payments');
    expect(formatCount(0, 1, 'download')).toBe('0 of 1 download');
  });

  test('agrees the noun with the total, not the filtered count', () => {
    // Typing into the search box must not flip the noun mid-keystroke.
    expect(formatCount(1, 12, 'page')).toBe('1 of 12 pages');
    expect(formatCount(0, 1, 'page')).toBe('0 of 1 page');
  });

  test('accepts an explicit irregular plural', () => {
    expect(formatCount(1, 5, 'entry', 'entries')).toBe('1 of 5 entries');
  });
});
