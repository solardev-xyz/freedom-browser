# Railgun POI response inspection — October 4, 2026

This slice implements a pure synchronous diagnostic for supplied response bytes. It adds no sender, service
query, account authority, persisted observation or recovery-state transition.
It extends the existing main-process submission-data module; wallet wire-data
validation remains in main with no new renderer or IPC surface.

## Why a matching result is not acceptance

The inspected wallet SDK snapshot is `5c9d04c844879b8377d91775052e88c836b48730`.
Its `src/services/poi/poi-node-request.ts` has SHA-256
`7f84e065e90fd4a5e1251f4167856479aa6f59816eb7e8fc2f3d91d277cdbe57`.
`submitPOI` awaits a request typed with a void result. The generic request helper
checks for an error field and otherwise casts the result. This source does not
establish a positive response contract proving proof acceptance, propagation,
membership or current eligibility. The live success envelope remains unqualified;
a service that omits a void result would classify as malformed here. That does
not establish failure. Its fallback/retry behavior is not adopted, and a future
sender must not reuse that automatic fallback requester.

`inspectRailgunPoiResponse({ submission, evidence })` normalizes the canonical
submission, then inspects either an exact bounded response record or a fixed
unavailability reason. Normalization authenticates neither submission ownership
nor transport provenance. A copied canonical submission can be inspected too.
All outputs remain caller-supplied diagnostics.

## Bounded interpretation

Response evidence has exactly `kind: 'response'`, `httpStatus` and a Buffer `body`
of at most 2,048 bytes, containing the complete decoded response, never a truncated
prefix. The inspector cannot establish completeness or provenance; a future
transport must enforce the cap after bounded decompression. Oversized responses,
including large error data, must be reported unavailable rather than truncated.
Unavailable evidence has exactly `kind: 'unavailable'` and
one of `timeout`, `cancelled`, `connection-failure`, `response-too-large`, or
`unavailable` as its reported reason. Invalid caller shapes, invalid canonical
submissions, unsupported types and oversized buffers throw the existing sanitized
submission-data refusal. Raw response content is never included in that error.

After validating arguments, unavailable evidence classifies as `unavailable`.
Any HTTP status other than 200 classifies as `http-failure`, regardless of body
content. HTTP 200 bytes require fatal UTF-8 decoding without a leading BOM, valid
JSON, no duplicate decoded member names at any depth and at most 32 nested
containers, counting the root as depth one. Malformed wire data returns
`malformed`; ordinary JSON whitespace and object key ordering remain allowed.

A response envelope has exactly `jsonrpc`, `id` and either `result` or `error`.
The version must be `2.0`. An error contains exactly `code`, `message` and optional
`data`. The ID must use a canonical positive decimal integer token within the
safe-integer range; error codes use canonical signed safe integers. Fractional,
exponent and negative-zero aliases are refused even when JavaScript would round
or coerce them to the expected value. This is a deliberately narrower diagnostic
profile, not a claim that all such representations violate JSON-RPC. Nested result
and error data may be any finite JSON value within the bounds.

Malformed schema takes precedence over ID mismatch. An otherwise valid envelope
with a different numeric ID is `unmatched`. A matching envelope is `rpc-result`
or `rpc-error`. Both set `matchingEnvelope: true`; neither verifies transport,
acceptance, disclosure permission or spending permission. A result such as false,
null or an object claiming acceptance has exactly the same authority: none.

The frozen result exposes only classification, HTTP status, response byte count,
matching-envelope boolean and false authority flags. False means a matching
envelope was not established, including cases where there was no body to compare.
It returns no response body,
error message/code/data, result value, request ID, payload hash, timestamp or
reported unavailability reason. The reason is validated and then discarded; it
is not retained as transport evidence. No parsed untrusted object escapes the helper.

## Recovery capacity remains reserved

Persisting two diagnostic responses now would consume both remaining transitions
reserved for an attempted record before a real resolution path is designed. That
schema change is deferred. Attempted records remain terminal and must not be
created on the funded profile. This helper neither records a response nor reopens
any prepared-record consumer, and it does not make a retry safe. Every class,
including RPC errors, HTTP failures, unavailable, unmatched and malformed, can
follow a request that the service processed. None establishes non-delivery or
that a submission did not occur. An attempted entry stays uncertain regardless.

A future transport needs its own genuine authorization, fresh account/proof/root
evidence, confirmed durable attempt and actual drain. A future resolution path
needs independently established service and chain semantics. Saved diagnostics
cannot substitute for either boundary.

## Qualification

The independent suite passes 244 tests: 33 existing submission-data tests and
211 new inspection cases. Lint passes. Coverage includes exact fields, type/byte
bounds, all diagnostic classes, malformed UTF-8/BOM, decoded duplicate names,
JSON grammar, container-depth limits, integer spelling/rounding, finite nested
numbers, nested id/code scoping, redaction and frozen non-authorizing results.

Sixteen selected baseline controls pass. Removing only the raw ID lexical check
makes the rounding alias `1791086400000.00001` classify as unmatched instead of
malformed; the raw-token equality still prevents a match. Removing only request-ID
equality makes three wrong canonical IDs match. Removing only duplicate-name
protection makes twelve ambiguous envelopes classify as results/errors. These
controls use temporary in-memory source transforms, not repository edits.

A separate deterministic generated-input probe passes 2,000 finite JSON
result/error payloads and 2,000 truncated bodies classified malformed. It uses a fixed seed and
is temporary evidence, not part of committed suite counts or exhaustive parser
verification. JSON.parse remains the sole grammar validator; a bounded second pass
collects duplicate/depth/numeric-token facts without constructing objects.

The full regression passes 11,464 tests / 33 skipped across 471 passing suites
(five skipped) in 383.170 seconds, with native access and the existing OpenLV
exclusion. It picked up the final 244-test file, including the sixteen scoping and
whitespace cases added while the broader run was in progress. Production source
remained frozen at SHA-256
`dc4a0f82586e6245752634bfba70cc0af3d3b21a3b60cb9b99f384a69d818a5f`.
Command: `npm run test:coverage -- --runInBand --forceExit
--testPathIgnorePatterns=openlv-protocol.test.js`. Native qualification is not repeated for this pure
export with no production caller; earlier whole-source inventories are historical
because the submission-data module changed. The existing builders and canonical
submission normalizer retain their behavior. No store schema, policy, dependency,
binary pin, IPC or UI changes are introduced. No live requests or funded profiles
are involved.

Claude reviewed the final implementation, tests, controls, completed regression
and publication wording. This is engineering review, not a security audit.
