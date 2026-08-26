/**
 * Remote-signer session broker.
 *
 * Main's remote signer backend publishes signing jobs over IPC (see
 * src/main/wallet/remote/bridge.js); this module runs them: it hosts an
 * openlv session (P2P, end-to-end encrypted — the signaling relay only
 * sees ciphertext), exposes the session URI for the QR dialog, tunnels
 * the wallet JSON-RPC request to the phone, and responds to main with
 * the phone's answer. Main verifies every signature before using it —
 * nothing here is trusted with more than transporting bytes.
 *
 * One session per job (per-request QR): no session secrets outlive the
 * request. UI (WP-R3) subscribes via onJobEvent to render QR / waiting /
 * error states and calls cancelJob when the user closes the dialog.
 */

// Default signaling relay (spec default). Carries only encrypted
// handshake/negotiation frames — never wallet data in the clear.
const DEFAULT_SIGNALING = { p: 'mqtt', s: 'wss://test.mosquitto.org:8081/mqtt' };

// Where the dual-purpose QR sends phones without an openlv-native wallet
// (solardev-xyz/freedom-bridge must be deployed at this origin). The
// session secret rides in the URL *fragment*, which browsers never send
// to the server. Interim test deployment; final hostname TBD.
const BRIDGE_ORIGIN = 'https://bridge.freedom.baby';

// The openlv SDK (168 KiB vendor bundle) is only needed once a signing
// job actually arrives — keep it off the renderer boot path.
let vendorPromise = null;
const loadVendorOpenlv = () => (vendorPromise ??= import('../../vendor/openlv.esm.js'));

/**
 * User-facing status line per job-event phase, shared by the QR UIs
 * (connect-phone screen, remote-signing panel). Keys are the phases this
 * module emits; phases without an entry keep the previous status.
 */
export const PHASE_STATUS_TEXT = {
  signaling: 'Waiting for your phone…',
  ready: 'Waiting for your phone…',
  linking: 'Phone found — connecting…',
  connected: 'Connected — confirm on your phone…',
  'switching-chain': 'Connected — approve the network switch on your phone…',
  'awaiting-approval': 'Connected — confirm on your phone…',
};

/** Wallet SDKs answer `{result}` / `{error:{code,message}}` envelopes; tolerate bare values. */
function unwrapResponse(payload) {
  if (payload && typeof payload === 'object') {
    if (payload.error) return { error: payload.error };
    if ('result' in payload) return { result: payload.result };
  }
  return { result: payload };
}

/**
 * @param {Object} deps
 * @param {Object} [deps.openlv] - openlv SDK surface (injectable for tests; lazy vendor load otherwise)
 * @param {typeof window.remoteSigner} [deps.remoteSigner] - preload IPC bridge
 * @param {{p: string, s: string}} [deps.signaling]
 * @param {string} [deps.bridgeOrigin]
 */
export function createRemoteSessionBroker({
  openlv = null,
  remoteSigner = window.remoteSigner,
  signaling = globalThis.window?.nodeConfig?.openlvSignaling
    ? { p: 'mqtt', s: globalThis.window.nodeConfig.openlvSignaling }
    : DEFAULT_SIGNALING,
  bridgeOrigin = BRIDGE_ORIGIN,
} = {}) {
  /** jobId → { session, settled, respond } */
  const jobs = new Map();
  const listeners = new Set();
  const disposers = [];

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[RemoteSession] job listener failed:', err);
      }
    }
  }

  /** Settle a job exactly once: deliver the outcome (unless silent) and tear down. */
  function settle(jobId, payload) {
    const job = jobs.get(jobId);
    if (!job || job.settled) return false;
    job.settled = true;
    if (payload) {
      job.respond(payload);
    }
    teardown(jobId);
    return true;
  }

  function teardown(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    jobs.delete(jobId);
    job.settled = true; // an attempt still in createSession must go stale
    job.abortAttempt?.(new Error('Session closed'));
    if (job.session) {
      Promise.resolve(job.session.close()).catch((err) => {
        console.warn('[RemoteSession] session close failed:', err.message);
      });
    }
  }

  // The phone should never initiate requests toward the browser in this
  // flow; answer like the reference provider does so openlv-SDK wallets
  // get a proper JSON-RPC error instead of a hang.
  const onIncomingMessage = async () => ({ error: { code: -32601, message: 'Method not found' } });

  /**
   * Put the phone's wallet on the tx's chain before the real request:
   * in-app wallet sessions default to Ethereum mainnet no matter what
   * the user selected in the wallet. Unknown chain (4902) → offer to
   * add it (EIP-3085) when we have public RPC endpoints to describe it
   * with, then switch again.
   *
   * @returns {{error?: {code?: number, message?: string}}}
   */
  async function ensureChain(session, chain) {
    const switchChain = async () =>
      unwrapResponse(
        await session.send({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chain.chainId }],
        }),
      );

    const first = await switchChain();
    if (!first.error) return {};
    if (first.error.code !== 4902 || !chain.rpcUrls) return { error: first.error };

    const added = unwrapResponse(
      await session.send({ method: 'wallet_addEthereumChain', params: [chain] }),
    );
    if (added.error) return { error: added.error };

    // EIP-3085 wallets MAY switch on add; make it explicit either way.
    return switchChain();
  }

  /**
   * Host a session for one request and deliver the outcome via `respond`
   * — main's IPC reply for signing jobs, a local promise for the
   * connect-phone flow. `kind` ('signing' | 'connect') rides on every
   * emitted event so UI consumers can tell the flows apart.
   */
  async function runJob({ jobId, method, params, chain }, kind, respond) {
    if (jobs.has(jobId)) return;
    const entry = { jobId, method, params, chain, kind, respond, session: null, settled: false, attempt: 0 };
    jobs.set(jobId, entry);
    await runAttempt(entry);
  }

  /**
   * One session attempt for a job. retryJob supersedes the running
   * attempt with a fresh one (new QR); a superseded attempt must neither
   * settle the job nor emit UI events, hence the staleness guard.
   */
  async function runAttempt(entry) {
    const { jobId, method, params, chain, kind } = entry;
    const attempt = ++entry.attempt;
    const stale = () => entry.settled || entry.attempt !== attempt;

    // The SDK's send() only gives up on its own (long) response timeout;
    // when this attempt is cancelled or superseded we bail out of the
    // await immediately instead of parking the frame on a dead session.
    let abortAttempt;
    const aborted = new Promise((_, reject) => {
      abortAttempt = reject;
    });
    aborted.catch(() => {}); // rejection is consumed via race, or not at all
    entry.abortAttempt = abortAttempt;

    try {
      const sdk = openlv || (await loadVendorOpenlv());
      const session = await sdk.createSession(
        signaling,
        sdk.mqtt,
        [sdk.webrtc()],
        onIncomingMessage,
      );
      if (stale()) {
        // Cancelled/aborted/superseded while the session was being created.
        Promise.resolve(session.close()).catch(() => {});
        return;
      }
      entry.session = session;

      const uri = sdk.encodeConnectionURL(session.getHandshakeParameters());
      emit({
        jobId,
        kind,
        phase: 'qr',
        method,
        uri,
        bridgeUrl: `${bridgeOrigin}/#${uri}`,
      });

      session.emitter.on('state_change', (state) => {
        if (!stale() && state?.status) {
          emit({ jobId, kind, phase: state.status, method });
        }
      });

      await session.connect();
      await session.waitForLink();
      if (stale()) return;

      if (chain) {
        emit({ jobId, kind, phase: 'switching-chain', method });
        const switched = await Promise.race([ensureChain(session, chain), aborted]);
        if (stale()) return;
        if (switched.error) {
          emit({ jobId, kind, phase: 'error', method, error: switched.error });
          settle(jobId, {
            error: { rpcCode: switched.error.code, message: switched.error.message },
          });
          return;
        }
      }

      emit({ jobId, kind, phase: 'awaiting-approval', method });
      const { result, error } = unwrapResponse(
        await Promise.race([session.send({ method, params }), aborted]),
      );
      if (stale()) return;

      if (error) {
        emit({ jobId, kind, phase: 'error', method, error });
        // rpcCode: main maps EIP-1193 codes (4001 …) to REMOTE_* there,
        // where the error registry lives.
        settle(jobId, { error: { rpcCode: error.code, message: error.message } });
      } else {
        emit({ jobId, kind, phase: 'done', method });
        settle(jobId, { result });
      }
    } catch (err) {
      if (stale()) return; // failures of a torn-down session are noise
      console.error('[RemoteSession] job failed:', err);
      emit({ jobId, kind, phase: 'error', method, error: { message: err.message } });
      settle(jobId, { error: { code: 'REMOTE_UNKNOWN', message: err.message } });
    }
  }

  return {
    /** Start listening for signing jobs from main. */
    start() {
      disposers.push(
        remoteSigner.onRequest((job) =>
          runJob(job, 'signing', (payload) => remoteSigner.respond({ jobId: job.jobId, ...payload })),
        ),
      );
      disposers.push(
        remoteSigner.onAbort(({ jobId }) => {
          // Main already failed the job (timeout) — settle silently.
          const kind = jobs.get(jobId)?.kind;
          if (settle(jobId)) {
            emit({ jobId, kind, phase: 'aborted' });
          }
        }),
      );
    },

    stop() {
      while (disposers.length) disposers.pop()();
      for (const jobId of [...jobs.keys()]) teardown(jobId);
    },

    /** User closed the QR dialog — tell main and drop the session. */
    cancelJob(jobId) {
      const kind = jobs.get(jobId)?.kind;
      if (settle(jobId, { error: { code: 'REMOTE_USER_CANCELLED' } })) {
        emit({ jobId, kind, phase: 'cancelled' });
      }
    },

    /**
     * Abandon the current session and mint a fresh QR for the same job
     * (e.g. the phone failed to connect, or the QR sat unscanned too
     * long for the user's comfort). No-op for settled/unknown jobs.
     */
    retryJob(jobId) {
      const entry = jobs.get(jobId);
      if (!entry || entry.settled) return;
      const oldSession = entry.session;
      entry.session = null;
      entry.abortAttempt?.(new Error('Superseded by a new code'));
      if (oldSession) {
        Promise.resolve(oldSession.close()).catch(() => {});
      }
      runAttempt(entry);
    },

    /**
     * Connect-phone flow (no main involvement): host a session whose only
     * request is eth_requestAccounts, so the user can pick an account to
     * add. Follow progress via onJobEvent with the returned jobId; abort
     * with cancelJob.
     *
     * @returns {{jobId: string, accounts: Promise<string[]>}}
     */
    connectPhone() {
      const jobId = `connect-${crypto.randomUUID()}`;
      const accounts = new Promise((resolve, reject) => {
        runJob({ jobId, method: 'eth_requestAccounts', params: [] }, 'connect', ({ result, error }) => {
          if (error || !Array.isArray(result) || result.length === 0) {
            const err = new Error(error?.message || 'Your phone reported no accounts');
            err.code = error?.code || 'REMOTE_BAD_RESPONSE';
            reject(err);
          } else {
            resolve(result);
          }
        });
      });
      // The screen owns the rejection UX; avoid unhandled-rejection noise
      // when it cancels before subscribing.
      accounts.catch(() => {});
      return { jobId, accounts };
    },

    /** Subscribe to job lifecycle events; returns a disposer. */
    onJobEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let defaultBroker = null;

/** Wire the singleton broker to the preload bridge (called from wallet-ui). */
export function initRemoteSession() {
  if (!defaultBroker) {
    defaultBroker = createRemoteSessionBroker();
    defaultBroker.start();
  }
  return defaultBroker;
}

/** The running broker, for UI modules (QR dialog) to subscribe/cancel. */
export function getRemoteSessionBroker() {
  return defaultBroker;
}
