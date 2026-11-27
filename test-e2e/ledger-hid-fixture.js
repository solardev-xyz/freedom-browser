// A fake Ledger behind main's relay, for the specs that run the core's
// Ledger backend (FREEDOM_LEDGER_BACKEND=core; freedom-core design 0016,
// LDG-3). The identity core is the real freedom-cored: it builds every APDU
// and sends each to main as `shell.ledger_apdu`; main's relay
// (src/main/core/ledger-relay.js) admits it by its grammar and carries it to
// the device it opens per operation. Here that device is this fake, put in
// the relay's place for node-hid's (`openDevice`) inside the running app.
//
// It holds `key`: the address check (E0 02) is answered with its public key
// and address, the app check (B0 01) with the Ethereum app, and every piece
// with 9000, but the one the user confirms (the APDU whose `deadline_ms` is
// 5 minutes): that one waits for a user who never answers, until main lets
// go of the device (`detach()`, or the exchange's signal), when it fails as
// hid-device.js's does. `ledgerHidEvents()` reads what it saw: each open,
// each exchange (its first four bytes and deadline), the held APDU and each
// detach, whether an exchange was in flight. No APDU's bytes beyond the
// header are kept.

const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

/** Puts the fake in the relay's place; `key` is the account's test key. */
function fakeLedgerHid(electronApp, key) {
  return electronApp.evaluate(
    (_electron, args) => {
      const req = process.mainModule
        .require('module')
        .createRequire(`${args.root}/src/main/core/core-process.js`);
      const { Wallet } = req('ethers');
      const relay = req('./core-process').getLedgerRelay();
      if (!relay) throw new Error('No Ledger relay: the identity core is not running');
      const wallet = new Wallet(args.key);
      const publicKey = Buffer.from(wallet.signingKey.publicKey.slice(2), 'hex');
      const text = Buffer.from(wallet.address.slice(2), 'ascii');
      const OK = Buffer.from('9000', 'hex');
      const ADDRESS = Buffer.concat([Buffer.from([publicKey.length]), publicKey, Buffer.from([text.length]), text, OK]);
      // The Ethereum app 1.13.0.
      const APP = Buffer.from('0108457468657265756d06312e31332e309000', 'hex');
      const seen = { events: [] };
      globalThis.__ledgerHid = seen;
      let opened = 0;
      relay.openDevice = () => {
        const number = ++opened;
        let pending = null;
        let detached = false;
        seen.events.push({ type: 'open', device: number });
        const device = {
          exchange(apdu, ms, signal) {
            return new Promise((resolve, reject) => {
              const head = Buffer.from(apdu).subarray(0, 4).toString('hex');
              seen.events.push({ type: 'exchange', device: number, head, ms });
              const fail = () => {
                const err = new Error('Ledger HID: disconnected (closed by main)');
                err.name = 'HidDeviceError';
                err.failure = 'disconnected';
                err.detached = true;
                reject(err);
              };
              if (detached) {
                fail();
                return;
              }
              const mine = { fail };
              pending = mine;
              signal?.addEventListener('abort', () => device.detach(), { once: true });
              const answer = (bytes) =>
                setImmediate(() => {
                  if (pending !== mine) return;
                  pending = null;
                  resolve(bytes);
                });
              if (head.startsWith('e002')) answer(ADDRESS);
              else if (head.startsWith('b001')) answer(APP);
              else if (ms === 300_000) seen.events.push({ type: 'held', device: number });
              else answer(OK);
            });
          },
          detach() {
            if (detached) return;
            detached = true;
            seen.events.push({ type: 'detach', device: number, inFlight: pending !== null });
            const held = pending;
            pending = null;
            held?.fail();
          },
        };
        return device;
      };
    },
    { root: repoRoot, key }
  );
}

/** What the fake saw, in order. */
const ledgerHidEvents = (electronApp) => electronApp.evaluate(() => globalThis.__ledgerHid?.events.slice() ?? []);

/** How many times the device has waited for the user. */
const ledgerHidHeld = async (electronApp) => (await ledgerHidEvents(electronApp)).filter((e) => e.type === 'held').length;

module.exports = { fakeLedgerHid, ledgerHidEvents, ledgerHidHeld };
