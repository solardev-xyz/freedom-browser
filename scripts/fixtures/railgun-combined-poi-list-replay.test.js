// Fresh Node module cache for real Ed25519 + real production wire normalizers.
// The fabricated unit Merkle path is NOT a cryptographic membership test; the
// native resumed POI job must independently verify its saved real Poseidon path.
const { execFileSync } = require('child_process');
const path = require('path');
const script = String.raw`
const assert=require('assert/strict'),path=require('path');
const root=process.argv[1],control=process.argv[2];
const signature=require(path.join(root,'railgun-own-poi-membership-signature'));
const list=require(path.join(root,'railgun-combined-poi-list-replay'));
const installed=signature.install();
const records=require(path.join(root,'../../src/main/wallet/railgun-poi-records'));
const field=(n)=>BigInt(n).toString(16).padStart(64,'0');
const note={blindedCommitment:'0x'+field(1),type:'Transact'};
const event={index:0,blindedCommitment:note.blindedCommitment,type:'Transact'};
const signed={...event,signature:installed.sign(event)};
const proof={leaf:field(1),indices:field(0),elements:Array(16).fill(field(0)),root:field(2)};
const payload={listKey:records.REQUIRED_LIST,blindedCommitmentsOut:[note.blindedCommitment]};
const value={publicKeySpki:installed.exportPublicKey(),listKey:payload.listKey,note,answers:{
 ppoi_pois_per_list:{[note.blindedCommitment]:{[payload.listKey]:'Valid'}},
 ppoi_merkle_proofs:[proof],ppoi_poi_events:[{signedPOIEvent:signed,validatedMerkleroot:proof.root}],ppoi_validate_poi_merkleroots:true,
}};
const setupKey=value.publicKeySpki;installed.close();
if(control==='key')value.publicKeySpki='302a300506032b6570032100'+'01'.repeat(32);
if(control==='signature')value.answers.ppoi_poi_events[0].signedPOIEvent.signature='00'.repeat(64);
let replay,provider;
try {
 if(['key','signature'].includes(control)){assert.throws(()=>signature.installReplay(list.replayOptions(value)));process.exit(0);}
 replay=signature.installReplay(list.replayOptions(value));
 assert.equal(typeof replay.sign,'undefined');
 if(control==='root')value.answers.ppoi_poi_events[0].validatedMerkleroot=field(3);
 if(control==='leaf')value.answers.ppoi_merkle_proofs[0].leaf=field(4);
 if(control==='type')value.note.type='Shield';
 if(control==='status')value.answers.ppoi_pois_per_list[note.blindedCommitment][payload.listKey]='Missing';
 if(control==='payload')payload.blindedCommitmentsOut=['0x'+field(5)];
 if(['root','leaf','type','status','payload'].includes(control)){assert.throws(()=>list.create(value,payload));process.exit(0);}
 provider=list.create(value,payload);
 assert.equal(value.publicKeySpki,setupKey);
 assert.equal(provider.acceptPost,undefined);assert.equal(provider.sign,undefined);
 assert.equal(Object.hasOwn(provider.report(),'accepted'),false);
 const params={chainType:'0',chainID:'11155111',txidVersion:'V2_PoseidonMerkle',listKey:payload.listKey,blindedCommitments:[note.blindedCommitment]};
 assert.deepEqual(provider.answer('ppoi_merkle_proofs',params),[proof]);
 value.answers.ppoi_merkle_proofs[0].leaf=field(9);
 assert.equal(provider.answer('ppoi_merkle_proofs',params)[0].leaf,field(1));
 assert.throws(()=>provider.answer('ppoi_submit_transact_proof',{}));
 assert.throws(()=>provider.answer('ppoi_merkle_proofs',{...params,blindedCommitments:['0x'+field(8)]}));
 assert.throws(()=>provider.assertChange({type:'Transact',blindedCommitment:'0x'+field(3)}));
 assert.throws(()=>list.assertProvider({...provider}));
 provider.close();assert.throws(()=>provider.answer('ppoi_merkle_proofs',params));
}finally{provider?.close();replay?.close();}
`;
test.each(['healthy', 'key', 'signature', 'root', 'leaf', 'type', 'status', 'payload'])(
  'public-key replay: %s',
  (control) => {
    expect(() =>
      execFileSync(process.execPath, ['-e', script, __dirname, control], {
        timeout: 10000,
        stdio: 'pipe',
      })
    ).not.toThrow();
  }
);
test('saved helper dependency is colocated with tested replay module', () => {
  expect(path.dirname(require.resolve('./railgun-own-poi-membership-signature'))).toBe(__dirname);
});
