const { spawnSync } = require('child_process');
const entry = require.resolve('./railgun-process-guards');
function run(body) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('assert/strict'); const { installRailgunProcessGuards } = require(${JSON.stringify(entry)}); ${body}`,
    ],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}
test('canaries verify every hook; caught refusals still notify the owner, including Electron resolveHost', () => {
  const report = run(`
    let calls = 0;
    const net = { resolveHost() {}, request() {}, fetch() {}, isOnline: () => true };
    const guard = installRailgunProcessGuards({ electronNet: net, onRefusal: () => calls++ });
    assert.equal(calls, 0);
    const before = guard.report(); assert.equal(before.canaries, before.hooks.length); assert.ok(before.hooks.length >= 90);
    for (const action of [() => net.resolveHost('refused'), () => require('tls').connect(), () => require('dns').promises.lookup('refused'), () => new (require('worker_threads').Worker)('refused')]) {
      assert.throws(action, /Railgun process capability refused/);
    }
    assert.equal(calls, 4); assert.equal(guard.report().attempts, 4); assert.equal(net.isOnline(), true);
    process.stdout.write(JSON.stringify(guard.report()));
  `);
  expect(report.hooks).toContain('electron.net.resolveHost');
  expect(report.hooks).toContain('worker_threads.Worker');
});
test('the normal native addon loader is refused before it can extract or load a binary', () => {
  const report = run(`
    let calls = 0;
    const guard = installRailgunProcessGuards({ onRefusal: () => calls++ });
    assert.throws(() => process.dlopen({}, '/not-loaded.node'), /Railgun process capability refused/);
    assert.equal(calls, 1);
    process.stdout.write(JSON.stringify(guard.report()));
  `);
  expect(report.hooks).toContain('process.dlopen');
  expect(report.attempts).toBe(1);
});
test('a non-configurable read-only capability fails guard installation instead of silently staying live', () => {
  const report = run(`
    const net = {};
    Object.defineProperty(net, 'fetch', { value() {}, configurable: false, writable: false });
    assert.throws(() => installRailgunProcessGuards({ electronNet: net, onRefusal() {} }));
    process.stdout.write(JSON.stringify({ refused: true }));
  `);
  expect(report.refused).toBe(true);
});
