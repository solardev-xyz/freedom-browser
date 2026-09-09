// Private child entry point. Never import this module into Electron main.
// No profile policy, wallet signing, renderer IPC, or credentials live here.
const { pin, verifyArtifact } = require('./myotis-artifact');
const EXPECTED_ABI = pin.abi;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const OPERATIONS = Object.freeze({
  ens: 'ensRecordJson',
  call: 'ethCallJson',
  account: 'requestAccountJson',
  gas: 'estimateGasJson',
  fee: 'feeEstimateJson',
  broadcast: 'sendRawTransactionJson',
});

function runChild(host = process, loadAddon = require, verify = verifyArtifact) {
  let addon;
  let handle = -1;
  let generation;
  let stopping = false;
  let active = 0;
  let lastId = 0;
  function send(message) {
    if (host.connected) host.send({ ...message, generation });
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    // This may block or leave native workers alive. Parent enforces the grace
    // deadline externally and waits for OS exit, never for this acknowledgement.
    try { if (handle > 0) addon.stop(handle); } catch { /* Parent owns termination. */ }
    host.exit(0);
  }
  host.on('disconnect', stop);
  host.on('message', async (message) => {
    if (!message || stopping) return;
    if (message.type === 'start' && !generation) {
      generation = message.generation;
      let failure = 'configuration';
      try {
        if (!['mainnet', 'gnosis'].includes(message.network)) throw new Error('network');
        failure = 'artifact';
        verify(message.addonPath);
        failure = 'load';
        addon = loadAddon(message.addonPath);
        failure = 'methods';
        if (['init', 'create', 'start', 'stop', 'statusJson', 'drainLogs', ...Object.values(OPERATIONS)]
          .some((method) => typeof addon[method] !== 'function')) throw new Error('methods');
        failure = 'abi';
        if (addon.init() !== EXPECTED_ABI) throw new Error('ABI');
        failure = 'create';
        handle = addon.create(message.network, message.dataDir);
        if (handle < 1) throw new Error('create');
        failure = 'start';
        if (!addon.start(handle)) throw new Error('start');
        send({ type: 'started', ok: true });
      } catch {
        send({ type: 'started', ok: false, failure });
        stop();
      }
      return;
    }
    if (message.generation !== generation || !generation) return;
    if (message.type === 'stop') { stop(); return; }
    if (message.type !== 'request' || handle < 1) return;
    const { id, op, args } = message;
    if (!Number.isSafeInteger(id) || id <= lastId || !Array.isArray(args)) return;
    lastId = id;
    const reply = (ok, result) => send({ type: 'reply', id, op, ok, result });
    if (JSON.stringify(args).length > MAX_MESSAGE_BYTES ||
      (op !== 'status' && (!Object.hasOwn(OPERATIONS, op) || active >= 1))) {
      reply(false);
      return;
    }
    if (op !== 'status') active += 1;
    try {
      const raw = op === 'status'
        ? addon.statusJson(handle)
        : await addon[OPERATIONS[op]](handle, ...args);
      if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) throw new Error('size');
      const result = JSON.parse(raw);
      // Drain bounded native diagnostics here; never forward raw engine logs
      // or exception strings that could contain request payloads to main.
      if (op === 'status') addon.drainLogs(200);
      if (!stopping) reply(true, result);
    } catch {
      if (!stopping) reply(false);
    } finally {
      if (op !== 'status') active -= 1;
    }
  });
}

if (require.main === module) runChild();
module.exports = { runChild };
