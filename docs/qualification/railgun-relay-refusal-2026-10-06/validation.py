"""Source-derived exact report validator. No cryptography or profile reads."""
if not __debug__: raise RuntimeError('Optimized Python forbidden')
import hashlib,json,re

def parse(raw):
 def pairs(rows):
  value={}
  for key,item in rows:
   assert key not in value,'Duplicate JSON key';value[key]=item
  return value
 return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(AssertionError('Nonfinite JSON')))
def exact(a,b):
 assert type(a)is type(b),'Type differs'
 if type(a)is dict:
  assert set(a)==set(b),'Fields differ'
  for key in a:exact(a[key],b[key])
 elif type(a)is list:
  assert len(a)==len(b),'Length differs'
  for x,y in zip(a,b):exact(x,y)
 else:assert a==b,'Value differs'
def shape(value,keys):assert type(value)is dict and set(value)==set(keys),'Shape differs'
def natural(value,low=0,high=9007199254740991):assert type(value)is int and low<=value<=high
def digest(value):assert type(value)is str and re.fullmatch('[0-9a-f]{64}',value)

def fixed_fields(expected,scenario):
 case=expected['scenarios'][scenario]
 return dict(schema='railgun-relay-refusal-native-v1',scenario=scenario,result={k:case[k] for k in ['status','stage']},
  selectedInputType='Shield',inputAmount='2000',feeAmount='100',selfAmount='1900',exactReviewCallbacks=1,disclosureCallbacks=1,
  capturedHistoryUnrelated=scenario=='unrelated-history',refusalBeforeMembershipVerifier=True,signatureVerificationOfCapturedHistoryInThisRun=False,
  selectedServiceMethods=case['poiMethods'],syntheticOperationCanonicalHeaders=expected['operationHeaderRequests'],noDurableRelayRows=True,
  custodyLogicalInspectionUnchanged=True,relaySignerLaunched=False,relaySigningLoanIssued=False,proofProduced=False,liveServiceContact=False,
  realServiceAuthority=False,relaySendPermitted=False,syntheticPublicHistory=True,originalSourceSha256=expected['sourceSha256'],blockOffset=5944700,
  setupRanges=expected['ranges'],originalControllerDeadlineMs=180000,overallFixtureDeadlineMs=900000,sourceInventoryIsExecutionCoverage=False)

def validate_report(report,frozen,expected):
 fixed=fixed_fields(expected,frozen['scenario'])
 shape(report,[*fixed,'translatedLogsSha256','originalJobs','sourceSha256','syntheticRpcRequests'])
 exact({key:report[key] for key in fixed},fixed)
 exact(report['translatedLogsSha256'],frozen['translatedLogsSha256'])
 exact(report['sourceSha256'],frozen['selectedSources'])
 # Total setup RPC is recorded, not claimed as a source-derived exact count;
 # the operation's exact 15 canonical requests are checked above.
 natural(report['syntheticRpcRequests'],15,10000)
 rows=report['originalJobs'];assert type(rows)is list
 exact(len(rows),len(expected['originalUtilityRoles']))
 hashes=[];keys=0
 reads={'get','getMany','open','next','nextMany','seek','end'}
 writes={'batch','txBegin','txStage','txCommit','txAbort','txRead'}
 for row,role in zip(rows,expected['originalUtilityRoles']):
  shape(row,['role','inputSha256','messages','keyRequests','keyReplies','results','closedObserved','methods','guards','closed'])
  exact(row['role'],role);digest(row['inputSha256']);hashes.append(row['inputSha256'])
  exact(row['guards'],frozen['environment']['guards']);exact(row['results'],1);exact(row['closedObserved'],True)
  is_key=role in ['spending-public','viewing-identity','wallet-scan','wallet-restore','construct','reconstruct']
  exact(row['keyRequests'],int(is_key));exact(row['keyReplies'],int(is_key));keys+=row['keyReplies']
  methods=row['methods'];assert type(methods)is dict
  if role in ['spending-public','viewing-identity']:exact(methods,{'key':1,'result':1})
  elif role=='quote':exact(methods,{'result':1})
  elif role.startswith('public-'):
   allowed={'sourceNext','jobResult'}|(reads|writes if role=='public-apply' else set())
   assert set(methods)<=allowed;exact(methods.get('jobResult'),1);natural(methods.get('sourceNext'),1)
  else:
   allowed={'key','result'}|{c+'.'+m for c in ['public','wallet'] for m in reads}
   if role=='wallet-scan':allowed.add('wallet.batch')
   assert set(methods)<=allowed;exact(methods.get('key'),1);exact(methods.get('result'),1)
   for channel in ['public','wallet']:assert any(key.startswith(channel+'.') for key in methods)
  for value in methods.values():natural(value,1)
  natural(row['messages'],1);exact(row['messages'],sum(methods.values()))
  closed=row['closed'];shape(closed,['code','exitCode','escalated','peerDisconnected','peakRssBytes'])
  exact({key:value for key,value in closed.items() if key!='peakRssBytes'},dict(code='RAILGUN_PROCESS_CLOSED',exitCode=15,escalated=False,peerDisconnected=False))
  natural(closed['peakRssBytes'],0,768*1024*1024)
 exact(keys,6)
 # Public planning input excludes range and may repeat across empty ranges.
 # Hashes bind original bytes, but uniqueness is intentionally not asserted.
 return True

def translated_digest(raw):
 value=parse(raw);logs=value['logs'];exact([row['blockNumber'] for row in logs],[10,20,30])
 derived=[]
 for row in logs:
  item=dict(row);n=row['blockNumber']+5944700
  item.update(blockNumber=n,blockHash='0x'+format(n+1,'064x'),transactionHash='0x'+format(n+1000,'064x'));derived.append(item)
 return hashlib.sha256(json.dumps(derived,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
