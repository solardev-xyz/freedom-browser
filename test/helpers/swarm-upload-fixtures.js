/**
 * Fixtures for main's streamed Swarm uploads (freedom-core design 0015,
 * Uploads; `src/main/core/swarm-shell.js`), for the suites that drive the
 * executor without a core:
 * - `bodyClient()`: the core's client as the executor sends `swarm.body`
 *   on it, each body kept with its params and options and answered by the
 *   test (or at once by `answer`), main's withdrawal recorded;
 * - `zeros(n)`, `drainBody(body)`: a body's bytes and a node that takes
 *   them whole, holding none;
 * - `unreadParts(row, params)`: a source for each part a parent's params
 *   name, never opened, for plays that ask for none.
 */

const { paramParts } = require('../../src/main/core/swarm-grammar');

const KIB = 1024;

/** A zero byte stream of `n` bytes, in views of one 64 KiB buffer. */
const ZEROS = Buffer.alloc(64 * KIB);
function zeros(n) {
  let left = n;
  return new ReadableStream(
    {
      pull(controller) {
        if (!left) {
          controller.close();
          return;
        }
        const k = Math.min(left, ZEROS.length);
        controller.enqueue(ZEROS.subarray(0, k));
        left -= k;
      },
    },
    { highWaterMark: 0 }
  );
}

/** Reads a request body to its end, holding none of it: its length. */
async function drainBody(body) {
  const reader = body.getReader();
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return length;
    length += value.byteLength;
  }
}

/** A source for each part `params` name, never opened: for a play that asks none. */
function unreadParts(row, params) {
  return new Map(
    [...paramParts(row, params)].map(([k, bytes]) => [k, { path: '/never/opened', bytes }])
  );
}

/**
 * The core's client as the executor sends `swarm.body` on it
 * (`requestStreamTo`, `current`, `watchdogProgress`): each body asked is
 * kept in `bodies`, with its params and options, and answered with
 * `answer(params)`'s `{ result, body }` when given, else held until its
 * `respond(result, body)` or `fail(err)`. Main's withdrawal (its signal)
 * marks it `withdrawn` and fails it as the client does: a body not yet
 * answered rejects `cancelled`, an answered one errors `cancelled`.
 * `progress` records each `watchdogProgress(generation, id, ms)`.
 */
function bodyClient({ generation = 1, answer = null } = {}) {
  let nextBody = 900;
  const client = {
    current: { number: generation },
    bodies: [],
    progress: [],
    requestStreamTo(gen, method, params, context, options) {
      const body = {
        id: nextBody++,
        gen,
        method,
        params,
        context,
        options,
        withdrawn: false,
        answered: null,
      };
      client.bodies.push(body);
      options.onSent?.(body.id, gen.number);
      return new Promise((resolve, reject) => {
        const cancelled = Object.assign(new Error('Cancelled'), { code: 'cancelled' });
        let controller = null;
        body.respond = (result, stream = new ReadableStream({ start: (c) => c.close() })) => {
          const reader = stream.getReader();
          const wrapped = new ReadableStream(
            {
              start(c) {
                controller = c;
              },
              async pull(c) {
                const next = await reader.read();
                if (next.done) c.close();
                else c.enqueue(next.value);
              },
              cancel() {
                body.withdrawn = true;
                reader.cancel().catch(() => {});
              },
            },
            { highWaterMark: 0 }
          );
          body.answered = result;
          resolve({ result, body: wrapped });
        };
        body.fail = reject;
        options.signal?.addEventListener(
          'abort',
          () => {
            body.withdrawn = true;
            if (!body.answered) reject(cancelled);
            else controller?.error(cancelled);
          },
          { once: true }
        );
        if (answer) {
          const { result, body: stream } = answer(params);
          body.respond(result, stream);
        }
      });
    },
    watchdogProgress(gen, id, ms) {
      client.progress.push([gen, id, ms]);
      return true;
    },
  };
  return client;
}

module.exports = { bodyClient, drainBody, unreadParts, zeros };
