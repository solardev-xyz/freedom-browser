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
const crypto = require('crypto');

const PENDING_FILE = 'safe-pending.json';

let cache = null;

function getFilePath() {
  return path.join(app.getPath('userData'), PENDING_FILE);
}

function load() {
  if (cache !== null) {
    return cache;
  }
  const filePath = getFilePath();
  if (!fs.existsSync(filePath)) {
    cache = {};
    return cache;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    cache = JSON.parse(raw);
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      throw new Error('Pending store root must be an object');
    }
  } catch (err) {
    console.error('[SafePending] Failed to load pending store:', err);
    try {
      const corruptPath = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, corruptPath);
      console.warn(`[SafePending] Moved unreadable pending store aside to ${corruptPath}`);
    } catch (moveErr) {
      console.error('[SafePending] Failed to move corrupted pending store aside:', moveErr);
    }
    cache = {};
  }
  return cache;
}

function save() {
  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  const body = JSON.stringify(cache || {}, null, 2);
  const temporary = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, filePath);
  } catch (err) {
    console.error('[SafePending] Failed to save pending store:', err);
    try {
      if (fs.existsSync(temporary)) {
        fs.unlinkSync(temporary);
      }
    } catch {
      // Preserve original storage failure
    }
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

function _resetForTests() {
  cache = null;
}

module.exports = {
  getPending,
  setPending,
  clearPending,
  listPendingIndexes,
  _resetForTests,
};
