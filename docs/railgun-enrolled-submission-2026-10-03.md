# Railgun combined submission qualification — October 3, 2026

The offline qualification now connects the actual enrolled private-operation
controller, vault spending signer B, prover A, independent verifier C, completion
receipt, submission controller, fresh C verification, vault EOA signer,
transaction service, transaction network and encrypted EOA journal. A simulated
RPC accepts the exact serialized transaction only after the actual journal has
persisted its attempted hash and calldata-derived intent. Completion reuse is
refused. A fresh public-address context reopens the journal and confirms that the
unresolved attempt still blocks another transaction.

The final [acknowledged transfer report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-enrolled-submission-transfer-2026-10-03.json)
and [lost-acknowledgment unshield report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-enrolled-submission-unshield-uncertain-2026-10-03.json)
each record 109 source hashes matching the qualification tree and 19 existing
enrolled recovery runs. Their additional combined controller portions take
4,271 ms and 3,839 ms respectively. Both record exactly one simulated raw send,
zero live submissions, completion-stage refusal on reuse and unresolved-journal
gating after reopening.

These are disposable synthetic-vault runs. POI, preflight and RPC responses are
simulated; the signed transactions are never sent to a live network. The
acknowledgment-loss variant throws after observing the attempted record and signed
bytes. The real controller retains the authenticated hash as unknown, makes no
second send and preserves the attempted state on reopen. The acknowledged variant
retains submitted state. A fresh context is a storage reopen within the process,
not a claim of a full application restart or mined transaction.

The fixture replaces RPC acquisition only for the submission network. It requires
fresh submission/recovery modules, restores cached modules and exports afterward,
and invalidates captured simulated sources before returning. The earlier private
controller fixture supplies simulated POI and preflight observations while using
real account state, vault keys, utility processes and stores. No application test
hook, dependency or renderer API was added. Source inventories record the exact
files used by each run; historical reports are not claims that all their hashes
match later HEADs.

## Independent finality review

The user-created Codex reviewer replaced Claude after Claude's quota was exhausted.
It reproduced a correctness defect in cold EOA recovery: finality could change hash
at the same height during review, or claim a height above the observed head, and
still resolve. The shared recovery helper now reads a fresh head, corroborates the
finalized tag through a numbered canonical-header read, rechecks the tag and
revalidates the earlier reviewed anchor after approval. It rejects contradictory
or regressing evidence and permits advancement only when the earlier anchor
remains canonical under those RPC observations.

Full native regression after the production correction passed 9,032 tests / 33
skipped across 430 passing suites in 318 seconds, with the same OpenLV exclusion
as earlier runs. Lint is clean. A later fixture-only review strengthened its
evidence: every simulated send invocation is counted before any assertion can
throw, and completion reuse must fail specifically at the completion stage
without another review or send. The final combined runs use those assertions.

Both Shield and private recovery use this helper. The public-address RPC boundary
allows only bounded canonical numbered header requests with matching returned
heights. Shield recovery now also retains per-attempt exclusion until late review
callbacks drain, matching private recovery's cancellation behavior. The reviewer
approved the correction after focused tests and additional in-memory probes.
These checks establish internal consistency of unverified RPC observations, not
cryptographic finality or independently verified chain state.

The funded Shield note remains unreserved and unspent. Live owned-note POI
disclosure remains pending authorization. Transact-input provenance, cold private
signing reconstruction, post-transaction POI/second spend, broadcaster integration
and funded private qualification remain open. Exact own-hash EOA recovery does
not release a private signing reservation or authorize replay.
