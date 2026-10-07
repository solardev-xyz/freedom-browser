const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'railgun-source-identity-host.js'), 'utf8');
function load({ realm, mainThread = true } = {}) {
  const reads = [],
    replacements = new Map(),
    module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    __dirname,
    process: { type: realm },
    require(name) {
      if (name === 'worker_threads') return { isMainThread: mainThread };
      if (name === 'fs')
        return {
          readFileSync(filename) {
            reads.push(filename);
            if (replacements.has(filename)) {
              const value = replacements.get(filename);
              if (value instanceof Error) throw value;
              return value;
            }
            return fs.readFileSync(filename);
          },
        };
      if (['path', 'crypto'].includes(name)) return require(name);
      throw Error('No host module should execute');
    },
  });
  return { factory: module.exports.createRailgunSourceIdentityHost, reads, replacements };
}
test('hashes fixed implementation files afresh without executing services or reading profiles', () => {
  const m = load(),
    host = m.factory();
  expect(m.reads).toEqual([]);
  expect(Object.keys(host)).toEqual(['readDigest']);
  expect(Object.isFrozen(host)).toBe(true);
  const first = host.readDigest(),
    names = m.reads.slice();
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set(names).size).toBe(29);
  expect(names.every((name) => name.startsWith(path.resolve(__dirname, '..') + path.sep))).toBe(
    true
  );
  expect(names.every((name) => name.endsWith('.js') && !name.endsWith('.test.js'))).toBe(true);
  expect(names).toContain(path.join(__dirname, 'railgun-source-identity-host.js'));
  expect(host.readDigest()).toBe(first);
  expect(m.reads.slice(names.length)).toEqual(names);
  for (const name of names) {
    m.replacements.set(name, Buffer.from('changed source'));
    expect(host.readDigest()).not.toBe(first);
    m.replacements.delete(name);
  }
});
test('a missing implementation refuses without returning file paths or partial identity', () => {
  const m = load(),
    host = m.factory();
  host.readDigest();
  m.replacements.set(m.reads[0], new Error('private path must not be exposed'));
  let error;
  try {
    host.readDigest();
  } catch (caught) {
    error = caught;
  }
  expect(error.code).toBe('RAILGUN_SOURCE_IDENTITY_UNAVAILABLE');
  expect(error.message).toBe('Railgun source identity unavailable');
  expect(error.cause).toBeUndefined();
});
test.each([{ realm: 'renderer' }, { realm: 'utility' }, { mainThread: false }])(
  'foreign realm refuses before source reads: %p',
  (options) => {
    const m = load(options);
    expect(() => m.factory()).toThrow(
      expect.objectContaining({ code: 'RAILGUN_SOURCE_IDENTITY_UNAVAILABLE' })
    );
    expect(m.reads).toEqual([]);
  }
);
test('neither factory nor method accepts caller-supplied source paths', () => {
  const m = load();
  expect(() => m.factory({ sources: [] })).toThrow();
  expect(() => m.factory().readDigest('/foreign')).toThrow();
  expect(m.reads).toEqual([]);
});
