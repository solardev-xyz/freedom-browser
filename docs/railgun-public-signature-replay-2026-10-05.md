# Public-key replay for disposable Railgun service fixtures

This fixture-only prerequisite lets a new qualification process verify saved
simulated list responses without receiving the setup process's signing key.
Production code, service trust and the genuine proof-bound list-acceptance
constructor are unchanged. It follows the native terminal-ingestion checkpoint
at `719ec8779406a2f87a042c01850408bfbb1c0d63`; those native reports remain evidence
for their recorded sources and do not qualify this new helper. The older own-POI
membership and own-Transact-creator qualifiers also pin this helper, so their
native evidence likewise remains historical.

The existing signing installer adds an active-only export of its public Ed25519
SPKI bytes. The new replay installer accepts that public key, the exact required
list identifier, a bounded event and its signature. It requires the signature to
verify with the disposable public key and fail with the production list key
before importing consumers. It retains genuine event parsing and Ed25519
verification, substitutes only the fixture list key, and exposes no signing or
private-key API. Closing revokes the captured verifier; consumers must drain
before closure. Cache cleanup covers the five explicit consumers, not arbitrary
already-loaded modules. Healthy retries require freshly loaded consumers.

The replay installer requires canonical key/event/signature shapes and rejects
noncanonical field encodings, invalid sign bits and all eight canonical low-order
Ed25519 points before delegating to crypto. Review of an earlier scratch version
found that the measured Node/OpenSSL runtime accepts some low-order forgeries;
DER import and re-export alone did not establish point safety. The corrected
fixture rejects these encodings. This is explicit encoding and low-order
validation, not a claim of general prime-subgroup verification.

All 52 focused tests pass on Node v24.18.1 / OpenSSL 3.5.7 in 1.576 seconds, and
repository-wide lint passes. The tests use real isolated Node processes and real
production event parsing/signature verification. One test exports public state
in one process, observes its exit and verifies in another; this qualifies only
the signature fixture. Three detached guard-removal controls in the reviewed
scratch package fail their intended cases. The tests recording actual OpenSSL
acceptance are deliberate runtime sentinels and may need reassessment when that
runtime changes. They do not claim Electron accepts those forgeries.

A successful replay does not restore an account, approve a proof POST, issue a
membership capability or establish current eligibility. The supplied event is a
key-possession check, not an allowlist: the verifier accepts other valid events
signed by that setup key. The future restart harness must pin the public key to
the actual successful setup acceptance, bind every saved response to the recorded
public wire and authenticate private facts through the genuine encrypted stores.
It must never serialize an acceptance capability or carry the disposable private
key across the process boundary.

The [evidence index](qualification/railgun-public-signature-replay-2026-10-05.json)
records exact source/dependency hashes and local test/control provenance. No
native Electron account restart, new live request, funded operation or fresh full
regression is claimed. Claude reviewed the corrected implementation and tests;
this is engineering review, not an external security audit. The complete native
restart, cold second submission and original-signature recovery remain open.
