# Restricted snapshot adapter: native and type qualification

The completed-snapshot read adapter now passes a genuine-account native probe
and a separate strict declaration check against pinned Kohaku sources. Source
commit `20560d869be1682fe74cc1deea57f72358bddfaf` adds the opt-in fixture and its qualifier hook;
the adapter and borrowed-account bridge remain the reviewed `c03cbd38` bytes.
Main remains `e98e2dd5`, with its explicit bundled-node refresh and Electron
44.5.1 installation already recorded. No dependencies or production activation
changed.

## Native result

One fresh enrolled profile runs the real bridge and adapter over the existing
synthetic WETH history: three received notes, two unspent and one spent. Nine
shared read vectors and four mutation-isolation reads pass. Mutating returned
arrays, entries and assets cannot change later results or the genuine account's
data.

A further read is admitted immediately before close and refuses before shutdown
is observed. Three post-close calls refuse. Aborting the probe's own host lifetime
also makes the genuine host refuse capture; the borrowed owners remain live and
their original view still answers two reads. The probe never closes those owners.

All fourteen measured activity deltas are exactly zero, covering utility/worker
admissions and settlements, rejected barriers, all utility broker messages, key
requests/replies, RPC factories/requests, transport/signer factories, applications
and restores. Existing worker-port messages are not independently metered. File
names and bytes remain equal at the measured checkpoints for the identity,
account stores, current wallet generation, inventory marker and any existing EOA
journal. An absent EOA journal stays absent. This is not whole-browser-profile
identity, absence of transient filesystem activity or physical socket drainage.

The surrounding wallet fixture still performs its normal writes, restoration and
key work outside the added read window. Its complete original report remains
within the original exact expectations and timing/RSS allowances, apart from the
new probe report and selected source inventory.
The original Electron process `11711` and launcher handle `54098` both exited
zero. All source/runtime pins were checked before and after execution. The
[native evidence](qualification/railgun-kohaku-snapshot-native-2026-10-06/INDEX.json)
preserves the raw report and distinguishes the 152 selected files from the broad
source inventory; neither is an execution-coverage count.

Root verification passes **544 tests across 16 suites**, with natural exit,
warning-free full lint and changed-source formatting. Independent review strengthened pending
read shutdown, host refusal, observer forwarding and evidence joins. This was
one bounded native case, not another full regression or nine/fifteen-case run.

## Strict declaration result

An independently reviewed harness uses the already-installed TypeScript 6.0.3
compiler API with strict checking, no emit and no skipped library checks. Root
reproduction at `20560d86` passes the positive capability/assignment case and all
24 unsuppressed negatives: nine bind upstream types and fifteen check Freedom's
own declaration. The two invalid upstream capabilities fail specifically on
unsupported ERC1155 assets and numeric rather than bigint amounts.

Every program resolves 220 source/declaration files; 274 inputs are frozen.
All eight loaded Kohaku source files match Git blobs at
`6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. Root's new freeze differs from the
reviewed author's freeze only in the root commit. Compiler, case, source,
dependency and options bytes remain identical. Original prepare/run handles
`78257` and `97687` both exited zero.

This establishes declaration/consumer assignability for that exact resolved
graph. JavaScript implementation typechecking is disabled. Upstream defines its
note capability as `unknown`; Freedom supplies the concrete `ReadNote` shape.
Installed `ox` is 0.14.45, while the pinned provider requests `^0.12.0`, so this is
not an upstream lockfile build. Historical syntax-only comments and contract flags
remain unchanged; the new check applies to the restricted read declaration only.
The [type evidence and reproduction archive](qualification/railgun-kohaku-snapshot-types-2026-10-06/INDEX.json)
keeps author and root runs separate and preserves inspectable harness inputs.
Its map distinguishes 37 byte-exact payloads from six path-normalized derivatives;
original and published hashes are separate, and reproduction requires fresh path
and discovery-record pinning.

## Remaining work

The adapter remains a restricted synchronous-host, CommonJS/Node read component.
Generic upstream Host support, transaction-capable extraction, standalone package
and browser qualification remain separate. Neither these reads nor their types
grant ownership, finality, POI eligibility or spending authority. Live private
service/broadcaster qualification and later product/UI design remain open in the
[parity plan](railgun-parity-plan-2026-10-04.md).
