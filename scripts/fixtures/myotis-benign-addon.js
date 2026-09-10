// Disposable-host-only fixture. No networking, native addon, signing or secrets.
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const MODES = new Set(['healthy', 'natural-exit', 'blocked-read', 'blocked-status', 'blocked-stop', 'startup-failure']);
if (config.identity !== 'freedom-myotis-benign-v1' || !MODES.has(config.mode)) {
  throw new Error('Invalid qualification fixture');
}
// Idle child cleanup is independently finite if controller supervision fails.
// Blocking fixtures use the native 15s wait below; neither expiry can pass.
setTimeout(() => process.exit(78), 18000);
const identityFile = path.join(__dirname, 'fixture-events.jsonl');
function event(type) {
  fs.appendFileSync(identityFile, JSON.stringify({ type, mode: config.mode, time: Date.now(), pid: process.pid }) + '\n');
}
function block() {
  // One bounded native wait, not a JS timer callback. When it expires, exit
  // synchronously with a distinctive code: fixture expiry is NEVER a pass.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  process.exit(78);
}
module.exports = {
  init() { event('init'); return config.mode === 'startup-failure' ? 0 : 22; },
  create(network, dataDir) {
    if (network !== 'mainnet' || fs.realpathSync(dataDir) !== fs.realpathSync(path.join(__dirname, 'data'))) {
      throw new Error('Fixture path mismatch');
    }
    event('create'); return 1;
  },
  start() {
    event('start');
    if (config.mode === 'natural-exit') setTimeout(() => process.exit(0), 500);
    return true;
  },
  statusJson() {
    event('status');
    if (config.mode === 'blocked-status') block();
    return JSON.stringify({ beaconState: 'SYNCED', elReaderAvailable: true, elHunting: false, snapPeers: 1 });
  },
  ethCallJson() {
    event('call');
    if (config.mode === 'blocked-read') block();
    return Promise.resolve(JSON.stringify({ resultHex: '0x1234' }));
  },
  drainLogs() { return ''; },
  stop() { event('stop'); if (config.mode === 'blocked-stop') block(); },
};
