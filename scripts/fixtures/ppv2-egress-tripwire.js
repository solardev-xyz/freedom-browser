/** Test-only main-process tripwires. Install before loading the SDK. Not a sandbox. */
const assert = require('assert/strict');
const { syncBuiltinESMExports } = require('module');

function installPPv2EgressTripwire(electronNet, electronSession) {
  const saved = [],
    attempts = [],
    hooks = [],
    probes = [],
    canaries = [];
  let restored = false,
    checkingCanaries = false;
  function patch(object, key, label) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    saved.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete object[key];
    });
    const refuse = function () {
      if (checkingCanaries) canaries.push(label);
      else if (attempts.length < 64)
        attempts.push({ api: label, stack: new Error().stack.split('\n').slice(2, 7) });
      throw new Error('Controlled PPv2 direct egress refused');
    };
    Object.defineProperty(object, key, { configurable: true, writable: true, value: refuse });
    hooks.push(label);
    probes.push({ object, key, refuse, label });
  }
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const undo of saved.reverse()) undo();
    syncBuiltinESMExports();
  };
  try {
    patch(globalThis, 'fetch', 'global.fetch');
    patch(globalThis, 'WebSocket', 'global.WebSocket');
    for (const name of ['http', 'https']) {
      const api = require(name);
      for (const method of ['request', 'get']) patch(api, method, `${name}.${method}`);
    }
    for (const method of ['connect', 'createConnection'])
      patch(require('net'), method, `net.${method}`);
    patch(require('net').Socket.prototype, 'connect', 'net.Socket.connect');
    patch(require('tls'), 'connect', 'tls.connect');
    patch(require('http2'), 'connect', 'http2.connect');
    const dgram = require('dgram');
    patch(dgram, 'createSocket', 'dgram.createSocket');
    for (const method of ['send', 'connect', 'bind'])
      patch(dgram.Socket.prototype, method, `dgram.Socket.${method}`);
    for (const [label, api] of [
      ['dns', require('dns')],
      ['dns.promises', require('dns').promises],
    ]) {
      for (const key of Object.keys(api))
        if (/^(lookup|resolve|reverse)/.test(key)) patch(api, key, `${label}.${key}`);
      const methods = new Set();
      for (
        let prototype = api.Resolver.prototype;
        prototype && prototype !== Object.prototype;
        prototype = Object.getPrototypeOf(prototype)
      ) {
        for (const key of Object.getOwnPropertyNames(prototype))
          if (/^(lookup|resolve|reverse)/.test(key)) methods.add(key);
      }
      for (const method of methods)
        patch(api.Resolver.prototype, method, `${label}.Resolver.${method}`);
    }
    if (electronNet)
      for (const method of ['request', 'fetch'])
        patch(electronNet, method, `electron.net.${method}`);
    if (electronSession) {
      for (const method of ['fetch', 'resolveHost', 'resolveProxy']) {
        let owner = electronSession;
        while (owner && !Object.hasOwn(owner, method)) owner = Object.getPrototypeOf(owner);
        assert.ok(owner, `Electron session ${method} must be hooked`);
        patch(owner, method, `electron.session.${method}`);
      }
    }
    patch(require('worker_threads'), 'Worker', 'worker_threads.Worker');
    for (const method of [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork',
    ])
      patch(require('child_process'), method, `child_process.${method}`);
    syncBuiltinESMExports();
    // Exercise each installed hook before the SDK loads. Canary records are
    // separate and cannot clear or hide attempts during the actual lifecycle.
    checkingCanaries = true;
    for (const { object, key, refuse, label } of probes) {
      assert.equal(object[key], refuse);
      const before = canaries.length;
      assert.throws(() => object[key](), /Controlled PPv2 direct egress refused/);
      assert.equal(canaries.length, before + 1);
      assert.equal(canaries.at(-1), label);
    }
    checkingCanaries = false;
  } catch (error) {
    restore();
    throw error;
  }
  return {
    restore,
    assertClean() {
      assert.deepEqual(
        attempts,
        [],
        'Unexpected direct network attempts in controlled PPv2 lifecycle'
      );
    },
    report() {
      return {
        attempts: [...attempts],
        hooks: [...hooks],
        refusedCanaries: [...canaries],
        scope: 'main JavaScript APIs; mocked host transport',
        osSandbox: false,
      };
    },
  };
}
module.exports = { installPPv2EgressTripwire };
