jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
}));
const { transition } = require('./railgun-combined-poi-restart-storage');
test('observer refuses a storage module loaded before instrumentation', () => {
  const script = `
    const assert = require('assert/strict');
    const storage = require.resolve('./src/main/wallet/privacy-storage');
    const cached = { exports: {} };
    require.cache[storage] = cached;
    const observer = require('./scripts/fixtures/railgun-combined-poi-restart-storage');
    assert.throws(() => observer.install({ directory: '/unused', phase: () => 'restart-bootstrap' }));
    assert.equal(require.cache[storage], cached);
    assert.deepEqual(cached.exports, {});
  `;
  const result = require('child_process').spawnSync(process.execPath, ['-e', script], {
    cwd: require('path').resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
});
const a = 'a'.repeat(64),
  b = 'b'.repeat(64);
function check(name, old, value) {
  return transition(name, JSON.stringify(old), JSON.stringify(value));
}
test.each(['railgun-wallet-catalog-v1', 'railgun-public-catalog-v1'])(
  'only constructor lease + one sequence on %s',
  (name) => {
    const old = {
      lease: a,
      sequence: 2,
      pending: null,
      active: { id: 'same' },
    };
    expect(check(name, old, { ...old, lease: b, sequence: 3 })).toEqual(['lease', 'sequence']);
    expect(() =>
      check(name, old, {
        ...old,
        lease: b,
        sequence: 3,
        active: { id: 'new' },
      })
    ).toThrow();
    expect(() => check(name, old, { ...old, lease: b, sequence: 4 })).toThrow();
  }
);
test.each(['freedom-railgun-host-scan-v1', 'freedom-railgun-txid-v1'])(
  'journal %s cannot recover pending or alter checkpoint',
  (name) => {
    const old = {
      lease: a,
      sequence: 2,
      generation: 1,
      pending: null,
      checkpoint: { root: 'same' },
    };
    expect(check(name, old, { ...old, lease: b, sequence: 3, generation: 2 })).toHaveLength(3);
    expect(() =>
      check(name, { ...old, pending: {} }, { ...old, lease: b, sequence: 3, generation: 2 })
    ).toThrow();
    expect(() =>
      check(name, old, {
        ...old,
        lease: b,
        sequence: 3,
        generation: 2,
        checkpoint: { root: 'new' },
      })
    ).toThrow();
  }
);
test.each([
  'railgun-private-reservations-v1',
  'railgun-private-capsules-v1',
  'railgun-poi-intents-v1',
])('only lease may change %s', (name) => {
  const old = {
    lease: a,
    sequence: 2,
    entries: [{ state: 'attempted', payload: 'same' }],
  };
  expect(check(name, old, { ...old, lease: b })).toEqual(['lease']);
  expect(() => check(name, old, { ...old, lease: b, entries: [] })).toThrow();
  expect(() => check(name, old, { ...old, lease: b, sequence: 3 })).toThrow();
});
test('unknown writes and initialization refuse', () => {
  expect(() => transition('railgun-private-capsules-v1', null, '{}')).toThrow();
  expect(() => check('arbitrary', {}, {})).toThrow();
  expect(() =>
    check('railgun-account-enrollment-v1', { status: 'pending' }, { status: 'active' })
  ).toThrow();
});
test.each([
  'railgun-private-reservations-floor-v1',
  'railgun-private-capsules-floor-v1',
  'railgun-poi-intents-floor-v1',
])('floor %s must be exact', (name) => {
  expect(check(name, { sequence: 2 }, { sequence: 2 })).toEqual([]);
  expect(() => check(name, { sequence: 2 }, { sequence: 3 })).toThrow();
});

// Separate setup process creates real encrypted fixture storage without defeating
// the observer's required first-import guard in the process under test.
test('installed observer delegates genuine storage while bootstrap checks stop at second/terminal phases', () => {
  const fs = require('fs'),
    path = require('path'),
    directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'restart-storage-installed-'));
  const setup = String.raw`
    const assert=require('assert/strict'), fs=require('fs');
    const {createPrivacyScope}=require('./src/main/networks/privacy-context');
    const scope=createPrivacyScope({profileId:'restart-storage-unit',signal:new AbortController().signal});
    const subject={kind:'private-account',principal:'a',protocol:'railgun',deployment:'sepolia',chainId:11155111,role:'storage'};
    const handle=scope.getContext(subject), directory=process.argv[1], key=Buffer.alloc(32,7);
    const options={handle,directory,key};
  `;
  const seed =
    setup +
    String.raw`
    const storage=require('./src/main/wallet/privacy-storage');
    (async()=>{
      const store=storage.createPrivacyStorage(options);
      await store.set('freedom-railgun-txid-v1',JSON.stringify({pending:{work:'legitimate-terminal-work'}}));
      await store.set('railgun-account-enrollment-v1',JSON.stringify({status:'pending'}));
      await store.set('railgun-wallet-catalog-v1',JSON.stringify({lease:'a'.repeat(64),sequence:2,pending:null,active:{id:'same'}}));
      scope.close();
    })().catch(e=>{console.error(e);process.exitCode=1});
  `;
  const exercise =
    setup +
    String.raw`
    const observerModule=require('./scripts/fixtures/railgun-combined-poi-restart-storage');
    const sticky=require('./scripts/fixtures/railgun-native-assertions');
    let phase='restart-bootstrap';
    const observer=observerModule.install({directory,phase:()=>phase});
    const storage=require('./src/main/wallet/privacy-storage');
    const wrappedFactory=storage.createPrivacyStorage;
    (async()=>{
      const filename=storage.getPrivacyStoragePath(handle,directory);
      const before=fs.readFileSync(filename);
      const store=storage.createPrivacyStorage(options);
      assert.throws(()=>storage.createPrivacyStorage({...options,handle:scope.getContext({...subject,principal:'missing'})}));
      assert.deepEqual(fs.readdirSync(directory),[require('path').basename(filename)]);
      await assert.rejects(store.get('freedom-railgun-txid-v1'));
      await assert.rejects(store.get('railgun-account-enrollment-v1'));
      await assert.rejects(store.set('anything','new'));
      let attempts=0;
      await assert.rejects(store.update('unknown-record',()=>{attempts++;return 'new'}));
      assert.equal(attempts,1);
      assert.ok(sticky.report().some(v=>v.label==='restart-storage.transition'));
      assert.deepEqual(fs.readFileSync(filename),before);
      let allowedCalls=0;
      await store.update('railgun-wallet-catalog-v1',old=>{allowedCalls++;const v=JSON.parse(old);return JSON.stringify({...v,lease:'b'.repeat(64),sequence:v.sequence+1})});
      assert.equal(allowedCalls,1);
      assert.equal(JSON.parse(await store.get('railgun-wallet-catalog-v1')).sequence,3);
      assert.deepEqual(observer.report().map(v=>[v.record,v.mutable]),[['railgun-wallet-catalog-v1',['lease','sequence']]]);
      const afterBootstrap=fs.readFileSync(filename);
      for(const nextPhase of ['second-open-wallet','terminal-txid-advance']){
        phase=nextPhase;
        assert.equal(await store.get('freedom-railgun-txid-v1'),JSON.stringify({pending:{work:'legitimate-terminal-work'}}));
        assert.equal(await store.get('railgun-account-enrollment-v1'),JSON.stringify({status:'pending'}));
      }
      assert.deepEqual(fs.readFileSync(filename),afterBootstrap);
      let terminalCalls=0;
      await store.update('freedom-railgun-txid-v1',old=>{terminalCalls++;assert.ok(JSON.parse(old).pending);return JSON.stringify({pending:null,completed:true})});
      assert.equal(terminalCalls,1);
      assert.equal(await store.get('freedom-railgun-txid-v1'),JSON.stringify({pending:null,completed:true}));
      await store.set('terminal-fixture-value','delegated');
      assert.equal(await store.get('terminal-fixture-value'),'delegated');
      assert.equal(observer.report().length,1);
      observer.close();
      assert.notEqual(storage.createPrivacyStorage,wrappedFactory);
      const reopened=storage.createPrivacyStorage(options);
      assert.equal(await reopened.get('terminal-fixture-value'),'delegated');
      assert.equal(await reopened.get('freedom-railgun-txid-v1'),JSON.stringify({pending:null,completed:true}));
      assert.equal(fs.readFileSync(filename,'utf8').includes('legitimate-terminal-work'),false);
    })().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{observer.close();scope.close()});
  `;
  for (const script of [seed, exercise]) {
    const result = require('child_process').spawnSync(process.execPath, ['-e', script, directory], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  }
});
