/**
 * The profile's Radicle node on the freedom-radicled service process
 * (freedom-core design 0008, step 6), in place of the add-on's in-process
 * node, for radicle-manager.js under `FREEDOM_RADICLE_BACKEND=service`. The
 * process is radicled-client.js's; this is the node's life on it.
 *
 * - **The start** (0008, "Start, stop and reconciliation" and "The sealed
 *   release"), on each process, a crash's restart's too:
 *   1. spawn: `serve` on the Radicle home (the client), after main's check
 *      of its grant (design 0010, step 7);
 *   2. `rad.hello`, whose `recipient` is the X25519 key the process made
 *      for this start;
 *   3. `nodes.seal_radicle_key { recipient }` from the core
 *      (`vaultBackend.sealRadicleKey`): the node key sealed to it;
 *   4. `rad.identity { sealed }`, or `{ ephemeral: true }` on the core's
 *      `no_vault` only, never after another answer: a throwaway key, made
 *      in the process, never written (0008, "Profiles without a vault");
 *   5. `rad.reconcile`, under its 300 s;
 *   6. `rad.start { alias }`;
 *   7. running, once a `rad.stats` reply says `node_alive`. The manager
 *      then runs today's background `connect_seeds(15000)` and the default
 *      repository's clone (`connectSeeds`, `cloneRepo`).
 *
 *   Main sees the recipient, `enc` and the ciphertext, never the key, and
 *   logs none of them.
 * - **When the vault is locked** (0008, "When the node can start"): no
 *   process is spawned. The spawn waits, in main, for the core's
 *   `vault.unlocked` (B4's `deferSpawn`): at the start, and for a crash's
 *   restart that falls due while the vault is locked. The wait is no crash,
 *   and holds no gate on the home. The boundary is the seal's reply: a lock
 *   before it makes the core answer `vault_locked`, and the process is shut
 *   down and the start waits again; once the reply has arrived, a lock stops
 *   nothing, and the start completes.
 * - **`key_file_present`** (0008, "The switch"): the home still holds
 *   `keys/radicle`, from the add-on. Once the process has exited, so the
 *   home's gate is free, the core runs the switch, `nodes.write_identity {
 *   node: 'radicle', home, alias, custody: 'sealed' }` with no wipe, which
 *   removes the key files and names the old identity in `node/dirty`. Only
 *   on `installed` does the start run once more; a second
 *   `key_file_present` in the same start is an error.
 * - **The other start steps' errors** end the process, which main doesn't
 *   restart (0008, Errors): `rad.reconcile`'s `deadline` is "Radicle is
 *   still repairing its data", for which the manager's start, the Retry,
 *   spawns a fresh process that continues from the checkpoints;
 *   `recovery_failed`, `start_failed` and `bad_sealed_key` give the
 *   service's message to the manager's error state.
 * - **Readiness** (0008, Main's side): up while the generation is live,
 *   its `rad.start` succeeded, and the last `rad.stats` reply says
 *   `node_alive` and is under 15 s old. `rad.stats` runs every 5 s once
 *   `rad.start` has succeeded. A running node that isn't up goes
 *   `restarting`, and comes back `running` once it is.
 * - **Crashes and restarts** are the client's: 0.5 s, 2 s, then 10 s, and
 *   three within 60 s stop them. Each restart is a new generation, with
 *   the whole start again: its key is sealed anew.
 * - **Stop** is the process's end: `rad.shutdown`, and the kill 10 s after
 *   it. The exit is the proof that the node stopped, in place of the
 *   add-on's `isStarted()` (R-8).
 * - **Reads** (`read`, `rad.read`) go to the running generation only, as
 *   radicle-service-backend.js sends them: none while it starts or after
 *   it ended (`stopped`).
 * - **Before the first spawn of each start**, a control socket the add-on
 *   left at `<home>/node/control.sock` is removed under the home's gate
 *   (`removeStaleControlSocket`), so the grant check doesn't refuse a home
 *   the add-on crashed on.
 * - **Diagnostics** (design 0010, step 5): hello's confinement is logged at
 *   each spawn, and the build info and confinement are kept for the nodes
 *   panel.
 */

const fs = require('fs');
const crypto = require('crypto');
const { spawn: spawnProcess } = require('child_process');
const defaultLog = require('../logger');
const { CoreError, isObject } = require('../core/service-client');
const { confinementLog } = require('../ipfs/ipfsd-client');
const { RadicledClient } = require('./radicled-client');
const { getRadicledBinaryPath } = require('./radicled-binary');
const { removeStaleControlSocket } = require('./radicled-gate');

const HEALTH_INTERVAL_MS = 5_000;
const STATS_FRESH_MS = 15_000;
// rad.start's alias, as the add-on passes it: the service sets it only on a
// home that has none yet.
const DEFAULT_ALIAS = 'FreedomBrowser';
const UNAVAILABLE = 'radicle_unavailable';
const DIRECT = Object.freeze({ mode: 'direct' });

// The manager's error texts. None names a path.
const EXITED = 'freedom-radicled exited';
const CRASHED = 'freedom-radicled crashed three times within a minute';
const NOT_RUNNING = 'The Radicle node is not running';
const CONFINEMENT_REFUSED = 'freedom-radicled refused its confinement';
const LOCK_HELD = 'The Radicle data is in use by another process. Close it and try again.';
const STORAGE = "freedom-radicled can't use the Radicle data's storage";
const USAGE = 'freedom-radicled refused how it was started';
const GRANT_REFUSED = "The Radicle data overlaps another component's directory";
const KEY_UNAVAILABLE = "Radicle couldn't get its key from the identity core";
const REPAIRING = 'Radicle is still repairing its data';
const KEY_FILE_AGAIN = 'The Radicle data still holds a key file after its switch to the service';
const START_FAILED = 'Failed to start the Radicle node';
const IDENTITY_MISMATCH = 'freedom-radicled answered with an identity main did not ask for';

// A start step's codes whose message the manager shows (0008, Errors).
const STEP_MESSAGES = new Set([
  'recovery_failed',
  'start_failed',
  'bad_sealed_key',
  'no_identity',
  'invalid_argument',
]);

/** What the manager shows for a start step's error `err`. */
function stepFailure(err) {
  const code = err?.code;
  if (code === 'deadline') return REPAIRING;
  if (STEP_MESSAGES.has(code)) {
    return typeof err.message === 'string' && err.message ? err.message : START_FAILED;
  }
  return START_FAILED;
}

/** What the manager shows for the client's `failed` reason. */
function clientFailure(reason) {
  switch (reason) {
    case 'exit code 77':
      return CONFINEMENT_REFUSED;
    case 'exit code 75':
      return LOCK_HELD;
    case 'exit code 74':
      return STORAGE;
    case 'exit code 64':
      return USAGE;
    case 'three crashes within a minute':
      return CRASHED;
    case 'spawn wait failed':
    case 'spawn deferral failed':
      return KEY_UNAVAILABLE;
    default:
      return EXITED;
  }
}

/**
 * The core, as the node uses it: the vault's state and its events, the
 * sealed release, and the switch (`vaultBackend`).
 */
function coreKeys() {
  const { vaultBackend } = require('../core/vault-backend');
  return {
    status: () => vaultBackend.status(),
    seal: (recipient) => vaultBackend.sealRadicleKey(recipient),
    switchHome: (spec) => vaultBackend.writeNodeIdentity(spec, crypto.randomUUID()),
    onVaultEvent: (listener) => vaultBackend.onVaultEvent(listener),
  };
}

/** Main's record of node identity writes (core/node-identity-guard.js). */
function identityGuard() {
  const guard = require('../core/node-identity-guard');
  return {
    blockReason: () => guard.nodeBlockReason('radicle'),
    block: (status) => guard.blockNode('radicle', status),
    unblock: () => guard.unblockNode('radicle'),
  };
}

class RadicledNode {
  /**
   * @param {object} options
   * @param {string} options.home - the profile's Radicle home
   *   (`prepareRadicleDataDir()`)
   * @param {string} options.lockDir - the core's lock directory
   * @param {string} options.ownHome - the service's own `HOME`
   *   (`getRadicledHomeDir()`)
   * @param {string} [options.alias] - `rad.start`'s alias
   * @param {Function} [options.switchAlias] - () => the alias the switch
   *   writes into the home's configuration: the one it has
   * @param {object} [options.keys] - the core (`coreKeys()`): `status()`,
   *   `seal(recipient)`, `switchHome(spec)`, `onVaultEvent(listener)`
   * @param {object} [options.guard] - main's node identity guard
   *   (`identityGuard()`): `blockReason()`, `block(status)`, `unblock()`
   * @param {Function} [options.removeStaleSocket] - (home, { signal, log })
   *   (`removeStaleControlSocket`)
   * @param {object} [options.network] - the process's policy; `direct`
   * @param {Function} [options.onFailure] - (reason, node) once it gives up
   *   after it was running
   * @param {Function} [options.onChange] - (state, node): `restarting`,
   *   `running` again, and `waiting` (for the vault's unlock)
   * @param {string} [options.command] - the binary
   * @param {Function} [options.spawn] - child_process.spawn (injectable)
   * @param {string|null} [options.serviceVersion] - the release hello must
   *   report (the client's default)
   * @param {object} [options.log]
   * @param {string} [options.shellVersion]
   * @param {Function} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    home,
    lockDir,
    ownHome,
    alias = DEFAULT_ALIAS,
    switchAlias = null,
    keys = null,
    guard = null,
    removeStaleSocket = removeStaleControlSocket,
    network = DIRECT,
    onFailure = null,
    onChange = null,
    command = null,
    spawn = spawnProcess,
    serviceVersion = undefined,
    log = defaultLog,
    shellVersion,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.home = home;
    this.lockDir = lockDir;
    this.ownHome = ownHome;
    this.alias = alias;
    this.switchAlias = switchAlias ?? (() => alias);
    this.keys = keys ?? coreKeys();
    this.guard = guard ?? identityGuard();
    this.removeStaleSocket = removeStaleSocket;
    this.network = network;
    this.onFailure = onFailure;
    this.onChange = onChange;
    this.command = command;
    this.spawn = spawn;
    this.serviceVersion = serviceVersion;
    this.log = log;
    this.shellVersion = shellVersion;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.client = null;
    // stopped → starting → running ⇄ restarting; failed, or stopping → stopped.
    this.state = 'stopped';
    this.failureReason = null;
    // The code of the start step's error the node gave up on, if one did
    // (`deadline`: still repairing, so the manager's start retries).
    this.failureCode = null;
    this.serviceHello = null;
    // The generation whose `rad.start` succeeded: { gen, did, nid, alias,
    // ephemeral }. Dropped with the generation.
    this.active = null;
    // The last stats reply, for the `active` it was asked of.
    this.stats = null;
    this.statsFlight = null;
    this.pollTimer = null;
    // The switch ran in this start (it runs once).
    this.switched = false;
    // A process shut down for the unlock or the switch, and the start
    // again after it: its promise, or null.
    this.cycling = null;
    // The wait for the vault's unlock: the deferred spawn's go-ahead, the
    // wakers of the waits under way, and whether the manager was told.
    this.spawnCleared = false;
    this.wakers = new Set();
    this.waitingForUnlock = false;
    this.prepareAbort = null;
    this.prepared = null;
    this.started = null;
    this.resolveStart = null;
    this.stopping = null;
  }

  /** Whether this build has the freedom-radicled binary. */
  static isAvailable() {
    return fs.existsSync(getRadicledBinaryPath());
  }

  /** The libradicle build the process links, or null. */
  get version() {
    return this.serviceHello?.libradicle.version ?? null;
  }

  /** The confinement the process got (design 0010, "Reporting"), or null. */
  get confinement() {
    return this.serviceHello?.confinement ?? null;
  }

  /** The libradicle build and the service, for the nodes panel. */
  buildInfo() {
    const hello = this.serviceHello;
    if (!hello) return null;
    return {
      name: 'libradicle',
      version: hello.libradicle.version,
      git_commit: hello.libradicle.git_commit,
      service: {
        name: 'freedom-radicled',
        version: hello.service_version,
        network: hello.network,
        confinement: hello.confinement,
      },
    };
  }

  /**
   * Starts the node. Resolves true once it is up, through any unlock wait,
   * switch and restarts on the way; false if it gave up (`failureReason`
   * says why) or was stopped first.
   */
  start() {
    if (this.started) return this.started;
    if (this.stopping) return Promise.resolve(false);
    this.state = 'starting';
    this.switched = false;
    this.started = new Promise((resolve) => {
      this.resolveStart = resolve;
    });
    this.prepareAbort = new AbortController();
    this.prepared = this.removeStaleSocket(this.home, {
      signal: this.prepareAbort.signal,
      log: this.log,
    })
      .catch(() => {})
      .then(() => {
        if (!this.stopping && this.state !== 'failed') this.spawnClient();
      });
    return this.started;
  }

  spawnClient() {
    const client = new RadicledClient({
      home: this.home,
      lockDir: this.lockDir,
      ownHome: this.ownHome,
      network: this.network,
      ...(this.command ? { command: this.command } : {}),
      ...(this.serviceVersion !== undefined ? { serviceVersion: this.serviceVersion } : {}),
      spawn: this.spawn,
      log: this.log,
      shellVersion: this.shellVersion,
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      // Before every spawn, a crash's restart's too: none while the vault
      // is locked (0008, "When the node can start").
      deferSpawn: () => this.deferSpawn(),
    });
    this.client = client;
    client.on('ready', (hello) => this.onReady(client, hello));
    client.on('exit', () => this.onExit(client));
    client.on('failed', (reason) => this.onClientFailed(client, reason));
    this.schedulePoll();
    // Readiness is the node's: the handshake's failures arrive as events.
    client.start().catch(() => {});
  }

  /** Stops the node: its process's exit is the proof. Idempotent. */
  stop() {
    if (!this.stopping) this.stopping = this.stopNode();
    return this.stopping;
  }

  async stopNode() {
    this.state = 'stopping';
    const cycling = this.cycling;
    this.cycling = null;
    this.prepareAbort?.abort();
    this.cancelTimers();
    this.wakeWaits();
    this.retireGeneration();
    this.settleStart(false);
    // At once, so a deferred spawn's wait ends with it; a client made while
    // the stale socket was checked has none (`start`).
    const stopped = this.client?.stop();
    await this.prepared;
    // A switch's write in flight too: the core holds the home's gate for
    // it, so a later start waits for it.
    await Promise.all([stopped, cycling]);
    this.state = 'stopped';
  }

  /** Whether the node is up (0008, Main's side, "Readiness"). */
  isUp() {
    const active = this.active;
    return Boolean(
      active &&
      this.client?.serves(active.gen) &&
      this.stats?.active === active &&
      this.stats.result.node_alive === true &&
      this.now() - this.stats.at < STATS_FRESH_MS
    );
  }

  /** The number of the process whose `rad.start` succeeded, while it
   * serves, or null: each crash's restart is a new one. */
  get generation() {
    return this.liveActive()?.gen.number ?? null;
  }

  /** The running generation's identity, `{ did, nid, alias, ephemeral }`,
   * or null. */
  activeIdentity() {
    const active = this.liveActive();
    if (!active) return null;
    const { did, nid, alias, ephemeral } = active;
    return { did, nid, alias, ephemeral };
  }

  /** The node's connected peers, as its last stats reply counted them, or
   * null. */
  connectedPeers() {
    const peers = this.liveStats()?.connected_peers;
    return Number.isInteger(peers) ? peers : null;
  }

  /** `rad.connect_seeds { timeout_ms }` on the running generation: today's
   * report. */
  connectSeeds(timeoutMs) {
    const active = this.liveActive();
    if (!active) return Promise.reject(new Error(NOT_RUNNING));
    return this.client.connectSeeds(active.gen, timeoutMs);
  }

  /**
   * `rad.read { op, args }` on the running generation (0008, "JSON
   * results"): `{ result, body }`, the head and its JSON body as a byte
   * stream (radicled-client.js's `read`). `signal` cancels it, before the
   * head or during the body. With no generation running, `stopped`.
   */
  read(op, args, { signal = null } = {}) {
    const active = this.liveActive();
    if (!active) return Promise.reject(new CoreError('stopped', NOT_RUNNING));
    return this.client.read(active.gen, op, args, { signal });
  }

  /** What main holds for the running generation's streams (the client's
   * `streamStats`), or null. */
  streamStats() {
    const active = this.liveActive();
    return active ? this.client.streamStats(active.gen) : null;
  }

  /** `rad.clone { rid, timeout_ms }` on the running generation, without
   * progress events. */
  cloneRepo(rid, timeoutMs) {
    const active = this.liveActive();
    if (!active) return Promise.reject(new Error(NOT_RUNNING));
    return this.client.clone(active.gen, { rid, timeout_ms: timeoutMs, progress: false });
  }

  // ---- the vault's unlock ----

  /**
   * The client's deferred spawn: none while the vault is locked. A wait
   * that ends lets the client ask again, which spawns.
   */
  deferSpawn() {
    if (this.spawnCleared) {
      this.spawnCleared = false;
      return null;
    }
    return this.untilVaultUsable().then((usable) => {
      if (usable) this.spawnCleared = true;
    });
  }

  /**
   * Resolves true once a spawn may go ahead: the vault is unlocked, or there
   * is none (the seal then answers `no_vault`). While it is locked, waits
   * for the core's next vault event, then asks again. False once the node
   * stops or gives up, whose client's stop has ended the wait. Rejects if
   * the core can't say, which fails the start: nothing falls back to a
   * throwaway key.
   */
  async untilVaultUsable() {
    for (;;) {
      if (this.stopping || this.state === 'failed') return false;
      // Subscribed before asking, so an unlock meanwhile isn't missed.
      const woken = this.nextVaultEvent();
      let status;
      try {
        status = await this.keys.status();
      } catch (err) {
        woken.cancel();
        this.log.error("[Radicle] The vault's state couldn't be read", {
          code: err?.code || 'error',
        });
        throw err;
      }
      if (this.stopping || this.state === 'failed') {
        woken.cancel();
        return false;
      }
      if (!status?.exists || status.unlocked) {
        woken.cancel();
        this.waitingForUnlock = false;
        return true;
      }
      if (!this.waitingForUnlock) {
        this.waitingForUnlock = true;
        this.log.info('[Radicle] The vault is locked: the node starts once it is unlocked');
        this.notify('waiting');
      }
      await woken.promise;
    }
  }

  /** The next vault event, or the node's stop: `{ promise, cancel }`. */
  nextVaultEvent() {
    let wake;
    const promise = new Promise((resolve) => {
      wake = resolve;
    });
    let unsubscribe = () => {};
    const done = () => {
      this.wakers.delete(done);
      unsubscribe();
      wake();
    };
    this.wakers.add(done);
    try {
      unsubscribe = this.keys.onVaultEvent(() => done()) ?? (() => {});
    } catch {
      unsubscribe = () => {};
    }
    return { promise, cancel: done };
  }

  wakeWaits() {
    for (const wake of [...this.wakers]) wake();
  }

  // ---- the start, on each generation ----

  onReady(client, hello) {
    if (client !== this.client || this.stopping || this.state === 'failed') return;
    this.serviceHello = hello;
    // What the process got (design 0010, "Reporting"): logged at each spawn.
    this.log.info('[Radicle] freedom-radicled confinement', confinementLog(hello.confinement));
    void this.runStart(client, client.current, hello);
  }

  /** Whether `gen` of `client` still carries this start. */
  carries(client, gen) {
    return (
      client === this.client &&
      client.serves(gen) &&
      !this.stopping &&
      this.state !== 'failed' &&
      !this.cycling
    );
  }

  async runStart(client, gen, hello) {
    // 3. The node key, sealed to this process (0008, "The sealed release").
    let params;
    try {
      const sealed = await this.keys.seal(hello.recipient);
      params = { sealed: { enc: sealed?.enc, ciphertext: sealed?.ciphertext } };
    } catch (err) {
      if (!this.carries(client, gen)) return;
      if (err?.code === 'no_vault') {
        // The only answer that leads to a throwaway key.
        params = { ephemeral: true };
      } else if (err?.code === 'vault_locked') {
        // Before the key's release: the process goes, and the start waits.
        this.log.info('[Radicle] The vault locked before the node key was released');
        this.cycle(client, 'unlock');
        return;
      } else {
        this.log.error("[Radicle] The core didn't release the node key", {
          code: err?.code || 'error',
        });
        this.giveUp(KEY_UNAVAILABLE);
        return;
      }
    }
    // From here on a lock stops nothing (0008: the boundary is the seal's
    // reply). A process that ended meanwhile is restarted by the client,
    // and its restart is sealed anew.
    if (!this.carries(client, gen)) return;

    // 4. rad.identity.
    let identity;
    try {
      identity = await client.identity(gen, params);
    } catch (err) {
      this.onStepError(client, gen, 'rad.identity', err);
      return;
    }
    if (!this.carries(client, gen)) return;
    const ephemeral = Boolean(params.ephemeral);
    if (
      !isObject(identity) ||
      typeof identity.did !== 'string' ||
      typeof identity.nid !== 'string' ||
      identity.ephemeral !== ephemeral
    ) {
      this.log.error('[Radicle] freedom-radicled answered rad.identity with another identity');
      this.giveUp(IDENTITY_MISMATCH);
      return;
    }

    // 5. rad.reconcile.
    let report;
    try {
      report = await client.reconcile(gen);
    } catch (err) {
      this.onStepError(client, gen, 'rad.reconcile', err);
      return;
    }
    if (!this.carries(client, gen)) return;
    this.log.info('[Radicle] freedom-radicled reconciled the Radicle data', {
      was_dirty: Boolean(report?.was_dirty),
      quarantined: Number.isInteger(report?.quarantined?.count) ? report.quarantined.count : null,
    });

    // 6. rad.start.
    let started;
    try {
      started = await client.startNode(gen, this.alias);
    } catch (err) {
      this.onStepError(client, gen, 'rad.start', err);
      return;
    }
    if (!this.carries(client, gen)) return;
    this.active = {
      gen,
      did: typeof started?.did === 'string' ? started.did : identity.did,
      nid: typeof started?.nid === 'string' ? started.nid : identity.nid,
      alias: typeof started?.alias === 'string' ? started.alias : null,
      ephemeral,
    };
    this.log.info('[Radicle] freedom-radicled node started', { ephemeral });
    // 7. Running once a stats reply says the node is alive.
    this.refreshStats();
  }

  /** A start step's error on `gen` (0008, Errors). */
  onStepError(client, gen, method, err) {
    if (client !== this.client || this.stopping || this.state === 'failed' || this.cycling) return;
    // The process ended under it, or was killed as hung: the client's rules
    // restart it or fail it.
    if (err?.code === UNAVAILABLE) return;
    if (err?.code === 'key_file_present') {
      this.cycle(client, 'switch');
      return;
    }
    this.log.error('[Radicle] freedom-radicled start step failed', {
      method,
      code: typeof err?.code === 'string' ? err.code : 'error',
    });
    this.giveUp(stepFailure(err), err?.code ?? null);
  }

  /**
   * Shuts the process down, then starts again on the same client: after the
   * vault locked before the key's release (the spawn waits for the unlock),
   * or for the switch, which runs once the process has exited and so let
   * the home's gate go. Neither counts as a crash.
   */
  cycle(client, why) {
    if (why === 'switch' && this.switched) {
      this.log.error('[Radicle] freedom-radicled found a key file again after the switch');
      this.giveUp(KEY_FILE_AGAIN, 'key_file_present');
      return;
    }
    this.retireGeneration();
    this.goDown();
    const run = (async () => {
      await client.stop();
      if (this.cycling !== run) return;
      if (why === 'switch' && !(await this.switchHome())) return;
      if (this.cycling !== run) return;
      this.cycling = null;
      // The deferred spawn asks the vault again.
      client.start().catch(() => {});
    })();
    this.cycling = run;
  }

  /**
   * The switch (0008, "The switch"): the core removes `keys/radicle` and
   * `keys/radicle.pub` under the home's gate and names the old identity in
   * `node/dirty`, with no wipe. True on `installed`; otherwise the node
   * gives up. An error reply wrote nothing; a lost reply may have, and so
   * may a write that didn't finish, so the node stays blocked until a write
   * is installed (node-identity-guard.js).
   */
  async switchHome() {
    const blocked = this.guard.blockReason();
    if (blocked) {
      this.giveUp(blocked);
      return false;
    }
    let alias = this.alias;
    try {
      alias = this.switchAlias() || this.alias;
    } catch {
      // The start's alias.
    }
    this.log.info('[Radicle] The Radicle data holds a key file: switching it to the service');
    let written;
    try {
      written = await this.keys.switchHome({
        node: 'radicle',
        home: this.home,
        alias,
        custody: 'sealed',
      });
    } catch (err) {
      if (err?.code === 'core_unavailable') this.guard.block('pending_recovery');
      this.log.error('[Radicle] The switch to the service failed', { code: err?.code || 'error' });
      this.giveUp(
        `The Radicle data couldn't be switched to the service: ${err?.message || 'error'}`,
        err?.code ?? null
      );
      return false;
    }
    if (written?.status !== 'installed') {
      const status = typeof written?.status === 'string' ? written.status : 'unknown';
      this.guard.block(status);
      this.giveUp(`The Radicle data's switch to the service did not finish (${status})`, status);
      return false;
    }
    this.guard.unblock();
    this.switched = true;
    this.log.info('[Radicle] The Radicle data is switched to the service: its key file is gone');
    return true;
  }

  // ---- running ----

  /** The active generation, while its process serves. */
  liveActive() {
    const active = this.active;
    return active && this.client?.serves(active.gen) ? active : null;
  }

  liveStats() {
    const active = this.liveActive();
    return active && this.stats?.active === active ? this.stats.result : null;
  }

  /** `rad.stats` on the active generation, one call at a time. */
  refreshStats() {
    if (this.statsFlight) return this.statsFlight;
    const active = this.liveActive();
    if (!active) return Promise.resolve();
    const flight = this.client
      .nodeStats(active.gen)
      .then(
        (result) => this.onStats(active, result),
        (err) => {
          if (err?.code !== UNAVAILABLE) {
            this.log.warn('[Radicle] freedom-radicled stats failed', {
              code: err?.code || 'error',
            });
          }
        }
      )
      .finally(() => {
        if (this.statsFlight === flight) this.statsFlight = null;
      });
    this.statsFlight = flight;
    return flight;
  }

  onStats(active, result) {
    if (active !== this.active || !isObject(result)) return;
    this.stats = { active, at: this.now(), result };
    this.checkUp();
  }

  /** Readiness, applied: running while up (0008, Main's side). */
  checkUp() {
    if (this.stopping || this.state === 'failed') return;
    const up = this.isUp();
    if (up && this.state === 'starting') {
      this.state = 'running';
      this.settleStart(true);
    } else if (up && this.state === 'restarting') {
      this.state = 'running';
      this.notify('running');
    } else if (!up && this.state === 'running') {
      this.goDown();
    }
  }

  schedulePoll() {
    if (this.pollTimer) return;
    this.pollTimer = this.setTimer(() => this.poll(), HEALTH_INTERVAL_MS);
    this.pollTimer?.unref?.();
  }

  /** Every 5 s: `rad.stats`, and readiness against the last reply. */
  poll() {
    this.pollTimer = null;
    if (this.stopping || this.state === 'failed') return;
    this.checkUp();
    this.refreshStats();
    this.schedulePoll();
  }

  // ---- the process ----

  onExit(client) {
    if (client !== this.client) return;
    this.retireGeneration();
    if (this.stopping || this.state === 'failed') return;
    this.goDown();
  }

  onClientFailed(client, reason) {
    if (client !== this.client || this.stopping || this.cycling) return;
    if (reason === 'spawn refused' && client.grantRefusal) {
      this.giveUp(GRANT_REFUSED);
      return;
    }
    this.giveUp(clientFailure(reason));
  }

  /** The generation's identity and stats go with it. */
  retireGeneration() {
    this.active = null;
    this.stats = null;
  }

  /** A running node goes down until it is up again. */
  goDown() {
    if (this.state !== 'running') return;
    this.state = 'restarting';
    this.notify('restarting');
  }

  /** Nothing more is started: the process goes, and the manager hears why. */
  giveUp(reason, code = null) {
    if (this.state === 'failed' || this.stopping) return;
    const wasStarting = this.state === 'starting';
    this.state = 'failed';
    this.failureReason = reason;
    this.failureCode = code;
    this.cycling = null;
    this.retireGeneration();
    this.cancelTimers();
    this.wakeWaits();
    this.client?.stop();
    if (wasStarting) {
      this.settleStart(false);
      return;
    }
    if (typeof this.onFailure === 'function') {
      try {
        this.onFailure(reason, this);
      } catch (err) {
        this.log.warn('[Radicle] freedom-radicled failure callback failed:', err.message);
      }
    }
  }

  cancelTimers() {
    if (this.pollTimer) this.clearTimer(this.pollTimer);
    this.pollTimer = null;
  }

  settleStart(value) {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    resolve?.(value);
  }

  notify(state) {
    if (typeof this.onChange !== 'function') return;
    try {
      this.onChange(state, this);
    } catch (err) {
      this.log.warn('[Radicle] freedom-radicled state callback failed:', err.message);
    }
  }
}

module.exports = {
  RadicledNode,
  coreKeys,
  identityGuard,
  stepFailure,
  clientFailure,
  DEFAULT_ALIAS,
  HEALTH_INTERVAL_MS,
  STATS_FRESH_MS,
  EXITED,
  CRASHED,
  NOT_RUNNING,
  CONFINEMENT_REFUSED,
  LOCK_HELD,
  GRANT_REFUSED,
  KEY_UNAVAILABLE,
  REPAIRING,
  KEY_FILE_AGAIN,
  START_FAILED,
};
