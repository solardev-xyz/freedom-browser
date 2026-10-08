# Railgun adapter dependency

Freedom installs `@freedom/railgun-kohaku-adapter@0.6.0` from the committed
`freedom-railgun-kohaku-adapter-0.6.0.tgz`. The lockfile binds its SHA-512 integrity;
`OWNER-0.6.0.json` records the source commit, SHA-256 and exact 280-file membership.
The source repository is https://github.com/solardev-xyz/railgun-kohaku-adapter.
The package is MPL-2.0, private in npm metadata, and has not been published to npm.

This artifact was packed from `cfc47ae3076ebce5fc6cbed949ee54eccb253bab` with
Node 24.18.1 and npm 11.16.0. Its SHA-256 is
`9584f3756ea49430b1bc6adc40dd401c06d2f6001c4b609be2dda286a5c63f35`. The packed
files equal those of `1f6c66e7b17a4ed3ec6f2d93a10d3c153fdf6a97`; the later commit
adds only unpublished qualification tools.

Relative to the previous 0.6.0 artifact (`fb3add6a`, recorded under
`previousCandidate` with its qualification scope), it adds:

- `session.openSubmissionRecovery`: observe or resolve the exact journaled own
  EOA submission of one held private operation, bound by its signing digest,
  nullifier, tree and operation. Consent names the actual transaction endpoint.
  The lane never signs, sends, retries or releases the hold.
- `openAccount({ publicCache: 'new' | 'pending' })`: an explicit public-cache
  rebuild or resume for accounts whose public generation belongs to another
  source policy, including earlier package builds and legacy Freedom profiles.

Its synthetic native acceptance on this host identity is recorded separately.
It is not a live Sepolia result.

The package owns the Railgun protocol algorithms, account stores, scan and proof
jobs, disclosure plans, recovery lanes and Kohaku adapters. Freedom supplies the
vault credential primitive, submitter metadata, privacy contexts, transport,
storage root and genuine Electron process handles through fixed host contracts.
The public main entry exposes only `initializeRailgunMain`; private owner modules
are not package subpaths. Generic Freedom journal code uses the bounded
`/host/journal-data` and branded `/host/owner-authority` bridges.

Engine and prover archives, their verification artifacts and Tor remain separately
installed, pinned runtime inputs. They are not bundled in this tarball. The package
uses the existing ethers peer and optional SQLite 13.0.3 peer; this update adds no
third-party dependency. Freedom's lockfile resolves one physical package copy.

## Reproduction and verification

From a clean package checkout at the source commit above, run `npm pack` with the
same npm version. No prepack or prepare script exists and no dependency install
is needed for packing. Compare the resulting tar SHA-256, lockfile integrity and
membership with `OWNER-0.6.0.json`. Never edit archive members directly.

`railgun-kohaku-adapter-package.test.js` checks the full tarball and installed
membership byte for byte, the lock integrity, CJS/ESM function identity, one-copy
resolution and refusal of private subpath imports and fabricated receipts.
Native execution and packaged loading require their separate qualification;
ordinary unit tests do not establish those results.

The preceding tar C candidate at `133e88cc` passed installed read, private
preparation, unchanged-production-list rejection, stored-proof restart and unsigned
packaged initialization checks. Those reports retain their exact source and tar
pins. This artifact adds the separately reviewed retained-POI and owned-POI
interfaces. The new final-tar campaign is separate from tar C and does not
exercise those additional POI facade methods. Transact staging, foreign-recipient
and relay native paths retain their earlier package pins. The signed-stop case is
controlled cancellation, not crash recovery; the packaged probe is initialization,
not packaged utility/proof execution or a full ordinary application launch.
The current extraction does not constitute a completed live Sepolia spend or
production UX integration.

## Earlier extraction stages

Earlier tarballs remain as historical artifacts. Versions 0.1–0.4 extracted the
adapter and pure data contracts; 0.5 added the guarded private execution kernel.
`EXECUTION-0.5.0.json` and the previous candidate in `OWNER-0.6.0.json` preserve
source and artifact identities. Source-bound tests, scripts and qualification
narratives are preserved in the dedicated repository with their original hashes
and separately labelled current successors. Old native evidence never qualifies a
new source revision automatically.
