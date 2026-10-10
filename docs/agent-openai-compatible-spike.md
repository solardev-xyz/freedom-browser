# Custom OpenAI-compatible provider spike

Branch: `experiment/agent-openai-compatible`.
Date: 2026-10-10. Base: `feature/freedom-automation-kernel` at `f5a41b99`.

## Result

The user-supplied `https://vibing.at/clankyou/v1` endpoint works with the installed
Pi 1.0.2 `openai-completions` transport without endpoint-specific compatibility
flags. A Freedom isolated session and a Freedom codemode session each performed
one synthetic tool call and used its returned value. This establishes feasibility;
custom-provider setup, credential persistence and model-picker integration are
not implemented by this spike.

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

The runtime and credential/model stores are in memory. No dependencies or
production connection behavior changed. `npm run lint` passed.

## Next implementation

Add an app-owned custom connection with a stable ID, user-supplied label, base URL,
optional encrypted API key and discovered/manual models. Register it through Pi's
existing transport; keep endpoint selection and credentials in the main process.
The renderer should use the normal model catalogue rather than runtime internals.

Support multiple independent connections, preserve custom base paths, and offer
model capability/limit settings where discovery supplies no reliable metadata.
Use synthetic chat and tool probes for connection testing; keep optional features
such as structured output disabled until configured or verified. Identify the
actual endpoint in privacy reporting without implying retention, TEE or E2EE
guarantees. Existing conversations must not silently change destination when a
connection is edited. No automatic credential forwarding across redirects.

Relevant local SDK documentation:
`node_modules/@earendil-works/pi-coding-agent/docs/models.md` and
`node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`.
