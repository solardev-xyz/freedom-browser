'use strict';
/** Checked, canaried accidental-egress guards. They are not a sandbox against
 * malicious native code, direct filesystem access or deliberate hook removal.
 */
const { syncBuiltinESMExports } = require('module');
function installRailgunProcessGuards({ electronNet, onRefusal }) {
  if (typeof onRefusal !== 'function') throw new Error('Railgun guard configuration refused');
  const probes = [],
    hooks = [];
  let checking = false,
    canaries = 0,
    attempts = 0;
  function patch(object, name, label) {
    const refused = () => {
      if (checking) canaries++;
      else {
        attempts++;
        try {
          onRefusal();
        } catch {
          /* The capability remains refused. */
        }
      }
      throw new Error('Railgun process capability refused');
    };
    // A regular function can also replace constructors (Worker/WebSocket).
    const replacement = function () {
      return refused();
    };
    const old = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, {
      value: replacement,
      writable: true,
      configurable: old?.configurable ?? true,
      enumerable: old?.enumerable ?? true,
    });
    if (object[name] !== replacement) throw new Error('Railgun guard installation failed');
    hooks.push(label);
    probes.push({ object, name, replacement });
  }
  patch(globalThis, 'fetch', 'global.fetch');
  patch(globalThis, 'WebSocket', 'global.WebSocket');
  for (const [name, methods] of [
    ['http', ['request', 'get']],
    ['https', ['request', 'get']],
    ['net', ['connect', 'createConnection']],
    ['tls', ['connect']],
    ['http2', ['connect']],
    ['dgram', ['createSocket']],
    ['worker_threads', ['Worker']],
    [
      'child_process',
      ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    ],
  ])
    for (const method of methods) patch(require(name), method, `${name}.${method}`);
  patch(require('net').Socket.prototype, 'connect', 'net.Socket.connect');
  for (const method of ['send', 'connect', 'bind'])
    patch(require('dgram').Socket.prototype, method, `dgram.Socket.${method}`);
  const dns = require('dns');
  for (const [label, api] of [
    ['dns', dns],
    ['dns.promises', dns.promises],
  ]) {
    for (const name of Object.keys(api))
      if (/^(lookup|resolve|reverse)/.test(name)) patch(api, name, `${label}.${name}`);
    const methods = new Set();
    for (
      let proto = api.Resolver.prototype;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const name of Object.getOwnPropertyNames(proto))
        if (/^(lookup|resolve|reverse)/.test(name)) methods.add(name);
    }
    for (const name of methods) patch(api.Resolver.prototype, name, `${label}.Resolver.${name}`);
  }
  if (electronNet) {
    const names = new Set();
    for (
      let proto = electronNet;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const name of Object.getOwnPropertyNames(proto))
        if (!['constructor', 'isOnline'].includes(name) && typeof electronNet[name] === 'function')
          names.add(name);
    }
    for (const name of ['fetch', 'request', 'resolveHost']) {
      if (typeof electronNet[name] === 'function') names.add(name);
    }
    for (const name of names) patch(electronNet, name, `electron.net.${name}`);
  }
  syncBuiltinESMExports();
  checking = true;
  try {
    for (const { object, name, replacement } of probes) {
      if (object[name] !== replacement) throw new Error('Railgun guard installation failed');
      const before = canaries;
      try {
        object[name]();
      } catch (error) {
        if (error.message !== 'Railgun process capability refused') throw error;
      }
      if (canaries !== before + 1) throw new Error('Railgun guard canary failed');
    }
  } finally {
    checking = false;
  }
  return Object.freeze({ report: () => Object.freeze({ hooks: [...hooks], canaries, attempts }) });
}
module.exports = { installRailgunProcessGuards };
