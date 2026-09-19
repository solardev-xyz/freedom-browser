# WebMCP in Freedom Agent

Freedom Agent can discover and invoke tools registered by the **currently loaded top-level page**. This includes JavaScript registrations and native declarative forms. Sites without usable WebMCP tools continue to work through semantic browser actions and visual fallback. No additional model provider, MCP server, extension or dependency is required.

## Runtime

The implementation is qualified on Electron **44.3.0 / Chromium 152.0.7977.78**. Startup enables the targeted `WebMCP,WebMCPTesting` Blink features before creating pages; a running app must be restarted. The lockfile already pinned this Electron version; refreshing the local installation did not change package manifests or the lockfile.

This runtime exposes `document.modelContext.getTools()` and `executeTool()` in the isolated automation world. Its input schemas and invocation arguments use JSON text. Freedom does not invoke a website's main-world polyfill and never retries a call using another API signature. The evolving specification now describes object arguments; a future Electron upgrade needs native contract qualification before changing the adapter.

## Agent workflow

1. `browser_list_page_tools` returns bounded, untrusted descriptions and schemas with opaque `toolRef` values. A snapshot also indicates native API availability; that flag alone does not mean the page registered tools.
2. `browser_call_page_tool` takes a discovered reference and an `arguments` object. Freedom validates supported schema constraints, then requests approval showing the site, tool name and exact arguments. Every invocation requires approval, including tools claiming to be read-only and sessions allowing ordinary website interactions.
3. `completed` means the website returned a result. Agent should inspect the visible result before claiming the task succeeded. A returned object can itself describe a website-level error.
4. `awaiting_user` means the native form still requires manual submission. Agent must wait for the user, rather than submitting through another tool. A subsequent discovery reads the last execution result without invoking again.
5. Stop requests native cancellation. Timeouts, callback failures, document replacement and cancellation do not imply rollback. Inspect before retrying; there is no automatic invocation retry.

References expire after rediscovery, observable registration changes, navigation and Stop. Same-document SPA routing invalidates references while allowing an existing native invocation to return its result. Cross-document navigation conservatively produces `outcome_unknown`; the new page must be inspected.

Discovery uses the native `RegisteredTool.window` identity to exclude embedded frames. Calls stay inside the canonical automation controller, task ownership and origin checks, existing run/cancellation path, and wallet/provider approval barrier. Page tools cannot introduce arbitrary main-world JavaScript, host filesystem paths, privileged IPC, or new model tools.

The approval binds the observed tool, document and exact input. It does **not** audit or pin the website's JavaScript implementation. Chromium dispatches a live website tool; its code and hidden effects remain untrusted even when its metadata has not changed. Annotations never grant authority.

## Bounds and compatibility

- Discovery examines at most 1,024 native registrations, considers at most 64 top-level tools, and returns at most 65,536 serialized descriptor characters. Each schema is limited to 16,384 characters and each description to 2,000. Omission is explicit through `truncated` and `unsupportedSchemas`.
- Arguments are JSON objects, limited to 8,192 characters, 2,048 values and 32 levels. No coercion occurs.
- The interpreted schema subset supports types, object properties/required/additional properties, array items/uniqueness, enums/constants, numeric/string/array/object bounds, unions and negation. Fixed-width anchored patterns support codes such as `^[A-Z]{3}$`. `format` is an annotation, not an assertion. Remote/local `$ref`, arbitrary regexes and other unsupported constraints omit that tool rather than silently bypassing validation. No schema generates code or fetches another resource.
- Results are limited to 32,768 characters with `outputTruncated`. Website exception bodies are not propagated; errors use a bounded category.
- Page-bridge calls have a three-second response deadline. Normal execution has a 30-second budget; a manual form can wait up to five minutes. Only discovery races are retried, up to three times.
- The pinned native runtime acknowledges cancellation of the caller's promise but does **not** pass an abort signal into the website callback. Website work may continue. `cancellationAcknowledged` is not evidence of rollback or callback termination.
- The current list reports the latest execution for that page adapter, not a persistent job history. Completed receipts remain in the ordinary agent activity/evidence flow.

## Qualification and smoke tests

On 2026-09-19, the user reported that the manual Pizza maker smoke test through Freedom Agent worked successfully.

Run deterministic tests without any model account:

```sh
npm test -- -- --runInBand src/main/automation src/main/agent/pi-browser-tools.test.js src/main/agent/agent-progress.test.js src/main/agent/freedom-agent-service.test.js src/renderer/lib/agent-ui.test.js
npm run test:e2e -- test-e2e/automation-page-tools.spec.js test-e2e/automation-native-dialog.spec.js
npm run lint
```

Native fixtures cover visible and hidden pages, both form modes, exact approval and denial, Stop and navigation during approval, wrong argument types, unchanged-metadata registration replacement, main-world API poisoning, iframe exclusion, callback errors, cancellation acknowledgement, cross-document navigation and SPA results. Unit tests additionally cover schema/output limits, unknown schemas, declined-call rediscovery, task custody loss and the external approval barrier.

Final local verification on 2026-09-18: nine WebMCP Electron tests passed; nine existing native-dialog regression tests passed; lint and diff whitespace checks passed. The installed Pi SDK constructed and executed both tools against a fixture controller, preserving structured arguments without a model request. The full unit suite passed 6,294 tests with 72 skipped and four previously reproduced baseline failures: two platform-dependent shortcut expectations in `settings-store.test.js`, the Linux owner expectation in `bubblewrap-backend.test.js` on macOS, and the wallet-record send case in `safe-fork.test.js`. The broader run also exposed a large-image validation regexp stack overflow; image size is now checked first and base64 is scanned without that repeated regexp.

Public Google demos were exercised on **2026-09-18**, using disposable profiles and the real native adapter, without a model or production accounts:

| Demo                                                                                       | Observed result                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Pizza maker](https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/)          | Seven tools discovered; adding two mushroom toppings returned a native result.                                                                                                            |
| [Flight search](https://googlechromelabs.github.io/webmcp-tools/demos/react-flightsearch/) | Search accepted LHR → JFK with fixed-width IATA validation; returned a result across SPA navigation; discovery then exposed `listFlights`, `resetFilters`, `searchFlights`, `setFilters`. |
| [French bistro](https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/)      | Native form discovered and filled with fictitious test values; returned `awaiting_user`. The probe cancelled it without submitting.                                                       |
| [Doors](https://googlechromelabs.github.io/webmcp-tools/demos/doors/)                      | Three tools discovered; opening a door navigated to the forest document and returned `outcome_unknown`, without replaying the action.                                                     |

For a manual Agent smoke test, restart Freedom, open pizza maker, and ask: “Use the site's tools to add two mushrooms to a medium pizza.” Check that approval names the tool and arguments, then verify the pizza changed. Decline a second action and confirm it does not run. In the bistro demo, ask Agent to fill the form using fictitious details: submission must remain yours. These are demo checks, not qualification of arbitrary real-world purchases or reservations.

References: [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp), [declarative API](https://developer.chrome.com/docs/ai/webmcp/declarative-api), [Community Group specification](https://webmachinelearning.github.io/webmcp/), [Google demos source](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/demos). Initial source review used demo revision `0edcbac8c6f769cdf5d52d42e8375c44d3077329`; live hosted pages may advance independently.

Remaining qualification includes Windows/Linux, frame-scoped WebMCP, additional schema dialects and future Chromium API changes. This is not a claim of complete WebMCP conformance.
