/**
 * In-process repository fetch status tracker.
 *
 * The native clone call performs the seed policy update and fetch on libuv's
 * worker pool. This module keeps that promise out of IPC request lifetimes so
 * window.radicle can start a fetch without keeping an IPC request open.
 * Internal Freedom pages also receive each transition as it happens.
 */

const log = require('../logger');

const records = new Map();

function publish(record) {
  const status = publicStatus(record);
  for (const listener of record.listeners) {
    try {
      listener(status);
    } catch (err) {
      log.warn(`[seed-status] listener failed for ${record.rid}: ${err.message}`);
    }
  }
}

function publicStatus(record) {
  const status = {
    rid: record.rid,
    state: record.state,
    inStorage: record.state === 'fetched',
    seedersKnown: record.seedersKnown,
    attemptCount: record.attemptCount,
    recentAttempts: record.recentAttempts.map((attempt) => ({ ...attempt })),
    progress: record.progress ? { ...record.progress } : null,
    lastError: record.lastError,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
  if (record.done) {
    Object.defineProperty(status, 'done', { value: record.done, enumerable: false });
  }
  return status;
}

function startFetch(rid, { fetchRepo, getSeeders, onStatus }) {
  const existing = records.get(rid);
  if (existing?.state === 'fetching') {
    if (onStatus) existing.listeners.add(onStatus);
    const status = publicStatus(existing);
    if (onStatus) onStatus(status);
    return status;
  }

  const record = {
    rid,
    state: 'fetching',
    seedersKnown: existing?.seedersKnown ?? null,
    attemptCount: (existing?.attemptCount ?? 0) + 1,
    recentAttempts: [],
    progress: { phase: 'starting' },
    lastError: null,
    startedAt: Date.now(),
    finishedAt: null,
    cancelled: false,
    listeners: new Set(onStatus ? [onStatus] : []),
  };
  records.set(rid, record);
  publish(record);

  const onProgress = (progress) => {
    if (record.cancelled || records.get(rid) !== record || !progress?.phase) return;
    const previous = record.progress;
    record.progress = { ...progress };
    if (progress.phase === 'peer-failed') {
      record.recentAttempts.push({
        nid: progress.nid,
        ok: false,
        error: progress.reason,
        at: Date.now(),
      });
      record.recentAttempts = record.recentAttempts.slice(-5);
    }
    if (progress.phase === 'done' && previous?.nid) {
      record.recentAttempts.push({ nid: previous.nid, ok: true, at: Date.now() });
      record.recentAttempts = record.recentAttempts.slice(-5);
    }
    publish(record);
  };

  let fetchResult;
  try {
    // Invoke synchronously so the native task is registered before startFetch
    // returns. This minimizes the seed-then-immediate-unseed cancellation race.
    fetchResult = fetchRepo(rid, onProgress);
  } catch (err) {
    fetchResult = Promise.reject(err);
  }

  record.done = Promise.resolve(fetchResult)
    .then(async (result) => {
      if (record.cancelled || records.get(rid) !== record) return;
      if (result?.cancelled) {
        record.state = 'cancelled';
        record.progress = { phase: 'cancelled' };
        record.finishedAt = Date.now();
        publish(record);
        record.listeners.clear();
        return;
      }
      record.state = 'fetched';
      record.progress = { phase: 'done' };
      record.finishedAt = Date.now();
      if (getSeeders) {
        try {
          record.seedersKnown = await getSeeders(rid);
        } catch (err) {
          log.warn(`[seed-status] seed count failed for ${rid}: ${err.message}`);
        }
      }
      publish(record);
      record.listeners.clear();
    })
    .catch((err) => {
      if (record.cancelled || records.get(rid) !== record) return;
      record.state = 'failed';
      record.progress = { phase: 'failed', reason: err.message };
      record.lastError = err.message;
      if (/no seeds found/i.test(err.message)) record.seedersKnown = 0;
      record.finishedAt = Date.now();
      publish(record);
      record.listeners.clear();
      log.warn(`[seed-status] ${rid} fetch failed: ${err.message}`);
    });

  return publicStatus(record);
}

function cancelFetch(rid) {
  const record = records.get(rid);
  const active = record?.state === 'fetching';
  if (record) {
    record.cancelled = true;
    record.state = 'cancelled';
    record.progress = { phase: 'cancelled' };
    record.finishedAt = Date.now();
    publish(record);
    record.listeners.clear();
  }
  records.delete(rid);
  return active ? record.done : null;
}

function subscribe(rid, listener) {
  const record = records.get(rid);
  if (!record || record.state !== 'fetching' || typeof listener !== 'function') return false;
  const added = !record.listeners.has(listener);
  record.listeners.add(listener);
  if (added) {
    try {
      listener(publicStatus(record));
    } catch (err) {
      record.listeners.delete(listener);
      log.warn(`[seed-status] listener failed for ${record.rid}: ${err.message}`);
      return false;
    }
  }
  return true;
}

function unsubscribe(listener) {
  for (const record of records.values()) record.listeners.delete(listener);
}

async function getStatus(rid, { repoExists, getSeeders } = {}) {
  const record = records.get(rid);
  let inStorage = record?.state === 'fetched';
  if (repoExists) {
    try {
      inStorage = await repoExists(rid);
    } catch {
      inStorage = false;
    }
  }

  if (!record) {
    let seedersKnown = null;
    if (getSeeders) {
      try {
        seedersKnown = await getSeeders(rid);
      } catch {
        seedersKnown = null;
      }
    }
    return {
      rid,
      state: inStorage ? 'fetched' : 'idle',
      inStorage,
      seedersKnown,
      attemptCount: 0,
      recentAttempts: [],
      progress: null,
      lastError: null,
      startedAt: null,
      finishedAt: null,
    };
  }

  if (inStorage && record.state !== 'fetching') record.state = 'fetched';
  return { ...publicStatus(record), inStorage };
}

function _reset() {
  for (const record of records.values()) record.cancelled = true;
  records.clear();
}

module.exports = { startFetch, cancelFetch, subscribe, unsubscribe, getStatus, _reset };
