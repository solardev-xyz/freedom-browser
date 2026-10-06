const path = require('path');
const fs = require('fs');
let electronDescriptor, typeDescriptor;
beforeEach(() => {
  jest.resetModules();
  electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  typeDescriptor = Object.getOwnPropertyDescriptor(process, 'type');
  Object.defineProperty(process.versions, 'electron', { value: 'test', configurable: true });
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
});
afterEach(() => {
  if (electronDescriptor) Object.defineProperty(process.versions, 'electron', electronDescriptor);
  else delete process.versions.electron;
  if (typeDescriptor) Object.defineProperty(process, 'type', typeDescriptor);
  else delete process.type;
});
function setup() {
  const isolation = jest.fn(() => ({ fixed: true })),
    read = jest.fn(() => ({ approved: true })),
    execute = jest.fn(async () => {});
  jest.doMock('./qualify-railgun-relay-positive', () => ({ assertIsolation: isolation }));
  jest.doMock('./fixtures/railgun-relay-cold-ready-native', () => ({
    readAdmission: read,
    execute,
  }));
  return { isolation, read, execute, main: require('./qualify-railgun-relay-cold-ready').main };
}
test('fixed opt-in entry joins isolation before and after original execution', async () => {
  const t = setup();
  await t.main(['/public/config.json'], { FREEDOM_RAILGUN_RELAY_COLD_READY: '1' });
  expect(t.read).toHaveBeenCalledWith('/public/config.json');
  expect(t.execute).toHaveBeenCalledTimes(1);
  expect(t.isolation).toHaveBeenCalledTimes(2);
});
test.each(['off', 'relative', 'extra', 'other-flag', 'wrong-process'])(
  'entry refuses %s before admission',
  async (name) => {
    const t = setup(),
      args = ['/public/config.json'],
      env = { FREEDOM_RAILGUN_RELAY_COLD_READY: '1' };
    if (name === 'off') delete env.FREEDOM_RAILGUN_RELAY_COLD_READY;
    if (name === 'relative') args[0] = 'config.json';
    if (name === 'extra') args.push('/other');
    if (name === 'other-flag') env.FREEDOM_RAILGUN_RELAY_POSITIVE = 'synthetic-list';
    if (name === 'wrong-process')
      Object.defineProperty(process, 'type', { value: 'utility', configurable: true });
    await expect(t.main(args, env)).rejects.toThrow();
    expect(t.read).not.toHaveBeenCalled();
    expect(t.execute).not.toHaveBeenCalled();
  }
);
test('entry keeps original execution pending and does not report final isolation early', async () => {
  const t = setup();
  let resolve;
  const original = new Promise((r) => {
    resolve = r;
  });
  t.execute.mockReturnValue(original);
  let done = false;
  const p = t.main(['/public/config.json'], { FREEDOM_RAILGUN_RELAY_COLD_READY: '1' }).then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(t.isolation).toHaveBeenCalledTimes(1);
  resolve();
  await p;
  expect(t.isolation).toHaveBeenCalledTimes(2);
});
test('entry source uses exact Electron entry-path selector and never creates a profile itself', () => {
  const s = fs.readFileSync(path.join(__dirname, 'qualify-railgun-relay-cold-ready.js'), 'utf8');
  expect(s).toContain('path.resolve(process.argv[1]) === path.resolve(__filename)');
  expect(s).not.toMatch(/importVault|create: true|initializeProfile/);
});
