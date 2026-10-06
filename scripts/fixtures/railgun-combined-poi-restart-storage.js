/** Transparent cold-bootstrap storage observation. This delegates every read,
 * update and key to production. It cannot create an enrollment or repair state. */
const path = require('path');
const fs = require('fs');
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
const leases = {
  'railgun-wallet-catalog-v1': ['lease', 'sequence'],
  'railgun-public-catalog-v1': ['lease', 'sequence'],
  'freedom-railgun-host-scan-v1': ['lease', 'sequence', 'generation'],
  'freedom-railgun-txid-v1': ['lease', 'sequence', 'generation'],
  'railgun-private-reservations-v1': ['lease'],
  'railgun-private-capsules-v1': ['lease'],
  'railgun-poi-intents-v1': ['lease'],
};
const floors = new Set([
  'railgun-private-reservations-floor-v1',
  'railgun-private-capsules-floor-v1',
  'railgun-poi-intents-floor-v1',
]);
function transition(name, previous, next) {
  assert.notEqual(previous, null);
  const old = JSON.parse(previous),
    value = JSON.parse(next);
  const fields = leases[name] ?? (floors.has(name) ? [] : null);
  assert.ok(fields, 'Unexpected bootstrap write');
  if (Object.hasOwn(old, 'pending')) assert.equal(old.pending, null);
  const strip = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => !fields.includes(k)));
  assert.deepEqual(strip(value), strip(old));
  for (const k of fields) {
    if (k === 'lease') {
      assert.match(value[k], /^[a-f0-9]{64}$/);
      assert.notEqual(value[k], old[k]);
    } else assert.equal(value[k], old[k] + 1);
  }
  return fields;
}
function companionTransition(phase, name, previous, next) {
  assert.equal(phase, 'second-recovery-companion-reopen');
  assert.ok(
    [
      'railgun-private-reservations-v1',
      'railgun-private-reservations-floor-v1',
      'railgun-private-capsules-v1',
      'railgun-private-capsules-floor-v1',
    ].includes(name)
  );
  return transition(name, previous, next);
}
function install({ directory, phase }) {
  assert.equal(require.cache[require.resolve('../../src/main/wallet/privacy-storage')], undefined);
  const storage = require('../../src/main/wallet/privacy-storage');
  const original = storage.createPrivacyStorage;
  assert.equal(
    require.cache[require.resolve('../../src/main/wallet/railgun-account-enrollment')],
    undefined
  );
  const writes = [];
  const companionWrites = [];
  const recovery = require('./railgun-combined-poi-second-recovery-storage').create();
  storage.createPrivacyStorage = (options) => {
    const filename = storage.getPrivacyStoragePath(options.handle, options.directory);
    assert.equal(fs.existsSync(filename), true);
    const genuine = original(options);
    return Object.freeze({
      ...genuine,
      async get(name) {
        const value = await genuine.get(name);
        if (phase().startsWith('restart-')) {
          if (name === 'railgun-account-enrollment-v1')
            assert.equal(JSON.parse(value).status, 'active');
          if (
            [
              'railgun-wallet-catalog-v1',
              'railgun-public-catalog-v1',
              'freedom-railgun-host-scan-v1',
              'freedom-railgun-txid-v1',
              'railgun-wallet-journal-v1',
            ].includes(name)
          ) {
            assert.notEqual(value, null);
            assert.equal(JSON.parse(value).pending, null);
          }
        }
        return value;
      },
      async update(name, change) {
        let record;
        await genuine.update(name, (old) => {
          const next = change(old);
          if (phase().startsWith('second-recovery-companion-')) {
            const mutable = companionTransition(phase(), name, old, next);
            companionWrites.push({
              file: path.relative(directory, filename),
              record: name,
              mutable,
            });
          }
          if (phase().startsWith('restart-')) {
            try {
              record = {
                phase: phase(),
                file: path.relative(directory, filename),
                record: name,
                mutable: transition(name, old, next),
              };
            } catch (error) {
              sticky.record(error, 'restart-storage.transition');
              throw error;
            }
          }
          if (phase() === 'second-proof-recovery' || phase() === 'second-proof-present') {
            try {
              recovery.inspect(name, old, next, path.relative(directory, filename));
            } catch (error) {
              sticky.record(error, 'recovery-storage.transition');
              throw error;
            }
          }
          return next;
        });
        if (record) writes.push(record);
      },
      async set(name, value) {
        assert.equal(phase().startsWith('restart-'), false);
        assert.equal(phase().startsWith('second-recovery-companion-'), false);
        assert.ok(!['second-proof-recovery', 'second-proof-present'].includes(phase()));
        return genuine.set(name, value);
      },
    });
  };
  return Object.freeze({
    recovery,
    companionReport: () => companionWrites.map((v) => ({ ...v })),
    report: () => writes.map((v) => ({ ...v })),
    close() {
      storage.createPrivacyStorage = original;
    },
  });
}
module.exports = { install, transition, companionTransition };
