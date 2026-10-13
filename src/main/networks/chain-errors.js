// The chain-data router's reading of an error's text, shared with main's
// Colibri executor, which answers the core with the one bit of that text the
// core's adaptive bypass needs (freedom-core design 0005, The rest: Colibri's
// `capacity`). The core ports both as `fc_chain::safe_error_message` and its
// capacity pattern, so the two must not drift.

// An error's text as the router quotes it: hex runs of 128 digits or more
// elided, whitespace runs collapsed to one space, cut at 500 UTF-16 units.
function safeErrorMessage(error) {
  return (error?.message || String(error))
    .replace(
      /0x[0-9a-fA-F]{128,}/g,
      (hex) => `${hex.slice(0, 10)}…(${Math.floor((hex.length - 2) / 2)} bytes)`
    )
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

// A source that ran out of gas or of its execution budget: the same request
// would fail there again, so the router blocks that route for the process's
// life. Matched on the safe text, never the raw message.
const CAPACITY_FAILURE =
  /out of gas|execution (?:gas|resource) limit|exceeds? (?:the )?(?:gas|execution) limit/i;

function isCapacityFailure(error) {
  if (error?.failureKind === 'capacity') return true;
  return CAPACITY_FAILURE.test(safeErrorMessage(error));
}

module.exports = { safeErrorMessage, isCapacityFailure };
