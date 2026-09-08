/**
 * Guard for the one version-bearing claim in architecture-boundaries.md.
 *
 * The Ring 0 "never rename" list names `@ethersphere/bee-js@^N`, and that
 * playbook is written to be trusted verbatim by agents. When the dependency
 * was bumped 12 -> 13 the doc kept saying `^12`, which reads as a contract to
 * an auditing agent — the drift invites a "restore the documented contract"
 * downgrade rather than a doc fix. Keep the two in lockstep mechanically.
 */

const fs = require('fs');
const path = require('path');

const DOC_PATH = path.join(__dirname, 'architecture-boundaries.md');
const PKG_PATH = path.join(__dirname, '..', '..', 'package.json');

describe('architecture-boundaries.md bee-js contract', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

  test('the Ring 0 list still names the bee-js dependency', () => {
    expect(doc).toMatch(/@ethersphere\/bee-js@\^\d+/);
  });

  test('the documented major matches the declared package.json range', () => {
    const declared = pkg.dependencies['@ethersphere/bee-js'];
    expect(declared).toBeDefined();

    const declaredMajor = declared.match(/(\d+)/)[1];
    const documented = [...doc.matchAll(/@ethersphere\/bee-js@\^(\d+)/g)].map((m) => m[1]);

    expect(documented.length).toBeGreaterThan(0);
    for (const major of documented) {
      expect(major).toBe(declaredMajor);
    }
  });
});
