/**
 * A scripted freedom-cored for main's Swarm executor (freedom-core design
 * 0015, SWM-5; `src/main/core/swarm-shell.js`): it answers the hello at
 * protocol 2 (fragments and streams) and the shutdown, sends the core's
 * Swarm asks (`shell.swarm_ready`, `shell.swarm_api`) for the parents main
 * sent, credits and cancels them, and reads main's answers as the core does:
 * whole replies, fragmented ones once reassembled (its bulk credit goes back
 * after each), stream heads and their data, end and abort frames.
 *
 * `stuck` stops it reading its pipe: main's writes are held unfinished until
 * `release()`, so what main writes after them waits in main, its charges
 * held (design 0015, Main's Swarm I/O pool: "the core stops reading its
 * pipe"). Main's own requests (the parents) are kept unanswered until
 * `respond()`.
 *
 * `startSwarmCore()` runs a real CoreClient against it, with main's Swarm
 * shell registered (`registerSwarmShell`), and `parentOf()` sends one of
 * main's requests and opens it in the shell from its `onSent`, as the
 * Swarm request's sender will.
 */

const { EventEmitter } = require('events');
const os = require('os');
const { PassThrough, Writable } = require('stream');
const timers = require('timers');
const { CoreClient } = require('../../src/main/core/core-client');
const {
  encodeCredit,
  encodeFrame,
  encodeStreamCredit,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  Reassembler,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_STREAM_CREDIT,
} = require('../../src/main/core/frame');
const { registerSwarmShell } = require('../../src/main/core/swarm-shell');

const STREAM_KINDS = new Set([KIND_DATA, KIND_END, KIND_ABORT, KIND_STREAM_CREDIT]);

// Real turns of the event loop, whatever Jest has done to the global timers
// (it fakes the globals only).
const tick = () => new Promise((resolve) => timers.setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

class FakeSwarmCore extends EventEmitter {
  constructor() {
    super();
    this.pid = 4515;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.streams = [];
    this.nextId = 1;
    this.stuck = false;
    this.held = [];
    // The core's own requests to main, awaiting their response.
    this.outstanding = new Set();
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.reassembler = new Reassembler();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of this.decoder.push(chunk)) {
          if (STREAM_KINDS.has(frame.kind)) {
            this.streams.push(frame);
            continue;
          }
          const delivery = this.reassembler.push(frame, (id) => this.outstanding.has(id));
          if (delivery?.type !== 'message' && delivery?.type !== 'response') continue;
          const { message } = delivery;
          if (message?.type === 'response') this.outstanding.delete(message.id);
          this.messages.push(message);
          if (delivery.type === 'response') {
            this.reassembler.grant();
            this.stdout.write(encodeCredit());
          }
          this.onMessage(message);
        }
        if (this.stuck) this.held.push(callback);
        else callback();
      },
      final: (callback) => {
        callback();
        setImmediate(() => this.exit(0));
      },
    });
  }

  onMessage(message) {
    if (message.method === 'core.hello') {
      this.send({
        type: 'response',
        id: message.id,
        result: {
          protocol: 2,
          core_version: '0.29.0',
          capabilities: ['vault.status', 'fragments', 'streams'],
        },
      });
      this.decoder.setKinds(CORE_STREAM_KINDS);
    } else if (message.method === 'core.shutdown') {
      this.send({ type: 'response', id: message.id, result: {} });
    }
  }

  send(message) {
    if (message.type === 'request') this.outstanding.add(message.id);
    this.stdout.write(encodeFrame(message));
  }

  /** One of the core's asks: its ID. */
  ask(method, params) {
    const id = this.nextId++;
    this.send({ type: 'request', id, method, params, context: { caller: 'core' } });
    return id;
  }

  /** `shell.swarm_ready { for, check }`. */
  ready(forId, check) {
    return this.ask('shell.swarm_ready', { for: forId, check });
  }

  /** `shell.swarm_api` for parent `forId`. */
  api(forId, call) {
    return this.ask('shell.swarm_api', { for: forId, ...call });
  }

  credit(id, bytes) {
    this.stdout.write(encodeStreamCredit(id, bytes));
  }

  cancel(id) {
    this.send({ type: 'cancel', id });
  }

  /** Answers main's own request `id`. */
  respond(id, result) {
    this.send({ type: 'response', id, result });
  }

  /** Main's requests named `method`. */
  requests(method) {
    return this.messages.filter((m) => m?.type === 'request' && m.method === method);
  }

  /** Main's answer to the core's ask `id`, once it has come. */
  reply(id) {
    return this.messages.find((m) => m?.type === 'response' && m.id === id);
  }

  framesOf(kind, id) {
    return this.streams.filter((frame) => frame.kind === kind && frame.id === id);
  }

  dataOf(id) {
    return Buffer.concat(this.framesOf(KIND_DATA, id).map((frame) => Buffer.from(frame.bytes)));
  }

  /** The stream `id`'s terminal: `{ end: true }`, its abort frame, or null. */
  terminal(id) {
    if (this.framesOf(KIND_END, id).length) return { end: true };
    return this.framesOf(KIND_ABORT, id)[0] ?? null;
  }

  /** Completes every write `stuck` held back, and those after. */
  release() {
    this.stuck = false;
    for (const callback of this.held.splice(0)) callback();
  }

  exit(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    setImmediate(() => {
      this.stdout.end();
      this.emit('close', code, signal);
    });
  }

  kill(signal) {
    setImmediate(() => this.exit(null, signal));
    return true;
  }
}

/**
 * A CoreClient against a FakeSwarmCore, with the Swarm shell registered
 * (`deps` are its seams) and started: `{ client, shell, core() }`, `core()`
 * the current process.
 */
async function startSwarmCore({ log, deps = {} } = {}) {
  const children = [];
  const client = new CoreClient({
    spawn: () => {
      const child = new FakeSwarmCore();
      children.push(child);
      return child;
    },
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
    shellVersion: 'test',
    grantRoot: os.tmpdir(),
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => {},
  });
  const shell = registerSwarmShell(client, { log, ...deps });
  await client.start();
  return { client, shell, core: () => children[children.length - 1] };
}

/**
 * Sends one of main's requests (`swarm.stamps`: the scripted core reads no
 * method's params, and the shell takes the row it is given) and opens it in
 * the shell from its `onSent` with `capture`, whose signal cancels main's
 * request too: `{ id, generation, handle, answered }`, `handle` the
 * registry's `{ close }`.
 */
function parentOf(client, shell, capture) {
  const out = { id: null, generation: null, handle: null, error: null };
  out.answered = client
    .request(
      'swarm.stamps',
      {},
      { caller: 'shell' },
      {
        // Its signal cancels main's request as it ends the parent.
        signal: capture.signal ?? null,
        onSent: (id, generation) => {
          out.id = id;
          out.generation = generation;
          try {
            out.handle = shell.open({ id, generation }, capture);
          } catch (err) {
            out.error = err;
          }
        },
      }
    )
    .catch(() => {});
  return out;
}

/** Waits for `predicate`, up to about `ms` of real time, in real turns and
 * millisecond sleeps (Jest's fake clock may hold `Date` still). */
async function until(predicate, what, ms = 4000) {
  for (let waited = 0; waited <= ms; waited += 1) {
    for (let i = 0; i < 20; i++) {
      if (predicate()) return;
      await tick();
    }
    await sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Credits every byte main has sent of stream `id` until it ends. */
async function drain(core, id) {
  let credited = 0;
  while (!core.terminal(id)) {
    const sent = core.dataOf(id).length;
    if (sent > credited) {
      core.credit(id, sent - credited);
      credited = sent;
    }
    await tick();
  }
}

module.exports = { FakeSwarmCore, drain, parentOf, sleep, startSwarmCore, tick, until };
