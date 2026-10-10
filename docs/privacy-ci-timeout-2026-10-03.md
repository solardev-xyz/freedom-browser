# PPv2 reconciliation test timeout — October 3, 2026

Railgun prover commit `302db90e` failed the first test-job attempt of CI run
37072536851 and passed on attempt 2. The first log ends with an uncaught
`PRIVACY_CONTEXT_REVOKED` from `ppv2-relay-reconciliation.test.js` teardown,
not a prover failure. A rerun alone did not resolve that finding.

The capacity test creates 63 journaled attempts using almost 200 real durable
writes, then verifies that refreshing them fits a simulated 60-second relay
quote. Its previous default Jest budget was five seconds. Claude reproduced the
same fatal teardown stack by forcing a 300 ms test budget; the ordinary targeted
run took about 3.6 seconds on this Mac. Slower filesystem work can exhaust the
previous budget. This explains a reproducible failure mechanism; CI's final
uncaught stack by itself does not identify the exact timeout boundary.

Jest timing out does not cancel the asynchronous test body. Closing its shared
scope during teardown allowed still-running work to reject after the test had
ended. A second rejection-observation gap existed between starting `gate.submit`
and awaiting it after advancing fake timers.

The test now has an explicit 30-second wall-clock budget, while retaining its
existing simulated quote-deadline assertion. Its capacity task and submit promise
are observed immediately and still awaited to assert their result. Teardown
captures and drains that test's task before closing its scope; the hook also has
a 30-second budget. The capacity routine aborts/drains remaining fake-clock work
before restoring real timers. Captured scope references avoid closing a later
test's scope if a hook were itself delayed.

All 41 reconciliation tests pass normally. Claude also used a temporary Jest
transformer outside the repository to force the capacity budget back to 300 ms:
Jest reported one expected timeout failure and 40 passing tests, with no fatal
privacy-session rejection. Repeating with a shorter hook budget also failed
cleanly. The forced 300 ms run was repeated against the final captured-scope and
matching-hook-budget version, with the same clean result: one timeout failure,
40 passing tests and no fatal rejection. The final ordinary 41-test run passes.

Only test lifecycle and timing changed. No production reconciliation policy,
reservation release, timeout or error handling was weakened. Claude reviewed the
fix and reproduced both the old crash and the clean timeout behavior. Lint passes.
