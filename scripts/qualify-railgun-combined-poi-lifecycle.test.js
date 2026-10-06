/** Static selector/import-order guards; no Electron or profile is opened. */
const fs = require('fs'),
  path = require('path');
const { parse } = require('acorn');
const source = fs.readFileSync(
  path.join(__dirname, 'qualify-railgun-combined-poi-lifecycle.js'),
  'utf8'
);
function nodes(predicate) {
  const result = [];
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (predicate(v)) result.push(v);
    for (const item of Object.values(v))
      if (Array.isArray(item)) item.forEach(visit);
      else visit(item);
  };
  visit(parse(source, { ecmaVersion: 'latest' }));
  return result;
}
test('opt-in guard executes before profile/directory access and is not inferred from a mode', () => {
  const declarations = nodes(
    (v) => v.type === 'VariableDeclarator' && v.id.name === 'recoveryCompanionMode'
  );
  expect(declarations).toHaveLength(1);
  const init = declarations[0].init;
  expect(init.type).toBe('CallExpression');
  expect(init.callee.property.name).toBe('enabled');
  expect(source.slice(init.arguments[0].start, init.arguments[0].end)).toBe('process.env');
  expect(source.slice(init.arguments[1].start, init.arguments[1].end)).toBe('args[7]');
  expect(init.arguments[2].name).toBe('inputCreator');
  const accesses = nodes(
    (v) =>
      v.type === 'CallExpression' &&
      ['existsSync', 'mkdirSync', 'initializeProfile'].includes(v.callee.property?.name)
  );
  expect(accesses.length).toBeGreaterThan(0);
  expect(accesses.every((v) => v.start > declarations[0].start)).toBe(true);
});
test('observer requires explicit flag and only recovery/submit, after all ordinary runtime/service interceptors', () => {
  const declarations = nodes(
    (v) => v.type === 'VariableDeclarator' && v.id.name === 'recoveryCompanion'
  );
  expect(declarations).toHaveLength(1);
  const init = declarations[0].init;
  expect(init.type).toBe('ConditionalExpression');
  expect(source.slice(init.test.start, init.test.end).replace(/\s+/g, '')).toBe(
    'recoveryCompanionMode&&(recoverStop||recoveredSubmit)'
  );
  expect(init.alternate.name).toBe('undefined');
  const runtime = source.indexOf('runtime.startRailgunProcess = (options)');
  const services = source.indexOf(
    "require('./fixtures/railgun-partial-controller-services').install"
  );
  const storage = source.indexOf(
    "require('./fixtures/railgun-combined-poi-store-observer').install"
  );
  expect(Math.min(runtime, services, storage)).toBeGreaterThan(0);
  expect(declarations[0].start).toBeGreaterThan(Math.max(runtime, services, storage));
});
test('cancelled recovery retains the same exact key-purpose allowlist as healthy recovery', () => {
  const guards = nodes(
    (v) =>
      v.type === 'IfStatement' &&
      source.slice(v.test.start, v.test.end).includes('second-recovery-companion-cancel')
  );
  expect(guards).toHaveLength(1);
  const body = source.slice(guards[0].consequent.start, guards[0].consequent.end);
  expect(body).toContain("'railgun-wallet-job.js': 'wallet-viewing'");
  expect(body).toContain("'railgun-private-recover-job.js': 'private-recover'");
  expect(body).not.toContain('spending-sign');
});
