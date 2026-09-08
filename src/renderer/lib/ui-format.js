// Shared formatting helpers for user-facing strings in the renderer.
//
// These exist so sibling surfaces agree on one convention instead of each
// inventing its own (see docs/agent-playbooks/ui-consistency.md):
//   * an empty counter reads `0`, never `--`
//   * a value the app has not learned yet reads `Unknown`, never a blank cell,
//     a bare product name or `--`
//   * a list counter pluralises, and names how many of the whole list is shown
//     while a filter is active

// Counters that have not reported yet. The Nodes menu markup carries the same
// literal as its static default so the first paint matches the first refresh.
export const EMPTY_COUNT = '0';

// One placeholder for "the app does not know this yet".
export const UNKNOWN = 'Unknown';

// Text for a numeric readout (peer counts, block heights). `0` for anything
// missing, so an idle node reads the same as a node reporting zero.
export function countText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return EMPTY_COUNT;
}

// Text for a "Version:" row: whatever the node reported, or `Unknown`.
export function versionText(value) {
  return (typeof value === 'string' && value.trim()) || UNKNOWN;
}

// `1 payment` / `2 payments`, with an explicit plural for irregular nouns.
export function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

// The subtitle of an internal list page: `12 downloads`, or `3 of 12
// downloads` while a search narrows it. The noun agrees with the total, so
// filtering a one-item list does not flip the noun mid-typing.
export function formatCount(shown, total, singular, plural = `${singular}s`) {
  const noun = pluralize(total, singular, plural);
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}
