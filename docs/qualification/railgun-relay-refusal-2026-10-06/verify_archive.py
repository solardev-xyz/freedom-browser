"""Recheck public archive metadata only; no runtime, profile, service or crypto replay."""
if not __debug__:raise RuntimeError('Optimized Python forbidden')
from pathlib import Path
import hashlib,json
from validation import parse,exact,validate_report
HERE=Path(__file__).resolve().parent

def sha(raw):return hashlib.sha256(raw).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def load(name):return parse((HERE/name).read_bytes())

def main():
 index=load('INDEX.json')
 exact(index['schema'],'railgun-relay-refusal-archive-index-v1')
 expectedNames=['README.md','EXPECTED.json','validation.py','verify_archive.py','source-inputs.json','provenance.json','declined-disclosure-report.json','unrelated-history-report.json']
 exact(sorted(index['files']),sorted(expectedNames))
 for name,pin in index['files'].items():
  path=HERE/name;assert path.resolve()==path and path.is_file()
  raw=path.read_bytes();exact(dict(bytes=len(raw),sha256=sha(raw)),pin)
 common=load('source-inputs.json');provenance=load('provenance.json');expected=load('EXPECTED.json')
 exact(common['head'],provenance['sourceHead']);exact(common['head'],'7564aaa90de2e5da61981c4123d1599172c25442')
 exact([len(common[k]) for k in ['sources','sourceSymlinks','selectedSources','runtimeInputs','installedSqliteInputs']],[11723,15,637,4,17])
 for name,pin in common['selectedSources'].items():exact(common['sources'][name],pin)
 exact(sorted(provenance['cases']),['declined-disclosure','unrelated-history'])
 for scenario,case in provenance['cases'].items():
  records=case['originalRecords'];reportRaw=(HERE/records['report']['archiveFile']).read_bytes();report=parse(reportRaw)
  exact(records['report']['sha256'],sha(reportRaw));exact(records['report']['bytes'],len(reportRaw));exact(records['report']['exactBytesCopied'],True)
  frozen={**common,**case['freezeRemainder']}
  exact(records['sourceFreeze']['normalizedCanonicalSha256'],sha(canonical(frozen)))
  validate_report(report,frozen,expected)
  for record in records.values():
   if 'normalized'in record:exact(record['normalizedCanonicalSha256'],sha(canonical(record['normalized'])))
  result=records['RESULT.json']['normalized'];request=records['request']['normalized']
  exact(result['qualified'],True);exact(result['sourceFreezeSha256'],records['sourceFreeze']['sha256'])
  exact(result['reportSha256'],sha(reportRaw));exact(result['logSha256'],records['child.log']['sha256'])
  exact(records['child.log']['bytes'],0);exact(result['logSha256'],sha(b''))
  exact(records['POST-CHECK.json']['normalized'],dict(unchanged=True))
  exact(result['head'],common['head']);exact(result['scenario'],scenario)
  exact(frozen['requestSha256'],records['request']['sha256']);exact(request['approvedForNative'],True)
  for key in ['head','scenario','outputDirectory','evidenceDirectory','launcherFreezeSha256']:exact(request[key],frozen[key])
  final=records['process-001.json']['normalized'];initial=records['process-000.json']['normalized'];pid=case['originalElectronPid']
  assert type(pid)is int and pid>0
  exact(final,dict(state='finished',pid=pid,exitObserved=True,exitCode=0,timedOut=False,interrupted=False,terminateRequested=False,killRequested=False))
  exact(initial,dict(state='running',pid=pid,exitObserved=False,exitCode=None,timedOut=False,interrupted=False,terminateRequested=False,killRequested=False))
  exact(result['originalChild'],final)
  exact(provenance['rootObservation'][scenario]['originalElectronPid'],pid)
  exact(case['durationFromRecordedWallClockMs'],result['createdWindow'][1]-result['createdWindow'][0])
 print(json.dumps(dict(publicMetadataConsistent=True,exactReports=2,utilityRows=136,sourceEntries=11723,nativeOrCryptoReplay=False,runtimePayloadRehash=False,profileReads=False)))
if __name__=='__main__':main()
