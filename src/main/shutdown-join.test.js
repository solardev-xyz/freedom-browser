// Guard for the one invariant windDown() exists to keep: every stop leg is
// waited for, whatever the others do.
//
// src/main/index.js is the Electron entry point and has no unit harness, so
// this is a source guard rather than a behavioural test. It is worth having
// anyway: joining the legs with `Promise.all` settles the whole join on the
// *first* rejection, which releases app.quit() while stopIpfs()'s dispatcher
// ack is still in flight — and that is exactly the window issue #345 aborted
// in (`FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw`, SIGABRT).
// Reproduced on this branch by making one leg reject: with `Promise.all` the
// quit aborted, with `Promise.allSettled` it exited 0. The behavioural half
// of the cover is test-e2e/live/ipfs-quit.spec.js, which needs the real
// native addon and so cannot run under `harness`.

const fs = require('node:fs');
const path = require('node:path');

const INDEX = path.join(__dirname, 'index.js');

// The wind-down body: from the log line that announces the wait to the end of
// the function. Keyed on the log text rather than on the join itself so a
// join that was deleted outright still fails here instead of vacuously
// passing.
function windDownJoin() {
  const source = fs.readFileSync(INDEX, 'utf8');
  const start = source.indexOf(
    "log.info('[App] Waiting for Ant, IPFS, Myotis, Radicle, Tor, and TON to stop...');"
  );
  if (start === -1) return null;
  const end = source.indexOf('\napp.on(', start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe('wind-down stop-leg join', () => {
  test('the wind-down still announces the wait it is named for', () => {
    expect(windDownJoin()).not.toBeNull();
  });

  test('joins every stop leg with allSettled, never short-circuiting on a rejection', () => {
    const join = windDownJoin();
    // Comments name both, so compare the calls themselves.
    const calls = (join.match(/Promise\.(all|allSettled|race|any)\s*\(/g) || []).map((c) =>
      c.replace(/\s*\($/, '')
    );
    expect(calls).toContain('Promise.allSettled');
    expect(calls).not.toContain('Promise.all');
    expect(calls).not.toContain('Promise.race');
    expect(calls).not.toContain('Promise.any');
  });

  test('every named stop leg is in the join', () => {
    const join = windDownJoin();
    for (const leg of [
      'myotisStopped',
      'stopAnt',
      'stopIpfs',
      'stopRadicle',
      'stopTor',
      'stopTon',
    ]) {
      expect(join).toContain(leg);
    }
  });
});
