/**
 * scripts/staple-with-retry.sh (#757): `xcrun stapler staple|validate` is
 * retried with growing pauses and fails only after the last attempt. A fake
 * `xcrun` on PATH stands in for Apple's tool, so this runs on any host.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'staple-with-retry.sh');
const maybe = process.platform === 'win32' ? describe.skip : describe;

// `xcrun` that logs each call and fails (exit 68, like the ticket-service
// drop) until its call count reaches `succeedOn`; 0 never succeeds.
function fakeXcrun(succeedOn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staple-retry-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(
    path.join(dir, 'xcrun'),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
n=$(wc -l < "${calls}")
if [ ${succeedOn} -ne 0 ] && [ "$n" -ge ${succeedOn} ]; then exit 0; fi
echo "The network connection was lost." >&2
exit 68
`,
    { mode: 0o755 }
  );
  const target = path.join(dir, 'Freedom.app');
  fs.mkdirSync(target);
  return {
    dir,
    target,
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []),
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
  };
}

function run(args, env) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, env });
}

maybe('staple-with-retry.sh', () => {
  test('succeeds on the first attempt without pausing', () => {
    const fake = fakeXcrun(1);
    const result = run(['staple', fake.target], fake.env);
    expect(result.status).toBe(0);
    expect(fake.calls()).toEqual([`stapler staple ${fake.target}`]);
    expect(result.stdout).toContain('attempt 1/5');
    expect(result.stdout).toContain('succeeded');
  });

  test('retries a dropped connection and succeeds on a later attempt', () => {
    const fake = fakeXcrun(3);
    const result = run(['validate', fake.target], {
      ...fake.env,
      STAPLE_RETRY_DELAYS: '0 0 0 0',
    });
    expect(result.status).toBe(0);
    expect(fake.calls()).toEqual(Array(3).fill(`stapler validate ${fake.target}`));
    expect(result.stdout).toMatch(/failed \(exit 68\) on attempt 1\/5; retrying in 0s/);
    expect(result.stdout).toMatch(/failed \(exit 68\) on attempt 2\/5; retrying in 0s/);
    expect(result.stdout).toContain('succeeded for');
    expect(result.stdout).toContain('on attempt 3/5');
  });

  test('fails with the last exit status after every attempt failed', () => {
    const fake = fakeXcrun(0);
    const result = run(['staple', fake.target], { ...fake.env, STAPLE_RETRY_DELAYS: '0 0 0 0' });
    expect(result.status).toBe(68);
    expect(fake.calls()).toHaveLength(5);
    expect(result.stdout).toMatch(/::error title=staple-with-retry::.*failed on all 5 attempts/);
  });

  test('the default schedule is 20/40/80/160 s, five attempts', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain('${STAPLE_RETRY_DELAYS-20 40 80 160}');
  });

  test('pauses for the configured time between attempts', () => {
    const fake = fakeXcrun(2);
    const started = Date.now();
    const result = run(['staple', fake.target], { ...fake.env, STAPLE_RETRY_DELAYS: '1 0' });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(result.stdout).toContain('retrying in 1s');
  });

  test('each path gets its own attempts and a later failure still fails the run', () => {
    const fake = fakeXcrun(0);
    const other = path.join(fake.dir, 'Freedom.dmg');
    fs.writeFileSync(other, '');
    const result = run(['validate', fake.target, other], { ...fake.env, STAPLE_RETRY_DELAYS: '0' });
    expect(result.status).toBe(68);
    // The first path exhausts its two attempts and stops the run.
    expect(fake.calls()).toEqual(Array(2).fill(`stapler validate ${fake.target}`));
  });

  test('rejects a missing path, an unknown action and a malformed schedule', () => {
    const fake = fakeXcrun(1);
    expect(run(['staple', path.join(fake.dir, 'nope.app')], fake.env).status).toBe(1);
    expect(run(['remove', fake.target], fake.env).status).toBe(2);
    expect(run(['staple'], fake.env).status).toBe(2);
    expect(run(['staple', fake.target], { ...fake.env, STAPLE_RETRY_DELAYS: '20 x' }).status).toBe(
      2
    );
    expect(fake.calls()).toEqual([]);
  });
});

// Every staple and validate in the release pipeline goes through the script:
// a bare `xcrun stapler` call would be back to failing on one dropped
// connection.
describe('no bare stapler calls', () => {
  const files = [
    '.github/workflows/release.yml',
    'scripts/macos-notary.js',
    'scripts/after-sign.js',
    'scripts/build.js',
  ];

  test.each(files)('%s calls stapler only through staple-with-retry.sh', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(#|\/\/|\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/xcrun\s+stapler|['"]stapler['"]/);
  });

  test('the release workflow staples and validates through the script', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('bash scripts/staple-with-retry.sh staple "$dmg"');
    expect(workflow).toMatch(
      /bash scripts\/staple-with-retry\.sh validate dist\/mac-arm64\/Freedom\.app "\$\{dmgs\[@\]\}"/
    );
  });
});
