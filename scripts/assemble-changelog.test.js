// Fragment assembly (changelog.d/ -> CHANGELOG.md).
//
// The splice is the part worth pinning: entries have to join a heading that is
// already in `## [Unreleased]`, a heading that is missing has to appear at its
// Keep a Changelog position rather than at the end, and nothing below the
// Unreleased block — the shipped releases — may move. Each case below is run
// against a changelog shaped like the real one.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SECTIONS,
  sectionOf,
  collectFragments,
  renderSections,
  pendingFragments,
  spliceIntoChangelog,
} = require('./assemble-changelog.js');

const CHANGELOG = `# Changelog

All notable changes to Freedom will be documented in this file.

## [Unreleased]

### Added

- An existing added entry

### Fixed

- An existing fixed entry
  - with a sub-bullet

## [0.8.5] - 2026-09-10

### Fixed

- A shipped entry that must not move
`;

function fragmentDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-d-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe('sectionOf', () => {
  test('maps a filename prefix to its Keep a Changelog heading', () => {
    expect(sectionOf('fixed--settings-deeplink.md')).toBe('Fixed');
    expect(sectionOf('Added--nightly-builds.md')).toBe('Added');
  });

  test('rejects a name with no section prefix, naming the valid ones', () => {
    expect(() => sectionOf('settings-deeplink.md')).toThrow(/must start with one of/);
    expect(() => sectionOf('broken--thing.md')).toThrow(/fixed/);
  });
});

describe('collectFragments', () => {
  test('groups by section, sorts by filename and skips README and empties', () => {
    const dir = fragmentDir({
      'README.md': '# not a fragment',
      'fixed--b.md': '- Entry B\n',
      'fixed--a.md': '- Entry A\n',
      'added--z.md': '- Entry Z\n',
      'fixed--empty.md': '   \n',
    });
    const bySection = collectFragments(dir);
    expect(bySection.get('Fixed')).toEqual(['- Entry A', '- Entry B']);
    expect(bySection.get('Added')).toEqual(['- Entry Z']);
  });

  test('is empty when the directory does not exist', () => {
    expect(collectFragments(path.join(os.tmpdir(), 'no-such-changelog-d')).size).toBe(0);
  });
});

describe('renderSections', () => {
  test('emits headings in Keep a Changelog order, not insertion order', () => {
    const bySection = new Map([
      ['Security', ['- S']],
      ['Added', ['- A']],
      ['Fixed', ['- F']],
    ]);
    const out = renderSections(bySection);
    expect(out.indexOf('### Added')).toBeLessThan(out.indexOf('### Fixed'));
    expect(out.indexOf('### Fixed')).toBeLessThan(out.indexOf('### Security'));
  });
});

describe('spliceIntoChangelog', () => {
  test('appends to a heading that is already in Unreleased', () => {
    const out = spliceIntoChangelog(CHANGELOG, new Map([['Fixed', ['- A new fixed entry']]]));
    const unreleased = out.slice(out.indexOf('## [Unreleased]'), out.indexOf('## [0.8.5]'));
    expect(unreleased).toContain('- An existing fixed entry');
    expect(unreleased).toContain('- A new fixed entry');
    expect(unreleased.indexOf('- An existing fixed entry')).toBeLessThan(
      unreleased.indexOf('- A new fixed entry')
    );
  });

  test('inserts a missing heading at its canonical position', () => {
    const out = spliceIntoChangelog(CHANGELOG, new Map([['Changed', ['- A changed entry']]]));
    const unreleased = out.slice(out.indexOf('## [Unreleased]'), out.indexOf('## [0.8.5]'));
    expect(unreleased.indexOf('### Added')).toBeLessThan(unreleased.indexOf('### Changed'));
    expect(unreleased.indexOf('### Changed')).toBeLessThan(unreleased.indexOf('### Fixed'));
  });

  test('leaves shipped releases untouched', () => {
    const out = spliceIntoChangelog(CHANGELOG, new Map([['Fixed', ['- A new fixed entry']]]));
    const shipped = out.slice(out.indexOf('## [0.8.5]'));
    expect(shipped).toBe(CHANGELOG.slice(CHANGELOG.indexOf('## [0.8.5]')));
  });

  test('keeps sub-bullets with their entry', () => {
    const out = spliceIntoChangelog(
      CHANGELOG,
      new Map([['Fixed', ['- Parent entry\n  - Child detail']]])
    );
    expect(out).toContain('- Parent entry\n  - Child detail');
  });

  test('refuses a changelog with no Unreleased heading', () => {
    expect(() =>
      spliceIntoChangelog('# Changelog\n\n## [0.8.5]\n', new Map([['Fixed', ['- X']]]))
    ).toThrow(/no '## \[Unreleased\]' heading/);
  });

  test('is a no-op when there are no fragments', () => {
    expect(spliceIntoChangelog(CHANGELOG, new Map())).toBe(CHANGELOG);
  });

  test('a second write adds nothing, since nothing consumed the fragments', () => {
    // The script never deletes a fragment, so `--write` twice before the
    // `git rm` used to duplicate every entry.
    const bySection = new Map([
      ['Fixed', ['- A new fixed entry\n  - with a sub-bullet']],
      ['Changed', ['- A changed entry']],
    ]);
    const once = spliceIntoChangelog(CHANGELOG, bySection);
    expect(spliceIntoChangelog(once, bySection)).toBe(once);
    expect(once.match(/- A new fixed entry/g)).toHaveLength(1);
    expect(once.match(/- A changed entry/g)).toHaveLength(1);
  });

  test('still splices the fragments the block does not carry yet', () => {
    const once = spliceIntoChangelog(CHANGELOG, new Map([['Fixed', ['- Entry one']]]));
    const twice = spliceIntoChangelog(once, new Map([['Fixed', ['- Entry one', '- Entry two']]]));
    expect(twice.match(/- Entry one/g)).toHaveLength(1);
    expect(twice).toContain('- Entry two');
  });

  test('every section name it accepts can be spliced', () => {
    for (const section of SECTIONS) {
      const out = spliceIntoChangelog(CHANGELOG, new Map([[section, [`- ${section} entry`]]]));
      expect(out).toContain(`- ${section} entry`);
    }
  });
});

describe('pendingFragments', () => {
  test('drops an entry the Unreleased block already carries', () => {
    const pending = pendingFragments(
      CHANGELOG,
      new Map([['Fixed', ['- An existing fixed entry\n  - with a sub-bullet', '- A new one']]])
    );
    expect(pending.get('Fixed')).toEqual(['- A new one']);
  });

  test('ignores entries that only appear in a shipped release', () => {
    const pending = pendingFragments(
      CHANGELOG,
      new Map([['Fixed', ['- A shipped entry that must not move']]])
    );
    expect(pending.get('Fixed')).toEqual(['- A shipped entry that must not move']);
  });
});

describe("this repo's own changelog.d/", () => {
  test('every fragment name carries a valid <section>-- prefix', () => {
    // Nothing else checks a fragment's name before release: `code-changed`
    // calls `changelog.d/` prose, so a mis-named fragment would merge green
    // and throw on the releaser running the assembler. This runs in the
    // ungated `test` job on every pull request instead.
    expect(() => collectFragments()).not.toThrow();
  });
});
