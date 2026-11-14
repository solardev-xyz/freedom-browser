/**
 * An in-process freedom-radicled for main's tests (freedom-core design
 * 0008): fake-ipfsd.js's child, its frames, streams, credit and exits,
 * answering the Radicle service's methods.
 *
 * `fakeRadicled(script)` returns a `spawn` for `RadicledClient`, the
 * children it spawned, and what each was spawned with (`spawned`: the
 * command, args and options, the environment among them). Each child
 * answers what the script says, by method without `rad.` (`hello`,
 * `identity`, `reconcile`, `start`, `stats`, `read`, …), and the default
 * otherwise:
 * - `hello`: `helloFor(args)`, the `--network` policy it was spawned with
 *   (the import process's `{ mode: "offline" }`), a recipient, the
 *   libradicle build and a confinement report;
 * - `identity`, `reconcile`, `start`: their results for a fresh home;
 * - `import_repo`: `{ rid: IMPORT_RID }`;
 * - `stats`: a running node's (`statsResult`);
 * - `shutdown`: the process exits 0;
 * - anything else: `unknown_method`.
 *
 * A handler answers through the child, as fake-ipfsd.js's do: `result`,
 * `error`, `head` and `body`, `event`, `exit`, or nothing, to hang. A
 * `rad.read` is answered as the service answers one (`readReply`): its head,
 * `{ content_type: "application/json", bytes, body: true }`, then the JSON
 * as the window allows (`readHead` and `body` for the two apart). With
 * `{ says: false }` the head leaves `body` out and opens the stream all the
 * same, as freedom-radicled 0.1.0's did. A `rad.blob` is answered with
 * `blobReply`: its head, and its bytes when the head says they follow.
 *
 * **Network operations** (0008, Methods `rad.connect_seeds` and
 * `rad.clone`): a script's `clone` handler runs the clone. `child.claim(id)`
 * is the network start, as the service's `Ticket::claim`: null if main's
 * cancel came first (the connection has answered it `cancelled`, and
 * nothing starts), else the clone's token, `{ cancelled }`, which main's
 * cancel flips from then on (`onCancel` runs), the connection answering
 * nothing: the handler answers once its clone stops. `child.progress(id)`
 * is the request's progress hub (fake-radicled-progress.js): the service's
 * bounded queue, written one event at a time, which the handler flushes
 * before it answers. With `stdoutHighWaterMark`, the child's stdout holds
 * that many bytes before a write waits for main to read: a reader that
 * pauses (`child.stdout.pause()`) holds the hub's next event back.
 *
 * As the real service does:
 * - **it checks its environment first** (0008, "Spawn and lock"): with any
 *   `RAD_*`, `GIT_*`, `SSH_AUTH_SOCK`, `LISTEN_*` or `XDG_CONFIG_HOME`, or
 *   without `HOME` as an absolute directory, it exits 64 and answers
 *   nothing (`envRefusal`);
 * - **a start step it answers with an error ends it** (0008, Errors): after
 *   an error reply to `rad.identity`, `rad.reconcile` or `rad.start` it
 *   exits 0, unless the script sets `lingerAfterFailedStep` (a process
 *   that doesn't end, for main's kill);
 * - **the import process ends after the import's answer** (design 0010,
 *   D5): after any reply to `rad.import_repo` it exits 0, unless the script
 *   sets `lingerAfterImport`.
 */

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { FakeIpfsdChild, networkOf } = require('./fake-ipfsd');
const { ProgressHub } = require('./fake-radicled-progress');
const { PINNED_RADICLED_VERSION } = require('../../src/main/radicle/radicled-pin');

/** The confinement a fake process reports (freedom-core design 0010). */
const CONFINEMENT = Object.freeze({
  mechanism: 'landlock-4+seccomp',
  files: 'enforced',
  exec: 'enforced',
  ipc: 'partial',
  network: 'none',
  gaps: ['signals'],
  reasons: {},
  resolution: 'system',
});

/** A recipient as the service writes it: 32 bytes, standard base64. */
const RECIPIENT = Buffer.alloc(32, 7).toString('base64');

const HELLO = Object.freeze({
  protocol: 1,
  // The release main expects (`radicled-pin.js`): another is refused.
  service_version: PINNED_RADICLED_VERSION,
  libradicle: { version: '0.8.0', git_commit: '216ced6dddccd7cb1103b2cfda238936cd618897' },
  recipient: RECIPIENT,
  network: { mode: 'direct' },
  confinement: CONFINEMENT,
});

const DID = 'did:key:z6MkfakeRadicledNode';
const NID = 'z6MkfakeRadicledNode';
/** The repository a fake import process imports. */
const IMPORT_RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

/** The start steps: an error reply to one ends the process (0008, Errors). */
const START_STEPS = new Set(['rad.identity', 'rad.reconcile', 'rad.start']);

/** The hello a process spawned with `args` answers: its policy, or the
 * import process's none. */
function helloFor(args = []) {
  if (args[0] === 'import') return { ...HELLO, network: { mode: 'offline' } };
  return { ...HELLO, network: networkOf(args) ?? HELLO.network };
}

/** A running node's `rad.stats` (freedom-core `vectors/radicle-stats.json`),
 * with `overrides`. */
function statsResult(overrides = {}) {
  return {
    node: 'running',
    node_alive: true,
    connected_peers: 0,
    unit: null,
    quarantined_count: 0,
    pools: {
      read: { running: 0, queued: 0, threads: 4, queue: 320 },
      network: { running: 0, queued: 0, threads: 8, queue: 16 },
      write: { running: 0, queued: 0, threads: 1, queue: 16, repairs: 0 },
    },
    budget: { output: { used: 0, limit: 268435456 } },
    network: { mode: 'direct', nat64: { state: 'pending', prefixes: [], failures: [] } },
    ...overrides,
  };
}

/**
 * Why the real service would refuse to start in `env` (its `env::check`):
 * the class of an inherited variable it must not have, `home` for a `HOME`
 * that isn't an absolute directory, or null.
 */
function envRefusal(env = {}) {
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith('RAD_')) return 'rad';
    if (upper.startsWith('GIT_')) return 'git';
    if (upper === 'SSH_AUTH_SOCK') return 'ssh_agent';
    if (upper.startsWith('LISTEN_')) return 'socket_activation';
    if (upper === 'XDG_CONFIG_HOME') return 'xdg_config';
  }
  const home = env.HOME;
  if (typeof home !== 'string' || !path.isAbsolute(home)) return 'home';
  try {
    return fs.statSync(home).isDirectory() ? null : 'home';
  } catch {
    return 'home';
  }
}

class FakeRadicledChild extends FakeIpfsdChild {
  constructor(script, args, pid, env) {
    super(script, args, pid);
    this.env = env;
    // What the service's own check refuses of its environment, if anything:
    // then it exits 64 before it reads a frame.
    this.refused = envRefusal(env);
    this.methods = new Map(); // id -> method, for the start steps' errors
    if (script.stdoutHighWaterMark) {
      this.stdout = new PassThrough({ highWaterMark: script.stdoutHighWaterMark });
    }
    // The network requests past their start: id -> their token.
    this.claimed = new Map();
    // The clones' progress: id -> their hub.
    this.hubs = new Map();
  }

  onFrame(frame) {
    const id = frame.message?.type === 'cancel' ? frame.message.id : null;
    const token = id === null ? null : this.claimed.get(id);
    if (token) {
      // Past the network start, main's cancel reaches the clone's token
      // alone: the connection answers nothing.
      this.cancels.push(id);
      if (!token.cancelled) {
        token.cancelled = true;
        token.onCancel?.();
      }
      return;
    }
    super.onFrame(frame);
  }

  /** The network start of request `id`: its token, or null if main's cancel
   * came first (answered `cancelled`; nothing starts). */
  claim(id) {
    if (this.cancels.includes(id)) return null;
    const token = { cancelled: false, onCancel: null };
    this.claimed.set(id, token);
    return token;
  }

  /** Request `id`'s progress hub, made at its first use. */
  progress(id) {
    let hub = this.hubs.get(id);
    if (!hub) {
      hub = new ProgressHub(this, id);
      this.hubs.set(id, hub);
    }
    return hub;
  }

  answer(message) {
    if (this.refused) return;
    this.methods.set(message.id, message.method);
    const method = message.method.replace(/^rad\./, '');
    const handler = this.script[method];
    if (handler) {
      handler(message, this);
      return;
    }
    switch (method) {
      case 'hello':
        this.result(message.id, helloFor(this.args));
        break;
      case 'identity':
        this.result(message.id, {
          did: DID,
          nid: NID,
          ephemeral: Boolean(message.params?.ephemeral),
        });
        break;
      case 'reconcile':
        this.result(message.id, {
          was_dirty: false,
          repaired: {},
          quarantined: { count: 0, first: [] },
        });
        break;
      case 'start':
        this.result(message.id, { did: DID, nid: NID, alias: message.params?.alias ?? null });
        break;
      case 'stats':
        this.result(message.id, statsResult());
        break;
      case 'import_repo':
        this.result(message.id, { rid: IMPORT_RID });
        break;
      case 'shutdown':
        setImmediate(() => this.exit(0));
        break;
      default:
        this.error(message.id, 'unknown_method', 'unknown method');
    }
  }

  /** `rad.read`'s head for a body of `bytes` bytes, which opens the stream:
   * `{ content_type, bytes, body: true }`, or with `says: false` the same
   * without `body` (freedom-radicled 0.1.0's head). */
  readHead(id, bytes, { says = true } = {}) {
    const result = { content_type: 'application/json', bytes };
    if (says) result.body = true;
    this.sender.head(id, Buffer.from(JSON.stringify({ type: 'response', id, result })), true);
    this.pump();
  }

  /** `rad.read`'s whole reply: the head (`readHead`'s, with `options`), then
   * `text` (a string or bytes) as the window allows, then its end. */
  readReply(id, text, options) {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
    this.readHead(id, bytes.length, options);
    this.body(id, bytes);
  }

  /** `rad.blob`'s reply (0008, "The blob API"): the head `{ oid, size,
   * binary, range, body }` (`binary` false and `range` null unless given),
   * whose `body` (by default, whether `bytes` has any) opens the stream, then
   * `bytes` as the window allows. */
  blobReply(id, head, bytes = Buffer.alloc(0)) {
    const opens = head.body ?? bytes.length > 0;
    const result = { binary: false, range: null, ...head, body: opens };
    this.sender.head(id, Buffer.from(JSON.stringify({ type: 'response', id, result })), opens);
    this.pump();
    if (opens) this.body(id, bytes);
  }

  /** An error reply with `data` (0008, Errors: `range_not_satisfiable`'s
   * `{ size }`). */
  errorWithData(id, code, message, data) {
    this.sender.reply(
      id,
      Buffer.from(JSON.stringify({ type: 'response', id, error: { code, message, data } }))
    );
    this.pump();
  }

  /** A result; after the import's, the import process ends (exit 0). */
  result(id, result) {
    super.result(id, result);
    this.afterImport(id);
  }

  /** An error reply; after a start step's, or the import's, the process
   * ends (exit 0). */
  error(id, code, message = code) {
    super.error(id, code, message);
    if (START_STEPS.has(this.methods.get(id)) && !this.script.lingerAfterFailedStep) {
      setImmediate(() => this.exit(0));
    }
    this.afterImport(id);
  }

  afterImport(id) {
    if (this.methods.get(id) === 'rad.import_repo' && !this.script.lingerAfterImport) {
      setImmediate(() => this.exit(0));
    }
  }
}

/**
 * A `spawn` that starts fake freedom-radicled children: `script` answers,
 * by method, for every child; `children` lists them, and `spawned` what
 * each was spawned with. A child whose environment the real service would
 * refuse exits 64 at once.
 */
function fakeRadicled(script = {}) {
  const children = [];
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new FakeRadicledChild(script, args, 6000 + children.length, options?.env);
    children.push(child);
    spawned.push({ command, args, options });
    if (child.refused) setImmediate(() => child.exit(64));
    return child;
  };
  return { spawn, children, spawned, script };
}

module.exports = {
  fakeRadicled,
  envRefusal,
  helloFor,
  statsResult,
  CONFINEMENT,
  HELLO,
  RECIPIENT,
  DID,
  NID,
  IMPORT_RID,
};
