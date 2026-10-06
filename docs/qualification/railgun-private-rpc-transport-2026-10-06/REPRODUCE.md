# Replay the bounded Node composition checks

The repository test is src/main/networks/private-rpc-transport.test.js, SHA0c85fb420dce036aed173b2f6b2e08546c72c6b30359b12900368c249ffc8feb. Its body is intentionally not duplicated here. Verify that hash and every DEPENDENCIES.json entry before replay. Reuse the already-installed pinned dependencies; this archive requests no installation or package change.

Use a fresh disposable repository copy named test-tree beside a copied controls.py (rename the exact archived controls.py.txt). Files mutated by the controls must be regular private copies, never symlinks to a working repository. Do not run the controls in the active checkout. They temporarily replace only the detached private-rpc.js or isolated-socks.js and restore each original in finally. Run ordinary Python; the historical controls recipe uses assertions and does not independently refuse optimized Python. The publication builder adds no retrospective protection to that original recipe.

From test-tree, run:

    npm test -- -- --runInBand --runTestsByPath src/main/networks/private-rpc-transport.test.js src/main/networks/private-rpc.test.js src/main/networks/wallet-tor-transport.test.js src/main/networks/isolated-socks.test.js
    npm run lint -- --max-warnings 0

Then run `python3 controls.py` from its parent. The four mutation patterns, selected case names, expected exit one/failure fragments and restoration logic are inspectable in that exact recipe. The four archived patches reconstruct its full mutants against the production source digests recorded in ARCHIVE-MAP. Apply or inspect only in another disposable copy; never treat these patches as fixes. Each map entry records the original full-mutant digest/size and the different derived patch digest/size.

The tests require permission to bind literal127.0.0.1 loopback listeners. A denied bind is a failed run, not a skipped qualification. They never contact the logical RPC hostname: the SOCKS fixture forwards to its fixed loopback TLS server. Existing public test certificate material stays in repository helpers and is not reproduced as publication credentials.

ROOT-OBSERVATIONS is a new summary attributed to the parent's original handles/completion records, not a raw process log. root-tests.log and root-lint.log are exact original bytes. Author log/control files are also exact. Runtime execPath and the author format ignorePath are explicitly placeholder-normalized derived JSON; original digests/sizes are retained separately. No local developer/tool path is published. This is a partial author archive: initial fixture/environment diagnostics and duplicate candidate/production bodies are deliberately omitted, not relabelled as successes.

The source fixture and runtime-probe record Node24.18.1/OpenSSL3.5.7/ABI137. This is not a new Electron version claim, a full repository regression, Tor circuit qualification or operating-system egress proof. Running the controls again produces new observations; it does not reproduce the original process IDs or timings.
