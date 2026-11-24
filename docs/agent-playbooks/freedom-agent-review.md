# Freedom Agent review task brief

Use with PR #457 (`feature/freedom-automation-kernel` → `main`) and the
[review guide](../agent-review-guide.md). This is a review brief, not authorization
to change credentials, purchase postage, publish user content or mutate a real
project. Follow repository `AGENTS.md` and the applicable architecture/UI playbooks.

## Scope

Review the current branch against its current merge base with `origin/main`.
Record the exact head and base hashes before starting. Review the final code,
not just recent commits. Pick one or more bounded passes from the guide and
state which you covered; one pass is not a full-feature audit.

Trace representative operations from renderer/IPC through main-process policy
and dispatch to their results and saved evidence. Look for incorrect behavior,
authority expansion, credential disclosure, races, cancellation/retry bugs,
persistence failures and misleading UI claims. Check tests against the contract;
a passing implementation-shaped test alone does not establish correctness.

Prioritize newer Claude/custom-provider and privacy boundaries: the September
independent review did not cover them. Preserve accepted product decisions while
reviewing their enforcement: Windows broad reads, explicit approvals for writes
and sensitive effects, best-effort detached-process cancellation, and optional
custom compatibility checks are documented boundaries, not unreported regressions.

## Safe validation

Use disposable profiles and fixture projects. Run targeted tests for a suspected
issue; broad tests already recorded at another commit are historical evidence.
Do not use live credentials or incur inference charges without authorization.
Do not exercise wallet/publication actions, destructive recovery or real project
fault injection merely to strengthen a review finding.

Review without edits unless implementation work is separately assigned. If a
bounded review is delegated, keep its file/behavior scope explicit and reconcile
findings that cross into another pass. Do not request a whole-tree rewrite or
report stylistic preferences as release blockers.

## Report

For each actionable finding give:

- Severity and a short description of the user-visible or security impact.
- Exact file/line and the triggering sequence or minimal reproduction.
- Expected contract versus observed behavior, including affected platforms.
- Evidence/test result, or a clear statement that it remains a hypothesis.
- A bounded fix direction and a regression test worth adding.

Conclude with reviewed head/base, areas covered, checks actually run, unresolved
questions and untested areas. If no actionable finding remains, say so for the
reviewed scope. Do not turn an untested platform or an older audit into a claim
that the full PR is verified. Send the report to the coordinating reviewer;
external GitHub comments or review submissions require an explicit request.
