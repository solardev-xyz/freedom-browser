#!/usr/bin/env node
/**
 * Rewrite `src/renderer/design-system-inventory.json` from the tree as it
 * stands, for the design system's ratchet in
 * `src/renderer/design-system.test.js` (#1198).
 *
 *   npm run ui:inventory              # print what would change
 *   npm run ui:inventory -- --write
 *
 * Regenerating is the right move after a migration *removed* entries: a
 * screen moved onto the `ui-` blocks, the shared tokens and the size scales.
 * A run that would *grow* the inventory refuses to write and prints the new
 * entries instead, because each one is a screen styling itself again; use a
 * block from `src/renderer/pages/styles/ui.css` (or add a variant there).
 * Overrule it with `--allow-growth` only for a reason you state in the PR.
 */
const fs = require('fs');
const { INVENTORY_FILE, buildInventory, compare } = require('../test/helpers/design-system-sweep');

const args = process.argv.slice(2);
const write = args.includes('--write');
const allowGrowth = args.includes('--allow-growth');

const next = buildInventory();
const current = fs.existsSync(INVENTORY_FILE)
  ? JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'))
  : { totals: {} };

const { added, removed } = compare(current, next);
for (const entry of removed) console.log(`- ${entry}`);
for (const entry of added) console.log(`+ ${entry}`);
for (const [section, total] of Object.entries(next.totals)) {
  console.log(`${section}: ${current.totals?.[section] ?? 0} -> ${total}`);
}

if (added.length && !allowGrowth) {
  console.error(
    `\nRefusing to record ${added.length} new entr${added.length === 1 ? 'y' : 'ies'}. ` +
      `Use a ui- block and the shared tokens (docs/design-system.md).\n` +
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
