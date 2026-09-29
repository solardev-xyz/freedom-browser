const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('refresh tool keeps snapok IPv4 peers, normalizes mapped IPv4 and drops bad or duplicate entries', () => {
  const script = path.join(__dirname, 'myotis-seeds.py');
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('seeds', ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
key = 'ab' * 64
rows = [
 '1.2.3.4\\t30303\\t0x' + key + '\\t1\\tsnapok',
 '::ffff:1.2.3.4\\t30303\\t0x' + key + '\\t1\\tsnapok',
 '5.6.7.8\\t30304\\t' + key + '\\t1\\tsnapok',
 'bad.host\\t30303\\t' + key + '\\t1\\tsnapok',
 '999.1.2.3\\t30303\\t' + key + '\\t1\\tsnapok',
 '1.2.3.5\\t70000\\t' + key + '\\t1\\tsnapok',
 '1.2.3.6\\t30303\\t' + key + '\\t1\\tsnapbad',
 '1.2.3.7\\t30303\\t' + key + '\\t1',
 '1.2.3.8\\t30303\\t' + key + '\\t1\\tsnapok\\tsnapbad',
 '::1\\t30303\\t' + key + '\\t1\\tsnapok',
]
print(json.dumps(list(module.candidates(rows).values())))
`;
  const pins = JSON.parse(
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', code], {
      encoding: 'utf8',
    })
  );
  expect(pins).toEqual([
    `enode://${'ab'.repeat(64)}@1.2.3.4:30303`,
    `enode://${'ab'.repeat(64)}@5.6.7.8:30304`,
  ]);
  expect(require('../src/main/myotis/seed-pins').parse(JSON.stringify(pins))).toEqual(pins);
});
