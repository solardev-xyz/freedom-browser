'use strict';

const { WFP_IDENTITIES, REPLACEMENTS, RUST_TOOLCHAIN } = require('./build-windows-workspace');

test('Freedom owns all fourteen WFP identities independently of Codex', () => {
  expect(WFP_IDENTITIES).toHaveLength(14);
  const before = WFP_IDENTITIES.map(pair => pair[0]);
  const after = WFP_IDENTITIES.map(pair => pair[1]);
  expect(new Set(after).size).toBe(14);
  for (const identity of after) {
    expect(identity).toMatch(/^0x[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/);
    expect(before).not.toContain(identity);
  }
  expect(REPLACEMENTS).toContainEqual(['codex_wfp_', 'freedom_wfp_']);
  expect(RUST_TOOLCHAIN).toBe('1.95.0');
});
