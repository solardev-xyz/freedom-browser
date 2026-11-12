/**
 * Names over IPNS, for main (freedom-core design 0011, "Names over IPNS").
 *
 * A DNS name with an ENS contenthash (`example.com`) loads as
 * `ipns://<key>`, so its committed URL carries the key, not the name. The
 * chrome keys such a page on its name (`applyDnsNameIdentity`, from
 * `state.knownEnsNames`), and main, which now answers pages' requests
 * itself, needs the same name: before the tab loads `ipns://<key>`, the
 * chrome holds the name for the tab's next commit in main
 * (`page:bind-name`). Main takes it only if that commit is on exactly that
 * key and its own resolution of the name answers the key; this decides
 * nothing by itself.
 */

import { applyDnsNameIdentity } from './url-utils.js';
import { state } from './state.js';

/**
 * Bind the name the chrome would key `url` on, if it is a DNS name over
 * IPNS, for `webview`'s next commit. Returns whether it asked main.
 *
 * @param {HTMLElement} webview - the tab's webview
 * @param {string} url - the main-frame URL about to load
 * @param {Map} [knownEnsNames] - hash/CID/key -> name
 */
export function bindPageNameForLoad(webview, url, knownEnsNames) {
  // Best effort: a binding that fails leaves the page keyed on
  // `ipns://<key>` in main, and never stops the load.
  try {
    if (typeof url !== 'string' || !/^ipns:\/\//i.test(url)) return false;
    const identity = applyDnsNameIdentity(url, knownEnsNames ?? state.knownEnsNames);
    const name = /^ens:\/\/([^/?#]+)/.exec(identity || '')?.[1];
    if (!name) return false;
    // The key as the commit will carry it: this renderer parses the scheme
    // as the guest's does.
    const parsed = new URL(url);
    if (parsed.protocol !== 'ipns:' || !parsed.hostname) return false;
    const guest = webview?.getWebContentsId?.();
    if (!Number.isInteger(guest) || typeof window.electronAPI?.bindPageName !== 'function') return false;
    window.electronAPI.bindPageName(guest, name, parsed.hostname);
    return true;
  } catch {
    return false;
  }
}
