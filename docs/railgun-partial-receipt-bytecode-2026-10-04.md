# Partial-unshield receipt bytecode evidence

Read-only local inspection on 2026-10-04. No repository edits, network requests, funded profile access or EVM execution. Findings concern the supplied public bytecode capture, not independently proved canonical chain state.

## Inputs and integrity

- Capture: [public bytecode capture](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-public-contract-bytecodes-2026-10-04.json).
- Capture SHA-256: `a1f3a1c51c6272eca7940313bf3b8d6b8229527db3aaf3334acc76d8314c0427` (verified).
- Capture block: 11834513; recorded source: `https://sepolia.rpc.sentio.xyz`.
- Local artifact: [upstream WETH9 creation artifact](https://github.com/Railgun-Privacy/contract/blob/36bcf5ed7cf94bfafb6e1a303e1832c769c16780/externalArtifacts/WETH9.json), byte-identical to commit `36bcf5ed7cf94bfafb6e1a303e1832c769c16780`.
- Artifact-file SHA-256: `de69033cfc5a987aa051e23b79e0e2a1611b6345083c514b62935e34a6877ca9`.
- Local creation code: 3504 bytes; Keccak-256 `0xe400d18e1e1223434b13ddcb681585a94337319a6de92c41904679dc34481a29`.
- Captured WETH runtime: 3124 bytes; Keccak-256 `0xc864e10689f2da18833652a3b075d43106e87f0f90d95ee64f6f0b33bc026083`, equal to the production WETH code pin.
- Embedded local runtime: 3124 bytes; Keccak-256 `0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23`.
- Captured Railgun implementation runtime: 22812 bytes; Keccak-256 `0xd9ed4f83c7592b5a366858ae7a4f6c764543373bf7465ab457b80edc3d74b016`, equal to the production implementation code pin.

## Exact creation/runtime comparison

The creation code contains `610c348061017c6000396000f300` immediately before the embedded runtime: PUSH2 0x0c34 (3124), DUP1, PUSH2 0x017c (380), PUSH1 0, CODECOPY, PUSH1 0, RETURN, STOP. The copied/returned runtime begins at creation-byte offset 380 and extends to the end of the artifact creation code.

Captured and embedded runtime are NOT byte-identical. Their first 3081 bytes (runtime offsets 0 through 3080 inclusive) are byte-identical:

`0x2ed19494e7def0c00c199c9a7b1f938de6ec4603c65492cb6f41eb41ed92e602` (Keccak-256).

Both end with a 43-byte Solidity metadata trailer starting at runtime offset 3081 (0x0c09). The final two bytes, `0029`, specify the preceding 41-byte CBOR value. It is a one-entry map, key `bzzr0`, value a 32-byte hash:

- Captured: `a165627a7a72305820ada21019359e795ae4ccc73a92bede8dc56770bd023704c143e5070861a8cf8c0029`.
- Embedded: `a165627a7a72305820deb4c2ccab3c2fdca32ab3f46728389c2fe2c165d5fafa07661e4e004f6c344a0029`.

Exactly 32 bytes differ: runtime offsets 3090 through 3121 inclusive (0x0c12 through 0x0c31), the metadata hash value. No opcode/operand prefix bytes differ. This is a specific comparison of these artifacts, not permission to strip arbitrary metadata or weaken production code hashes. The code immediately preceding the trailer ends in STOP at offset 3080.

## Captured WETH transfer path

Offsets below are runtime byte offsets, hexadecimal.

- Dispatcher compares selector `a9059cbb` (transfer) at 0x008f and branches to 0x0370.
- Entry rejects nonzero CALLVALUE, decodes recipient and amount, then jumps at 0x03ac–0x03af to 0x0bce.
- At 0x0bce–0x0bda, the wrapper supplies CALLER as the source and enters the shared transferFrom routine at 0x068c.
- 0x068c–0x06db checks the source balance against the amount and reverts on insufficiency.
- 0x06dc–0x08ce handles allowance only when source differs from CALLER and allowance is not unlimited. For transfer's CALLER source that allowance branch is skipped.
- 0x08cf–0x0969 subtracts from the source balance and adds to the destination balance.
- 0x0998 pushes Transfer topic `ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`.
- 0x09ce executes LOG3 with source/destination topics and the amount as data; 0x09cf onward returns true through the caller.

There is no zero-amount bypass between a successful balance/allowance check and LOG3. Therefore a successful transfer(to, 0) emits a distinct zero-value Transfer event. Separate successful transfer calls to the same destination each emit their own event; there is no aggregation in this token routine.

This is static inspection of captured bytecode, not an executed loopback/EVM test or source-recompilation proof. It establishes token-side behavior. The separate captured-implementation inspection below establishes the caller path; it is not inferred from the newer Action-emitting source checkout.

## Railgun caller-side investigation

### Method and independent anchors

The runtime was linearly disassembled while skipping PUSH operands, then the relevant dispatch, branch, return-continuation and external-CALL paths were inspected. Local `contracts/logic/RailgunLogic.sol` guided names only. No exact compilation equivalence with that checkout or its newer Action-emitting wallet is asserted.

The following anchors were independently identified in the captured implementation:

- `treasury()` selector `61d027b3`: dispatcher 0x0169, target 0x0400, loads slot 0xf9 and masks the low 160 bits.
- `unshieldFee()` selector `053ed12a`: dispatcher 0x0233, target 0x029d, loads slot 0xfa, shifts/divides by 2^120, masks 120 bits.
- `getFee(uint136,bool,uint120)` dispatch selector `43c88730` reaches 0x1000 through 0x03a7/0x03b5. The selector is a locating anchor; the arithmetic below is read from the runtime.
- Unshield topic `d93cf895c7d5b2cd7dc7a098b678b3089f37d91f48d9b83a0800a91cbdf05284` equals Keccak-256 of `Unshield(address,(uint8,address,uint256),uint256,uint256)`. It is pushed at 0x3369 and emitted by LOG1 at 0x33a7.

The unshield caller at 0x1d1c onward checks the transaction's unshield enum. A zero enum skips this routine; a nonzero enum reaches 0x1dac–0x1daf, which jumps to 0x32ae with the transaction's unshield preimage calldata offset. This is not a claim that arbitrary calldata passes all preceding transaction verification.

### ERC20 branch and fee arithmetic

At 0x32ae, the routine decodes the preimage token enum through 0x4bb0, bounds it to the enum range, and takes the ERC20 branch when it is zero. The nonzero branch jumps to 0x33ad. The ERC20 branch decodes the token address at preimage+0x40 and the uint120 value at preimage+0x80.

At 0x3301–0x331e it loads the same slot/field exposed by `unshieldFee()`, supplies literal true for inclusive fee calculation, and jumps to 0x1000. The inclusive path at 0x100d–0x1048 uses divisor 10000. Its checked helpers are multiplication at 0x53a2 (MUL at 0x53b3), division at 0x53cb (DIV at 0x53eb), and subtraction at 0x53f1 (SUB at 0x5400). For a valid gross unshield amount U and fee basis points f, it computes:

- fee = floor(U * f / 10000)
- base = U - fee

The returned fee is also obtained as U-base, preserving exact conservation. The uint136 checked intermediates and uint120 result masks are visible in the bytecode. With the separately captured value f=25, gross amounts 1 through 399 give fee=0. This numerical example is conditional on that fee state; runtime code alone does not fix f to 25 forever.

### Both calls execute without zero/equality suppression

The first call is assembled at 0x3325–0x3341:

- token = the decoded ERC20 token address;
- recipient = low 160 bits of preimage.npk;
- amount = base;
- return continuation = 0x3342;
- unconditional jump to transfer helper 0x3969.

On successful return, the second call is assembled immediately at 0x3342–0x3364:

- 0x3343–0x3345 loads treasury slot 0xf9;
- token = the same retained token address;
- recipient = low 160 bits of that treasury slot;
- amount = fee;
- return continuation = 0x3365;
- unconditional jump to the same helper 0x3969.

Critical continuation bytes disassemble as:

```text
333e PUSH2 3969
3341 JUMP
3342 JUMPDEST
3343 PUSH1 f9
3345 SLOAD
3346 PUSH2 3365
... token/treasury/fee stack shuffles and masks only ...
3361 PUSH2 3969
3364 JUMP
3365 JUMPDEST
```

There is no conditional jump between the successful first return and the second helper invocation. There is no fee==0 or recipient==treasury comparison governing either call. Destination equality does not merge the calls.

The transfer helper at 0x3969 writes the recipient and amount into the ABI arguments, pushes selector `a9059cbb` at 0x3989, and follows the unconditional encoding path through 0x34d3 to 0x3999. That routine constructs the SafeERC20 failure context and enters 0x3a6e, whose byte-copy continuation reaches the actual EVM CALL at 0x3aa2 with zero native value. None of these pre-CALL helper steps skip zero-valued transfers or merge equal destinations.

After CALL, failure handling checks call success, code presence when the return is empty, and true when a bool return is present. Failure reverts; it is not silently accepted. Successful helper cleanup returns to the exact continuation above. Only after the second successful return does 0x3369–0x33a7 encode and emit Unshield with recipient, token, base and fee.

### Supported conclusion and receipt implications

For a successful ERC20 unshield through this captured implementation, both transfer calls execute. That remains true when fee=0 and when recipient equals treasury, including both conditions together. Combined with the independently inspected pinned WETH runtime, the successful transaction retains two distinct outgoing WETH Transfer logs in call order: base transfer first, fee transfer second. A zero fee still has its own zero-value log. Equal destinations still have two logs; a future receipt matcher must not aggregate them or accept one log as satisfying both transfers.

This statement is conditional on transaction success and execution of these pinned runtimes. A failed first or second call can revert the transaction and its logs. Resource exhaustion likewise is not a successful case. No EVM simulation, live transfer or funded account was used.

The captured implementation establishes both transfers before its Unshield event. The event-order addendum below traces the surrounding Nullified/Transact call path. Neither analysis proves proof acceptance or canonical inclusion; the exact-five-log rule remains a deliberately bounded receipt policy.

### Treasury/state and evidence limits

The supplied bytecode capture records block 11834513 and the public RPC source; its bytes and hashes were checked locally. It does not contain a state proof authenticating proxy implementation selection, treasury, fees or canonical block inclusion.

The earlier deployment report `docs/qualification/railgun-sepolia-deployment-2026-10-02.json` records treasury `0x0dCE0Fe955222A3ED1B756b1D962Dd0A1615E1af` and unshieldFee=25 at block 11829346, with two unverified public RPC observations. The later local `/private/tmp/railgun-sepolia-deployment-oct3-f.json` reports the same values at 11834513. These are bounded observations, not a permanent treasury pin or proof of the state at an arbitrary future receipt block. The runtime's slot load is authoritative about where it gets the second recipient; it does not supply that slot's future value.

Therefore the zero-transfer and equal-recipient control-flow uncertainty is resolved for the supplied runtime, but treasury binding at a receipt's actual execution state remains a separate schema/qualification requirement. None of this grants receipt authentication, finality, ownership, POI acceptance, retry or spending authority.

## Additional raw-byte SHA-256 hashes

These hashes are over decoded code bytes, not the textual hex or JSON:

| Bytes                                         | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Local WETH creation (3504 bytes)              | `f4b61154f6a886ccb5d13f5d8b0ab6dfdc5b7c1c183a7bd0c7289f89c9c9c56d` |
| Local embedded WETH runtime (3124 bytes)      | `5566bf50796faf93c9b6f6adacd3b32c70bfe16b48ffc59db6cd144cbdc89739` |
| Captured WETH runtime (3124 bytes)            | `9bbda01ae25d1f2b4171918cc6280a5769d6d6fc5500ed01e2143697902df4e1` |
| Captured Railgun implementation (22812 bytes) | `caaeab321d8c7e3016fe03bfd108fef29b23cb248c2304931523892fbeb2b37f` |

Reproduction: decode the capture's `code.implementation` hex as bytes, disassemble while skipping each PUSH operand, and inspect the byte-offset intervals above. The WETH comparisons use `code.wrappedNative`. Offsets include the full runtime, without stripping metadata. This analysis does not execute the EVM or fetch network data.

## Captured implementation event-order addendum

2026-10-04; local static disassembly only. Supplied capture SHA-256 `a1f3a1c51c6272eca7940313bf3b8d6b8229527db3aaf3334acc76d8314c0427`; implementation Keccak-256 `0xd9ed4f83c7592b5a366858ae7a4f6c764543373bf7465ab457b80edc3d74b016`. No network, EVM execution or repository evidence edits.

The earlier Nullified call path is now confirmed in the captured bytecode, rather than inferred from the newer Solidity source:

1. The actual transact ABI selector is `0xd8ae136a`. Dispatcher compares it at 0x00aa and branches to 0x059f; decoded entry jumps at 0x05ae to 0x1bad.
2. The first per-transaction loop starts at 0x1c5b. It checks the validation result before the 0x1cd0 continuation. It then prepares the selected transaction and jumps at 0x1cfc–0x1cff to **0x2fc4**, saving **0x1d00** as return continuation.
3. The routine at 0x2fc4 loops through nullifiers at 0x2fc8, performs nullifier storage checks/writes, increments at 0x311e–0x312b and branches back. Loop completion branches to 0x312f, pops the cursor, then pushes the Nullified topic at **0x3131**. This is an instruction inside the 0x2fc4 routine, not a separate callable JUMPDEST.
4. That topic is `0x781745c57906dc2f175fec80a9c691744c91c48a34a83672c41c2604774eb11f`, independently equal to the local ABI topic for `Nullified(uint16,bytes32[])`. Arguments are encoded via 0x5682, and **LOG1 is at 0x3192**.
5. The same routine then assembles ordinary commitments/ciphertexts at 0x3195–0x3286. Its loop is bounded by boundParams.commitmentCiphertext length; for the agreed partial shape this is one, so it copies the first ordinary commitment, not the final unshield commitment. Cleanup computes the updated output cursor and returns through 0x2db9 to the saved caller continuation 0x1d00.
6. Caller advances its first transaction loop at 0x1d05–0x1d17; only after the loop terminates at 0x1d18 does the separate **unshield loop at 0x1d1c** begin. Its nonzero-unshield branch jumps at 0x1dac to 0x32ae, with continuation 0x1db0. The previous evidence documents the two ERC20 calls and Unshield LOG1 at 0x33a7 within that routine.
7. Only after the unshield loop finishes at 0x1dc2 does the caller obtain the insertion coordinates via 0x09e1 and check whether the assembled ordinary-output array is empty. The branch at 0x1dd9 skips the event only for zero ordinary outputs. The supported partial has one. It pushes topic `0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1` at 0x1ddd, independently equal to the current Transact ABI topic, encodes via 0x549f, and emits **Transact LOG1 at 0x1e19**.

Thus for the supported single partial transaction, the traced proxy event order is Nullified before the ERC20-unshield routine, then Unshield, then the final Transact event. Combined with the separately traced two WETH calls, the expected five-event order is Nullified → WETH base Transfer → WETH fee Transfer → Unshield → Transact. Fee zero or equal recipient/treasury does not suppress either token call/log.

The strict exactly-five-total-logs matcher is a deliberately bounded receipt policy. This static call-path analysis is not a receipt inclusion proof, deployed proxy storage proof, full EVM execution qualification, or permission to accept arbitrary batched transactions/token implementations. Treasury remains the explicitly reviewed historical policy baseline, not authenticated state at inclusion. A transaction that reverts does not retain these logs. No newer Action-emitting source equivalence was assumed.
