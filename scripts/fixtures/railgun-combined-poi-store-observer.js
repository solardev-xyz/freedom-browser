/** Fixture-only delegated factory observation. Genuine enrollment supplies every
 * option and storage key; this observer issues no proof/owner capability. The
 * bounded key copy is wiped on replacement/close and never enters a worker/report. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { assert } = require('./railgun-native-assertions');
const sha = (v) => createHash('sha256').update(v).digest('hex');
exports.install = () => {
  assert.equal(
    require.cache[require.resolve('../../src/main/wallet/railgun-account-enrollment')],
    undefined
  );
  const module = require('../../src/main/wallet/railgun-poi-intent-store');
  const original = module.createRailgunPoiIntentStore;
  let latest;
  const copies = [];
  module.createRailgunPoiIntentStore = async (options) => {
    const store = await original(options);
    latest?.options.key.fill(0);
    latest = { store, options: { ...options, key: Buffer.from(options.key) } };
    copies.push(latest.options.key);
    assert.equal(latest.options.key.byteLength, 32);
    return store;
  };
  const current = (store) => {
    assert.ok(latest && latest.store === store);
    return latest.options;
  };
  const bytes = (options) => {
    const result = {};
    const visit = (dir) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name),
          st = fs.lstatSync(file);
        assert.equal(st.isSymbolicLink(), false);
        if (st.isDirectory()) visit(file);
        else {
          assert.ok(st.isFile());
          result[file] = sha(fs.readFileSync(file));
        }
      }
    };
    visit(path.dirname(options.directory));
    return result;
  };
  return Object.freeze({
    async document(store) {
      const options = current(store),
        {
          createPrivacyScope,
          getPrivacyContext,
        } = require('../../src/main/networks/privacy-context');
      const context = getPrivacyContext(options.handle),
        scope = createPrivacyScope({ profileId: context.profileId, signal: context.signal });
      try {
        const storage = require('../../src/main/wallet/privacy-storage').createPrivacyStorage({
          ...options,
          handle: scope.getContext(context.subject),
        });
        const value = JSON.parse(await storage.get('railgun-poi-intents-v1'));
        assert.ok([1, 2, 3].includes(value.version));
        return value;
      } finally {
        scope.close();
      }
    },
    async oldReader(store) {
      const options = current(store),
        filename =
          require.resolve('../../src/main/wallet/railgun-poi-intent-store-old-reader.fixture');
      assert.equal(
        sha(fs.readFileSync(filename)),
        '618bdff954dae9bf31836c8d1ab9b5100d7409b9f7f8e68844afdff4b577fb89'
      );
      store.close();
      await store.closed;
      const before = bytes(options);
      let floorCalls = 0,
        unexpected;
      try {
        await assert.rejects(
          async () => {
            unexpected = await require(filename).createRailgunPoiIntentStore({
              ...options,
              create: false,
              advanceFloor: async (sequence) => {
                floorCalls++;
                return options.advanceFloor(sequence);
              },
            });
          },
          { code: 'RAILGUN_POI_INTENT_STORE_REFUSED' }
        );
      } finally {
        unexpected?.close();
        if (unexpected?.closed) await unexpected.closed;
      }
      assert.equal(floorCalls, 0);
      assert.deepEqual(bytes(options), before);
      return {
        pinnedOldReaderWholeDocumentRefused: true,
        oldReaderFloorWrites: 0,
        oldReaderBytesUnchanged: true,
      };
    },
    report: () => ({
      copies: copies.length,
      unwiped: copies.filter((key) => key.some((v) => v !== 0)).length,
    }),
    close() {
      module.createRailgunPoiIntentStore = original;
      latest?.options.key.fill(0);
      latest = undefined;
    },
  });
};
