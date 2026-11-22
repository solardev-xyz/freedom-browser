/**
 * freedom-root.js's names against freedom-core's `vectors/layout.json`
 * (design 0013, "Vectors": `source: design`, PRF-9a): `MOVED_ENTRIES` is
 * fc-profile's list, in the order a move takes them, and the names under a
 * profile's directory (`freedom/`, its journal and marker, the placeholder)
 * are the core's. A name main resolves into `freedom/` that the core leaves
 * at the root, or the reverse, would split a store between the two.
 *
 * **Which file.** The vectors aren't copied into this repository: the file
 * is read from a freedom-core checkout. FREEDOM_CORE_LAYOUT_VECTORS names
 * it, or it sits beside FREEDOM_CORE_VECTORS, or in the freedom-core
 * checkout FREEDOM_CORED_PATH was built in; skipped otherwise. CI checks
 * out freedom-core's at a reviewed commit and names it; a file named there
 * that is missing fails the suite rather than skipping it.
 */

const fs = require('fs');
const path = require('path');
const {
  FREEDOM_DIR,
  LAYOUT_MARKER,
  MOVED_ENTRIES,
  MOVE_JOURNAL,
  PLACEHOLDER,
} = require('./freedom-root');

function vectorsPath() {
  if (process.env.FREEDOM_CORE_LAYOUT_VECTORS) return process.env.FREEDOM_CORE_LAYOUT_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) {
    return path.join(path.dirname(process.env.FREEDOM_CORE_VECTORS), 'layout.json');
  }
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors', 'layout.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const file = vectorsPath();
const vectors = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const describeIfVectors = vectors ? describe : describe.skip;
// Named outright (CI does): they must be there.
const required = Boolean(process.env.FREEDOM_CORE_LAYOUT_VECTORS);

(required ? test : test.skip)('the vectors FREEDOM_CORE_LAYOUT_VECTORS names are there', () => {
  expect(fs.existsSync(file)).toBe(true);
  expect(vectors?.moved_entries?.length).toBeGreaterThan(0);
});

describeIfVectors(
  "freedom-root.js's names against the core's layout vectors (0013, PRF-9a)",
  () => {
    test("MOVED_ENTRIES is fc-profile's list, in its order", () => {
      expect([...MOVED_ENTRIES]).toEqual(vectors.moved_entries);
    });

    test("the names under a profile's directory are the core's", () => {
      expect(FREEDOM_DIR).toBe(vectors.constants.freedom_dir);
      expect(MOVE_JOURNAL).toBe(vectors.constants.move_journal);
      expect(LAYOUT_MARKER).toBe(vectors.constants.layout_marker);
      expect(PLACEHOLDER).toBe(vectors.constants.placeholder);
      expect(MOVED_ENTRIES).toContain(PLACEHOLDER);
    });
  }
);
