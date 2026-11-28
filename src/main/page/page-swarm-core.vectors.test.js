/**
 * window.swarm on the core's backend (page-swarm-core.js; freedom-core
 * design 0015, "Main's encoding of a request" and D5) against the pinned
 * core's `vectors/swarm.json`: every step of its `methods` cases.
 * - **encode:** the step's params, rebuilt as JavaScript held them (each
 *   data value as its kind: a Buffer, a Uint8Array, an ArrayBuffer, a
 *   `{ type: 'Buffer', data }` or a string; a part from its content or its
 *   repeated unit), written by `writePageParams` for the step's method, are
 *   the step's params exactly, in the wire form (the file's `string_json`
 *   and `string_repeat` are the plain strings they write), with each part
 *   main holds of the step's length and SHA-256, and read back they give a
 *   grammar row whose parts are those (what the parent is opened with);
 * - **decode:** every answer the reference gave, as the core sends it
 *   (typed, D5), is the page's answer: the same result or error.
 *
 * Skipped unless the vectors are found (test/helpers/swarm-vectors.js):
 * FREEDOM_CORE_SWARM_VECTORS names freedom-core's `vectors` directory, as
 * CI does at the pinned commit, and then a missing file fails the suite.
 */

const { heldOf, sha256, swarmVectors, swarmVectorsRequired } = require('../../../test/helpers/swarm-vectors');
const { paramParts, rowFor } = require('../core/swarm-grammar');
const { readTyped, writePageParams, writeTyped } = require('../core/swarm-typed');
const { pageAnswer } = require('./page-swarm-core');

const swarm = swarmVectors('swarm.json');
const describeIfVectors = swarm ? describe : describe.skip;

(swarmVectorsRequired ? test : test.skip)('the vectors FREEDOM_CORE_SWARM_VECTORS names are there', () => {
  expect(swarm?.methods?.length).toBeGreaterThan(0);
});

const steps = [];
for (const testCase of swarm?.methods || []) {
  testCase.steps.forEach((step, i) => {
    if (typeof step.method === 'string' && step.params !== undefined) steps.push([`${testCase.id} #${i}`, step]);
  });
}

/** The file's typed form as main writes it on the wire. */
function wireOf(typed) {
  const [tag] = Object.keys(typed);
  const value = typed[tag];
  switch (tag) {
    case 'string_json':
      return { string: JSON.parse(value) };
    case 'string_repeat':
      return { string: value.repeat(typed.count) };
    case 'array':
      return { array: value.map((item) => (item.hole ? item : wireOf(item))) };
    case 'object':
      return { object: value.map(([key, member]) => [key, wireOf(member)]) };
    default:
      return typed;
  }
}

/** Whether a typed answer carries a digest in place of a string. */
const digested = (typed) => JSON.stringify(typed).includes('"string_digest"');

describeIfVectors("vectors/swarm.json's methods: a page's params in the typed form, and the answers", () => {
  test.each(steps)('%s: written as the reference sent them', (_id, step) => {
    const parts = step.parts || [];
    const encoded = writePageParams(step.method, heldOf(step.params, parts));
    expect(encoded.typed).toEqual(wireOf(step.params));
    expect([...encoded.parts.keys()]).toEqual(parts.map((part) => part.part));
    for (const part of parts) {
      const held = encoded.parts.get(part.part);
      expect(held.byteLength).toBe(part.length);
      expect(sha256(held)).toBe(part.sha256);
    }
    // What the parent is opened with: the row, and exactly these parts.
    const back = readTyped(JSON.parse(JSON.stringify(encoded.typed)));
    const row = rowFor(step.method, back);
    if (row !== null) {
      const declared = paramParts(row, back);
      expect([...declared.keys()].sort()).toEqual([...encoded.parts.keys()].sort());
      for (const [part, length] of declared) expect(encoded.parts.get(part).byteLength).toBe(length);
    }
  });

  test.each(steps)("%s: the core's typed answer is the page's", (_id, step) => {
    if (step.result_typed !== undefined && !digested(step.result_typed)) {
      expect(pageAnswer({ result_typed: wireOf(step.result_typed) })).toEqual({
        result: heldOf(step.result_typed, []),
      });
    } else if (step.error_typed !== undefined && !digested(step.error_typed)) {
      expect(pageAnswer({ error_typed: wireOf(step.error_typed) })).toEqual({ error: heldOf(step.error_typed, []) });
    } else if (step.result !== undefined) {
      expect(pageAnswer({ result_typed: writeTyped(step.result) })).toEqual({ result: step.result });
    } else if (step.error !== undefined) {
      expect(pageAnswer({ error_typed: writeTyped(step.error) })).toEqual({ error: step.error });
    }
  });
});
