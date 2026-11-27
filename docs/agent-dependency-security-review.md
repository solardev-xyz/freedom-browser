# Agent dependency upgrade security review — 2026-11-09

Scope: #831, Pi 1.0.2 → 1.5.0, DCAP 0.6.5 → 0.7.1, PDF.js 6.3.289 → 6.5.438.
The candidates were already installed in an isolated worktree before the user
introduced the mandatory pre-install security gate. This is a retrospective
review, not evidence that the new ordering was followed. Future updates must
follow the gate before installation.

## Provenance and registry checks

All three direct releases use GitHub OIDC publishing and carry verified SLSA
provenance from their upstream release tags. The previous pins also identify
the registry publisher as GitHub Actions. The registry maintainer list is
package-wide, not historical evidence of unchanged ownership:

| Package | Published (UTC) | Repository tag / commit |
| --- | --- | --- |
| Pi | 2026-11-02 | `earendil-works/pi` `v1.5.0` / `f9a26365568127461c47a07a37dcb42c140a3ac5` |
| DCAP | 2026-11-03 | `Phala-Network/dcap-qvl` `v0.7.1` / `05c200b752ecb824b73e5b1ae63cc047f1702ab2` |
| PDF.js | 2026-11-01 | `mozilla/pdf.js` `v6.5.438` / `0a4153349dc473ba950fc17941c5ca7eda43c1de` |

`npm audit signatures` verified registry signatures for all 1,123 installed
packages and provenance attestations for 367. All 35 changed/added lock entries
have registry.npmjs.org HTTPS URLs and SHA-512 integrity. None has an install
script. The npm install omitted lifecycle execution; the existing project
postinstall was then run explicitly to install the unchanged Electron pin and
rebuild existing native addons. No newly introduced lifecycle script was run.

## Source and dependency changes inspected

Pi's runtime, schema validation, codemode output and worker boundaries, MCP auth,
ChatGPT OAuth, credential handling and telemetry defaults were compared with the
previous pin. Freedom does not use the removed TypeBox-specific schema features.
The new JSON Schema validator avoids eval. The new Markdown CJK helper and glob
matching code were inspected for unexpected execution, filesystem, network or
credential access. No such additions were found. DCAP still gets public collateral
through Freedom's preinstalled destination/size/redirect guard. PDF's new renderer
worker is not configured or loaded by Freedom; existing font/native-canvas
packaging exclusions remain.

Pi siblings move together to 1.5.0. New packages are pi-schema, marked-cjk-friendly,
Pi's nested minimatch 11.0.3, and @isaacs/nonrecursive-glob-match 1.1.0. Pi also
re-resolved AWS/Smithy and Babel runtime patch dependencies. Those are disclosed
rather than presented as three isolated tarball changes. The existing scoped
Undici override is retained deliberately: it resolves to 8.12.4, rather than
Pi's own 8.12.3 pin. Undici 8.12.4 has upstream nodejs/undici provenance.

**Evidence gap:** minimatch 11.0.3 and
@isaacs/nonrecursive-glob-match 1.1.0 have registry signatures but no build
provenance. Minimatch is newly nested and pinned exactly by Pi; its matcher entry
point and imports were checked for unexpected I/O or execution paths. The glob
matcher was published November 5 and has no registry repository
field. The glob matcher’s shipped code was inspected: it contains only string
matching and internal module
imports, with no process, filesystem, network or eval access. No minimum release
age is mandated by the gate; this is an explicit engineering assessment, not a
claim that signatures or package popularity prove safety. Their BlueOak licences
are recorded in LICENSE_AUDIT.md.

The advisory count changes from 38 (11 low, 27 moderate) to 37 (11 low,
26 moderate), with zero high/critical findings in either lock. Existing findings
include Elliptic chains through wallet/DCAP dependencies and development/build
packages; this scoped upgrade does not claim to repair them all.

## Compatibility and limits

The review found and fixed a Claude codemode loadout API change and preserved
error diagnostics after Pi joined text output. Native Responses fixtures now
recognise supported models' `additional_tools` representation. DCAP's pure
TD-relaunch advisory remains advisory and preserves previously supported
OutOfDate encryption; configuration-needed, revoked and unknown statuses remain
blocked. The upstream Intel-QVL status convergence change is documented.

The full unit suite, native Electron codemode/MCP including ASAR, and sandboxed
PDF extraction/rendering passed. Claude independently reviewed Freedom’s changed integration points, selected
upstream modules and the compatibility fixes. No live paid provider requests or packaged Windows/Linux
smoke were performed. These checks reduce risk; they cannot establish that every
upstream line or release workflow is free of malicious code.
