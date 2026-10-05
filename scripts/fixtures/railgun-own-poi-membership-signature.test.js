/** Real Node module-cache and Ed25519 tests. No mocked verification/registry,
 * network, enrolled account, POI proof or live service acceptance is exercised. */
const { execFileSync } = require('child_process');
const path = require('path');
const fixture = require.resolve('./railgun-own-poi-membership-signature');
const wallet = path.resolve(__dirname, '../../src/main/wallet');
const prelude = `
const assert = require('assert/strict');
const crypto = require('crypto');
const fixture = require(${JSON.stringify(fixture)});
const wallet = ${JSON.stringify(wallet)};
const originalVerify = crypto.verify;
const listKey = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';
const recordsPath = require.resolve(wallet + '/railgun-poi-records');
const event = {index: 0, blindedCommitment: '0x' + '1'.repeat(64), type: 'Transact'};
const proof = {leaf: event.blindedCommitment.slice(2), indices: '0'.repeat(64), elements: Array(16).fill('0'.repeat(64)), root:'2'.repeat(64)};
const note = {blindedCommitment:event.blindedCommitment,type:event.type};
function evidence(value = event) {
  const signing = fixture.install();
  const result = {publicKeySpki:signing.exportPublicKey(),listKey,event:{...value},signature:signing.sign(value)};
  signing.close();
  return result;
}
function verify(options, records = require(recordsPath)) {
  return records.verifyPoiEvent([{signedPOIEvent:{...options.event,signature:options.signature},validatedMerkleroot:proof.root}], {...note,type:options.event.type}, proof);
}
`;
function run(code) {
  return execFileSync(process.execPath, ['-e', prelude + code], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 128 * 1024,
  });
}

test('legacy signing keeps its behavior and exports only immutable canonical public SPKI', () => {
  run(`
    const signing = fixture.install();
    assert.deepEqual(Object.keys(signing).sort(), ['attempts','close','exportPublicKey','sign']);
    assert.ok(Object.isFrozen(signing));
    const publicKeySpki = signing.exportPublicKey();
    assert.match(publicKeySpki, /^302a300506032b6570032100[0-9a-f]{64}$/);
    assert.equal(typeof publicKeySpki, 'string');
    assert.equal(signing.exportPublicKey(),publicKeySpki);
    assert.throws(() => crypto.createPrivateKey({key:Buffer.from(publicKeySpki,'hex'),format:'der',type:'pkcs8'}));
    const options = {publicKeySpki,listKey,event,signature:signing.sign(event)};
    assert.equal(signing.attempts(),0);
    assert.equal(verify(options).signedPOIEvent.signature,options.signature);
    assert.equal(signing.attempts(),1);
    const captured = require(recordsPath);
    signing.close(); signing.close();
    assert.throws(() => signing.sign(event));
    assert.throws(() => signing.exportPublicKey());
    assert.throws(() => verify(options,captured));
    assert.equal(crypto.verify,originalVerify);
    assert.equal(require.cache[recordsPath],undefined);
    assert.throws(() => verify(options));
  `);
});

test.each(['Shield', 'Transact'])(
  'replay uses real verification for %s without key generation or signing',
  (type) => {
    run(`
    const options = evidence({...event,type:${JSON.stringify(type)}});
    crypto.generateKeyPairSync = () => assert.fail('Replay generated a key');
    crypto.sign = () => assert.fail('Replay signed');
    const replay = fixture.installReplay(options);
    assert.deepEqual(Object.keys(replay).sort(),['attempts','close']);
    assert.ok(Object.isFrozen(replay));
    assert.equal(crypto.verify,originalVerify);
    assert.equal(replay.attempts(),0);
    const records = require(recordsPath);
    assert.equal(verify(options,records).signedPOIEvent.signature,options.signature);
    assert.equal(replay.attempts(),1);
    assert.throws(() => verify({...options,signature:'0'.repeat(128)},records));
    assert.equal(replay.attempts(),2);
    replay.close(); replay.close();
    assert.throws(() => verify(options,records));
    assert.equal(require.cache[recordsPath],undefined);
    assert.throws(() => verify(options));
    assert.equal(crypto.verify,originalVerify);
  `);
  }
);

test('actual public-only handoff verifies in a different process', () => {
  const serialized = run(
    'process.stdout.write(JSON.stringify({pid:process.pid,options:evidence()}));'
  );
  const handoff = JSON.parse(serialized);
  expect(Object.keys(handoff.options).sort()).toEqual([
    'event',
    'listKey',
    'publicKeySpki',
    'signature',
  ]);
  run(`
    const handoff = ${JSON.stringify(handoff)};
    assert.notEqual(process.pid,handoff.pid);
    assert.throws(() => process.kill(handoff.pid,0), error => error.code === 'ESRCH');
    const replay = fixture.installReplay(handoff.options);
    verify(handoff.options);
    assert.equal(replay.attempts(),1);
    replay.close();
  `);
});

test('signature binds optional prefix and canonical property order, not caller insertion order', () => {
  run(`
    const options = evidence({...event,blindedCommitment:event.blindedCommitment.slice(2)});
    const replay = fixture.installReplay({...options,event:{type:event.type,blindedCommitment:options.event.blindedCommitment,index:0}});
    verify(options);
    assert.throws(() => verify({...options,event}));
    replay.close();
    const keys=crypto.generateKeyPairSync('ed25519');
    const reordered={type:event.type,blindedCommitment:event.blindedCommitment,index:0};
    const wrong={publicKeySpki:keys.publicKey.export({format:'der',type:'spki'}).toString('hex'),listKey,event,signature:crypto.sign(null,Buffer.from(JSON.stringify(reordered)),keys.privateKey).toString('hex')};
    assert.throws(() => fixture.installReplay(wrong));
    assert.equal(require.cache[recordsPath],undefined);
  `);
});

const bad = [
  ['missing option', 'delete options.signature'],
  ['extra option', 'options.secret = "forbidden"'],
  ['wrong list', 'options.listKey = "0".repeat(64)'],
  ['production key', 'options.publicKeySpki = "302a300506032b6570032100" + listKey'],
  [
    'foreign key',
    'options.publicKeySpki = crypto.generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).toString("hex")',
  ],
  [
    'non Ed25519 key',
    'options.publicKeySpki = crypto.generateKeyPairSync("ed448").publicKey.export({format:"der",type:"spki"}).toString("hex")',
  ],
  ['trailing key bytes', 'options.publicKeySpki += "00"'],
  ['uppercase key', 'options.publicKeySpki = options.publicKeySpki.toUpperCase()'],
  ['buffer key', 'options.publicKeySpki = Buffer.from(options.publicKeySpki,"hex")'],
  ['bad DER', 'options.publicKeySpki = "00".repeat(44)'],
  ['wrong signature', 'options.signature = "0".repeat(128)'],
  ['truncated signature', 'options.signature = options.signature.slice(2)'],
  ['uppercase signature', 'options.signature = options.signature.toUpperCase()'],
  ['buffer signature', 'options.signature = Buffer.from(options.signature,"hex")'],
  ['changed event', 'options.event.index = 1'],
  ['negative index', 'options.event.index = -1'],
  ['out of range index', 'options.event.index = 65536'],
  ['fractional index', 'options.event.index = 0.5'],
  ['wrong type', 'options.event.type = "partial-unshield"'],
  ['invalid field', 'options.event.blindedCommitment = "0x" + "f".repeat(64)'],
  ['uppercase field', 'options.event.blindedCommitment = "0X" + "1".repeat(64)'],
  ['extra event property', 'options.event.root = "0".repeat(64)'],
  ['symbol property', 'options[Symbol("extra")] = true'],
  ['inherited options', 'Object.setPrototypeOf(options,{})'],
  ['inherited event', 'Object.setPrototypeOf(options.event,{})'],
];
test.each(bad)(
  'rejects %s before import, restores global verify and permits later genuine replay',
  (_name, mutation) => {
    run(`
    const genuine = evidence();
    const options = JSON.parse(JSON.stringify(genuine));
    ${mutation};
    assert.throws(() => fixture.installReplay(options));
    assert.equal(crypto.verify,originalVerify);
    assert.equal(require.cache[recordsPath],undefined);
    const replay = fixture.installReplay(genuine);
    verify(genuine);
    replay.close();
  `);
  }
);

test.each(['options', 'event'])(
  'rejects %s proxy/accessor without invoking caller hooks',
  (target) => {
    run(`
    const genuine = evidence();
    let calls=0;
    const trapped = new Proxy(${target === 'options' ? 'genuine' : 'genuine.event'},{get(){calls++;throw Error('hook');},ownKeys(){calls++;throw Error('hook');},getPrototypeOf(){calls++;throw Error('hook');}});
    assert.throws(() => fixture.installReplay(${target === 'options' ? 'trapped' : '{...genuine,event:trapped}'}));
    const unsafe = {...${target === 'options' ? 'genuine' : 'genuine.event'}};
    Object.defineProperty(unsafe,${JSON.stringify(target === 'options' ? 'signature' : 'index')},{enumerable:true,get(){calls++;throw Error('hook');}});
    assert.throws(() => fixture.installReplay(${target === 'options' ? 'unsafe' : '{...genuine,event:unsafe}'}));
    assert.equal(calls,0);
    assert.equal(require.cache[recordsPath],undefined);
    const replay = fixture.installReplay(genuine);verify(genuine);replay.close();
  `);
  }
);

test.each([
  'railgun-poi-records',
  'railgun-poi-source',
  'railgun-poi-membership',
  'railgun-account-poi',
  'railgun-own-poi-membership',
])('refuses replay after %s consumer cache admission', (name) => {
  run(`
    const options=evidence();
    const filename=require.resolve(wallet + '/' + ${JSON.stringify(name)});
    // An occupied consumer-cache slot is the boundary: do not import native/UI
    // dependencies merely to test the already-loaded admission refusal.
    require.cache[filename]={exports:{}};
    assert.throws(() => fixture.installReplay(options));
    assert.equal(crypto.verify,originalVerify);
    delete require.cache[filename];
    const replay=fixture.installReplay(options);verify(options);replay.close();
  `);
});

test('signature installer refuses concurrent replay and leaves legacy verifier usable', () => {
  run(`
    const signing=fixture.install();
    const options={publicKeySpki:signing.exportPublicKey(),listKey,event,signature:signing.sign(event)};
    assert.throws(() => fixture.installReplay(options));
    verify(options);assert.equal(signing.attempts(),1);
    signing.close();
    const replay=fixture.installReplay(options);verify(options);replay.close();
  `);
});

const lowOrderPoints = [
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
];
const nonCanonicalPoints = [
  ['y equals field modulus', 'ed' + 'ff'.repeat(30) + '7f'],
  ['noncanonical identity', 'ee' + 'ff'.repeat(30) + '7f'],
  ['sign-bit identity', '01' + '00'.repeat(30) + '80'],
  ['sign-bit order-two point', 'ec' + 'ff'.repeat(31)],
];
test.each([
  ...lowOrderPoints.map((point, index) => [`canonical low-order point ${index}`, point]),
  ...nonCanonicalPoints,
])(
  'rejects %s before delegating to crypto even where a runtime might reject it',
  (_name, point) => {
    run(`
    const options = {publicKeySpki:'302a300506032b6570032100' + ${JSON.stringify(point)}, listKey, event, signature:'01' + '00'.repeat(63)};
    let calls=0;
    crypto.verify=(...args)=>{calls++;return originalVerify(...args);};
    const observed=crypto.verify;
    assert.throws(()=>fixture.installReplay(options));
    assert.equal(calls,0,'Unsafe point must refuse before runtime crypto');
    assert.equal(crypto.verify,observed);
    assert.equal(require.cache[recordsPath],undefined);
    crypto.verify=originalVerify;
    const good=evidence();
    const replay=fixture.installReplay(good);verify(good);replay.close();
  `);
  }
);

test('rejects identity universal-signature forgery despite actual Node OpenSSL acceptance', () => {
  run(`
    const publicKeySpki='302a300506032b6570032100' + '01' + '00'.repeat(31);
    const options={publicKeySpki,listKey,event,signature:'01' + '00'.repeat(63)};
    const key=crypto.createPublicKey({key:Buffer.from(publicKeySpki,'hex'),format:'der',type:'spki'});
    const bytes=Buffer.from(options.signature,'hex');
    assert.equal(originalVerify(null,Buffer.from(JSON.stringify(event)),key,bytes),true);
    assert.equal(originalVerify(null,Buffer.from(JSON.stringify({...event,index:1})),key,bytes),true);
    assert.throws(()=>fixture.installReplay(options));
    assert.equal(require.cache[recordsPath],undefined);
    assert.equal(crypto.verify,originalVerify);
  `);
});

test('rejects an order-eight key with a signature that actual Node crypto accepts', () => {
  run(`
    const publicKeySpki='302a300506032b6570032100' + '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05';
    const key=crypto.createPublicKey({key:Buffer.from(publicKeySpki,'hex'),format:'der',type:'spki'});
    const signature='01'+'00'.repeat(63);
    let accepted;
    for(let index=0;index<256;index++){
      const candidate={...event,index};
      const message=Buffer.from(JSON.stringify(candidate));
      if(originalVerify(null,message,key,Buffer.from(signature,'hex'))){accepted=candidate;break;}
    }
    assert.ok(accepted,'Bounded real-crypto search must find admitted order-eight evidence');
    assert.throws(()=>fixture.installReplay({publicKeySpki,listKey,event:accepted,signature}));
    assert.equal(require.cache[recordsPath],undefined);
  `);
});
