const {
  DOMAIN_APPROVAL_SOURCE,
  domainApprovalHeading,
  domainDisplayText,
  domainTermText,
  parseDomainApproval,
} = require('./domain-approval');

const to = '0x59E16fcCd424Cc24e280Be16E11Bcd56fb0CE547';
const request = (presentation, overrides = {}) => ({
  action: 'wallet_transaction',
  operation: 'domain_execute',
  wallet: { kind: 'transaction', to, domain: presentation },
  ...overrides,
});
const base = {
  format: 'freedom-domain-approval/1',
  action: 'register',
  name: 'freedom-audit.eth',
  durationSeconds: 31536000,
  priceWei: '3125000000000000',
  contract: { address: to.toLowerCase(), name: 'ENS ETHRegistrarController' },
  items: [{ label: 'Name', value: 'freedom-audit.eth' }],
};

test('reads the typed description and names only the contract being called', () => {
  expect(parseDomainApproval(request(base))).toEqual({
    action: 'register',
    name: 'freedom-audit.eth',
    durationSeconds: 31536000,
    priceWei: '3125000000000000',
    contractName: 'ENS ETHRegistrarController',
    items: [{ label: 'Name', value: 'freedom-audit.eth' }],
  });
  const elsewhere = request(base);
  elsewhere.wallet.to = '0x0000000000000000000000000000000000000001';
  expect(parseDomainApproval(elsewhere).contractName).toBe('');
});

test.each([
  ['another operation', request(base, { operation: 'eth_sendTransaction' })],
  ['a signature', { ...request(base), wallet: { ...request(base).wallet, kind: 'signature' } }],
  ['plain text', { ...request(base), wallet: { kind: 'transaction', to, summary: 'Register x' } }],
  ['a JSON string instead of the typed object', { ...request(base), wallet: { kind: 'transaction', to, domain: JSON.stringify(base) } }],
  ['an unknown format', request({ ...base, format: 'other' })],
  ['an unknown action', request({ ...base, action: 'transfer' })],
  ['a non-string item', request({ ...base, items: [{ label: 'Name', value: 1 }] })],
  ['too many items', request({ ...base, items: Array(21).fill({ label: 'a', value: 'b' }) })],
])('falls back to the generic card for %s', (_, value) => {
  expect(parseDomainApproval(value)).toBeNull();
});

test.each([
  ['register_commit', 31536000, 'Start registering freedom-audit.eth for 1 year?'],
  ['register', 31536000, 'Register freedom-audit.eth for 1 year?'],
  ['renew', 2 * 31536000, 'Renew freedom-audit.eth for 2 years?'],
  ['renew', 30 * 86400, 'Renew freedom-audit.eth for 30 days?'],
  ['set_website', null, 'Point freedom-audit.eth to a Swarm website?'],
  ['clear_website', null, 'Clear the website of freedom-audit.eth?'],
  ['set_address', null, 'Set the ETH address of freedom-audit.eth?'],
  ['set_text', null, 'Set a text record on freedom-audit.eth?'],
])('words the %s heading with the name and term', (action, durationSeconds, heading) => {
  expect(domainApprovalHeading({ action, name: 'freedom-audit.eth', durationSeconds })).toBe(heading);
});

test('terms read in years or days, never raw seconds for a whole term', () => {
  expect(domainTermText(31536000)).toBe('1 year');
  expect(domainTermText(3 * 31536000)).toBe('3 years');
  expect(domainTermText(28 * 86400)).toBe('28 days');
  expect(domainTermText(null)).toBe('');
});

test('line breaks and separators in a value stay visible inside that value', () => {
  expect(domainDisplayText('a\nb\r\nc d e\u0085f ⏎ g‮h')).toBe(
    'a\\u{000A}b\\u{000D}\\u{000A}c\\u{2028}d\\u{2029}e\\u{0085}f ⏎ g\\u{202E}h'
  );
});

test('the source line says Freedom prepared it', () => {
  expect(DOMAIN_APPROVAL_SOURCE).toMatch(/^Prepared by Freedom/);
  expect(DOMAIN_APPROVAL_SOURCE).not.toMatch(/page Agent is controlling/);
});
