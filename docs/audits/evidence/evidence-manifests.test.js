/**
 * Guard for the in-repo `SHA256SUMS` trust roots under docs/audits/evidence.
 *
 * Those manifests are what each evidence README tells a verifier to check a
 * download against, so a stale line is indistinguishable from tampering with
 * the evidence set. 511dc4af rewrote all five READMEs under
 * myotis-recovery-integration-2026-09 when the raw captures moved out to
 * alan-artifacts, but left the `README.md` digests pinned to the pre-rewrite
 * bytes — `sha256sum --check` then failed in every one of those directories.
 *
 * Every retained file must exist and match its recorded digest. Only the
 * explicitly enumerated published captures may be absent. The inventory is
 * independent of filesystem discovery, so deleting a harness or manifest
 * cannot silently turn a required input into an out-of-tree capture.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVIDENCE_ROOT = __dirname;
const CAPTURE_FILES = [
  'gnosis-result.json', 'gnosis-stdout.log', 'mainnet-result.json',
  'mainnet-stdout.log', 'summary.json',
];
// These locations describe the intentional evidence move, not today's file
// existence. New/moved entries must update this contract explicitly.
const INVENTORY = {
  'myotis-recovery-integration-2026-09/SHA256SUMS': {
    retained: ['README.md', 'electron-main.js'], published: CAPTURE_FILES,
  },
  'myotis-recovery-integration-2026-09/final/SHA256SUMS': {
    retained: ['README.md', 'electron-main.js'], published: CAPTURE_FILES,
  },
  'myotis-recovery-integration-2026-09/review-fixed/SHA256SUMS': {
    retained: ['README.md', 'electron-main.js'], published: CAPTURE_FILES,
  },
  'myotis-recovery-integration-2026-09/asar/SHA256SUMS': {
    retained: ['README.md', 'prepare.js', 'source-hashes.json'], published: ['result.jsonl'],
  },
  'myotis-recovery-integration-2026-09/asar/review-fixed/SHA256SUMS': {
    retained: ['README.md', 'source-hashes.json'], published: ['result.jsonl'],
  },
};

function findManifests(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findManifests(full));
    else if (entry.name === 'SHA256SUMS') found.push(full);
  }
  return found;
}

// `<64 hex>  <name>` — the format GNU coreutils' sha256sum writes and reads.
function parseManifest(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
      if (!match) throw new Error(`unparsable SHA256SUMS line: ${line}`);
      return { digest: match[1], name: match[2] };
    });
}

const manifests = findManifests(EVIDENCE_ROOT);

describe('docs/audits/evidence SHA256SUMS trust roots', () => {
  test('every expected manifest exists and every discovered manifest is classified', () => {
    const found = manifests.map(file => path.relative(EVIDENCE_ROOT, file).split(path.sep).join('/'));
    expect(found.sort()).toEqual(Object.keys(INVENTORY).sort());
  });

  describe.each(Object.entries(INVENTORY))('%s', (relative, inventory) => {
    const file = path.join(EVIDENCE_ROOT, relative);
    const dir = path.dirname(file);
    const entries = parseManifest(fs.readFileSync(file, 'utf8'));

    test('lists exactly the retained and published inputs', () => {
      expect(entries.map(entry => entry.name).sort()).toEqual(
        [...inventory.retained, ...inventory.published].sort()
      );
      for (const name of inventory.retained) expect(fs.statSync(path.join(dir, name)).isFile()).toBe(true);
    });

    test.each(entries.map((e) => [e.name, e.digest]))(
      '%s matches its recorded digest',
      (name, digest) => {
        const target = path.join(dir, name);
        // Only a capture explicitly published to alan-artifacts may be absent.
        if (inventory.published.includes(name) && !fs.existsSync(target)) return;

        const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        expect(actual).toBe(digest);
      }
    );
  });
});
