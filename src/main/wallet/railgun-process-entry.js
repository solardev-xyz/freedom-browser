/** Internal Electron utility bootstrap. Accidental egress guards, not an OS
 * sandbox. General jobs may receive viewing material. The dedicated identity
 * job can receive one main-authorized binary key for public-key derivation.
 */
'use strict';
for (const key of Object.keys(process.env)) delete process.env[key];
// ws is imported transitively by the pinned engine, but these compute jobs
// never use its transports. Keep its optional helpers on their JS fallback;
// the guards below refuse all normal Node native-addon loading.
process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';
const parent = process.parentPort;
const pending = new Map();
const controller = new AbortController();
let initialized = false,
  stopped = false,
  port;
function fail(reason = 'protocol') {
  if (stopped) return;
  stopped = true;
  controller.abort();
  for (const task of pending.values()) task.reject(new Error('Railgun session unavailable'));
  pending.clear();
  if (!port) {
    process.exit(1);
    return;
  }
  // Failure and close use one ordered channel. Reasons contain no job/network
  // diagnostics and never compete with a separate parentPort notification.
  try {
    port.postMessage(JSON.stringify({ type: 'failure', reason }));
  } finally {
    port.close();
  }
}
function receive({ data, ports = [] }) {
  if (stopped) return;
  try {
    if (data && typeof data === 'object' && data.type === 'key-reply') {
      const task = pending.get(data.id);
      if (
        ports.length ||
        Object.keys(data).sort().join(',') !== 'bytes,id,type' ||
        data.id !== 1 ||
        !task?.binary ||
        !(data.bytes instanceof Uint8Array) ||
        !(data.bytes.buffer instanceof ArrayBuffer) ||
        data.bytes.byteLength !== 32 ||
        data.bytes.byteOffset !== 0 ||
        data.bytes.buffer.byteLength !== 32
      )
        throw new Error();
      pending.delete(data.id);
      task.resolve(data.bytes);
      return;
    }
    if (
      ports.length ||
      typeof data !== 'string' ||
      data.length > 4 * 1024 * 1024 + 128 ||
      Buffer.byteLength(data) > 4 * 1024 * 1024 + 128
    )
      throw new Error();
    const message = JSON.parse(data);
    if (
      !message ||
      Object.keys(message).length !== 2 ||
      message.type !== 'reply' ||
      typeof message.wire !== 'string' ||
      Buffer.byteLength(message.wire) > 2 * 1024 * 1024
    )
      throw new Error();
    const id = JSON.parse(message.wire).id,
      task = pending.get(id);
    if (!task || task.binary) throw new Error();
    pending.delete(id);
    task.resolve(message.wire);
  } catch {
    fail();
  }
}
const guard = require('./railgun-process-guards').installRailgunProcessGuards({
  electronNet: require('electron').net,
  onRefusal: () => fail('egress'),
});
parent.on('message', ({ data, ports = [] }) => {
  try {
    if (
      initialized ||
      stopped ||
      ports.length !== 1 ||
      typeof data !== 'string' ||
      Buffer.byteLength(data) > 132000
    )
      throw new Error();
    const message = JSON.parse(data);
    if (
      !message ||
      Object.keys(message).length !== 3 ||
      message.type !== 'init' ||
      typeof message.filename !== 'string' ||
      !require('path').isAbsolute(message.filename) ||
      typeof message.input !== 'string' ||
      Buffer.byteLength(message.input) > 65536
    )
      throw new Error();
    initialized = true;
    port = ports[0];
    port.on('message', receive);
    port.on('close', () => {
      stopped = true;
      controller.abort();
      for (const task of pending.values()) task.reject(new Error('Railgun session unavailable'));
      pending.clear();
      process.exit(1);
    });
    port.start();
    let job;
    try {
      job = require(message.filename);
    } catch {
      fail('job');
      return;
    }
    const request = (wire, binary = false) => {
      if (
        controller.signal.aborted ||
        typeof wire !== 'string' ||
        Buffer.byteLength(wire) > 2 * 1024 * 1024 ||
        pending.size >= 8
      )
        return Promise.reject(new Error('Railgun session unavailable'));
      const id = JSON.parse(wire).id;
      if (!Number.isSafeInteger(id) || id < 1 || pending.has(id))
        return Promise.reject(new Error('Railgun session unavailable'));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, binary });
        port.postMessage(JSON.stringify({ type: 'command', wire }));
      });
    };
    Promise.resolve()
      .then(() =>
        job.run(message.input, {
          request: (wire) => request(wire),
          requestKey: (wire) => request(wire, true),
          signal: controller.signal,
          guardReport: guard.report,
          close: () => port.close(),
        })
      )
      .then(
        () => {
          if (!stopped) port.postMessage(JSON.stringify({ type: 'ready' }));
        },
        () => fail('job')
      );
  } catch {
    fail();
  }
});
