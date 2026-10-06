/**
 * Size of Node's libuv threadpool in the main process (#514).
 *
 * The pool runs every async `fs` call, `dns.lookup`, zlib and crypto job in
 * main, plus every libradicle N-API call: each addon export is an async
 * task that holds a pool thread until it returns, so a clone or a seed
 * connect occupies one for as long as it runs (seconds to minutes; the
 * timeout argument is not a hard bound). libuv's default is four threads,
 * so a couple of clones and a seed connect leave async fs and DNS queued
 * behind them.
 *
 * libuv reads UV_THREADPOOL_SIZE once, when the pool is first used, so this
 * must run before anything in main queues pool work — it is the first
 * statement in src/main/index.js. An explicit value in the environment
 * wins. Child processes inherit the variable; for them it only sizes a
 * pool that would otherwise default to four.
 */

const DEFAULT_THREADPOOL_SIZE = 16;

function applyThreadpoolSize(env = process.env) {
  if (!env.UV_THREADPOOL_SIZE || !env.UV_THREADPOOL_SIZE.trim()) {
    env.UV_THREADPOOL_SIZE = String(DEFAULT_THREADPOOL_SIZE);
  }
  return env.UV_THREADPOOL_SIZE;
}

module.exports = { applyThreadpoolSize, DEFAULT_THREADPOOL_SIZE };
