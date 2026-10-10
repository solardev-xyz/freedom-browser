# Custom OpenAI-compatible provider spike

Branch: `experiment/agent-openai-compatible`.
Date: 2026-10-10. Base: `feature/freedom-automation-kernel` at `f5a41b99`.

## Result

The user-supplied `https://vibing.at/clankyou/v1` endpoint works with the installed
Pi 1.0.2 `openai-completions` transport without endpoint-specific compatibility
flags. A Freedom isolated session and a Freedom codemode session each performed
one synthetic tool call and used its returned value. The initial feasibility spike
was followed by the implementation below on the same experimental branch.

Only synthetic prompts and tool results were sent. No real browser pages, project
files or conversation history were supplied. The user-provided key was delivered
through hidden stdin, held in process memory and not written to source or reports.

## Observations

| Check | Observed result |
| --- | --- |
| Unauthenticated `GET /models` | HTTP 401 with an OpenAI-shaped authentication error |
| Authenticated `GET /models` | HTTP 200, `object: list`, eight model IDs |
| Model IDs | `auto`, `fast`, `smart`, `best`, `fable`, `opus`, `sonnet`, `haiku` |
| Non-streaming Chat Completions | HTTP 200; requested synthetic answer returned |
| Streaming Chat Completions | SSE text deltas, `finish_reason: stop`, usage chunk and `[DONE]` |
| Selected `fast` model | Response identifies `claude-haiku-4-5-20251001` |
| Forced function call | Correct function name, JSON arguments, call ID and `tool_calls` finish reason |
| Function result replay | Random value returned through a `role: tool` message appeared in the final answer |
| JSON-schema response format | One conflicting-prompt probe returned the requested schema-conforming object |
| Unknown model | HTTP 400, no successful silent fallback observed |
| Pi default transport | Correct answer; no provider-specific compatibility overrides |
| Pi cancellation | `stopReason: aborted` after caller cancellation |
| Freedom isolated tool session | Exactly one synthetic tool execution; result used in the answer |
| Freedom codemode session | Exactly one synthetic tool execution through codemode; result used in the answer |

Successful short chat requests took roughly 2–4 seconds in these probes. These are
single-machine observations, not performance guarantees. The schema check is
evidence for this endpoint/model only, not a general capability of compatible APIs.

## Compatibility limits and quirks

- A non-streaming request with `max_tokens: 64` returned HTTP 502, reporting that
  the underlying Claude response exceeded its output-token maximum. It did not
  return a normal length-truncated completion. The same short prompt succeeded
  with a 2,048-token limit. A 64-token streaming probe did return an answer whose
  reported completion usage exceeded 64 tokens. Small output-limit behavior is
  therefore inconsistent across the two paths; this is a gateway observation,
  not a reason to apply a global Freedom workaround.
- Responses include a nonstandard `reasoning` field, which the installed Pi
  transport already understands. Reports omit the reasoning text.
- One manually constructed tool-history replay added unsolicited commentary; the
  automated replay using an actual returned call and random result succeeded.
  Tool replay should be qualified further during full integration.
- The catalogue supplies IDs and ownership metadata, not context sizes, output
  limits, image/tool capability declarations, pricing or privacy guarantees.
  Do not infer these from aliases such as `best` or `opus`.
- The probe's 32K context and 2,048 output-token model descriptor are explicit
  test configuration, not discovered endpoint limits. Zero cost metadata is a
  Pi descriptor placeholder, not a claim that usage is free.
- Cancellation confirms that Freedom/Pi stops waiting. It does not prove that
  the gateway stopped upstream generation or billing.
- Other aliases, image inputs, multiple simultaneous tool calls, live permission
  classification, large contexts, sustained concurrency, Responses API and
  cross-platform UI qualification were not tested.

## Reproduction

`scripts/spike-openai-compatible.js` reads a single JSON object from stdin with
`baseUrl`, `apiKey` and `model` fields. Supply it through a secret-aware launcher
or hidden stdin; do not put a real key in a committed fixture or shell command.
It emits JSON summaries, never credentials or full provider error payloads.
Running it makes a small set of real inference requests. It is not a CI test.

The original probe uses in-memory runtime and credential/model stores.
Set `phase: "production"` to exercise Freedom's production connection resolver,
discovery, synthetic connection test and a codemode session instead. That phase
also keeps the supplied credential in memory. No dependencies were added.

## Implemented connection flow

Choose **Models → Add provider → OpenAI-compatible**, enter a connection name,
API base URL (including `/v1` or any proxy prefix) and optional API key. Leave model
IDs empty to discover them through `GET /models`, or enter IDs manually when
discovery is unavailable. Connections appear independently in the normal model
picker and support favourites, refresh, selection and disconnect.

- Credentials use Freedom's existing encrypted, profile-bound store. Keyless
  connections also work when secure credential storage is unavailable.
- Chat Completions is the supported protocol. Responses-only servers, custom
  authentication/header schemes and provider-specific extensions are not covered.
- Discovery accepts model IDs only. Model limits default to 32,768 context and
  4,096 output tokens; these are estimates, not discovered limits. Under
  **Details & connection settings**, select a model to configure its limits and
  declared image, reasoning-control and strict JSON-schema support. Optional
  capabilities start off. The schema setting enables schema requests for Freedom's
  classifiers; the connection test does not certify those optional capabilities.
- Refresh preserves manual entries, existing settings, favourites and selection.
  Remove unwanted IDs through the saved connection's model list.
- After connecting, **Check compatibility** is offered prominently as an optional
  step. Saving/discovering models sends no inference requests. The check sends up
  to three small requests: streamed chat, a synthetic function call, and a random
  tool result. It uses no real browser or workspace tools and discloses possible
  token charges before running. Results identify the checked model and saved
  configuration; changing models/settings does not inherit another result.
  Partial failures identify streaming, tool calling or tool-result handling.
  Users can retry, select another model, or continue without checking/anyway.
  Results are transient, not a full-compliance certification.
- An endpoint cannot be changed after saving. Add a new connection to change it;
  existing conversations retain their original connection identity. Keys can be
  rotated or explicitly removed, and names/model settings remain editable. New
  requests check the current connection and key; removing a model or disconnecting
  blocks further requests through an already-created runtime. Requests already
  sent cannot be recalled.
- Only the configured `/models` and `/chat/completions` destinations receive the
  configured key; redirects are refused. Keyless requests carry no authorization
  header. HTTP is supported for local/LAN servers with a transport warning.
- Privacy reporting identifies the connection name and actual destination origin,
  with unknown retention/privacy guarantees and no implied TEE or E2EE.

## Implementation qualification

On macOS, an Electron fixture test covers setup, discovery, saved model settings,
the tool test, a streamed chat, privacy details, and two independent connections,
including a keyless/manual-model server. The changed setup and settings surfaces
were checked in both themes. Unit coverage includes credential isolation and
reload, immutable endpoints, secret-free public status, bounded storage writes,
untrusted catalogue metadata, redirect/destination restrictions and keyless auth.
`npm run lint` and the full unit suite pass (9,524 passed, 129 skipped); the
custom-provider Electron test also passes. Its optional-check coverage includes no
automatic inference, switching models during a check, partial failure, retry and
continuing despite failure. No dependencies were added.

The production resolver was then tested against the supplied endpoint with `fast`:
all eight IDs were discovered, the synthetic tool round trip passed, and an
isolated Freedom session dispatched `codemode` and `freedom_probe` exactly once,
using the returned random value. No real user files/pages/history were sent.

User smoke testing, native Windows/Linux UI checks and broader server compatibility
remain open. The earlier endpoint quirks and untested capabilities still apply.

Relevant local SDK documentation:
`node_modules/@earendil-works/pi-coding-agent/docs/models.md` and
`node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`.
