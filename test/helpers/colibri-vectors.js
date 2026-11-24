/**
 * freedom-core's Colibri vectors (`vectors/colibri.json`, design 0014,
 * COL-1): the JS reference's recording of every Colibri request and
 * checkpoint case, with each data request its C core made.
 *
 * Found as the other vector suites find theirs: FREEDOM_CORE_COLIBRI_VECTORS
 * names the file, or it sits beside FREEDOM_CORE_VECTORS, or in the
 * freedom-core checkout FREEDOM_CORED_PATH was built in. `colibriVectors` is
 * `null` when they aren't found; suites skip then, unless
 * FREEDOM_CORE_COLIBRI_VECTORS names the file (`colibriVectorsRequired`).
 *
 * Their worlds, `fixtures/colibri/` (`sessions.json`, and `bodies/` named by
 * each answer's SHA-256), are beside the file: `colibriFixturesDir`, `null`
 * when the checkout has no such directory.
 */

const fs = require('fs');
const path = require('path');

function colibriVectorsPath() {
  if (process.env.FREEDOM_CORE_COLIBRI_VECTORS) return process.env.FREEDOM_CORE_COLIBRI_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) {
    return path.join(path.dirname(process.env.FREEDOM_CORE_VECTORS), 'colibri.json');
  }
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors', 'colibri.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const colibriVectorsFile = colibriVectorsPath();
const colibriVectors =
  colibriVectorsFile && fs.existsSync(colibriVectorsFile)
    ? JSON.parse(fs.readFileSync(colibriVectorsFile, 'utf8'))
    : null;
const colibriVectorsRequired = Boolean(process.env.FREEDOM_CORE_COLIBRI_VECTORS);
const colibriFixturesCandidate =
  colibriVectorsFile && path.join(path.dirname(colibriVectorsFile), 'fixtures', 'colibri');
const colibriFixturesDir =
  colibriFixturesCandidate && fs.existsSync(path.join(colibriFixturesCandidate, 'sessions.json'))
    ? colibriFixturesCandidate
    : null;

/**
 * A recorded data request as the service sends it (`request.rs`,
 * `FetchParams`): the C core writes `exclude_mask` as a string and `ttl` as
 * a number; the fetch carries both as numbers, `ttl` as `max_age` when set.
 */
function serviceParams(request, recorded) {
  const ttl = Number(recorded.ttl ?? 0);
  return {
    request,
    type: recorded.type,
    method: recorded.method ?? '',
    path: recorded.url ?? '',
    ...(recorded.payload !== undefined ? { payload: recorded.payload } : {}),
    accept: recorded.encoding ?? '',
    exclude_mask: Number(recorded.exclude_mask ?? 0),
    ...(ttl > 0 ? { max_age: ttl } : {}),
  };
}

/**
 * Every operation the cases open, in trace order: `{ case, op, fetches,
 * mainFetches }`. `op` is the operation as `colibri-fetch-contract.js` takes
 * it (a request's params as `JSON.stringify` writes the case's, its prover
 * the vectors' for the chain). `fetches` are its data requests, numbered as
 * the recorder numbered them (by first appearance), each `{ req, variant,
 * params, sent, own }`: the variant the recording names (`null` for none),
 * the service's params, and the reference's HTTP requests for it. A
 * checkpoint's first fetch is the service's own `checkpoint_proof`
 * (`checkpoint.rs`), whose request main makes (`mainFetches`).
 */
function recordedOperations(vectors) {
  const operations = [];
  for (const entry of vectors.cases) {
    const variants = new Map(entry.contract.map((item) => [item.req, item.variant]));
    const seen = new Map();
    let current = null;
    const open = (op) => {
      current = {
        case: entry,
        op: { id: operations.length + 1, ...op },
        fetches: [],
        mainFetches: [],
      };
      operations.push(current);
    };
    for (const step of entry.trace) {
      if (step.op === 'request') {
        const asked = entry.requests[step.index];
        open({
          kind: 'request',
          chain: entry.chain,
          method: asked.method,
          params: JSON.stringify(asked.params),
          zk: entry.zk,
          prover: vectors.servers[entry.chain].prover[0],
        });
      } else if (step.op === 'checkpoint') {
        open({ kind: 'checkpoint', chain: entry.chain });
        current.fetches.push({
          req: null,
          variant: 'checkpoint_proof',
          own: true,
          params: {
            request: current.op.id,
            type: 'checkpoint_proof',
            method: 'post',
            path: '',
            accept: 'ssz',
            exclude_mask: 0,
          },
          sent: [],
        });
      } else if ((step.op === 'step' || step.op === 'verify') && typeof step.status === 'string') {
        const status = JSON.parse(step.status);
        if (status.status !== 'pending') continue;
        for (const recorded of status.requests) {
          if (seen.has(recorded.req_ptr)) continue;
          const fetch = {
            req: recorded.req_ptr,
            variant: variants.has(recorded.req_ptr) ? variants.get(recorded.req_ptr) : undefined,
            own: false,
            params: serviceParams(current.op.id, recorded),
            sent: [],
          };
          seen.set(recorded.req_ptr, fetch);
          current.fetches.push(fetch);
        }
      } else if (step.op === 'fetch') {
        seen.get(step.req)?.sent.push(step);
      } else if (step.op === 'main_fetch') {
        current.mainFetches.push(step);
        if (step.variant === 'checkpoint_proof') current.fetches[0].sent.push(step);
      }
    }
  }
  return operations;
}

module.exports = {
  colibriFixturesDir,
  colibriVectors,
  colibriVectorsFile,
  colibriVectorsRequired,
  recordedOperations,
};
