'use strict';

const { selectedPackages } = require('./windows-workspace-notices');

test('attribution includes the selected build graph without unrelated workspace or development crates', () => {
  const helper = { name: 'freedom-windows-workspace', version: '0.1.0' };
  const dependency = { name: 'example', version: '2.0.0' };
  const metadata = { packages: [helper, dependency, { name: 'unrelated', version: '1.0.0' }] };
  expect(selectedPackages(metadata, 'freedom-windows-workspace v0.1.0 (C:\\source)\nexample v2.0.0\nexample v2.0.0 (*)\n')).toEqual([dependency, helper]);
});

test('missing or ambiguous dependency identities stop packaging instead of omitting notices', () => {
  expect(() => selectedPackages({ packages: [] }, '')).toThrow('inventory');
  expect(() => selectedPackages({ packages: [] }, 'missing v1.0.0')).toThrow('inventory');
  expect(() => selectedPackages({ packages: [
    { name: 'duplicate', version: '1.0.0', source: 'one' },
    { name: 'duplicate', version: '1.0.0', source: 'two' },
  ] }, 'duplicate v1.0.0')).toThrow('inventory');
});
