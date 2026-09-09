// Execute only in a VM with mocked I/O, timers and Atomics. No fixture process.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture(mode) {
  const host = {
    module: { exports: {} }, __dirname: '/owned',
    process: { pid: 1, exit: jest.fn() },
    setTimeout: jest.fn(), SharedArrayBuffer, Int32Array,
    Atomics: { wait: jest.fn() },
    require: (name) => name === 'path' ? path : {
      readFileSync: () => JSON.stringify({ identity: 'freedom-myotis-benign-v1', mode }),
      appendFileSync: jest.fn(), realpathSync: (value) => value,
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'myotis-benign-addon.js'), 'utf8'), host);
  return host;
}

test('fixed handshake failure returns wrong ABI and idle expiry remains a distinct failure', () => {
  const host = fixture('startup-failure');
  expect(host.module.exports.init()).toBe(0);
  const [expire, delay] = host.setTimeout.mock.calls[0];
  expect(delay).toBeLessThanOrEqual(20000);
  expire();
  expect(host.process.exit).toHaveBeenCalledWith(78);
  expect(fixture('healthy').module.exports.init()).toBe(22);
});

test('blocking fixture has a bounded native wait independent of JS timer delivery', () => {
  const host = fixture('blocked-read');
  host.module.exports.ethCallJson();
  expect(host.Atomics.wait.mock.calls[0][3]).toBe(15000);
  expect(host.process.exit).toHaveBeenCalledWith(78);
});
