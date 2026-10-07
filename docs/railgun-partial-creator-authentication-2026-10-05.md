# Railgun change and received-note creator authentication

October 5, 2026. Creator authentication is implemented and qualified following the
[partial receipt and TXID milestone](railgun-partial-receipt-2026-10-04.md).
The later [merged qualification](railgun-creator-merged-qualification-2026-10-05.md)
records the current-main sync, explicit node refresh and full 14,483-test regression.

This extends authentication of the transaction that created an input to an
existing transfer or full withdrawal. It does not yet enable a partial own
operation or qualify the complete partial-withdrawal/POI/restart/second-spend flow.

## Authority and cryptography

A recovered change note must be tied to its creating transaction before it can
support a later spend. A received note needs the same verification without access
to the sender's private capsule or journal. The existing keyless note-provenance
worker is the appropriate boundary: its input binds the selected note, creator
row, TXID checkpoint and source events. The own-TXID worker cannot substitute for
it because that worker requires the creating operation's private wallet records.

The note-provenance worker verifies the TXID path and independently hashes the
creator's final unshield preimage with the pinned engine. The host derives the
required affirmative diagnostic from its normalized input, validates the exact
reply and waits for child exit. The structural event comparator continues to
report that it did not perform this hash check. Source authentication, ownership,
current-root acceptance and spending authority remain separate checks.

Both pre-spend provenance and retained recovery require that result before root
acquisition. The three retained POI consumers preserve their existing identity,
source, checkpoint and receipt-registry joins before releasing credentials or
accepting recovery. A copied diagnostic object cannot replace those capabilities.

## Compatibility correction from independent review

The initial implementation restricted every creator containing an unshield to
one input, one ordinary WETH output at index zero and a final WETH unshield.
Claude identified that this narrowed pre-existing received-note support. That
restriction belongs to the bounded retained consumers; it must not become a
global restriction on note provenance or pre-spend authentication.

The generic route now hashes the final commitment for every
unshield shape already admitted by its canonical row/event normalizers, using
the pinned engine's token validation. Existing nonzero ordinary-output selection,
multiple inputs/outputs and supported token types remain usable. The
existing maximum of thirteen total commitments includes the final unshield.
Creators without an unshield retain their existing result shape. The generic route also preserves an explicit
`unshield: null` as absent; the retained helper continues to refuse it, matching
its previous restriction. Both behaviors have regression tests.

## Final evidence

The [qualification index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-creator-authentication-2026-10-05.json)
records exact report hashes and all changed JavaScript hashes. Reports are copied
byte-for-byte from native runs. All inventories matched before publication.

- Generic real-engine provenance: 18 groups in 4,479 ms, including non-WETH ERC20,
  ERC721, ERC1155, thirteen-input/thirteen-total-commitment bounds, nonzero selected
  output indices and ordinary multi-output compatibility. Four wrong-preimage or
  commitment cases have valid paths and matching structural events before refusal.
  An ERC721 quantity of two has a matching hash/path but fails token validation;
  selecting the final unshield as an ordinary note fails normalization. Ten fixture
  children drain separately, preserving the existing 64 KiB wire/input limits.
- Bounded partial provenance: 12 groups in 1,947 ms. Legacy companion: eight groups
  in 1,138 ms. Both use the corrected generic verifier.
- Enrolled self-change OUTPUT qualification: eleven recovery groups, eleven
  membership groups and seventeen connected proof/check/output groups in 112,052 ms.
  Genuine local POI proof generation for the legacy second spend takes 4,756 ms
  and is independently verified; the list service uses a disposable signing key. The actual
  membership registry carries the creator hash diagnostic and rejects copied
  receipts. Capture evidence records the creator hash, creator-before-own ordering
  and shared checkpoint before and after encrypted enrollment/mirror reopening.
  Captures labelled after refusal controls record the subsequent successful retry,
  not a hash verification by the refused attempt.
  One simulated POST is durably attempted; cold attempted-output recovery matches
  without another POST or proving run.
- Received output from a different account derived from the same public test
  mnemonic: eleven retained recovery groups
  in 40,667 ms, including reopening. It does not require the sender's capsule or
  private journal. This foreign run does not include membership, POI proving or
  connected output recovery; those are qualified by the self run above.
- `npm test`: 1,150 tests across nine suites pass in 83.133 seconds; lint is clean. The 50-test provenance suite also passes after
  formatting, without increasing the unique test total.
  In-memory removal of the final-hash equality causes all five targeted negative
  tests to fail directly. Separate removal of the retained diagnostic gates causes
  all nine targeted consumer tests to fail. Repository sources are unchanged by
  these mutation controls. The full repository regression was not refreshed here.

The enrolled fixture constructs a synthetic Shield of 1,500 units, an SDK-encrypted
ordinary output of 1,000 units and a 500-unit unshield. A self output uses the SDK
Change annotation; a foreign output is a received transfer. The subsequent own
operation retains the existing full-withdrawal shape. Chain/service observations,
spend proofs and spend signatures are synthetic; POI cryptography and encrypted
stores are real. Reopening occurs in the same parent application process, not
across a complete application restart. No funded account, live service request or
live submission is used. These results do not establish the first partial
operation's combined POI or an actual completed second spend.

The initial bounded-only runs and earlier test count of 1,138 are superseded by
these final reports and the corrected generic source. Historical broader Kohaku
compatibility and full-suite reports remain evidence for their recorded commits,
not a fresh full regression at this source state.

## Remaining work

Implement combined change and unshield POI persistence, normal post-restart
change ingestion and selection,
and a complete second spend bound to that recovered change. Main partial
operation admission remains closed until those dependencies are verified.

All code remains within the main-process wallet and its existing keyless worker
boundary. No renderer, IPC, dependency or runtime-pin changes are needed here.
