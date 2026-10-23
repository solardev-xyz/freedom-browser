'use strict';

// Chromium's native WebMCP (`document.modelContext`) is experimental in the
// pinned Electron runtime, and only Freedom Agent's page tools use it. With AI
// off nothing in Freedom reads it, so exposing it to every page would only add
// experimental attack surface and a fingerprint. `WebMCPTesting` is not needed:
// `WebMCP` alone exposes getTools()/executeTool()/registerTool() and the
// declarative form tools the adapter uses (Electron 44.3.0).
//
// Blink features are a process-wide command-line switch that has to be set
// before the first renderer starts, so the decision is the stored choice at
// launch: AI turned on later gets page tools from the next start (until then
// discovery reports them unavailable), and the switch cannot exclude private
// windows.
function webMcpBlinkFeatures(settings) {
  return settings?.enableAi === true ? 'WebMCP' : null;
}

// What this launch actually decided, so page-tool discovery can say "restart
// Freedom" instead of a bare available=false when AI was turned on after
// launch (#803). null until main/index.js records it (tests, other hosts).
let enabledAtLaunch = null;

function recordWebMcpLaunch(features) {
  enabledAtLaunch = Boolean(features);
}

function webMcpEnabledAtLaunch() {
  return enabledAtLaunch;
}

module.exports = { webMcpBlinkFeatures, recordWebMcpLaunch, webMcpEnabledAtLaunch };
