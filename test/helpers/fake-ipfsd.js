/**
 * An in-process freedom-ipfsd for main's tests (freedom-core design 0007):
 * a fake child process (stdio streams, `pid`, `kill()`, `exit` and `close`)
 * that speaks the service's frames, its streams written by `stream-sender.js`
 * (the JS model of fc-protocol's Sender), so credit, cancels and terminals
 * follow the design's rules.
 *
 * `fakeIpfsd(script)` returns a `spawn` for `FreedomIpfsdNode` and the
 * children it spawned. Each child answers what the script says, by method
 * (`hello`, `start`, `stop`, `stats`, `request`), and the default otherwise:
 * a persistent process's hello, `{ instance }` for start and stop, a stats
 * reply, and `ipfs.shutdown` exits 0. A handler gets the message and the
 * child, and answers through it:
 * - `child.result(id, result)`, `child.error(id, code, message)`;
 * - `child.head(id, { status, headers, body })`, then `child.body(id,
 *   bytes, { abort })`: pushed as the window allows, then ended or aborted;
 * - nothing, to hang;
 * - `child.event(name, data)`, `child.exit(code)`.
 *
 * Each child records `requests` (in order), `cancels` and the credit it got.
 */

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const {
  encodeFrame,
  FrameDecoder,
  KIND_STREAM_CREDIT,
  serviceKinds,
} = require('../../src/main/core/frame');
const { StreamSender } = require('./stream-sender');

const json = (value) => Buffer.from(JSON.stringify(value));

const HELLO = Object.freeze({
  protocol: 1,
  service_version: '0.1.0',
  freedom_ipfs: { version: '0.4.6', git_commit: '0bb3e995a9f3da7d2df30939115cfee9b21bd212' },
  kind: 'persistent',
});

/** A stats reply as the service writes it, with `gateway` overrides. */
function statsResult(gateway = {}) {
  return {
    gateway: {
      active_native_handles: 0,
      total_started: 0,
      total_completed: 0,
      total_failed: 0,
      total_cancelled: 0,
      total_freed: 0,
      total_gateway_busy_responses: 0,
      bytes_read: 0,
      max_active_handles: 0,
      last_native_error_code: null,
      last_native_error_message: null,
      ...gateway,
    },
    progress: { active: [], active_count: 0, event_count: 0, events: [] },
    store: { block_count: 3, total_bytes: 1234 },
    budget: { memory: { used: 45088768, limit: 201326592 } },
  };
}

class FakeIpfsdChild extends EventEmitter {
  constructor(script, args, pid) {
    super();
    this.script = script;
    this.args = args;
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    this.cancels = [];
    this.credited = 0;
    this.exited = false;
    this.sender = new StreamSender();
    this.producers = new Map(); // id -> { bytes, offered, abortAt, code }
    const decoder = new FrameDecoder({ kinds: serviceKinds('sender') });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (!this.exited) {
          for (const frame of decoder.push(chunk)) this.onFrame(frame);
          this.pump();
        }
        callback();
      },
      final: (callback) => {
        this.stdinClosed = true;
        callback();
      },
    });
  }

  onFrame(frame) {
    if (frame.kind === KIND_STREAM_CREDIT) {
      this.credited += frame.credit;
      this.sender.receive(frame);
      return;
    }
    const { message } = frame;
    if (message.type === 'cancel') {
      this.cancels.push(message.id);
      this.sender.cancel(message.id);
      this.producers.delete(message.id);
      return;
    }
    this.requests.push(message);
    this.sender.request(message.id);
    const method = message.method.replace(/^ipfs\./, '');
    const handler = this.script[method];
    if (handler) {
      handler(message, this);
      return;
    }
    switch (method) {
      case 'hello':
        this.result(message.id, HELLO);
        break;
      case 'start':
      case 'stop':
        this.result(message.id, { instance: message.params.instance });
        break;
      case 'stats':
        this.result(message.id, statsResult());
        break;
      case 'shutdown':
        setImmediate(() => this.exit(0));
        break;
      default:
        this.error(message.id, 'unknown_method', 'unknown method');
    }
  }

  result(id, result) {
    this.sender.reply(id, json({ type: 'response', id, result }));
    this.pump();
  }

  error(id, code, message = code) {
    this.sender.reply(id, json({ type: 'response', id, error: { code, message } }));
    this.pump();
  }

  /** A head; with `body: true` its stream opens once it is written. */
  head(id, { status = 200, headers = [], body = true } = {}) {
    this.sender.head(id, json({ type: 'response', id, result: { status, headers, body } }), body);
    this.pump();
  }

  /** The body's bytes, as the window allows; then its end, or with
   * `abort: { at, code }`, an abort once that many are queued. */
  body(id, bytes, { abort = null } = {}) {
    this.producers.set(id, {
      bytes,
      offered: 0,
      abortAt: abort ? abort.at : null,
      code: abort?.code,
    });
    this.pump();
  }

  event(event, data) {
    this.stdout.write(encodeFrame({ type: 'event', event, data }));
  }

  produce() {
    for (const [id, p] of this.producers) {
      for (;;) {
        if (p.abortAt !== null && p.offered >= p.abortAt) {
          // The bytes before it are written first: an abort purges what
          // is still queued.
          if (this.sender.queued(id)) break;
          this.sender.abort(id, p.code, 'scripted');
          this.producers.delete(id);
          break;
        }
        if (p.offered >= p.bytes.length) {
          this.sender.finish(id);
          this.producers.delete(id);
          break;
        }
        const limit = p.abortAt === null ? p.bytes.length : Math.min(p.bytes.length, p.abortAt);
        const pushed = this.sender.push(id, p.bytes.subarray(p.offered, limit));
        if (pushed.refused) {
          this.producers.delete(id);
          break;
        }
        p.offered += pushed.taken;
        if (pushed.taken === 0) break;
      }
    }
  }

  pump() {
    if (this.exited) return;
    for (;;) {
      this.produce();
      const next = this.sender.nextFrame();
      if (!next) return;
      this.stdout.write(next.bytes);
    }
  }

  /** The process exits with `code` (null and `signal` for a kill). */
  exit(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('close', code, signal);
    });
  }

  kill(signal = 'SIGTERM') {
    this.killedWith = signal;
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  /** The requests of `method`, in order. */
  sent(method) {
    return this.requests.filter((message) => message.method === method);
  }
}

/**
 * A `spawn` that starts fake freedom-ipfsd children: `script` answers, by
 * method, for every child; `children` lists them, with the command, args
 * and options each was spawned with.
 */
function fakeIpfsd(script = {}) {
  const children = [];
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new FakeIpfsdChild(script, args, 5000 + children.length);
    children.push(child);
    spawned.push({ command, args, options });
    return child;
  };
  return { spawn, children, spawned, script };
}

module.exports = { fakeIpfsd, statsResult, HELLO };
