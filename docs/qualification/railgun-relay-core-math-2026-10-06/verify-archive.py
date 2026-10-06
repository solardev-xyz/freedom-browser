"""Verify public archive bytes; optionally reconstruct original metadata in memory.
No runtime imports, subprocesses, network, profiles or source checkout are read.
Original prefix arguments are strings used for reconstruction only, not paths read.
"""
if not __debug__:
    raise RuntimeError('Optimized Python forbidden')
import argparse
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
encode = lambda value: (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()


def read(name):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            assert key not in result, 'Duplicate JSON key'
            result[key] = value
        return result
    return json.loads((HERE / name).read_bytes(), object_pairs_hook=unique)


def expand(value, prefixes):
    if isinstance(value, str):
        for marker, prefix in prefixes.items():
            value = value.replace(marker, prefix)
        return value
    if isinstance(value, list):
        return [expand(v, prefixes) for v in value]
    if isinstance(value, dict):
        return {expand(k, prefixes): expand(v, prefixes) for k, v in value.items()}
    return value


def verify(repo_prefix=None, scratch_prefix=None):
    index = read('INDEX.json')
    assert index['kind'] == 'Reviewed public archive; exact copies and derived metadata explicitly distinguished'
    for name, entry in index['files'].items():
        assert Path(name).name == name and name not in ['.', '..']
        file = HERE / name
        assert file.is_file() and not file.is_symlink()
        raw = file.read_bytes()
        assert len(raw) == entry['bytes'] and sha(raw) == entry['sha256'], name
    provenance, inputs = read('PROVENANCE.json'), read('INPUTS.json')
    originals = provenance['originalRecords']
    for name in ['report.json', 'child.log', 'process-001.json', 'process-002.json', 'RESULT.json']:
        raw = (HERE / name).read_bytes()
        assert len(raw) == originals[name]['bytes'] and sha(raw) == originals[name]['sha256'], name
    assert (HERE / 'child.log').read_bytes() == b''
    assert provenance['engineeringReview']['status'] == 'clear'
    report, result = read('report.json'), read('RESULT.json')
    assert result['qualified'] is True and result['exitCode'] == 0
    assert result['reportSha256'] == sha((HERE / 'report.json').read_bytes())
    parent = read('process-002.json')
    assert parent['state'] == 'finished' and parent['exitObserved'] is True and parent['exitCode'] == 0
    assert all(parent[key] is False for key in ['timedOut', 'interrupted', 'terminateRequested', 'killRequested'])
    assert parent['pid'] == result['pid'] == read('process-001.json')['pid']
    assert result['reportedOriginalUtilityClosures'] == len(report['originalJobs']) == 2
    assert [row['role'] for row in report['originalJobs']] == ['producer', 'recovery-math']
    assert all(row['exitCode'] == 15 and row['escalated'] is False and row['peerDisconnected'] is False for row in report['originalJobs'])
    assert len(inputs['sources']) == 13728 and len(inputs['sourceLinks']) == 15
    assert len(inputs['runtimeInputs']) == 2389 and len(report['sourceSha256']) == 612
    assert all(inputs['sources'][name] == pin for name, pin in report['sourceSha256'].items())
    assert (repo_prefix is None) == (scratch_prefix is None), 'Supply both original prefixes or neither'
    reconstructed = []
    if repo_prefix is not None:
        prefixes = {'${REPO}': repo_prefix, '${SCRATCH}': scratch_prefix}
        for marker, prefix in prefixes.items():
            assert sha(prefix.encode()) == provenance['normalization']['prefixes'][marker]['sha256'], marker
        original_inputs = expand(inputs, prefixes)
        metadata = expand(provenance['originalFreezeMetadata'], prefixes)
        frozen = {key: original_inputs[key] if key in original_inputs else metadata[key]
                  for key in provenance['originalFreezeKeyOrder']}
        values = {
            'PRE.json': original_inputs,
            'POST.json': {'unchanged': True, 'inputs': original_inputs},
            'railgun-relay-core-native-root-freeze-oct6-b.json': frozen,
            'railgun-relay-core-native-root-request-oct6-b.json': expand(provenance['originalRequest'], prefixes),
            'input.json': frozen['config'],
        }
        for name, value in values.items():
            raw = encode(value)
            assert len(raw) == originals[name]['bytes'] and sha(raw) == originals[name]['sha256'], name
            reconstructed.append(name)
    return {'archiveBytesVerified': True, 'originalMetadataReconstructed': reconstructed,
            'cryptographyRerun': False, 'runtimeOrProfileRead': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-prefix')
    parser.add_argument('--scratch-prefix')
    args = parser.parse_args()
    print(json.dumps(verify(args.repo_prefix, args.scratch_prefix), indent=2))
