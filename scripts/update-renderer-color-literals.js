#!/usr/bin/env node
/**
 * Rewrite `src/renderer/renderer-color-literals.json` from the tree as it
 * stands, for the colour-literal guard in `src/renderer/renderer-styles.test.js`
 * (#261 item 1a).
 *
 *   npm run styles:inventory        # print what would change
 *   npm run styles:inventory -- --write
 *
 * Regenerating is the right move only after *removing* literals — tokenising a
 * page's palette, or annotating a declaration with `/* theme-literal: … *\/`.
 * Adding a colour literal to the renderer is what the guard exists to stop, so
 * a run that would *grow* the inventory refuses to write and prints the new
 * pairs instead; overrule it with `--allow-growth` and say why in the PR.
 */

const fs = require('fs');

const { INVENTORY_FILE, buildInventory } = require('../test/helpers/renderer-color-sweep');

const args = process.argv.slice(2);
const write = args.includes('--write');
const allowGrowth = args.includes('--allow-growth');

const next = buildInventory();
const current = fs.existsSync(INVENTORY_FILE)
  ? JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'))
  : { total: 0, files: {} };

const flatten = (inventory) =>
  new Set(
    Object.entries(inventory.files).flatMap(([file, pairs]) => pairs.map((p) => `${file}  ${p}`))
  );

const before = flatten(current);
const after = flatten(next);
const added = [...after].filter((entry) => !before.has(entry)).sort();
const removed = [...before].filter((entry) => !after.has(entry)).sort();

for (const entry of removed) console.log(`- ${entry}`);
for (const entry of added) console.log(`+ ${entry}`);
console.log(`${current.total ?? before.size} -> ${next.total} recorded colour literals`);

if (added.length && !allowGrowth) {
  console.error(
    `\nRefusing to record ${added.length} new colour literal(s). Paint from a ` +
      `var(--token), or annotate the declaration with /* theme-literal: <reason> */.\n` +
      `If the growth is genuinely intended, re-run with --allow-growth.`
  );
  process.exit(1);
}

if (!write) {
  console.log('\n(dry run — pass --write to update the inventory)');
  process.exit(0);
}

fs.writeFileSync(INVENTORY_FILE, `${JSON.stringify(next, null, 2)}\n`);
console.log(`\nwrote ${INVENTORY_FILE}`);
