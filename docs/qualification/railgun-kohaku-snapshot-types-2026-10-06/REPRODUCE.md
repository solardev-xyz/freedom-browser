# Snapshot declaration conformance: evidence and reproduction

This archive has **37 byte-exact original payloads and six explicitly derived, path-normalized payloads**. All payload filenames end in `.txt`. `ARCHIVE-MAP.json` identifies both the preserved private original's hash/size and the actual published bytes' hash/size. `INDEX.json` and this document are derived publication metadata. Do not format payloads.

The six `derived/` files are the harness, author README, review patch, compiler discovery report and both source freezes. Their only transformation is literal UTF-8 replacement of local path prefixes with the map's role-specific placeholders. Everything else, including recorded hashes, stays unchanged. The map records each replacement role and occurrence count without exposing its private path value. The 37 files under `raw/` remain byte-exact. The original PACKAGE is an **original-hash catalog**: compare its entries to `originalSha256`, not to transformed published bytes. Likewise, hashes inside reports, discovery references and root observations identify the preserved private originals. Published derived-file hashes are separate and must never be presented as those original hashes.

## Historical result and limits

The actual TypeScript **6.0.3 compiler API** ran strict/noEmit with `skipLibCheck:false`: one positive program and 24 exact unsuppressed negatives passed, comprising nine upstream-binding and 15 Freedom-declaration cases. Each program loaded 220 source/declaration files; 219 were common and 274 total inputs were frozen. The eight loaded Kohaku sources matched Git blobs at `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. Exact diagnostic code/file/line/character and distinguishing messages were checked.

This is declaration/consumer assignability, **not JavaScript implementation typechecking** (`allowJs:false`, `checkJs:false`) or generic upstream Host support. No runtime authority, ownership, finality or spending grant follows. Upstream `PICapabilities.note` is `unknown`; concrete `ReadNote` fields are the Freedom specialization. Installed ox **0.14.45** differs from the provider's requested **^0.12.0**: this qualifies the recorded resolved graph, not an upstream lockfile build. The compiler never executed that graph. Historical syntax-only comments and review-pending flags are preserved, not claims about the later reproduction.

The author's original r2 root was `c03cbd384ed6b0968432f890530e1fe1fc5b0452`. Root later used byte-identical harness/spec/cases in a fresh prepare at `20560d869be1682fe74cc1deea57f72358bddfaf`. Original freezes differ only in `rootHead`; original reports differ only in `rootHead` and `sourceFreezeSha256`. All 274 original input hashes/options/graph fields match. Preserved ROOT-PREPARATION records session **78257**, observed exit **0**; ROOT-OBSERVATION records session **97687**, observed exit **0**, declaration clean before/after and the two upstream negative reason-path checks. These observations are attributed to those root records, not inferred from logs. Archive normalization ran no compiler; the normalized harness itself has not been executed.

## Verify published bytes

Set `ARCHIVE` to the publication directory:

```sh
python3 - "$ARCHIVE" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
manifest = json.loads((root / 'ARCHIVE-MAP.json').read_text())
for entry in manifest['entries']:
    data = (root / entry['archivedPath']).read_bytes()
    if len(data) != entry['archivedBytes'] or hashlib.sha256(data).hexdigest() != entry['archivedSha256']:
        raise SystemExit('Published payload mismatch: ' + entry['archivedPath'])
print('Verified', len(manifest['entries']), 'published payloads')
PY
```

This verifies the public copies; it cannot establish the unavailable private originals' bytes. Their hashes preserve provenance, while independent review compared originals before publication. No compiler binary, dependencies, profile, handoff or runtime wire data is distributed. Redundant per-case graph dumps and r1/probe evidence remain outside this archive.

## Repin and reproduce in a new directory

1. Copy the derived harness, raw CASE-SPEC and 25 raw `cases/` files into a new disposable run directory, stripping only the final `.txt`. Copy the derived discovery report separately. Preserve all archived evidence. Do **not** install either historical source freeze as the new run's freeze: `prepare` refuses overwriting one.
2. Use an existing root checkout at a recorded revision, or document a newly reviewed revision. Supply the actual Kohaku Git checkout at `tmp/privacy-build/pinned-inputs/kohaku` with the pinned HEAD above and the declaration's required relative location. Existing declaration, package/lock and dependency bytes must be compared with the original input catalog. A source directory without Git metadata cannot satisfy the eight blob checks. No stubs or third-party source patches substitute for the real graph.
3. Resolve `<REPOSITORY_ROOT>`, `<COMPILER_DISCOVERY_DIRECTORY>`, `<TYPESCRIPT_PACKAGE_ROOT>` and `<NODE_EXECUTABLE>` to the intended existing tooling and checkout in your disposable copies. `<PRIOR_R1_PRIVATE_DIRECTORY>` is historical context only and is not needed for execution. The actual compiler entry/package, Node executable and 58 standard library hashes must be verified. The bundled CLI was absent; the harness uses the compiler API. A bare clone alone is not promised to reproduce offline; missing prerequisites require separate setup, never an automatic download by this harness.
4. Hash the newly localized discovery report and explicitly update the disposable harness's `discoveryHash`, along with its `root` and `discoveryPath`. The archived discoveryHash intentionally still identifies the original private report and will not accept the normalized or relocated report. Record the path/discoveryHash patch and all new hashes. Preserve compiler options, cases, expected diagnostics, plugin-only alias guard and Git-blob checks.
5. Run the matching existing Node executable with `harness.cjs prepare`, retain its log and observe exit 0 before running `harness.cjs run`. Retain the actual second exit observation, fresh freeze/report and all failure diagnostics. Require zero positive diagnostics, all 24 expected negatives and zero compiler writes.

Copying, path repinning and discoveryHash repinning create a **new qualification**, not a rerun of the archived source freeze. Compare all unchanged source/tool/dependency/case hashes exactly; explicitly account for harness/discovery and absolute option-path differences. Root metadata changes must be separately recorded. Different compiler, dependency or source bytes require review, not merely a path-equivalence assertion. Never rewrite historical hashes, suppress diagnostics or enable skipLibCheck to manufacture equivalence.
