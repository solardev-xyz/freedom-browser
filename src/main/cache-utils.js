// Upper bound per cache. Long browsing sessions can accumulate thousands
// of distinct names; without a cap the caches grow unboundedly since
// expired entries are only evicted on re-read. On set, if we're over the
// cap, drop expired entries first, then fall back to FIFO eviction.
const MAX_CACHE_ENTRIES = 500;

function capCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      if (cache.size <= MAX_CACHE_ENTRIES) return;
    }
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

module.exports = { MAX_CACHE_ENTRIES, capCache };
