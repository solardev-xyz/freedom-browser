# Agent session privacy verification

Date: 2026-10-06
Status: experimental session shield, CPU checks and NEAR request-bound connection/signature checks implemented; full inference verification and E2EE remain open
Branch: `experiment/agent-privacy-verification`, from `56108147`

## Product intent

Show a compact privacy shield for each Agent conversation. Its details must
separate provider policy claims from evidence Freedom has actually verified.
Prefer named states and specific checks over an arbitrary numerical trust score.
This describes inference privacy, not answer correctness or general website safety.

The shield should explain:

- Where model requests went and which provider/model handled them.
- What the provider claims about retention and hardware isolation.
- Which hardware, software, connection, response and encryption checks passed.
- Which requests lack verification, including earlier turns, helpers and classifiers.
- Where information leaves the inference boundary through browser actions,
  connected services, publication or other tools. These are separate from inference.
- That local transcript/attachment storage is a separate privacy boundary.

Suggested states: local endpoint; provider policy; TEE advertised; checks pending;
partially verified; verified inference; verification failed/unavailable. Final copy
must name the verified property and avoid implying that a partial result establishes
full conversation privacy. A loopback Ollama URL establishes the destination, not
proof that the server is offline or cannot forward requests.

## Implemented in this branch

- Exact-pinned `@phala/dcap-qvl@0.6.5` (user approved 2026-10-06).
- CPU quote checks in a bounded main-process-owned worker: Intel production trust
  chain and collateral, default rejection of debug enclaves, TCB/advisory results,
  fresh client nonce and ECDSA signing-address binding from authenticated report data.
  Network failures and rejected evidence remain distinct. No provider `verified`
  flag is trusted. Credentials and conversation contents never enter the worker.
- Fixed provider attestation URLs; collateral retrieval restricted to Phala PCCS
  and Intel's certificate host, with redirects rejected, HTTPS, byte/time limits
  and a worker heap limit. No arbitrary certificate URL is followed.
- Main, helper and permission runtimes count actual fetch attempts on Pi's stream
  and completion paths. This records configured model identity and destination
  origin, not proof of the backend model that served a response. Context management
  is included with the Agent runtime. Failed attempts still count.
- A header shield opens a bounded, keyboard-accessible detail panel in both themes.
  Hardware advisories/rejected evidence get attention; no state claims verified
  inference. E2EE coverage is reported per actual request, separately from hardware health.
- SQLite schema 6 retains bounded, allowlisted route aggregates (maximum 32, with
  overflow counted), not raw quotes, prompts, response bodies or credentials.
  Older history stays unknown; interrupted checks restore as unavailable. The
  session listing does not eagerly load privacy metadata.

The panel now groups the same model across Agent/helper/permission roles. Its
main view explains provider access, request coverage and hardware warnings in
plain language. Raw advisory IDs, labeled gateway/model reports, origins,
role counts and timestamps are under technical details. No numeric trust score
or green “private” verdict is derived from partial checks.

### Before choosing a model

The composer picker and connection setup's model overview show the same
per-model privacy symbols with hover explanations and screen-reader descriptions
before inference: provider policy/private/anonymized
claims, external routing, protected-hardware claims, local/configured Ollama
endpoints, and the checks Freedom can perform. Venice's explicit `supportsE2EE`
capability is retained in the catalog/cache and labeled E2EE when supported;
names never enable or imply encryption. NEAR attested routes use E2EE. OpenRouter
shows the conversation's retention requirement. Details explain the limits.
Symbols describe capabilities, not live health results or completed checks. A
lock indicates E2EE, a dashed lock conditional E2EE, an outline shield advertised
hardware protection, and a crossed-out database required zero-retention routing.
Device/server, policy, external-provider and unknown symbols cover other routes.
Direct OpenAI (including both ChatGPT logins), Anthropic and Meta connections
remain visually plain. This is a presentation choice, not a claim about their
retention or training terms. Models from those labs routed through OpenRouter
still show the applicable routing protection.
Refresh existing catalogs to obtain newly exposed provider capability metadata.

### Request-bound checks (2026-10-06)

NEAR chat completions now obtain fresh CPU evidence **before each inference
attempt**. A private Node HTTPS Agent observes the actual peer certificate's
SPKI, requests nonce-bound gateway/model quotes, verifies all candidate CPU
reports in the worker, and compares the quote-bound fingerprint with that peer.
The inference body is sent on that exact socket. A replacement socket is
rejected before sending the body; the ordinary same-provider transport may then
proceed with connection coverage explicitly unavailable. No POST is retried by
this layer after it may have been sent. E2EE additionally requires valid model-key evidence before content is sent.
Failure blocks the encrypted request; there is no plaintext retry. TLS and
receipt coverage remain separate from that key requirement.

Exact UTF-8 request-body bytes and raw uncompressed response bytes are hashed.
Responses are observed incrementally with backpressure, not cloned into an
unbounded buffer. A bounded SSE/JSON parser extracts the completion ID; it does
not reconstruct the signed bytes. Receipts use fixed endpoints, reject
redirects, have a 32 KiB body limit and a 10-second overall deadline with at most
three fetch attempts. The existing ethers dependency verifies EIP-191 signatures.
Gateway and model signatures require distinct matching preflight signers;
ambiguous/missing model matches, unknown scopes, altered hashes, incomplete
streams and unavailable receipts never become verified responses. Gateway
signatures do **not** establish that the model produced the response. Model
signatures do not establish a particular serving instance or approved software.

Per-route counts separately retain attempted checks, pending checks, matched
connections, gateway/model signatures, failures and unavailable results. Earlier
unverified attempts are never upgraded by later successes; adverse hardware
results remain visible. On reopening a chat, unfinished receipt checks become
unavailable. Only bounded counters and CPU summaries are persisted; no request
bodies, response bodies, keys or raw receipts enter this metadata. Final SDK text
can arrive before the receipt lookup finishes; the conversation-scoped shield
continues updating afterward. Credentials, sockets and verification stay in the
main process; the renderer receives allowlisted summaries. A chrome-only,
conversation-owner-checked privacy-setting IPC now controls future ZDR requests.

Venice's non-E2EE models retain observational CPU endpoint checks. A live synthetic test of
`e2ee-qwen3-8-27b` returned a NEAR gateway receipt with **different exact request
and response hashes and a different signer** from Venice's model attestation.
Its signature response itself says to treat the hashes as provider-reported
unless a documented canonical format lets the client recompute them. This is
not a client-verifiable receipt for Freedom's exchange. Do not infer model
verification from a valid signature over unrelated upstream bytes. A documented
proxy-to-upstream binding or a compatible encrypted transport is needed.

Live NEAR qualification used `Qwen/Qwen3.6-35B-A3B-FP8`: both a direct streaming
probe and the real Pi runtime returned a checked same-connection binding and a
valid gateway signature over the exact exchange. CPU status remained OutOfDate;
signature validity does not remove Intel advisories. UI checked in dark/light and
at 760×560, with Escape dismissal. Unit coverage includes replaced sockets before
body send, no duplicate POST after transport errors, altered signers/nonces/TLS
fingerprints/hashes, signer scope, ambiguous model evidence, stream framing,
cancellation, history coverage and all runtime roles.

Protocol sources:
- [NEAR TLS connection binding](https://docs.near.ai/cloud/verification/cloud-api/tls)
- [NEAR response signatures](https://docs.near.ai/cloud/verification/cloud-api/response-signatures)
- [NEAR quote/nonce/signer contract](https://docs.near.ai/cloud/verification/reference/quote-nonce-signer)
- [Venice TEE/E2EE guide](https://docs.venice.ai/guides/features/tee-e2ee-models)

Still open: GPU evidence; measured configuration/event logs and approved
image/source policy; Venice proxy/request binding; verified-only enforcement;
Ed25519/v2 encryption support; packaged worker and cross-platform qualification.
The stages below remain the plan for those stronger guarantees.

## Findings and live probes

The user's configured Venice and NEAR credentials were used only in memory by an
isolated Electron probe. Catalog and attestation GETs returned HTTP 200 on both.
The initial probe submitted no inference prompts and checked endpoint access only.
Later qualification used synthetic OK-only prompts through disposable runtimes; no
personal conversation content or provider configuration was changed, and no keys
were printed.

- Venice: 70 text catalog entries, 12 advertising TEE attestation. The sampled
  `e2ee-qwen-2-5-7b-p` report contained an Intel quote, GPU evidence, signing
  identity and an echoed matching nonce. Its `verified: true` is a server claim.
  The live response includes a nested `attestation`, an API version and a workload
  keyset digest; adapters must inspect this actual format instead of assuming the
  simplified documentation example is complete.
- NEAR: 57 catalog entries, 9 vLLM entries advertising attestation. A report for
  `Qwen/Qwen3.6-35B-A3B-FP8` returned separate gateway and model evidence, with
  Intel quotes, event logs and echoed matching nonces; the model also had GPU
  evidence. Initial reconnaissance did not verify quotes. CPU verification results from the
  subsequent implementation are recorded below; TLS and response binding remain open.

NEAR documents independent gateway, model, TLS, response and software checks.
Its connection binding requires the actual peer certificate and report from the
same TLS connection; inference on a new connection needs fresh binding. Gateway
evidence cannot substitute for model evidence. See the [gateway guide](https://docs.near.ai/cloud/verification/cloud-api),
[gateway attestation](https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation)
and [TLS binding](https://docs.near.ai/cloud/verification/cloud-api/tls).

Venice documents separate TEE and E2EE protocols. Its E2EE guide currently lists
function calling and file uploads as unsupported; its sample encrypts user/system
messages only. Agent compatibility and coverage of tool results, assistant history,
reasoning and schemas must be demonstrated before advertising whole-conversation
E2EE. A model identifier containing `e2ee` does not establish that the client used
encryption. See [Venice's protocol and limitations](https://docs.venice.ai/guides/features/tee-e2ee-models).

### Qualification results (2026-10-06)

The installed verifier validated a Venice `e2ee-qwen-2-5-7b-p` CPU quote with
`UpToDate` status. NEAR's Qwen 3.6 gateway and model CPU quotes validated but
returned `OutOfDate` and INTEL-SA-01192/01245/01312/01313 advisories. A later Venice
`e2ee-qwen3-6-35b-a3b` sample also returned those advisories. These are observations
of those endpoints at that time, not a blanket verdict on either provider.
Tampered quotes and collateral checked beyond their validity were rejected.

Six synthetic, capped requests through the real installed Pi runtime and the
configured keys recorded one attempt for each role/provider combination. Their
64-token caps were consumed before visible answer text; this qualifies transport
accounting, not task completion or E2EE/tool-call compatibility. Venice currently
labels the sampled `e2ee-qwen3-6-35b-a3b` as `private` while advertising attestation;
its name alone must not imply client encryption. No E2EE protocol was used.

Unit coverage includes real Pi stream/completion transports with mocked HTTP,
main/helper/classifier ownership, bounded records, invalid evidence, cancellation,
real SQLite reopen/migration, and history gaps. A disposable Electron profile
verified the panel in both themes, Escape/focus and a 760×560 window. Linux/Windows
and packaged-worker qualification remain open.

## Dependency review

Do not implement Intel quote cryptography from scratch or trust a provider's
`verified` boolean. The approved dependency is an exact pin of
`@phala/dcap-qvl@0.6.5`. Public npm metadata reports Apache-2.0, about
134 KB unpacked for the package itself, plus eight direct dependencies. It is a
JavaScript verifier suitable for a main-process-owned worker, avoiding UI stalls.
Existing Node crypto/ethers can support remaining protocol operations; assess
those separately rather than adding a full provider SDK by default.

Do **not** adopt the `@phala/dcap-qvl-node@0.3.3` dependency currently used by
NEAR's example verifier. The published Node/WebAssembly packages have no patched
release for [CVE-2026-22696](https://github.com/Phala-Network/dcap-qvl/security/advisories/GHSA-796p-j2gh-9m2q).
Upstream recommends the JavaScript package. The JS package also had a separate
[CRL verification flaw, fixed in 0.5.3](https://github.com/Phala-Network/dcap-qvl/security/advisories/GHSA-2cjj-h43h-m6xj).
The installed version is beyond both published JS affected ranges; that is not a
claim of an independent security audit. Review its actual installed dependency
tree and retain invalid quote/collateral regression coverage.

The installed tree reports a low-severity transitive `elliptic` advisory,
[CVE-2025-14505](https://github.com/advisories/GHSA-848j-6mx2-7j84), concerning
signature generation and private-key exposure. This worker performs verification
of public evidence only and receives no private signing keys. `elliptic@6.6.1`
already existed in the lockfile. Do not apply npm's suggested downgrade of the
verifier to 0.2.0: that would reintroduce the known critical verification issue.
This bounded use assessment is not an independent audit of the dependency.

## Implementation stages

1. **Evidence model and provider metadata.** Preserve advertised TEE/E2EE
   capabilities independently from verification. Define bounded, versioned
   request receipts with provider, model, request role, check results, timestamps,
   verifier/policy versions and public evidence identifiers. Missing metadata is
   unknown. Never store keys, prompts or response bodies in privacy receipts.
2. **Attestation engine.** Validate Intel trust chains, revocation, time and TCB
   status; NVIDIA evidence and signer bindings; nonce freshness, debug mode,
   measured configuration and event logs. Establish explicit accepted workload
   and source-provenance policy. Hardware validity alone does not establish that
   the loaded software respects privacy. Keep unknown/advisory states explicit.
3. **Request-path integration.** Start with NEAR's documented gateway flow.
   Bind actual inference connections, canonical model routing and exact response
   bytes to preflight evidence. Reverify after reconnection and signer rotation.
   Add Venice's provider-specific evidence/signature adapter with clearly stated
   proxy visibility. Intercept shared inference transport so main Agent, helpers,
   compaction and classifiers cannot escape coverage. Do not release unverified
   tool calls for execution when verified-response enforcement is selected.
4. **Session shield and history.** A small header button opens a concise detail
   panel using existing popover/accessibility patterns. Aggregate actual request
   receipts, not just the selected model. Persist bounded summaries with session
   history and preserve mixed/unknown coverage across reopen and compaction.
   Later success must not upgrade earlier unverified requests. Distinguish current
   readiness from historical checks that passed when a request was made.
5. **E2EE qualification.** Exercise protocol support with synthetic tool-call
   round trips, attachments and streaming. Encrypt before sending any sensitive
   context; verify key binding before encryption. Where Agent payloads are not
   supported, report that limitation rather than silently sending plaintext.
   Do not assume a text-only encryption demonstration covers Agent workflows.

Ordinary provider connections retain their existing behavior and display actual
coverage. Existing TEE-only catalog filtering remains a provider-claim filter;
do not silently redefine it as independent verification. An explicit requirement
for verified inference must stop before sending content if its preflight checks
fail, and must never silently switch to an unverified route. A post-response
failure is recorded as such; it cannot retroactively protect a request already sent.

## Architecture and validation

Verification, credentials, sockets and evidence ownership belong in `src/main/agent/`.
The renderer receives only normalized public summaries through existing Agent
state/events where possible. History persistence owns retention and migration.
Any new IPC surface requires the existing chrome-only sender policy and tests.
No top-level responsibility moves are planned.

Acceptance checks include altered/expired quotes and collateral, replayed nonces,
wrong signers, TLS reconnection, unexpected model routing, missing GPU evidence,
response hash mismatches, unsupported encryption fields, aborted streams, helper
and classifier coverage, mixed sessions, restart/compaction, and no secret-bearing
logs. Add bounded live tests with synthetic prompts using the already connected
providers. Qualify dependency packaging on macOS and CI on Linux/Windows, and
verify the shield in both themes with keyboard and screen-reader semantics.

## Tracking

- [x] Create the experimental branch and inspect existing provider/runtime boundaries.
- [x] Confirm both configured providers return catalog and fresh attestation reports.
- [x] Identify protocol limits and reject the vulnerable reference dependency.
- [x] Obtain approval and install the pinned verification dependency.
- [x] Implement CPU endpoint checks, role/destination accounting, session shield and bounded history.
- [x] Simplify the shield and implement NEAR same-connection and exact-response signature checks.
- [ ] Complete GPU/software checks, Venice proxy binding and E2EE; keep unsupported paths explicit.
- [ ] Review claims and enforcement before integrating into the feature branch.


## Active protections (2026-10-06)

OpenRouter conversations default to **Require zero data retention**. The shield
can turn this off for future requests in that conversation; the value persists
across reopening. The old connection-level control is hidden in setup. At Pi's
actual fetch boundary all Agent, helper, permission and context-management
requests enforce `provider.zdr=true`, `data_collection=deny`, parameter support,
and no server plugins or alternate-model routing. Opting out cannot override
OpenRouter account/guardrail enforcement. Routes retain their actual historical
requirement, so toggles cannot relabel previous requests. A failed policy save
leaves the active requirement unchanged.

ZDR eligibility belongs to endpoints, not every deployment of a model. Requiring
ZDR can change availability, latency and effective price by excluding routes;
there is no separate ZDR token-price tier in the documented routing API.
OpenRouter passes through the chosen provider's inference price. Account-level
prompt logging remains a separate OpenRouter setting. In-memory implicit prompt
caching is allowed by OpenRouter's definition of ZDR. Provider policies are not
cryptographic guarantees and do not cover Freedom's browser/MCP activity.

NEAR's attested Chat Completions routes now use its documented ECDSA E2EE
protocol, including `X-Encrypt-All-Fields`: all message roles and multimodal
content arrays, reasoning, tool definitions/schema, calls, arguments and tool
results. Client keys are per request and not persisted. Every returned model
key is bound to its independently checked CPU signing address before selecting
one. Accepted TCB states for encryption are UpToDate and OutOfDate; the latter
remains an explicit hardware advisory, matching the provider SDK's default
acceptance policy. Other states, invalid evidence and unavailable keys block
content submission. This does not establish GPU or approved software integrity.
Routing metadata and JSON fields outside the protocol's encryption set remain
visible; it is not encryption of the whole HTTP payload.

The shared ECDSA format uses secp256k1 ECDH, HKDF-SHA256 and AES-256-GCM. Ethers'
existing SigningKey performs curve operations (Electron BoringSSL does not
expose secp256k1); native crypto performs HKDF and AES. No dependency was added.
NEAR pins the raw 64-byte model key; Venice expects the uncompressed 65-byte
form. Streams are decrypted record by record with backpressure and bounded
buffering. Plaintext substituted for encrypted response content or a modified
GCM tag fails authentication. Signature checks hash ciphertext wire bytes,
before any JSON transformation. A pre-send verification failure returns an
explicit non-retryable privacy error rather than silently submitting plaintext.

Venice E2EE is used for streaming text requests, including prior assistant
replies (verified against the live endpoint; all message content is encrypted).
When optional tool definitions are present, an encrypted answering step lets
the same model answer ordinary messages or explicitly hand off to the original
native tool workflow. Tool definitions alone therefore no longer disable E2EE.
Pi text-part arrays are normalized to text before checking eligibility; actual
image/file parts retain their original HTTPS fallback and attachment reason.
The full AgentSession path (browser tools, skills and codemode enabled) is covered
by a local transport regression, alongside live synthetic text-part requests.
The first step streams ordinary answers after inspecting their initial text;
it does not buffer whole answers. A handoff must be complete and authenticated.
The encrypted step and subsequent tool request are counted separately.

Actual tool use/history, attachments, forced tool calls and non-streaming
output follow the user's authorized HTTPS-only fallback. The shield records
these reasons and warns that such requests can include previous chat history.
Encryption/verification failures and incomplete handoffs do not trigger this
fallback. Tool permissions and execution remain in the normal Agent workflow.
Older Venice catalogs refresh missing encryption capabilities automatically;
if an attested model's capabilities cannot be refreshed, resolution stops
instead of silently submitting messages without encryption. The model name
never selects protection.

Live synthetic tests through the real Pi runtime passed on NEAR
`Qwen/Qwen3.6-35B-A3B-FP8` (text, tool call, subsequent tool-result/history request,
checked connection and model signatures), and Venice `e2ee-qwen3-8-27b` (encrypted
text plus the disclosed tool fallback). No real conversation content or API keys
were printed; configured provider settings were not changed. Dark/light shield,
ZDR toggle, mixed coverage, Escape and a bounded 760×560 panel were exercised in
a disposable Electron profile. Linux screenshot/WCAG baselines and packaged
cross-platform checks remain open.

Additional protocol sources:
- [OpenRouter per-request ZDR](https://openrouter.ai/docs/guides/features/zdr)
- [OpenRouter provider routing/prices](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter pricing FAQ](https://openrouter.ai/docs/faq)
- [NEAR E2EE, including the ECDSA protocol](https://docs.near.ai/cloud/guides/e2ee-chat-completions)
- [NEAR SDK field handling](https://github.com/nearai/inference-sdk/blob/main/js/src/core/e2ee-chat.ts)
