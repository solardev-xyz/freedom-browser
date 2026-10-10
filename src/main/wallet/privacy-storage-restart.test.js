/** Host storage assertions retained from the historical cold bootstrap observer.
 * Two ordinary Node children use only disposable, public synthetic store data.
 * Campaign record/phase admission remains historical; no owner is constructed. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

test('encrypted storage survives an original process boundary and rejected callbacks leave bytes intact', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-storage-restart-'));
  const setup = `
    const assert=require('assert/strict'), fs=require('fs');
    const {createPrivacyScope}=require('./src/main/networks/privacy-context');
    const scope=createPrivacyScope({profileId:'restart-storage-unit',signal:new AbortController().signal});
    const subject={kind:'private-account',principal:'a',protocol:'railgun',deployment:'sepolia',chainId:11155111,role:'storage'};
    const handle=scope.getContext(subject), directory=process.argv[1], key=Buffer.alloc(32,7);
    const storage=require('./src/main/wallet/privacy-storage');
    const options={handle,directory,key};
  `;
  const seed =
    setup +
    `
    (async()=>{
      const store=storage.createPrivacyStorage(options);
      await store.set('public-catalog',JSON.stringify({lease:'a'.repeat(64),sequence:2,pending:null,active:{id:'same'}}));
      await store.set('public-journal',JSON.stringify({pending:{work:'legitimate-terminal-work'}}));
      await store.set('public-capsule',JSON.stringify({lease:'a'.repeat(64),sequence:4,entries:[{signature:'public-test-vector',proof:null}]}));
      await store.set('public-floor',JSON.stringify({sequence:4}));
    })().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>scope.close());
  `;
  const exercise =
    setup +
    `
    (async()=>{
      const filename=storage.getPrivacyStoragePath(handle,directory), before=fs.readFileSync(filename);
      const store=storage.createPrivacyStorage(options);
      assert.deepEqual(fs.readdirSync(directory),[require('path').basename(filename)]);
      let attempts=0;
      await assert.rejects(store.update('unknown-record',()=>{attempts++;throw Error('refused synthetic transition')}));
      assert.equal(attempts,1);assert.deepEqual(fs.readFileSync(filename),before);
      let allowedCalls=0;
      await store.update('public-catalog',old=>{allowedCalls++;const v=JSON.parse(old);return JSON.stringify({...v,lease:'b'.repeat(64),sequence:v.sequence+1})});
      assert.equal(allowedCalls,1);
      assert.deepEqual(JSON.parse(await store.get('public-catalog')),{lease:'b'.repeat(64),sequence:3,pending:null,active:{id:'same'}});
      const afterBootstrap=fs.readFileSync(filename);
      assert.equal(await store.get('public-journal'),JSON.stringify({pending:{work:'legitimate-terminal-work'}}));
      assert.deepEqual(fs.readFileSync(filename),afterBootstrap);
      let terminalCalls=0;
      await store.update('public-journal',old=>{terminalCalls++;assert.ok(JSON.parse(old).pending);return JSON.stringify({pending:null,completed:true})});
      assert.equal(terminalCalls,1);
      await store.set('terminal-fixture-value','delegated');
      const beforeRefusal=fs.readFileSync(filename);
      await assert.rejects(store.update('public-capsule',old=>{const value=JSON.parse(old);value.entries[0].proof='forbidden';throw Error('cancelled synthetic transition')}));
      assert.deepEqual(fs.readFileSync(filename),beforeRefusal);
      await store.update('public-capsule',old=>JSON.stringify({...JSON.parse(old),lease:'b'.repeat(64)}));
      await store.update('public-floor',old=>old);
      assert.deepEqual(JSON.parse(await store.get('public-capsule')),{lease:'b'.repeat(64),sequence:4,entries:[{signature:'public-test-vector',proof:null}]});
      assert.deepEqual(JSON.parse(await store.get('public-floor')),{sequence:4});
      const reopened=storage.createPrivacyStorage(options);
      assert.equal(await reopened.get('terminal-fixture-value'),'delegated');
      assert.equal(await reopened.get('public-journal'),JSON.stringify({pending:null,completed:true}));
      assert.equal(fs.readFileSync(filename,'utf8').includes('legitimate-terminal-work'),false);
    })().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>scope.close());
  `;
  try {
    for (const script of [seed, exercise]) {
      const result = spawnSync(process.execPath, ['-e', script, directory], {
        cwd: path.resolve(__dirname, '../../..'),
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(result.error).toBeUndefined();
      expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
        status: 0,
        signal: null,
        stderr: '',
      });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
