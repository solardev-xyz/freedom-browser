#!/usr/bin/env node
/**
 * Adopt the screenshots a failing `renderer-screenshots` run actually rendered
 * as the new baselines (#261 item 1c).
 *
 *   node scripts/apply-screenshot-baselines.js <dir>
 *
 * `<dir>` is a Playwright `test-results/` tree — normally the unzipped
 * `renderer-screenshots-diff` artifact from the CI job, which is the only
 * rendering that matters when a local run and CI disagree about font
 * rasterisation. Every `<name>-actual.png` under it replaces
 * `test-e2e/__screenshots__/<name>.png`.
 *
 * Nothing here decides whether the new pixels are *right*: read
 * `git diff --stat test-e2e/__screenshots__/` afterwards and look at the diff
 * images in the same artifact before committing.
 */

const fs = require('fs');
const path = require('path');

const BASELINES = path.resolve(__dirname, '..', 'test-e2e', '__screenshots__');

const [source] = process.argv.slice(2);
if (!source) {
  console.error('usage: node scripts/apply-screenshot-baselines.js <test-results dir>');
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`no such directory: ${source}`);
  process.exit(2);
}

const actuals = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('-actual.png')) actuals.push(full);
  }
})(source);

if (!actuals.length) {
  console.error(`no *-actual.png under ${source} — nothing to apply`);
  process.exit(1);
}

fs.mkdirSync(BASELINES, { recursive: true });
for (const file of actuals.sort()) {
  const target = path.join(BASELINES, `${path.basename(file, '-actual.png')}.png`);
  const existed = fs.existsSync(target);
  fs.copyFileSync(file, target);
  console.log(`${existed ? 'updated' : 'added  '} ${path.relative(process.cwd(), target)}`);
}
console.log(`\n${actuals.length} baseline(s) applied. Review the diff before committing.`);
