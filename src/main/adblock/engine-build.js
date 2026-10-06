/**
 * The CPU-heavy half of an ad-block engine build (#512): read the enabled
 * filter lists, strip `trusted-*` scriptlets from the lists that may not use
 * them, compile everything with @ghostery's FiltersEngine.parse, load the
 * scriptlet resources and serialize the result.
 *
 * It runs in `engine-build-worker.js` so the parse — hundreds of
 * milliseconds for the bundled lists — happens off Electron's main thread;
 * service.js only deserializes the bytes (the same thing its engine cache
 * already does). If the worker can't run, `engine-build-host.js` calls this
 * same function on the main thread instead, so the engine a frame gets is
 * the same either way.
 *
 * Plain data in, plain data out: no Electron, no logger (a worker has
 * neither), so problems come back as `warnings` for the caller to log.
 */

const fs = require('fs');
const { FiltersEngine } = require('@ghostery/adblocker');

// A `+js(...)` injection rule (not an `#@#` exception), capturing the
// scriptlet name.
const SCRIPTLET_RULE_RE = /^[^\n]*?#[$?]?#\+js\(\s*([^,)\s]+)[^\n]*$/gm;

/**
 * Drop the rules of `text` that invoke a trust-requiring scriptlet. Anything
 * named `trusted-*` counts even if the resources file doesn't list it, so a
 * newer list can't slip one past an older resources file.
 */
function stripTrustedScriptlets(text, trustedNames) {
  if (!text.includes('+js(')) return text;
  return text.replace(SCRIPTLET_RULE_RE, (line, name) =>
    name.startsWith('trusted-') || trustedNames.has(name) ? '' : line
  );
}

/**
 * @param {object} job
 * @param {Array<{category: string, path: string, trusted: boolean}>} job.lists
 *   Enabled lists, in build order. `trusted` lists keep their `trusted-*`
 *   scriptlet rules; every other list loses them.
 * @param {string[]} [job.trustedNames] Trust-requiring scriptlet names from
 *   the resources file (see service.js trustedScriptletNames).
 * @param {{text: string, checksum: string}|null} [job.resources]
 * @param {object} job.config FiltersEngine.parse options.
 * @returns {Promise<{bytes: Uint8Array|null, warnings: string[]}>} `bytes`
 *   is null when no enabled list could be read.
 */
async function buildSerializedEngine({ lists, trustedNames = [], resources = null, config }) {
  const warnings = [];
  const trusted = new Set(trustedNames);
  const texts = [];
  for (const list of lists) {
    try {
      const text = await fs.promises.readFile(list.path, 'utf-8');
      texts.push(list.trusted ? text : stripTrustedScriptlets(text, trusted));
    } catch (err) {
      // A bad list disables that category, never the whole feature.
      warnings.push(`skipping unreadable list '${list.category}': ${err.message}`);
    }
  }
  if (texts.length === 0) return { bytes: null, warnings };
  const engine = FiltersEngine.parse(texts.join('\n'), config);
  if (resources) engine.updateResources(resources.text, resources.checksum);
  return { bytes: engine.serialize(), warnings };
}

module.exports = { buildSerializedEngine, stripTrustedScriptlets };
