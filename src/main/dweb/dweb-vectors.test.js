/**
 * Main's side of design 0006 against fc-dweb's vectors (freedom-core
 * `vectors/dweb.json`): what main's validation and response operations must
 * also pass (implementation step 2).
 *
 * - `validation`: every plan the design names, valid or refused, and the
 *   refusal each gets, through `validatePlan`.
 * - `exchanges`: whole requests with scripted node answers, through the
 *   executor: the status, the headers, the body, the reads before the
 *   response and whether the upstream body was cancelled. Deviation
 *   `native-page-state` is applied as the core applies it.
 * - `operations`, `locations` and `failures`: the response operations, the
 *   redirect rewrite and the after-dial status mapping on their own.
 * - `requests`: the plans `test/helpers/fake-dweb-core.js` makes, so the
 *   stand-in the real-handler tests use plans as the core does.
 *
 * Skipped unless the vectors are found: FREEDOM_CORE_DWEB_VECTORS names the
 * file, or it sits beside FREEDOM_CORE_VECTORS, or in the freedom-core
 * checkout FREEDOM_CORED_PATH was built in.
 */

const fs = require('fs');
const path = require('path');
const { validatePlan } = require('./plan-validation');
const { executeFetch, failure } = require('./plan-executor');
const {
  canonicalizeRedirect,
  stripDecodedEncoding,
  stripPageStateHeaders,
  PAGE_STATE_RESPONSE_HEADERS,
} = require('./response-operations');
const { rewriteGatewayLocation } = require('../lib/gateway-location');
const { planDweb } = require('../../../test/helpers/fake-dweb-core');

function vectorsPath() {
  if (process.env.FREEDOM_CORE_DWEB_VECTORS) return process.env.FREEDOM_CORE_DWEB_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) {
    return path.join(path.dirname(process.env.FREEDOM_CORE_VECTORS), 'dweb.json');
  }
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors', 'dweb.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const file = vectorsPath();
const vectors = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const describeIfVectors = vectors ? describe : describe.skip;

/** `{ "$repeat": [text, count] }` stands for a long string. */
function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$repeat')
      return value.$repeat[0].repeat(value.$repeat[1]);
    return Object.fromEntries(keys.map((key) => [key, expand(value[key])]));
  }
  return value;
}

/** A chunk: hex, or `{ fill, length }` for a long run of one byte. */
function chunkBytes(spec) {
  if (typeof spec === 'string') return Uint8Array.from(Buffer.from(spec, 'hex'));
  return new Uint8Array(spec.length).fill(parseInt(spec.fill, 16));
}

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

describeIfVectors("fc-dweb's vectors through main", () => {
  test('validation: every plan gets the refusal the design gives it', () => {
    const requests = new Map(vectors.requests.map((entry) => [entry.id, entry]));
    const cases = [
      ...vectors.validation.map((entry) => {
        const source = entry.request_id ? requests.get(entry.request_id) : expand(entry);
        return [entry.id, source.plan, source.request, entry.expect];
      }),
      ...vectors.requests.map((entry) => [entry.id, entry.plan, entry.request, entry.validation]),
    ];
    const got = cases.map(([id, plan, request]) => [id, validatePlan(plan, request) ?? 'valid']);
    expect(got).toEqual(cases.map(([id, , , want]) => [id, want]));
    expect(cases.length).toBeGreaterThan(800);
  });

  test("validation: every path refusal the design's vectors carry is refused before any dial", () => {
    const refusedPaths = vectors.validation.filter((entry) => entry.expect === 'path');
    expect(refusedPaths.length).toBeGreaterThan(0);
    const deviations = vectors.requests.filter((entry) => entry.deviation === 'plan-paths');
    expect(deviations.map((entry) => validatePlan(entry.plan, entry.request))).toEqual(
      deviations.map(() => 'path')
    );
  });

  test('exchanges: the executor answers as the handlers did', async () => {
    const results = [];
    for (const entry of vectors.exchanges) {
      const resolution = async () => entry.resolution?.value;
      const plan = await planDweb(entry.request, {
        resolveContent: resolution,
        resolveTezos: resolution,
      });
      expect([entry.id, validatePlan(plan, entry.request)]).toEqual([entry.id, null]);
      const { upstream } = entry;
      const counter = { reads: 0, cancelled: false };
      let next = 0;
      const body =
        upstream.chunks == null
          ? null
          : new ReadableStream(
              {
                pull(controller) {
                  counter.reads += 1;
                  if (next < upstream.chunks.length) {
                    controller.enqueue(chunkBytes(upstream.chunks[next++]));
                  } else {
                    controller.close();
                  }
                },
                cancel() {
                  counter.cancelled = true;
                },
              },
              { highWaterMark: 0 }
            );
      const { backend } = entry.request;
      const origin = backend.ant
        ? vectors.constants.ant_api_url
        : backend.ipfs === 'gateway'
          ? vectors.constants.gateway_url
          : null;
      const response = await executeFetch(plan.fetch, {
        backend: {
          ref: backend,
          url: origin,
          request: async () =>
            new Response(body, { status: upstream.status, headers: upstream.headers }),
        },
        method: entry.request.method.toUpperCase(),
        log: quietLog,
        tag: '[vectors]',
        redactUrl: (url) => url,
      });
      await new Promise((resolve) => setImmediate(resolve));
      const reads = counter.reads;
      const cancelled = counter.cancelled;
      const bytes = response.body
        ? Buffer.from(await response.arrayBuffer()).toString('hex')
        : null;
      let headers = entry.js.response.headers;
      if (entry.deviation === 'native-page-state') {
        // Today the native node's answers pass unstripped; the design strips them.
        headers = headers.filter(([name]) => !PAGE_STATE_RESPONSE_HEADERS.includes(name));
      }
      const intact = Buffer.concat(
        (upstream.chunks || []).map((chunk) => Buffer.from(chunkBytes(chunk)))
      ).toString('hex');
      results.push({
        id: entry.id,
        requestUrl: origin ? `${origin}${plan.fetch.path}` : entry.js.request_url,
        status: response.status,
        headers: [...response.headers],
        body: bytes,
        // Null where the reference read ahead for its own reasons (the
        // external gateway's counting stream).
        reads: entry.js.reads_before_response === null ? null : reads,
        cancelled,
        want: {
          requestUrl: entry.js.request_url,
          status: entry.js.response.status,
          headers,
          body: entry.js.response.body === 'intact' ? intact : null,
          reads: entry.js.reads_before_response,
          cancelled: entry.js.body_cancelled,
        },
      });
    }
    expect(results.map(({ want: _want, ...got }) => got)).toEqual(
      results.map(({ id, want }) => ({ id, ...want }))
    );
  });

  test('operations: strip_page_state, strip_decoded_encoding and canonicalize_redirect', () => {
    const { strip_page_state: page, strip_decoded_encoding: decoded } = vectors.operations;
    expect(page.map((entry) => [...stripPageStateHeaders(new Headers(entry.headers))])).toEqual(
      page.map((entry) => entry.js.headers)
    );
    // The gateway's answers: the decoded encoding, then page state.
    expect(
      decoded.map((entry) => [
        ...stripPageStateHeaders(stripDecodedEncoding(new Headers(entry.headers))),
      ])
    ).toEqual(decoded.map((entry) => entry.js.headers));
    for (const entry of vectors.operations.canonicalize_redirect) {
      const ant = { status: entry.status, headers: new Headers(entry.headers) };
      const action = canonicalizeRedirect(ant, entry.request_url, 'ant');
      expect([entry.status, [...ant.headers]]).toEqual([entry.status, entry.js.ant.headers]);
      expect([entry.status, action === 'drop']).toEqual([
        entry.status,
        entry.js.ant.body === 'dropped',
      ]);
      if (entry.js.gateway_redirect_headers !== null) {
        // The gateway's 3xx: its decoded encoding and page state go first.
        const head = { status: entry.status, headers: new Headers(entry.headers) };
        stripDecodedEncoding(head.headers);
        stripPageStateHeaders(head.headers);
        expect(canonicalizeRedirect(head, entry.request_url, 'ipfs')).toBe('keep');
        expect([...head.headers]).toEqual(entry.js.gateway_redirect_headers);
      }
    }
  });

  test('locations: the gateway-space Location, rewritten or left alone', () => {
    const { locations } = vectors.locations;
    expect(
      locations.map((entry) => rewriteGatewayLocation(entry.location, entry.request_url))
    ).toEqual(locations.map((entry) => entry.rewritten));
  });

  test('failures: a dial that threw, by backend', () => {
    const errorOf = ({ message, code, cause_code: causeCode, name }) => {
      const err = new Error(message);
      if (code !== undefined) err.code = code;
      if (causeCode !== undefined) err.cause = { code: causeCode };
      if (name !== undefined) err.name = name;
      return err;
    };
    for (const entry of vectors.failures) {
      for (const [kind, js] of Object.entries(entry.js)) {
        const { status, message } = failure(kind, errorOf(entry.failure));
        expect([kind, status, JSON.stringify({ code: status, message })]).toEqual([
          kind,
          js.status,
          js.body,
        ]);
      }
    }
  });

  test("requests: the real-handler tests' stand-in plans as the core does", async () => {
    const got = [];
    for (const entry of vectors.requests) {
      const calls = [];
      const resolver = (fn) => async (name) => {
        calls.push({ fn, name });
        if (Object.hasOwn(entry.resolution || {}, 'threw')) throw new Error(entry.resolution.threw);
        return entry.resolution?.value;
      };
      const plan = await planDweb(entry.request, {
        resolveContent: resolver('resolveEnsContent'),
        resolveTezos: resolver('resolveTezosDomain'),
      });
      got.push({ id: entry.id, plan, resolve: calls });
    }
    expect(got).toEqual(
      vectors.requests.map((entry) => ({
        id: entry.id,
        plan: entry.plan,
        resolve: entry.js.resolve,
      }))
    );
  });
});
