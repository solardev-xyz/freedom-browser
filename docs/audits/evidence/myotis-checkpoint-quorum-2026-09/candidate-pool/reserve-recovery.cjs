const fs = require('node:fs');
const path = require('node:path');
const repo = process.cwd();
const { verifyCheckpoint } = require(path.join(repo,'src/main/myotis/checkpoint-verifier-worker'));
const { CHECKPOINT_NETWORKS } = require(path.join(repo,'src/main/myotis/checkpoint-verifier'));
const sources = CHECKPOINT_NETWORKS[1].sources;
const events=[];
const deadline=setTimeout(()=>{console.error('deadline');process.exit(1);},90000);
const fetchWithOutages = async(url, options)=>{
 if(sources.slice(0,3).some(source=>url.startsWith(source+'/'))){events.push({url,injected:'unavailable'});throw new Error('simulated original-provider outage');}
 const response=await fetch(url,options);events.push({url,status:response.status});return response;
};
(async()=>{
 try { const checkpoint=await verifyCheckpoint(1,{fetch:fetchWithOutages});
  if(checkpoint.sources.some(source=>sources.slice(0,3).includes(source)))throw new Error('unavailable source voted');
  fs.writeFileSync(process.argv[2] || '/private/tmp/pool-live-result.json',JSON.stringify({checkpoint,events},null,2));console.log(JSON.stringify({checkpoint,events}));
 }catch(error){console.error(JSON.stringify({code:error.code,message:error.message,events}));process.exitCode=1;}finally{clearTimeout(deadline);}
})();
