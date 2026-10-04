# Creator authentication after the October 5 main merge

Implementation checkpoint `7295be4c` adds the
[creator-authentication milestone](railgun-partial-creator-authentication-2026-10-05.md).
Merge `991192af` brings in main `dbfd0e7d`, including PR #493's RPC quorum
log-scan routing. The only conflict was a formatted timeout expression. The
resolution retains main's timeout hunk exactly, including its expanded background
scan budget, alongside the branch's private-balance routing and enrolled-send
protections. No new routing policy or dependency version was introduced.

## Explicit bundled-node refresh

All four download commands completed successfully at the repository's pins:
Ant 0.5.58 for its downloader targets, IPFS 0.4.3 host development/packaged addons,
Radicle 0.7.1 host addon, and Myotis 0.1.12 for all five release targets. The host
Myotis supervisor was rebuilt; the addon reports ABI 32. Installed Arti reports
2.6.0 and matches its unchanged pin, so it was retained. No network node was
started. The [refresh report](qualification/privacy-main-node-refresh-2026-10-05.json)
records eleven installed artifact hashes and download/build log hashes; all five
Myotis hashes match the committed release manifest.

## Verification

All 230 focused routing and bridge tests pass across four suites in 1.245 seconds.
The initial sandbox run could not bind local test listeners; the complete rerun
with local-listener permissions passed. External RPCs remain mocked.

The fresh [merged self-change OUTPUT report](qualification/railgun-creator-merged-output-self-2026-10-05.json)
passes eleven retained recovery groups, eleven membership groups and seventeen
connected proof/check/output groups in 113,128 ms. Genuine local POI proving for
the legacy second operation takes 4,749 ms and has an independent keyless verifier.
All 223 recorded hashes match. This is additional integration confirmation: the
main merge did not change any inputs inventoried by the preceding creator reports.

The [full merged regression](qualification/railgun-creator-merged-regression-2026-10-05.json)
passes **14,483 tests / 33 skipped**, with **507 passing suites / five skipped**
(512 total), in 528.133 seconds. All 1,358 tracked JavaScript/JSON file hashes
outside docs/research and their exact file set match before and after the run.
The common manifest digest is
`6e84dbf99cd0d5379b7ffa12e1945a30e138a3031ee2b76cd48de124bf1209ab`.
The established `openlv-protocol.test.js` exclusion and `--forceExit` remain;
this suite does not prove natural application-handle drainage. Lint is clean.

These runs use synthetic chain/services, dummy spend proofs/signatures, a
disposable list-signing key and simulated consent. Encrypted stores, controlled
reopening and local POI cryptography are real. This is not whole-application
restart, service acceptance, combined partial POI or a completed first/second
spend. No funded profile, live privacy-service request or live submission was used.

The next technical step remains combined change/unshield POI persistence, normal
change ingestion and selection, whole-application restart and a complete second
spend. Main partial-operation admission remains closed.
