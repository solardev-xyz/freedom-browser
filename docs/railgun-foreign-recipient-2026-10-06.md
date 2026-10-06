# Railgun full-value transfer to another account — October 6, 2026

Phase 1 of the approved contract: a private transfer from enrolled account A to a
different controlled Railgun account B, with one input, one output, the full input
value and no change. It reuses the direct enrolled-EOA submission path. There is
no relayer, partial A-to-B transfer, renderer or IPC path. Tests run under Jest
with mocked engines and the local fixture engine. This is not a native Electron,
live or production activation.

## Destination and relationship

Kohaku's `prepareTransfer(value, to)` keeps its meaning: `to` names the
destination. The private adapter only format-checks it and passes it to the host
unchanged. The plugin request keeps its shape, `{ kind, noteId, recipient }`.

`selectRailgunPrivatePreparation` adds `recipientRelationship: 'foreign'` to the
selection only when the transfer recipient differs from this account's instance
address and is a lowercase `0zk1` string of the canonical length. Without the
marker, a transfer keeps its original meaning: `recipient === instanceId`,
checked exactly as before. Main has no engine, so its checks are string-level.

Strict decoding lives in `railgun-private-destination.js` and runs only inside
guarded utilities, with the pinned engine importer each job already uses. It
requires version 1 and either no chain (all chains) or exactly chain type 0 with
the pinned Sepolia ID. Re-encoding the decoded data must reproduce the input
string byte for byte. The master public key must be a non-zero field element and
the viewing public key 32 bytes. If either key equals a key of the spending
account, the destination is refused. That covers A's own keys under another
encoding and an address sharing only one key with A.

Unmarked self transfers are not decoded. The instance address is the wallet's
own all-chains encoding, and every utility already asserts
`wallet.getAddress() === descriptor.instanceId`. Exact equality is therefore the
same decision as decode-then-compare, and the existing self paths stay unchanged.

## Output and the check before signing

The witness creates the output with
`TransactNote.createTransfer(decodedB, wallet.addressKeys, fullValue, tokenData, false, OutputType.Transfer, undefined)`.
The circuit (1x1), calldata kind (`railgun-private-transfer`) and public
expectation shape are unchanged: one commitment and one ciphertext.

`verifyRailgunForeignOutput` recovers that output as the sender, following the
relay reconstruction approach. It derives the shared key from A's viewing private
key and the blinded receiver key, then decrypts with `isSentNote = true`. It
requires all of the following:

- recipient master and viewing keys equal to the decoded destination
- exact value, WETH token data and token hash
- Transfer output type and the wallet source the fixed wallet job sets
- no memo ciphertext (`0x`) and no memo text
- a random, non-null sender value, so B cannot recover A's address
- `npk = poseidon(B.MPK, random)` and a note hash equal to the calldata commitment
- blinding keys re-derived from A's and B's viewing keys equal to the bundle's

The borrowed shared key is wiped on every path. The witness runs this check before
returning an intent and also requires `npkOut` and `valueOut` to match.

Before signing, the operation calls the existing
`railgun-private-receive-job.js`; the key-release allowlist is unchanged. A
foreign input adds only `recipientRelationship: 'foreign'`. The job decodes the
destination and refuses a malformed, wrong-chain or own-key address before it
requests the viewing key. Its result carries the marker. The host and
`normalizeRailgunPrivateReceiver` refuse a result with a missing or different
marker or recipient.

## Binding

The capsule `version` stays 1, because it names the on-chain shape. A foreign
record adds only the explicit marker to its selection. Records without it keep the
historical self meaning, so existing records stay readable and their bytes and
digests are unchanged (the existing goldens pass). Older readers refuse a marked
record through their exact-key checks. No `self` value is ever persisted.

- The signing authorization digest covers the capsule digest, which includes the
  destination and marker, and the verified receiver result, which includes both
  again.
- The Kohaku preparation review adds `recipientRelationship`,
  `canonicalDestination`, `destinationVerification` and
  `foreignOutputPoiDisclosure` for foreign transfers only. The final transaction
  review adds the relationship and the destination from the signed capsule. The
  recovered-submission disclosure review and the POI disclosure plan add the
  relationship and an explanation that A's POI submission links B's blinded
  output commitment to A's spend.
- Self-transfer review summaries are unchanged. Their existing golden digest
  still passes.

A destination changed after review is refused in several places. The offer and
capsule normalizers refuse one changed on either side. The receiver check refuses
one whose decoded keys differ from the decrypted recipient. Cold reconstruction
and POI reconstruction apply the same sent-output check to the original
ciphertext.

## Recovery and POI

`reconstructRailgunPrivateWitness` serves the pre-signing round trip and cold
recovery. Its foreign branch takes the output NPK from the sent-output check and
never re-encrypts. Recovery admission (`railgun-private-recovery-data.js` and the
account wallet's recovery binding) and both POI input normalizers accept a marked
foreign destination. Unmarked records keep self equality there too.

`reconstructRailgunPoiNotes` takes the verified NPK of B's output. A's
post-transaction POI therefore blinds B's actual commitment with B's NPK and
position. B's own received-note path derives the same NPK from B's key and
public ciphertext alone.

## Source pinning

`railgun-private-destination.js` joins the wallet policy's pinned sources, and
the dependency-walk test now expects 57 files. Like any change to the pinned
private-path sources edited here, this changes the derived-cache wallet policy,
so an existing account needs a fresh wallet generation.

## Tests

- `railgun-private-destination.test.js` covers each decode and sent-output check
  in isolation.
- `railgun-private-foreign-transfer.test.js` runs a coherent toy engine through
  the real witness, receiver job, cold reconstruction and POI reconstruction. It
  also covers B decrypting as receiver: an ordinary received note, with no sender
  address, using only B's keys. A cannot decrypt that output as a receiver.
- The toy-engine negatives cover wrong master or viewing key, wrong chain or chain
  type, wrong version, non-canonical encoding, undecodable addresses, own keys,
  altered ciphertext, a destination altered after review, memo present, sender
  revealed, Change or BroadcasterFee type and a different wallet source.
- `scripts/fixtures/railgun-foreign-transfer-engine.test.js` uses the pinned
  fixture engine, like the existing relay vector test, and needs its local
  install. Real address decoding, note encryption and key agreement pass through
  the production witness, receiver job, cold reconstruction and B's POI
  reconstruction. B decrypts the output as an ordinary hidden-sender note; A and
  an unrelated account cannot. With the real engine, the sent-output check
  refuses another account, altered ciphertext, a wrong value, a revealed sender, a
  Change type and a memo. Swapping the shared-key direction or dropping
  `isSentNote` makes these tests fail.
- Extended suites: preparation, capsule, results, receive host, operation (which
  recomputes the exact authorization digest), Kohaku plugin, Kohaku adapter,
  recovery data, account wallet recovery, recover job, both POI input normalizers,
  POI disclosure plan, and fresh and recovered submission.
- The old Kohaku test that refused `'0zk-foreign'` now accepts a canonical foreign
  destination explicitly. Malformed destinations, including `'0zk-foreign'`, are
  still refused before review.
- Removing any single check from the destination helper made at least one test
  fail, and so did removing each of the four foreign sent-output call sites.

## Open questions

1. Native Electron qualification is still needed: a second enrolled account,
   signing and proving, B's wallet scan receiving the output, and A's POI
   submission covering it. The fixture-engine test covers the cryptographic
   checks only.
2. Main derives the review relationship from exact strings. An other-chain
   encoding of A's own address is reviewed as foreign and then refused before
   signing. Decoding before review would need a new or extended utility job.
3. The explicit marker, rather than a new capsule version, carries the new
   meaning. If the lead prefers a separate capsule version for foreign records,
   every `partial ? 2 : 1` capsule-version site would change.
4. The wallet-source check mirrors relay reconstruction. If the fixed wallet job's
   source ever changes, new foreign intents would be refused before signing.
5. Refusing an address that shares only one key with A is stricter than refusing
   only both keys. It is deliberate and can be relaxed if a real use needs it.
6. The native qualification scripts hash fixed source lists for provenance, and
   none lists `railgun-private-destination.js` yet. A campaign covering the
   witness, receiver job or reconstruction should add it. Those scripts were not
   edited or run here.
7. No changelog fragment: this is internal, unshipped work with no UI or IPC.
