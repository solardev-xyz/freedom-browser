# Agent domain skills: implementation research

Date: 2026-10-20. Historical research and implementation plan; **no paid transaction tested**.

October 22 follow-up: the first shared-service/Agent implementation is on
`experiment/domain-skills`; see [current scope and qualification](domain-management.md).
This historical call matrix includes later operations that the first slice does
not expose. Mainnet-fork fixture writes are not live purchases or wallet-device qualification.

This covers buying, renewing and managing `.eth` (ENS), `.wei` (WNS) and `.gwei` (GNS), including pointing a name at a site published through Freedom's Swarm tools. Public contract reads and ABI checks were performed without accessing a user's wallet. Sources and observations are pinned below so that the implementation does not depend on an app screenshot or an outdated registration tutorial.

## Recommended implementation

Build namespace-specific skills backed by a small, typed main-process naming service. Keep the existing built-in wallet as the only signer and the existing wallet approval boundary as the only authority to spend or change records. Start with **an owned name → verified Swarm publication**, then add registration and renewal, then the rest of management.

The current browser/dApp wallet route can already sign contract requests from an official app. It is a useful integration test and fallback, but skills alone cannot reliably provide private commit secrets, deterministic calldata, durable recovery and independent record verification. The current native `wallet_transfer` tool accepts transfers, not contract calldata. This is the concrete missing capability that justifies a bounded naming adapter; extending that transfer tool into an arbitrary transaction escape hatch is unnecessary.

There are no mandatory product questions blocking the first implementation slice. Suggested defaults: Ethereum mainnet; currently selected supported wallet; registration owner equals payer; no primary-name change, wrapping, fuse burning or operator approval unless asked; no speculative purchase; replace only the requested records. A paid qualification run needs a chosen name and budget during a user-present qualification session.

## Evidence and scope

Pinned upstream source snapshots:

| Project | Revision | Relevant source |
| --- | --- | --- |
| ENSv1 contracts | `2a00e564caf5cf676cec66c9d13c322fb734a7f5` | [Controller/interface/deployments](https://github.com/ensdomains/ens-contracts/tree/2a00e564caf5cf676cec66c9d13c322fb734a7f5) |
| WNS | `54fa6223afaf80e8390b51fe4e4e69e1a922a5c8` | [NameNFT, registrar, tests](https://github.com/z0r0z/wei-names/tree/54fa6223afaf80e8390b51fe4e4e69e1a922a5c8) |
| GNS | `1155c82db1536ff0e1a66674bde84fe7fbf9f918` | [NameNFT, registrars, SDK, tests](https://github.com/lucadonnoh/gwei-names/tree/1155c82db1536ff0e1a66674bde84fe7fbf9f918) |
| ENSv2 contracts | `48b3e2d39513b9dd32ef1850877a29009bc807b9` | [Source and Sepolia artifacts](https://github.com/ensdomains/contracts-v2/tree/48b3e2d39513b9dd32ef1850877a29009bc807b9) |

The [machine-readable evidence](audits/evidence/agent-domains-2026-10-20.json) records the mainnet block, bytecode hashes, observed fees, controller authorization, and public dummy commitment/contenthash vectors. It is a historical observation, not a permanent contract allowlist or proof that fetched source exactly matches deployed bytecode. Before enabling writes, qualify each adapter against the deployed artifact/runtime on a fork. Never download an ABI at execution time and immediately trust it for signing.

The read-only snapshot is mainnet block **26,236,444**, hash `0x95ceefb5d84ad4025be173d96127ac2bdc14fe27cc29f619f84a11ebbf5e84af`. It used public RPC only for this investigation. Production must use Freedom's existing network/RPC policy; public fallback must not silently bypass the user's node/privacy choice. Looking up a candidate name can disclose interest in that name to the RPC service. No live registration, renewal, signature, mic capture, publication or gas payment was performed.

## Deployment map

All mainnet rows below require chain ID **1**. Matching an address without matching the chain is insufficient.

| Role | Address | Use |
| --- | --- | --- |
| ENS registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` | Owner, resolver and TTL routing for ENSv1 |
| ENS `.eth` base registrar | `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` | ERC721 registrant and expiry |
| ENS current controller | `0x59E16fcCd424Cc24e280Be16E11Bcd56fb0CE547` | Current tuple registration, unwrapped renewal |
| ENS wrapped controller | `0x253553366Da8546fC250F225fe3d25d0C782303b` | Wrapped-name registration/renewal ABI |
| ENS current public resolver | `0xF29100983E058B709F3D539b0c765937B804AC15` | Candidate for new names; existing names use their actual resolver |
| ENS NameWrapper | `0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401` | Wrapped ERC1155 ownership, fuses and expiry |
| ENS L1 reverse registrar | `0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb` | ETH primary name |
| ENS default reverse registrar | `0x283F227c4Bd38ecE252C4Ae7ECE650B0e913f1f9` | Default primary name; separate from ETH reverse |
| ENS universal resolver | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | Resolution entry point, not a registrar |
| WNS NameNFT | `0x0000000000696760E15f265e828DB644A0c242EB` | Registration, renewal, ERC721, records |
| GNS NameNFT | `0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6` | Registration, renewal, ERC721, records |

ENS addresses come from the pinned [mainnet deployment artifacts](https://github.com/ensdomains/ens-contracts/tree/2a00e564caf5cf676cec66c9d13c322fb734a7f5/deployments/mainnet), not older `0x2535…` examples alone. WNS/GNS addresses also match Freedom's existing `src/main/ens-resolver.js`. Canonical reference: [ENS deployments](https://docs.ens.domains/learn/deployments/).

## 1. Shared name and publication preparation

1. Parse a **name**, not a URL path, arbitrary wallet recipient, or calldata. Keep namespace explicit. A `.wei` name is not an `.eth` subname.
2. Normalize using the selected namespace's rules and show the final full name. For ENS use ENSIP-15 normalization (the installed ENS tooling must be checked for the exact supported implementation). Reject invalid/mixed-script inputs; present confusing Unicode clearly. Do not invent an IDNA/punycode conversion as a substitute for ENS normalization.
3. For WNS/GNS, contract normalization lowercases **ASCII A–Z only** and validates UTF-8. Length/pricing is UTF-8 **bytes**, not JavaScript character count. A full ENS normalizer is not their contract algorithm. For a new label, use a conservative ENSIP-15-safe input policy plus a contract-normalization cross-check; for existing names preserve their actual registered bytes rather than silently making a different name. `CAFÉ` becomes `cafÉ`, not `café`, under the observed contracts. Their full-name hash helpers are intentionally permissive, so availability/registration validation is still required.
4. Compute identifiers in trusted code; compare against contract helpers when available. ENS `.eth` base token ID is **labelhash**; ENS resolver node/NameWrapper ID is **full namehash**. WNS/GNS token ID is a full recursive namehash including the TLD. Do not reuse ENS-normalizing `namehash()` for arbitrary legacy WNS/GNS Unicode bytes.
5. Read at a coherent chain snapshot: account, active network, ownership, expiry/grace, resolver, requested old records, fees and available balance including gas. Recheck relevant state immediately before approving/sending.
6. Resolve the exact Swarm publication receipt. Require its **32-byte manifest reference**, successful upload and retrieval verification. A postage batch ID, arbitrary file hash, individual chunk reference, mutable feed address or encrypted 64-byte reference is not interchangeable with that manifest.

### Swarm contenthash encoding

For the ordinary 32-byte Swarm manifest reference `R`, EIP-1577/ENSIP-7 contenthash is:

```text
0xe40101fa011b20 || R
```

That is 39 bytes: Swarm namespace varint, CIDv1, Swarm-manifest codec, keccak-256 multihash code and 32-byte length, followed by the reference. The evidence file contains an exact synthetic vector. This agrees with Freedom's existing decoder (`src/main/ens-resolver.js`, `decodeContenthash`). Encode/decode round-trip before signing. Never store a `bzz://…` string as UTF-8 or just pass the raw 32-byte reference. Primary format reference: [EIP-1577](https://eips.ethereum.org/EIPS/eip-1577); implementation compatibility is additionally checked against the repo decoder.

A domain update changes a public pointer. It does not extend Swarm postage, erase an old immutable publication, make a site private, or guarantee permanent storage. Show the target publication and preserve unrelated records. After mining, read back/decode the contenthash, then perform a fresh Freedom resolution and open the name. Cache staleness is a reason to refresh/read chain, never to pay again.

## 2. ENS `.eth`: exact registration and renewal

### Current ENSv1 controller ABI

The controller at `0x59E1…` takes one tuple. Pin these fragments from its artifact:

```solidity
struct Registration {
  string label;
  address owner;
  uint256 duration;
  bytes32 secret;
  address resolver;
  bytes[] data;
  uint8 reverseRecord;
  bytes32 referrer;
}
rentPrice(string label, uint256 duration) view returns (uint256 base, uint256 premium);
available(string label) view returns (bool);
valid(string label) pure returns (bool);
makeCommitment(Registration registration) pure returns (bytes32);
commit(bytes32 commitment);
register(Registration registration) payable;
renew(string label, uint256 duration, bytes32 referrer) payable;
commitments(bytes32 commitment) view returns (uint256);
minCommitmentAge() view returns (uint256);
maxCommitmentAge() view returns (uint256);
MIN_REGISTRATION_DURATION() view returns (uint256);
```

`rentPrice` is a tuple return in the actual ABI; use the JSON artifact rather than copying pseudocode return syntax into an interface unchecked. Commitment is `keccak256(abi.encode(registration))`, with the **complete tuple**, including initialization calls and flags. The evidence vector compares local encoding to the deployed `makeCommitment` through `eth_call`. Source: [controller](https://github.com/ensdomains/ens-contracts/blob/2a00e564caf5cf676cec66c9d13c322fb734a7f5/contracts/ethregistrar/ETHRegistrarController.sol) and [interface](https://github.com/ensdomains/ens-contracts/blob/2a00e564caf5cf676cec66c9d13c322fb734a7f5/contracts/ethregistrar/IETHRegistrarController.sol).

### Registration procedure

1. Only top-level `.eth` names belong in this registrar. Check normalized label, `valid`, `available`, `rentPrice`, controller authorization and supported resolver. Minimum label length is three ENS characters; do not approximate Unicode length with `.length`.
2. Choose duration in seconds. Observed minimum is **2,419,200 seconds / 28 days**. Display the chosen calendar/seconds convention; do not assume all namespaces sell an arbitrary duration.
3. Generate a cryptographically random 32-byte secret **inside main**, privately persist the plan and secret before dispatch. Never ask the model to choose it or put it into chat/tool output. If using resolver initialization, encode only the approved records with the correct node. Registration may set contenthash in the same reveal transaction via resolver multicall.
4. Default owner=payer, `reverseRecord=0`, `referrer=bytes32(0)`. The latest controller's reverse flags target **the caller**, not automatically `registration.owner`. Setting a primary name is a separate user intent. Flags distinguish ETH reverse and default reverse; do not pass a Boolean from the older API.
5. Show the concrete plan and wallet transaction. Submit `commit(commitment)` with zero value after approval; persist tx hash/receipt and **on-chain commitment timestamp**. The commit itself costs gas but does not buy/reserve the name.
6. Wait until chain time reaches commitment time+minimum. Observed minimum 60 seconds, maximum 86,400. Latest ENS rejects at the upper boundary (`now >= committedAt+max`). Use an automatic lifecycle continuation, not a fixed wall-clock sleep followed by guessed success.
7. Recheck availability, account/chain, tuple integrity and quote. Price/premium can change; a larger spend needs fresh approval. Send `register(tuple)` with current approved `base+premium` ETH. It registers through the base registrar and transfers its ERC721 to the requested owner. These latest registrations are **unwrapped**, unlike the older controller.
8. Confirm receipt status and ownership/expiry/records; retrieve the site through the name. A successful commit or a broadcast reveal hash is not ownership. If someone else bought the name, report that and do not pick/buy another without user direction.

No arbitrary price buffer by default. Overpayments are refunded, but refund behavior can differ for contract-wallet callers; qualify the actual wallet type. A fresh quote plus simulation and a bounded user-approved total is better than silently adding ETH. Historical test label/year quote at the recorded block was `2046496373659585 wei` base, zero premium; this is **not a current price or product estimate**.

### Renewal: distinguish wrapped names

Read base `nameExpires(labelhash)`, registry owner, and NameWrapper data before selecting a controller. Anyone can pay renewal; this does not make them owner. ENSv1 grace is 90 days, and the ordinary expiry is distinct from wrapper expiry. [Base registrar source](https://github.com/ensdomains/ens-contracts/blob/2a00e564caf5cf676cec66c9d13c322fb734a7f5/contracts/ethregistrar/BaseRegistrarImplementation.sol).

| Name state | Write | Required postcondition |
| --- | --- | --- |
| Unwrapped ENSv1 | Current controller `renew(label,duration,bytes32(0))`, value quoted base | Base expiry increased by duration, ownership unchanged |
| Wrapped ENSv1 | Wrapped controller `renew(string label,uint256 duration)` at `0x2535…`, value its quoted base | Base expiry **and NameWrapper expiry** updated, owner/fuses preserved |
| Migrated ENSv2 / legacy after v2 activation | Version-specific adapter, see section7 | Never select a v1 renewal path solely from `.eth` suffix |

Why the split: current controller renewal calls the base only, whereas NameWrapper's controller-only `renew(labelhash,duration)` also updates its stored expiry. The wrapper currently authorizes the old wrapped controller. The base registrar does **not** directly authorize that old controller; renewal goes through the wrapper, which calls the base. Preserve this call chain rather than treating the old controller as a direct base controller. Artifact: [WrappedETHRegistrarController](https://github.com/ensdomains/ens-contracts/blob/2a00e564caf5cf676cec66c9d13c322fb734a7f5/deployments/mainnet/WrappedETHRegistrarController.json); wrapper logic: [NameWrapper.sol](https://github.com/ensdomains/ens-contracts/blob/2a00e564caf5cf676cec66c9d13c322fb734a7f5/contracts/wrapper/NameWrapper.sol). Fork-test this behavior before enabling renewals.

The older wrapped registration ABI is `register(string,address,uint256,bytes32,address,bytes[],bool,uint16)` with the corresponding `makeCommitment` arguments. It is **not** the latest tuple API. Do not automatically wrap new names or burn fuses; supported renewal does not require enabling every legacy registration path.

## 3. ENS management call matrix

Resolve the actual authoritative resolver/registry and simulate from the selected signer. Do not assume that the NFT owner, registry manager, resolver delegate and primary-name owner are the same person.

| Intent | Read/precondition | Exact ENSv1 write |
| --- | --- | --- |
| Set/replace/clear site | `registry.resolver(node)`, actual resolver `contenthash(node)`, interface/auth | Resolver `setContenthash(bytes32 node,bytes hash)`; `0x` only for an explicit clear |
| ETH address | Current `addr(bytes32)` | Resolver `setAddr(bytes32,address)` |
| Other chain address | Current `addr(bytes32,uint256)`, verified coin encoding | Resolver `setAddr(bytes32,uint256,bytes)` |
| Text/email/avatar/URL | `text(bytes32,string)` for explicit requested keys | Resolver `setText(bytes32,string,string)` |
| Several records | Each old value; supported resolver multicall, auth | Resolver `multicall(bytes[])` or `multicallWithNodeCheck(bytes32,bytes[])` on qualified implementation |
| Change resolver | Current resolver and all affected known records; manager/wrapper authority | Registry `setResolver(bytes32,address)` unwrapped; wrapper `setResolver(bytes32,address)` wrapped |
| Change registry manager | Current registry owner; not equivalent to registrant transfer | Registry `setOwner(bytes32,address)`; base owner may later `reclaim(uint256,address)` |
| Transfer unwrapped registrant | ERC721 owner/approvals; decide separately whether manager/records also change | Base registrar `safeTransferFrom(address,address,uint256)`; optional explicitly approved `reclaim` for new manager |
| Transfer wrapped name | Wrapper owner/fuses/expiry; transferable state | Wrapper `safeTransferFrom(address,address,uint256,uint256,bytes)` with amount 1 |
| Primary ETH name | Forward address points to chosen account; reverse owner/auth | L1 reverse registrar `setName(string)` for self; qualified authorized `setNameForAddr(address,address,address,string)` for other-supported paths |
| Primary default name | Default reverse name and forward match, current controller authorization | DefaultReverseRegistrar `setName(string)` for self; `setNameForAddr(address,string)` only with actual authority |
| Create unwrapped subname | Parent registry authority, labelhash, recipient, resolver, TTL | Registry `setSubnodeRecord(bytes32,bytes32,address,address,uint64)` |
| Create wrapped subname | Parent wrapper authority/fuses, bounded child expiry, recipient | Wrapper `setSubnodeRecord(bytes32,string,address,address,uint64,uint32,uint64)` |
| Inspect/revoke delegate | Registry/resolver/wrapper approval scope must be clear | Qualified contract's `setApprovalForAll(address,bool)` or resolver `approve(bytes32,address,bool)`; never grant blanket approval as a convenience |

Resolver authorization is defined by the actual implementation; the current [PublicResolver](https://github.com/ensdomains/ens-contracts/blob/2a00e564caf5cf676cec66c9d13c322fb734a7f5/contracts/resolvers/PublicResolver.sol) supports wrapped ownership and resolver-specific delegation. Records may also be offchain, wildcarded or inherited. ERC165 support alone does not prove a write is authorized or has normal effects; simulate and check readback.

Changing resolvers can disconnect all records. Do not automatically replace a custom/offchain resolver merely because the standard setter reverts. Read-only diagnosis and a conversational explanation are the fallback; a resolver migration is a separate plan that lists preserved/unavailable records. Custom resolvers need separately qualified adapters.

Wrapping, unwrapping, fuse burning, parent emancipation and migration require their own explicit plan. Fuses can remove capabilities irreversibly until expiry; name/parent state bounds subname operations. They are not prerequisites for ordinary site updates. [NameWrapper fuse reference](https://docs.ens.domains/wrapper/fuses/).

## 4. WNS `.wei` and GNS `.gwei`

These are independent ERC721 namespaces on Ethereum, not ENS registrar deployments. Their core write ABI is similar, but their fees/governance and deployment identities must remain separate. Detailed source references: [WNS NameNFT](https://github.com/z0r0z/wei-names/blob/54fa6223afaf80e8390b51fe4e4e69e1a922a5c8/src/NameNFT.sol), [GNS NameNFT](https://github.com/lucadonnoh/gwei-names/blob/1155c82db1536ff0e1a66674bde84fe7fbf9f918/src/NameNFT.sol); qualify behavior against their pinned tests and deployed runtime.

### Availability, commitment and registration

```solidity
normalize(string label) pure returns (string);
computeId(string fullName) pure returns (uint256);
isAvailable(string label, uint256 parentId) view returns (bool);
getFee(uint256 utf8ByteLength) view returns (uint256);
getPremium(uint256 tokenId) view returns (uint256);
makeCommitment(string label,address owner,bytes32 secret) pure returns (bytes32);
commitments(bytes32) view returns (uint256);
commit(bytes32);
reveal(string label,bytes32 secret) payable returns (uint256);
renew(uint256 tokenId) payable;
```

For a top-level name, `parentId=0` in availability. Read fee using normalized label byte length, plus current premium for the full token ID. Commitment is `keccak256(abi.encode(bytes(normalizedLabel),payer,secret))`; compare it with `makeCommitment`. Send commit, wait for mined timestamp+60sec, recheck state/quote, then call **`reveal(label,secret)`** with fee+premium. Reveal mints to **`msg.sender`**; its ABI has no owner argument. The committed owner must therefore be the actual wallet caller, not an arbitrary recipient or transaction router.

The commitment hash has no chain/contract domain separator and is the same across WNS/GNS for identical inputs; generate a fresh secret per operation and bind its stored plan to chain+contract. Both inspected contracts accept reveal up to and including committedAt+86,400sec; ENS's latest controller has a different upper boundary. Initial term is 365 days. Longer initial requested terms require registration then explicit additional renewals. Forwarder/Multicall3 write batching changes `msg.sender` and can break commitment ownership, record authorization, or refunds; do not use it as a general write optimization.

### Price observations and expiry

Observed at the pinned mainnet block:

| UTF-8 label bytes | WNS registration/one-year renewal | GNS registration/one-year renewal |
| --- | --- | --- |
| 1 | 0.5 ETH | 0.5 ETH |
| 2 | 0.1 ETH | 0.1 ETH |
| 3 | 0.05 ETH | 0.05 ETH |
| 4 | 0.01 ETH | 0.01 ETH |
| 5+ | 0.0005 ETH | 0.0005 ETH |

Registration may additionally have an expiry premium; gas is extra. **Always quote on chain**. WNS source-constructor default and README examples are not live prices: the currently observed default fee is 0.0005 ETH, controlled by its owner/DAO. GNS hardcodes its fee schedule and burns fees. These are materially different governance assumptions. Do not present either as dollar pricing or assume ENS's yearly fee applies.

`renew(tokenId)` adds exactly 365 days to the existing top-level expiry and is payable by anyone. Grace is90 days; grace names cannot be treated as active simply because `isExpired()` is false (that getter becomes true only after grace). Use `records`, `expiresAt`, `inGracePeriod`, parent state and actual contract simulation. Subnames inherit parent lifecycle and cannot be independently renewed through top-level `renew`. Premium decay is 21 days in inspected deployments; re-read premium at reveal time. GNS deployment/test references: [deployment scripts and tests](https://github.com/lucadonnoh/gwei-names/tree/1155c82db1536ff0e1a66674bde84fe7fbf9f918/test); WNS [fee/admin implementation](https://github.com/z0r0z/wei-names/tree/54fa6223afaf80e8390b51fe4e4e69e1a922a5c8/src).

### Management matrix

| Intent | NameNFT call | Important distinction |
| --- | --- | --- |
| Existing-name state | `ownerOf(uint256)`, `records(uint256)`, `recordVersion(uint256)`, `expiresAt(uint256)`, `getFullName(uint256)` | Record epoch/parent epoch matter after re-registration |
| Website | `setContenthash(uint256,bytes)`; read `contenthash(uint256)` | Getter also has `bytes32` overload for resolver compatibility; setter uses token ID |
| ETH address | `setAddr(uint256,address)` | Forward resolution otherwise falls back to token owner |
| Other address | `setAddrForCoin(uint256,uint256,bytes)` | Use correct coin-specific byte encoding |
| Text | `setText(uint256,string,string)` | Preserve unrelated keys |
| Primary name | `setPrimaryName(uint256)`; `0` clears | Caller owns active token; reverse lookup checks forward match |
| Subname | `registerSubdomain(string,uint256)` or `registerSubdomainFor(string,uint256,address)` | Actual parent owner is required; ERC721 operator approval is insufficient |
| Transfer | Standard ERC721 `safeTransferFrom(address,address,uint256)` | Active state required; resolver records survive transfer |
| Approval/revoke | `approve(address,uint256)`, `setApprovalForAll(address,bool)` | Token-transfer authority, **not** resolver edit authority |

A parent owner can overwrite a child even if that child was transferred to someone else. Epoch invalidation prevents stale descendants from retaining authority when an ancestor is re-registered. Maximum depth is 10 in inspected implementations. Display those constraints before selling/creating a subname; do not imply independent perpetual ownership. Inspect the [GNS subname tests](https://github.com/lucadonnoh/gwei-names/tree/1155c82db1536ff0e1a66674bde84fe7fbf9f918/test) and [WNS tests](https://github.com/z0r0z/wei-names/tree/54fa6223afaf80e8390b51fe4e4e69e1a922a5c8/test) for qualification cases.

### Optional registrar products: researched, not required for top-level names

| Deployment | Mainnet address | Separate capability |
| --- | --- | --- |
| WNS SubdomainRegistrar | `0x53745292f0d30d68204a63002C17bDa16C772bf7` | Parent-controlled sales/escrow |
| GNS SubdomainRegistrar | `0xc1D5245bfd98dDB7E73B33209B346b4FC0E03f3c` | Parent-controlled sales/escrow |
| GNS UniversalResolver | `0xD658131FFB6D732335d37f199374289F1b31564F` | Read adapter; not registration authority |
| GNS HumanRegistrar | `0xA4283D56f523d05bBd46e483f7861d6D10Cb330A` | Passport-proof `.zkpassport.gwei` subname claims |

SubdomainRegistrar has `configure(uint256,address,address,uint256,bool,address,uint256)`, `register(uint256,string)`, `registerFor(uint256,string,address)`, `deposit(uint256)`, `withdrawParent(uint256,address)`, `disable(uint256)`, `withdrawETH(address)`, `clearStaleEscrow(uint256)`. Read `config(parentId)` and escrow controller first. ETH price uses msg.value; ERC20 price uses exact allowance and token transfer. Optional gate applies to the **payer**. Flash mode temporarily transfers the parent token to the registrar and back; escrow mode transfers continuing custody. These need a separate approval/recovery design, never an automatic prerequisite for registering a top-level name. Sources: [GNS registrar](https://github.com/lucadonnoh/gwei-names/blob/1155c82db1536ff0e1a66674bde84fe7fbf9f918/src/SubdomainRegistrar.sol), [WNS registrar](https://github.com/z0r0z/wei-names/blob/54fa6223afaf80e8390b51fe4e4e69e1a922a5c8/src/SubdomainRegistrar.sol).

HumanRegistrar's `claim(ProofVerificationParams,string)` needs a real zkPassport proof bound to account, chain, app domain and scope, with a one-claim-per-document rule. An agent cannot fabricate this proof or handle a passport invisibly. It is a distinct user-present identity flow, not ordinary `.gwei` registration. Exact nested struct comes from the pinned [HumanRegistrar interface](https://github.com/lucadonnoh/gwei-names/blob/1155c82db1536ff0e1a66674bde84fe7fbf9f918/src/HumanRegistrar.sol); do not flatten it into guessed calldata. No need to add a passport dependency for the core feature.

GNS explicitly says its fork-specific changes have not been separately audited; inherited upstream audits are not a GNS audit. Avoid an assurance badge implying otherwise. This research is integration analysis, not an independent contract security audit. [Upstream disclosure](https://github.com/lucadonnoh/gwei-names/tree/1155c82db1536ff0e1a66674bde84fe7fbf9f918#audits).

## 5. Built-in wallet integration and typed tool boundary

Existing implementation points checked:

- `src/main/agent/builtin-skills.js`: bundled progressive read resources; skills are instruction, not authority. Add shared naming + per-namespace resources using its existing virtual paths, byte limits and allowlist.
- `src/main/agent/pi-browser-tools.js`: `wallet_transfer` has no contract calldata. Browser helpers cannot access wallet/node operations. Keep domain mutation under the main agent and the browser-owned wallet controller.
- `src/main/agent/agent-wallet-controller.js`: supported Agent signers are mnemonic, Ledger and remote. Safe/watch-only are not qualified Agent signers. It checks account/from/chain, estimates fees and requires the wallet transaction approval before signing. Preserve that boundary; no raw key export or model-selected signer.
- `src/main/wallet/transaction-service.js`, transaction recording/signers: reuse signing, transaction tracking and uncertain-dispatch reconciliation rather than creating a second wallet stack.
- `src/main/ens-resolver.js`: reuse namespace detection/contenthash decode/fresh resolution, but resolution support does not qualify write ABIs.
- Swarm publication/postage lifecycle: reuse persistent continuation and receipt-driven success, including the precedent that an operation should not end merely because the first wait elapsed.

Proposed API shape (names provisional, **not tools that exist today**):

| Tool | Input | Output/authority |
| --- | --- | --- |
| `domain_inspect` | Full name, optional selected wallet | Availability, owner/controller, expiry, resolver, supported actions and requested records; no write |
| `domain_prepare` | Typed intent: register/renew/set-records/subname/transfer; name, explicit duration/recipient/records/publication ID | Opaque plan ID, semantic diff, price/gas range, exact step list and qualification limitations; no signature |
| `domain_execute` | Opaque plan ID and current step | Host validates unchanged account/chain/intent/quote, presents exact wallet approval and sends only the pre-encoded allowlisted call |
| `domain_operation_status` | Operation ID, bounded wait | Durable receipt/state/next action, verifies records and resumes waiting; no automatic repeat purchase |

`domain_prepare` must not accept caller-supplied ABI, selector, contract address or opaque calldata. Namespace adapter selects a pinned deployment and permitted operation. Internal main-process transport can share the existing controller's account/fee/approval/signing code without granting new renderer transaction authority. New IPC, if required, must use the existing sender-policy checks and receive architecture review. Prefer the Agent tool path rather than exposing unnecessary new page APIs.

The semantic approval must render in the existing trusted chrome wallet approval surface and be bound to host-encoded transaction bytes; model prose is not the approval. It should say, for example, “Set the website for `alice.wei` to publication X; replace current reference Y; Ethereum; account Z; estimated maximum network fee…”. A registration approval includes term, owner, rental fee, premium, gas, and the separate commit/reveal steps. The user should not be forced to inspect raw calldata to understand a purchase. The exact transaction remains available for inspection. Existing approval modes do not silently authorize spending, operator access or changed owners.

Deployment validation must account for proxies and their current implementation/version; matching only a stable proxy runtime hash does not qualify its mutable implementation. Unknown implementation changes invalidate a prepared plan. Simulator input must be the **actual wallet sender**. `eth_call` success is useful but does not guarantee a future transaction will succeed or prove source safety. Revalidate address/code/version, balance, nonce policy and time-dependent state immediately before dispatch. Host arithmetic uses integer wei/seconds/IDs, never floating point.

## 6. Durable lifecycle, stop and recovery

Persist before dispatch: operation ID, profile/conversation, namespace+adapter version, chain, account, normalized label/IDs, owner, exact duration/records/publication reference, resolver, quote+spend ceiling, commitment and private secret, step/call digest, approval scope, tx dispatch IDs/hashes/nonces, receipt block hashes, deadline and verification results. Store secret in the existing protected credential/storage boundary or a dedicated encrypted store; never ordinary transcript/history/logs. If a platform cannot provide its promised secret protection, do not silently downgrade it. Purge secret when no longer needed under a deliberate retention policy, without losing public recovery receipts.

State machine:

```text
prepared → awaiting approval → commitment dispatching → commitment pending
  → waiting for chain age → reveal ready → awaiting reveal approval
  → reveal dispatching → reveal pending → verifying ownership/records
  → verifying Freedom resolution → completed
```

Record updates/renewals skip commitment states. Each state also permits `declined`, `stopped`, `failed`, `expired`, `needs user choice`, or **`dispatch unknown`**. Unknown dispatch is reconciled against the existing transaction recorder, nonce/hash/receipts and on-chain state before another send. Use one operation lock per identity/intent; multi-turn retries attach to that operation.

- Wait on chain timestamps, not merely a 60-second local timer. Bound polling/backoff and let the main lifecycle continue without consuming model tokens for every poll.
- Restart/context compaction restores operation IDs and progress; the model sees a safe summary, never the secret. Tab closure does not erase the commit.
- A user Stop prevents future unapproved actions/waits. It cannot undo a mined commit, broadcast reveal or already changed record. Preserve that distinction and an explicit resume path. Do not reveal later merely because the old run once wanted registration.
- Reorg: receipt block must remain canonical; recommit/reveal only after receipt/commitment/ownership reconciliation. A read provider timeout is not contract failure.
- Reverted transaction: decode a bounded known error; re-read state. Do not repeat indefinitely on unavailable name, insufficient funds, changed owner/fuse or expired commitment.
- Expired commit: same name may still be available, but another commit costs gas and needs the existing spend/approval boundary. Don't silently restart a purchase.
- Fee/record/owner/network changes invalidate stale plans. A premium falling does not permit changing the name; a price increase above approval cannot be hidden in gas.
- Replacement/cancellation transactions: reconcile the recorded nonce and final canonical receipt. Report gas already spent separately from rent actually paid.
- Resolver mismatch/failed retrieval after a successful record write is a verification problem, not permission to send the same write again.

## 7. ENSv2: prepare an adapter, do not pretend mainnet is qualified

Current official [overview](https://docs.ens.domains/ensv2/overview/) identifies Sepolia availability. The pinned contracts-v2 tree contains Sepolia deployments and no mainnet deployment artifacts. The inspected mainnet v1 base still authorizes its current controller and accepts the tested quote. Consequently this plan targets the observed v1 mainnet deployment while requiring runtime version detection and a deployment recheck when implementing.

Sepolia artifacts at the pinned revision list ETHRegistrar `0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3`, ETHRegistry `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` and PermissionedResolver implementation `0x7e4b2d59938930168024201752ee5503df402303`. Testnet chain is **11155111**, not 1. These are research references, not production allowlisted addresses.

The inspected v2 registrar interface uses:

```solidity
makeCommitment(string,address,bytes32,address subregistry,address resolver,uint64,bytes32) pure returns(bytes32);
commit(bytes32);
commitmentAt(bytes32) view returns(uint64);
getRegisterPrice(string,uint64,address paymentToken) view returns(uint256 base,uint256 premium);
register(string,address,bytes32,address subregistry,address resolver,uint64,address paymentToken,bytes32) returns(uint256);
getRenewPrice(string,uint64,address paymentToken) view returns(uint256);
renew(string,uint64,address paymentToken,bytes32);
```

It introduces ERC20 payment-token handling and exact allowances; native ETH is still needed for gas. Do not attach v1 rent in msg.value to this API. Token allowlist, decimals, price, allowance, spender and expiry need the same semantic approval protection. Legacy v1 renewal after activation may use `ETHRenewerV1.renew(string,uint64,address,bytes32)`, not either currently live controller. Registration pricing, grace, registry state, transfer/token IDs and resolver permissions also change. Source: [v2 interface](https://github.com/ensdomains/contracts-v2/blob/48b3e2d39513b9dd32ef1850877a29009bc807b9/contracts/src/registrar/interfaces/IETHRegistrar.sol), [Sepolia artifacts](https://github.com/ensdomains/contracts-v2/tree/48b3e2d39513b9dd32ef1850877a29009bc807b9/contracts/deployments/sepolia); forward-looking [readiness guide](https://docs.ens.domains/web/ensv2-readiness/) is not evidence of a mainnet migration already completed.

**Concrete documentation/artifact discrepancy:** the current [PermissionedResolver docs](https://docs.ens.domains/ensv2/permissioned-resolver/) describe `setContenthash(bytes dnsName,bytes)` and `setAddress(bytes,…)`. Pinned source and Sepolia `PermissionedResolverImpl.json` instead expose `setContenthash(bytes32,bytes)` and `setAddr(bytes32,…)`. This is not safe to resolve by guessing. Before v2 writes, select an exact released/deployed revision, verify ABI/runtime and run fork/testnet calls. Do not copy either shape into a catch-all `.eth` adapter. Shared-record/linking semantics in future resolvers can also make one edit affect multiple names; show the true affected set.

This is a contained qualification gate for **v2**, not a reason to block the existing qualified read path or all v1 research. The earlier `docs/audits/ensv2/README.md` covers read support only and should not be cited as registrar qualification.

## 8. Build order and acceptance matrix

### A. Deterministic core and owned-name website update

- Add namespace/deployment metadata, normalization/hash/contenthash helpers and bounded readonly inspect/quote adapters; no new dependency needed for basic ethers ABI encoding. The repo already directly depends on `@adraffy/ens-normalize` 1.11.1; reuse its ENSIP-15 path and qualify vectors rather than adding a second normalizer.
- Implement semantic plan + exact wallet execution using existing controller/signers, operation persistence and typed error/status results.
- Add bundled shared/ENS/WNS/GNS skill resources and discovery triggers (“give my site a name”, “point my domain at this publication”, “renew…”). The model decides intent; trusted code enforces exact calls.
- Implement set/readback contenthash for existing supported resolvers/contracts, confirm authority, preserve unrelated values, fresh Freedom open. User receives exact remaining action when authority/custom resolver is unsupported.

### B. Registration and renewal

- Namespace-specific commitments, quotes, expiry/grace, timing and owner rules.
- Recovery/restart/stop and unknown-dispatch tests before any live spending.
- ENS wrapped renewal branch, WNS/GNS one-year increments, clear total cost including multiple transactions.
- Site initialization in ENS registration where supported; WNS/GNS reveal then record write as separate approved steps. If the record write is declined/fails, retain the successfully purchased name and show that only linking remains.

### C. Full standard management

Address/text/primary records, owned-name discovery, transfers, delegate revocation, subnames and resolver changes are researched above. Implement them as explicit typed intents with separate authority/postconditions, not arbitrary-calldata access. Maintain local known-name inventory plus on-chain ownership verification. Complete wallet-wide discovery needs event indexing from verified deployment blocks or an explicitly disclosed indexer; ERC721 `balanceOf` does not enumerate IDs. Paginate/checkpoint log queries; validate every indexed candidate on chain. External indexers must not become signing authority or send all wallet/name history without disclosure.

Optional registrar storefront/escrow, passport claims, ENS migration/fuses/custom-resolver adapters, marketplace purchases and bulk operations remain separately scoped extensions. “Full standard management” should not imply every third-party domain marketplace or future ENS version is supported.

### Required automated qualification

| Area | Cases |
| --- | --- |
| Encoding | Published vectors; tuple vs legacy controller; contenthash prefix/length/roundtrip; namehash vs labelhash; selector overloads; UTF-8 byte prices and ASCII-only WNS/GNS lowercase |
| Names/state | Invalid, unavailable, Unicode/confusable, subname, wrong namespace/chain, nonexistent/expired/grace/premium, stale parent epoch, fee governance change |
| Authority | Selected account vs owner/delegate; wrapped fuses; actual resolver; denied user approval; remote/Ledger errors; unsupported Safe/watch-only; zero/arbitrary recipients |
| Lifecycle | Minimum and maximum timestamp boundaries; restart before/after every dispatch; unknown broadcast; duplicate turn/tool execution; dropped/replaced tx; reorg; failed reveal; stop then explicit resume |
| Money | Exact wei arithmetic, fee+premium, gas balance, price increase, multiple WNS/GNS years, refund receiver, ERC20 allowance only for qualified v2/optional registrar |
| Records | Preserve address/text, replace/clear only on request, no resolver auto-migration, readback mismatch, stale cache, custom/offchain resolver unsupported path |
| Wallet/UI | Semantic approval matches exact encoded transaction; main sender/chain policy; model cannot supply calldata/change deployment; private secret absent from logs/history/tool results; no helper wallet access |
| End-to-end | Disposable fake wallet/RPC + fork receipt/state fixtures; existing name update and register→link→resolve per namespace; Linux/Windows rendering where new UI is added |

Use mainnet-fork tests for actual deployed contracts (no public broadcasts), local deterministic fixtures for failure/reorg/recovery, and Sepolia where the specific deployment exists. Do not conflate GNS's same-address Sepolia deployment with WNS or ENS. Only after those pass, perform a **separately authorized** small-value live flow per namespace and supported signer. Record gas/rent, tx hashes, actual ownership/expiry/records, and Freedom resolution; ordinary CI must never buy/renew a real name.

## Implementation handoff — prepared 2026-10-20

For the next implementation session, start A on a new experimental sub-branch; implement inspect and owned-name binding first. Review the typed wallet boundary and private-operation persistence before enabling registration. Recheck live deployment/version/fee state, then B and C in that order. Reuse the [evidence file](audits/evidence/agent-domains-2026-10-20.json) as historical fixtures, not configuration. No research conclusion above authorizes a real purchase.
