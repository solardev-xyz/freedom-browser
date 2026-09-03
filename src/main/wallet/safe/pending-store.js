/**
 * Pending SafeTx store — the half-signed transaction that survives a
 * restart, as interim JSON (same posture as the other wallet JSON
 * stores; migrates into the unified wallet-history SQLite later).
 *
 * One pending SafeTx per Safe at a time, by design (research doc B.4):
 * a single slot sidesteps the nonce-replacement/ordering swamp that
 * Safe's hosted service exists to manage. Collected signatures are just
 * bytes — safe to persist, useless without the Safe and its chain state.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const PENDING_FILE = 'safe-pending.json';

let cache = null;

function getFilePath() {
  return path.join(app.getPath('userData'), PENDING_FILE);
}

function load() {
  if (cache !== null) {
    return cache;
  }
  try {
    cache = fs.existsSync(getFilePath())
      ? JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'))
      : {};
  } catch (err) {
    console.error('[SafePending] Failed to load pending store:', err);
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(getFilePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[SafePending] Failed to save pending store:', err);
  }
}

/** @returns {Object|null} The pending entry for a safe wallet index */
function getPending(safeIndex) {
  return load()[safeIndex] || null;
}

function setPending(safeIndex, entry) {
  load()[safeIndex] = entry;
  save();
}

function clearPending(safeIndex) {
  const store = load();
  if (safeIndex in store) {
    delete store[safeIndex];
    save();
  }
}

/** Safe wallet indexes that currently have a pending SafeTx. */
function listPendingIndexes() {
  return Object.keys(load()).map(Number);
}

module.exports = { getPending, setPending, clearPending, listPendingIndexes };
