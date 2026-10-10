# Public Railgun host-test fixtures

These plain structural transactions and journal histories preserve exact projections of the original Freedom fixture generators, pinned in the adjacent source records. Proofs and ciphertext are dummy values; they are not evidence of cryptographic validity, ownership, eligibility or funding. The capsule helper differs from its original only in its two imports (the installed package data surface and the local public deployment pins).

The ordinary Freedom transaction-intent and submission-journal tests use these records after the old protocol campaign scripts move to the dedicated Railgun repository. Their original behavioral assertions remain active. The test data lives outside `src/`, so it is outside the application's intended source allowlist; this does not assert that every platform's current packaging configuration enforces that allowlist.
