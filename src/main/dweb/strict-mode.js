/**
 * Strict mode (freedom-core design 0009, "Strict mode"; decision 2): the
 * profile's "Load only verified content from external nodes", off by
 * default, in Settings → Nodes beside the nodes' "Verify content from this
 * node".
 *
 * With it on, every request to an external backend whose content would be
 * `unverified` is refused with a 403 that says why: a DNSLink name, an IPNS
 * name with an inlined key other than Ed25519, an encrypted Swarm
 * reference, and anything from a node whose verification is off or from a
 * gateway the probe found without raw blocks. Verified and
 * `latest_asserted` content still loads, and the bundled nodes, whose
 * content is `node_asserted`, are untouched.
 *
 * The core decides it from the plan: main sends `strict: true` in the
 * reference of an external backend it captures (`bzz-protocol.js`'s
 * `antBackend`, `ipfs-manager.js`'s `ipfsBackend`), only while the core's
 * verifier is attached (protocol 2), as with `verify`. The setting is read
 * when the backend is captured, at admission, so a change applies to the
 * requests admitted after it (design 0006, Binding).
 *
 * It is kept in the profile's settings (`settings.json` in the profile's own
 * data directory), and only Settings (or the chrome) may write it over
 * `settings:save` (`ipc-sender-policy.js`): turning it off is a downgrade.
 */

const { loadSettings } = require('../settings-store');

/** The setting's key in the profile's settings. */
const STRICT_MODE_SETTING = 'loadOnlyVerifiedContent';

/** Whether the profile loads only verified content from external nodes:
 * on only when the stored value is `true`. */
function loadsOnlyVerifiedContent() {
  return loadSettings()?.[STRICT_MODE_SETTING] === true;
}

module.exports = { loadsOnlyVerifiedContent, STRICT_MODE_SETTING };
