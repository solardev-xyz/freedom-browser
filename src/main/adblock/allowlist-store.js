/**
 * Persistent per-site adblock allowlist: hosts whose pages bypass the
 * filter engine entirely (subdomain-aware, see request-classifier).
 * JSON-per-profile storage in userData, same shape as the other
 * per-origin stores (dapp-permissions.json, swarm-permissions.json).
 *
 * Mutations persist AND re-sync the live service themselves — the same
 * owns-its-side-effect shape as settings-store's refreshEngine trigger —
 * so no caller can leave the persisted file and the live engine bypass
 * out of step.
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { normalizeHost } = require('./request-classifier');

const ALLOWLIST_FILE = 'adblock-allowlist.json';

let cachedHosts = null;

function getAllowlistPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), ALLOWLIST_FILE);
}

function loadHosts() {
  if (cachedHosts) return cachedHosts;
  try {
    const raw = fs.readFileSync(getAllowlistPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
    cachedHosts = [...new Set(hosts.map(normalizeHost).filter(Boolean))];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`[adblock] failed to load allowlist: ${err.message}`);
    }
    cachedHosts = [];
  }
  return cachedHosts;
}

function saveHosts() {
  try {
    fs.writeFileSync(getAllowlistPath(), JSON.stringify({ hosts: cachedHosts }, null, 2), 'utf-8');
  } catch (err) {
    log.error(`[adblock] failed to save allowlist: ${err.message}`);
  }
}

// Lazy require — the service requires this module back at load time.
function syncService() {
  require('./service').setAllowlistedHosts(cachedHosts);
}

function getAllowlistedHosts() {
  return [...loadHosts()];
}

/** @returns {boolean} true if the host is valid (already present counts). */
function addAllowlistedHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  const hosts = loadHosts();
  if (!hosts.includes(normalized)) {
    hosts.push(normalized);
    saveHosts();
    syncService();
  }
  return true;
}

/** @returns {boolean} true if the host was present and removed. */
function removeAllowlistedHost(host) {
  const normalized = normalizeHost(host);
  const hosts = loadHosts();
  const index = hosts.indexOf(normalized);
  if (index === -1) return false;
  hosts.splice(index, 1);
  saveHosts();
  syncService();
  return true;
}

/** Test-only: clear the in-memory cache. */
function _resetAllowlistForTests() {
  cachedHosts = null;
}

module.exports = {
  getAllowlistedHosts,
  addAllowlistedHost,
  removeAllowlistedHost,
  _resetAllowlistForTests,
};
